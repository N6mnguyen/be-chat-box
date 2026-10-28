import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { Pool } from 'pg';
import { JWT_SECRET, PG_POOL } from './google-auth.service.js';

export interface AuthenticatedRequest extends Request {
  userId: string;
  deviceId: string;
}

interface AccessClaims {
  sub?: unknown;
  device_id?: unknown;
  scope?: unknown;
  iss?: unknown;
  aud?: unknown;
  iat?: unknown;
  exp?: unknown;
}

@Injectable()
export class AppJwtGuard implements CanActivate {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(JWT_SECRET) private readonly jwtSecret: string,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.header('Authorization');
    const token = authorization?.match(/^Bearer ([A-Za-z0-9._-]+)$/)?.[1];
    if (!token) {
      throw unauthenticated();
    }

    const claims = this.verify(token);
    if (!claims) {
      throw unauthenticated();
    }
    const result = await this.pool.query(
      `SELECT 1
       FROM app.users u
       JOIN app.devices d ON d.user_id = u.id
       WHERE u.id = $1 AND d.id = $2 AND u.status = 'active' AND d.revoked_at IS NULL`,
      [claims.sub, claims.device_id],
    );
    if (!result.rowCount) {
      throw unauthenticated();
    }

    request.userId = claims.sub as string;
    request.deviceId = claims.device_id as string;
    return true;
  }

  private verify(token: string): AccessClaims | null {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    const [headerPart, payloadPart, signature] = parts;
    try {
      const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as {
        alg?: unknown;
        typ?: unknown;
      };
      const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as AccessClaims;
      if (header.alg !== 'HS256' || header.typ !== 'JWT') {
        return null;
      }

      const expected = createHmac('sha256', this.jwtSecret)
        .update(`${headerPart}.${payloadPart}`)
        .digest();
      const actual = Buffer.from(signature, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return null;
      }

      const now = Math.floor(Date.now() / 1000);
      if (
        typeof claims.sub !== 'string' ||
        !UUID_PATTERN.test(claims.sub) ||
        typeof claims.device_id !== 'string' ||
        !UUID_PATTERN.test(claims.device_id) ||
        claims.scope !== 'full' ||
        claims.iss !== 'vchat-api' ||
        claims.aud !== 'vchat-client' ||
        typeof claims.exp !== 'number' ||
        claims.exp <= now ||
        typeof claims.iat !== 'number' ||
        claims.iat > now + 30
      ) {
        return null;
      }
      return claims;
    } catch {
      return null;
    }
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function unauthenticated(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'UNAUTHENTICATED',
    message: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.',
  });
}
