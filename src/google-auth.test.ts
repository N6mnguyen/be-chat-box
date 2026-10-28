import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { setup, teardown, h } from '../db/test/harness.js';
import { GoogleAuthService, signAccessToken, verifyGoogleAccessToken } from './google-auth.service.js';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const JWT_SECRET = 'test_jwt_secret_that_is_long_enough_123456';

before(setup, { timeout: 120_000 });
after(teardown);

function mockGoogleFetch(options: {
  audience?: string;
  sub?: string;
  email?: string;
  emailVerified?: boolean;
}) {
  const sub = options.sub ?? 'google-user-001';
  const email = options.email ?? 'google.user@example.com';
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') {
      return Response.json({
        issued_to: options.audience ?? CLIENT_ID,
        user_id: sub,
      });
    }
    assert.equal(url.pathname, '/oauth2/v3/userinfo');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer mock-google-access-token');
    return Response.json({
      sub,
      email,
      email_verified: options.emailVerified ?? true,
      name: 'Google User',
      picture: 'https://example.com/avatar.png',
    });
  };
}

test('verifies Google audience and verified email', async () => {
  const profile = await verifyGoogleAccessToken(
    'mock-google-access-token',
    CLIENT_ID,
    mockGoogleFetch({ email: 'Google.User@example.com' }) as typeof fetch,
  );
  assert.deepEqual(profile, {
    sub: 'google-user-001',
    email: 'google.user@example.com',
    name: 'Google User',
    picture: 'https://example.com/avatar.png',
  });
});

test('rejects credentials for another Google client or unverified email', async () => {
  await assert.rejects(
    verifyGoogleAccessToken(
      'mock-google-access-token',
      CLIENT_ID,
      mockGoogleFetch({ audience: 'another-client.apps.googleusercontent.com' }) as typeof fetch,
    ),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 401,
  );
  await assert.rejects(
    verifyGoogleAccessToken(
      'mock-google-access-token',
      CLIENT_ID,
      mockGoogleFetch({ emailVerified: false }) as typeof fetch,
    ),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 401,
  );
});

test('creates a Google identity once and issues a signed application JWT', async () => {
  const service = new GoogleAuthService(
    h.app,
    CLIENT_ID,
    JWT_SECRET,
    mockGoogleFetch({}) as typeof fetch,
  );
  const first = await service.exchange('mock-google-access-token');
  const second = await service.exchange('mock-google-access-token');

  assert.equal(first.user.email, 'google.user@example.com');
  assert.equal(first.user.name, 'Google User');
  assert.equal(first.user.picture, 'https://example.com/avatar.png');
  assert.match(first.accessToken, /^[^.]+\.[^.]+\.[^.]+$/);

  const payload = JSON.parse(Buffer.from(first.accessToken.split('.')[1], 'base64url').toString('utf8')) as {
    sub: string;
    scope: string;
    iat: number;
    exp: number;
  };
  const secondPayload = JSON.parse(Buffer.from(second.accessToken.split('.')[1], 'base64url').toString('utf8')) as {
    sub: string;
  };
  assert.equal(payload.sub, secondPayload.sub);
  assert.equal(payload.scope, 'full');
  assert.equal(payload.exp - payload.iat, 600);

  const result = await h.owner.query<{ identities: string }>(
    `SELECT count(*)::text AS identities FROM app.google_identities WHERE google_sub = $1`,
    ['google-user-001'],
  );
  assert.equal(result.rows[0].identities, '1');
  const storedUser = await h.owner.query<{
    username: string;
    display_name: string;
    email: string;
    status: string;
    has_settings: boolean;
  }>(
    `SELECT u.username, u.display_name, i.value AS email, u.status,
            EXISTS (SELECT 1 FROM app.user_settings s WHERE s.user_id = u.id) AS has_settings
     FROM app.google_identities g
     JOIN app.users u ON u.id = g.user_id
     JOIN app.identities i ON i.user_id = u.id AND i.type = 'email'
     WHERE g.google_sub = $1`,
    ['google-user-001'],
  );
  assert.equal(storedUser.rowCount, 1);
  assert.match(storedUser.rows[0].username, /^[a-z0-9_]{3,30}$/);
  assert.equal(storedUser.rows[0].display_name, 'Google User');
  assert.equal(storedUser.rows[0].email, 'google.user@example.com');
  assert.equal(storedUser.rows[0].status, 'active');
  assert.equal(storedUser.rows[0].has_settings, true);
  assert.ok(first.accessExpiresAt.endsWith('Z'));
});

test('links only an existing verified email identity', async () => {
  const verifiedUser = await h.activeUser('verified_google_link');
  await h.owner.query(
    `INSERT INTO app.identities (id, user_id, type, value, verified_at)
     VALUES ($1, $2, 'email', $3, now())`,
    [randomUUID(), verifiedUser, 'linked@example.com'],
  );
  const service = new GoogleAuthService(
    h.app,
    CLIENT_ID,
    JWT_SECRET,
    mockGoogleFetch({ sub: 'google-linked-001', email: 'linked@example.com' }) as typeof fetch,
  );
  const result = await service.exchange('mock-google-access-token');
  const linked = await h.owner.query<{ user_id: string }>(
    'SELECT user_id FROM app.google_identities WHERE google_sub = $1',
    ['google-linked-001'],
  );
  assert.equal(linked.rows[0].user_id, verifiedUser);
  assert.equal(result.user.email, 'linked@example.com');

  const unverifiedUser = await h.activeUser('unverified_google_link');
  await h.owner.query(
    `INSERT INTO app.identities (id, user_id, type, value)
     VALUES ($1, $2, 'email', $3)`,
    [randomUUID(), unverifiedUser, 'unverified@example.com'],
  );
  const unverifiedService = new GoogleAuthService(
    h.app,
    CLIENT_ID,
    JWT_SECRET,
    mockGoogleFetch({ sub: 'google-unverified-001', email: 'unverified@example.com' }) as typeof fetch,
  );
  await assert.rejects(
    unverifiedService.exchange('mock-google-access-token'),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 401,
  );
});

test('rotates refresh tokens and revokes a reused token family', async () => {
  const service = new GoogleAuthService(
    h.app,
    CLIENT_ID,
    JWT_SECRET,
    mockGoogleFetch({
      sub: 'google-refresh-001',
      email: 'refresh.user@example.com',
    }) as typeof fetch,
  );
  const first = await service.exchange('mock-google-access-token');
  const second = await service.refresh(first.refreshToken);
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.equal(second.user.email, 'refresh.user@example.com');

  await assert.rejects(
    service.refresh(first.refreshToken),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 401,
  );
  await assert.rejects(
    service.refresh(second.refreshToken),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 401,
  );
});

test('revokes the device and refresh family on logout', async () => {
  const service = new GoogleAuthService(
    h.app,
    CLIENT_ID,
    JWT_SECRET,
    mockGoogleFetch({
      sub: 'google-logout-001',
      email: 'logout.user@example.com',
    }) as typeof fetch,
  );
  const session = await service.exchange('mock-google-access-token');
  await service.logout(session.refreshToken);
  await assert.rejects(
    service.refresh(session.refreshToken),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 401,
  );
});

test('signs JWTs with HS256 and includes the user subject', () => {
  const token = signAccessToken('user-id', JWT_SECRET, 100, 700);
  const [header, payload, signature] = token.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')).alg, 'HS256');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).sub, 'user-id');
  const expected = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  assert.equal(signature, expected);
});
