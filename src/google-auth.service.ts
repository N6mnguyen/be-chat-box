import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

export const PG_POOL = Symbol('PG_POOL');
export const GOOGLE_CLIENT_ID = Symbol('GOOGLE_CLIENT_ID');
export const GOOGLE_FETCH = Symbol('GOOGLE_FETCH');
export const JWT_SECRET = Symbol('JWT_SECRET');

interface GoogleProfile {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

interface TokenInfo {
  aud?: unknown;
  audience?: unknown;
  issued_to?: unknown;
  user_id?: unknown;
}

interface UserInfo {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  picture?: unknown;
}

export interface AuthUser {
  name: string;
  email: string;
  picture?: string;
}

interface Account {
  id: string;
  displayName: string | null;
}

interface IssuedSession {
  scope: 'full';
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  deviceId: string;
  deviceToken?: string;
  user: AuthUser;
}

@Injectable()
export class GoogleAuthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(GOOGLE_CLIENT_ID) private readonly googleClientId: string,
    @Inject(JWT_SECRET) private readonly jwtSecret: string,
    @Inject(GOOGLE_FETCH) private readonly fetcher: typeof fetch,
  ) {}

  async exchange(googleAccessToken: string): Promise<IssuedSession> {
    const profile = await verifyGoogleAccessToken(googleAccessToken, this.googleClientId, this.fetcher);
    const account = await this.findOrCreateGoogleUser(profile);
    const device = await this.createDevice(account.id);

    return {
      ...this.accessToken(account.id, device.id),
      refreshToken: device.refreshToken,
      refreshExpiresAt: device.refreshExpiresAt,
      deviceToken: device.deviceToken,
      user: {
        name: account.displayName || profile.name || profile.email,
        email: profile.email,
        ...(profile.picture ? { picture: profile.picture } : {}),
      },
    };
  }

  async refresh(refreshToken: string): Promise<IssuedSession> {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const currentHash = hashSecret(this.jwtSecret, refreshToken);
      const current = await client.query<{
        id: string;
        family_id: string;
        device_id: string;
        user_id: string;
        user_status: string;
        consumed_at: Date | null;
        revoked_at: Date | null;
        expires_at: Date;
        device_revoked_at: Date | null;
      }>(
        `SELECT rt.id, rt.family_id, rt.device_id, rt.consumed_at, rt.revoked_at, rt.expires_at,
                d.user_id, d.revoked_at AS device_revoked_at, u.status AS user_status
         FROM app.refresh_tokens rt
         JOIN app.devices d ON d.id = rt.device_id
         JOIN app.users u ON u.id = d.user_id
         WHERE rt.token_hash = $1 AND rt.pepper_version = 'v1'
         FOR UPDATE OF rt, d, u`,
        [currentHash],
      );
      if (!current.rowCount) {
        throw invalidCredentials();
      }

      const token = current.rows[0];
      if (token.consumed_at) {
        await client.query(
          `UPDATE app.refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
           WHERE family_id = $1`,
          [token.family_id],
        );
        await client.query(
          `UPDATE app.devices SET revoked_at = COALESCE(revoked_at, now())
           WHERE id = $1`,
          [token.device_id],
        );
        await client.query('COMMIT');
        transactionOpen = false;
        throw invalidCredentials();
      }
      if (
        token.revoked_at ||
        token.device_revoked_at ||
        token.user_status !== 'active' ||
        token.expires_at.getTime() <= Date.now()
      ) {
        throw invalidCredentials();
      }

      const nextToken = randomBytes(32).toString('base64url');
      const nextId = randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
      await client.query(
        `UPDATE app.refresh_tokens SET consumed_at = now() WHERE id = $1`,
        [token.id],
      );
      await client.query(
        `INSERT INTO app.refresh_tokens
           (id, device_id, family_id, token_hash, pepper_version, expires_at)
         VALUES ($1, $2, $3, $4, 'v1', $5)`,
        [nextId, token.device_id, token.family_id, hashSecret(this.jwtSecret, nextToken), expiresAt],
      );
      await client.query(
        `UPDATE app.refresh_tokens SET replaced_by = $2 WHERE id = $1`,
        [token.id, nextId],
      );
      await client.query('UPDATE app.devices SET last_seen_at = now() WHERE id = $1', [token.device_id]);
      await client.query('COMMIT');
      transactionOpen = false;

      const user = await this.getAuthUser(token.user_id);
      return {
        ...this.accessToken(token.user_id, token.device_id),
        refreshToken: nextToken,
        refreshExpiresAt: expiresAt.toISOString(),
        user,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK').catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async logout(refreshToken: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ family_id: string; device_id: string }>(
        `SELECT family_id, device_id FROM app.refresh_tokens
         WHERE token_hash = $1 AND pepper_version = 'v1' FOR UPDATE`,
        [hashSecret(this.jwtSecret, refreshToken)],
      );
      if (current.rowCount) {
        await client.query(
          `UPDATE app.refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
           WHERE family_id = $1`,
          [current.rows[0].family_id],
        );
        await client.query(
          `UPDATE app.devices SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`,
          [current.rows[0].device_id],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private accessToken(
    userId: string,
    deviceId: string,
  ): Pick<IssuedSession, 'scope' | 'accessToken' | 'accessExpiresAt' | 'deviceId'> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + 10 * 60;
    return {
      scope: 'full',
      accessToken: signAccessToken(userId, this.jwtSecret, issuedAt, expiresAt, deviceId),
      accessExpiresAt: new Date(expiresAt * 1000).toISOString(),
      deviceId,
    };
  }

  private async createDevice(userId: string): Promise<{
    id: string;
    refreshToken: string;
    refreshExpiresAt: string;
    deviceToken: string;
  }> {
    const id = randomUUID();
    const refreshToken = randomBytes(32).toString('base64url');
    const deviceToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO app.devices (id, user_id, name, token_hash, token_pepper_version)
         VALUES ($1, $2, 'Web browser', $3, 'v1')`,
        [id, userId, hashSecret(this.jwtSecret, deviceToken)],
      );
      await client.query(
        `INSERT INTO app.refresh_tokens (id, device_id, family_id, token_hash, pepper_version, expires_at)
         VALUES ($1, $2, $3, $4, 'v1', $5)`,
        [randomUUID(), id, randomUUID(), hashSecret(this.jwtSecret, refreshToken), expiresAt],
      );
      await client.query('COMMIT');
      return { id, refreshToken, refreshExpiresAt: expiresAt.toISOString(), deviceToken };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async getAuthUser(userId: string): Promise<AuthUser> {
    const result = await this.pool.query<{ name: string; email: string }>(
      `SELECT COALESCE(u.display_name, i.value) AS name, i.value AS email
       FROM app.users u
       JOIN app.identities i ON i.user_id = u.id AND i.type = 'email'
       WHERE u.id = $1 AND u.status = 'active'
       LIMIT 1`,
      [userId],
    );
    if (!result.rowCount) {
      throw invalidCredentials();
    }
    return result.rows[0];
  }

  private async findOrCreateGoogleUser(profile: GoogleProfile): Promise<Account> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lockKeys = [`google-email:${profile.email}`, `google-sub:${profile.sub}`].sort();
      for (const key of lockKeys) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      }

      const linked = await client.query<{ id: string; display_name: string | null; username: string | null; status: string }>(
        `SELECT u.id, u.display_name, u.username, u.status
         FROM app.google_identities g
         JOIN app.users u ON u.id = g.user_id
         WHERE g.google_sub = $1
         FOR UPDATE OF u`,
        [profile.sub],
      );

      if (linked.rowCount) {
        if (linked.rows[0].status !== 'active') {
          throw invalidCredentials();
        }
        if (!linked.rows[0].username) {
          await client.query(
            'UPDATE app.users SET username = $2 WHERE id = $1 AND username IS NULL',
            [linked.rows[0].id, createUsername()],
          );
        }
        await client.query(
          'INSERT INTO app.user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [linked.rows[0].id],
        );
        await client.query('COMMIT');
        return { id: linked.rows[0].id, displayName: linked.rows[0].display_name };
      }

      const emailIdentity = await client.query<{
        user_id: string;
        status: string;
        display_name: string | null;
        username: string | null;
        verified_at: Date | null;
      }>(
        `SELECT i.user_id, i.verified_at, u.status, u.display_name, u.username
         FROM app.identities i
         JOIN app.users u ON u.id = i.user_id
         WHERE i.type = 'email' AND i.value = $1
         FOR UPDATE OF i, u`,
        [profile.email],
      );

      let userId: string;
      let displayName: string | null;
      if (emailIdentity.rowCount) {
        const existing = emailIdentity.rows[0];
        if (!existing.verified_at || existing.status !== 'active') {
          throw invalidCredentials();
        }
        userId = existing.user_id;
        displayName = existing.display_name;
        if (!existing.username) {
          await client.query(
            'UPDATE app.users SET username = $2 WHERE id = $1 AND username IS NULL',
            [userId, createUsername()],
          );
        }
        await client.query(
          'INSERT INTO app.user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [userId],
        );
      } else {
        userId = randomUUID();
        displayName = profile.name ?? null;
        await client.query(
          `INSERT INTO app.users (id, username, display_name, status)
           VALUES ($1, $2, $3, 'active')`,
          [userId, createUsername(), displayName],
        );
        await client.query(
          `INSERT INTO app.identities (id, user_id, type, value, verified_at)
           VALUES ($1, $2, 'email', $3, now())`,
          [randomUUID(), userId, profile.email],
        );
        await client.query('INSERT INTO app.user_settings (user_id) VALUES ($1)', [userId]);
      }

      await client.query(
        'INSERT INTO app.google_identities (google_sub, user_id) VALUES ($1, $2)',
        [profile.sub, userId],
      );
      await client.query('COMMIT');
      return { id: userId, displayName };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function verifyGoogleAccessToken(
  accessToken: string,
  clientId: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<GoogleProfile> {
  const tokenInfo = await googleJson<TokenInfo>(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
    fetcher,
  );
  const audiences = [tokenInfo.aud, tokenInfo.audience, tokenInfo.issued_to];
  if (!audiences.includes(clientId)) {
    throw invalidCredentials();
  }

  const userInfo = await googleJson<UserInfo>(
    'https://www.googleapis.com/oauth2/v3/userinfo',
    fetcher,
    accessToken,
  );
  if (
    typeof userInfo.sub !== 'string' ||
    userInfo.sub.length < 1 ||
    userInfo.sub.length > 255 ||
    typeof userInfo.email !== 'string' ||
    userInfo.email.length > 320 ||
    userInfo.email_verified !== true ||
    (typeof tokenInfo.user_id === 'string' && tokenInfo.user_id !== userInfo.sub)
  ) {
    throw invalidCredentials();
  }

  const email = userInfo.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw invalidCredentials();
  }

  return {
    sub: userInfo.sub,
    email,
    ...(typeof userInfo.name === 'string' && userInfo.name.trim()
      ? { name: userInfo.name.trim().slice(0, 80) }
      : {}),
    ...(typeof userInfo.picture === 'string' && userInfo.picture.startsWith('https://')
      ? { picture: userInfo.picture }
      : {}),
  };
}

async function googleJson<T extends object>(
  url: string,
  fetcher: typeof fetch,
  accessToken?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new ServiceUnavailableException({
      code: 'SERVER_BUSY',
      message: 'Không thể xác minh với Google lúc này.',
    });
  }

  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      throw invalidCredentials();
    }
    throw new ServiceUnavailableException({
      code: 'SERVER_BUSY',
      message: 'Không thể xác minh với Google lúc này.',
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ServiceUnavailableException({
      code: 'SERVER_BUSY',
      message: 'Google trả về phản hồi không hợp lệ.',
    });
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new ServiceUnavailableException({
      code: 'SERVER_BUSY',
      message: 'Google trả về phản hồi không hợp lệ.',
    });
  }

  return payload as T;
}

export function signAccessToken(
  userId: string,
  secret: string,
  issuedAt = Math.floor(Date.now() / 1000),
  expiresAt = issuedAt + 10 * 60,
  deviceId?: string,
): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    sub: userId,
    scope: 'full',
    iss: 'vchat-api',
    aud: 'vchat-client',
    iat: issuedAt,
    exp: expiresAt,
    ...(deviceId ? { device_id: deviceId } : {}),
  });
  const content = `${header}.${payload}`;
  const signature = createHmac('sha256', secret).update(content).digest('base64url');
  return `${content}.${signature}`;
}

function hashSecret(secret: string, value: string): Buffer {
  return createHash('sha256').update(secret).update(':').update(value).digest();
}

function createUsername(): string {
  return `u${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function invalidCredentials(): HttpException {
  return new HttpException(
    { code: 'INVALID_CREDENTIALS', message: 'Thông tin đăng nhập không hợp lệ.' },
    HttpStatus.UNAUTHORIZED,
  );
}
