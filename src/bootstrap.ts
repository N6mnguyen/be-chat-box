import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import express, { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { ApiExceptionFilter } from './api-exception.filter.js';
import { AppModule } from './app.module.js';

export async function createApp(pool: Pool, googleClientId: string, jwtSecret: string): Promise<INestApplication> {
  const application = await NestFactory.create(
    AppModule.register({ pool, googleClientId, jwtSecret }),
    { bodyParser: false },
  );
  application.getHttpAdapter().getInstance().disable('x-powered-by');
  application.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:4200')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  });
  application.use(express.json({ limit: '16kb' }));
  application.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (!error) {
      next();
      return;
    }
    const status = typeof error === 'object' && error !== null && 'status' in error && error.status === 413
      ? 413
      : 400;
    const requestId = randomBytes(16).toString('hex');
    response.setHeader('X-Request-Id', requestId);
    response.status(status).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: status === 413 ? 'Yêu cầu vượt quá kích thước cho phép.' : 'JSON không hợp lệ.',
        requestId,
      },
    });
  });
  application.useGlobalFilters(new ApiExceptionFilter());
  return application;
}
