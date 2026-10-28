import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { PG_POOL } from './google-auth.service.js';
import { GoogleAuthService } from './google-auth.service.js';

@Controller('v1/auth')
export class GoogleAuthController {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(@Inject(GoogleAuthService) private readonly googleAuth: GoogleAuthService) {}

  @Post('google')
  @HttpCode(HttpStatus.OK)
  exchangeGoogleToken(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!this.takeRateLimit(request.ip || 'unknown')) {
      response.setHeader('Retry-After', '60');
      throw new HttpException(
        { code: 'RATE_LIMITED', message: 'Thử lại sau một phút.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      !('accessToken' in body) ||
      typeof body.accessToken !== 'string' ||
      body.accessToken.length < 20 ||
      body.accessToken.length > 4096
    ) {
      throw new HttpException(
        { code: 'VALIDATION_FAILED', message: 'Dữ liệu đăng nhập không hợp lệ.' },
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.googleAuth.exchange(body.accessToken);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refreshToken(@Body() body: unknown) {
    if (
      typeof body !== 'object' ||
      body === null ||
      !('refreshToken' in body) ||
      typeof body.refreshToken !== 'string' ||
      body.refreshToken.length < 32 ||
      body.refreshToken.length > 256
    ) {
      throw new HttpException(
        { code: 'VALIDATION_FAILED', message: 'Dữ liệu làm mới phiên không hợp lệ.' },
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.googleAuth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Body() body: unknown): Promise<void> {
    if (
      typeof body !== 'object' ||
      body === null ||
      !('refreshToken' in body) ||
      typeof body.refreshToken !== 'string' ||
      body.refreshToken.length < 32 ||
      body.refreshToken.length > 256
    ) {
      throw new HttpException(
        { code: 'VALIDATION_FAILED', message: 'Dữ liệu đăng xuất không hợp lệ.' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.googleAuth.logout(body.refreshToken);
  }

  private takeRateLimit(ip: string): boolean {
    const now = Date.now();
    const current = this.attempts.get(ip);
    if (!current || current.resetAt <= now) {
      if (this.attempts.size >= 5000) {
        for (const [key, value] of this.attempts) {
          if (value.resetAt <= now) {
            this.attempts.delete(key);
          }
        }
      }
      if (this.attempts.size >= 5000) {
        return false;
      }
      this.attempts.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (current.count >= 20) {
      return false;
    }
    current.count += 1;
    return true;
  }
}

@Controller()
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('health')
  async health() {
    await this.pool.query('SELECT 1');
    return { status: 'ok' };
  }
}
