import { DynamicModule, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { AppJwtGuard } from './app-jwt.guard.js';
import { GoogleAuthController, HealthController } from './auth.controller.js';
import { ChatController } from './chat.controller.js';
import { GoogleAuthService, GOOGLE_CLIENT_ID, GOOGLE_FETCH, JWT_SECRET, PG_POOL } from './google-auth.service.js';

@Module({
  controllers: [GoogleAuthController, HealthController, ChatController],
  providers: [GoogleAuthService, AppJwtGuard],
})
export class AppModule {
  static register(options: { pool: Pool; googleClientId: string; jwtSecret: string }): DynamicModule {
    return {
      module: AppModule,
      providers: [
        { provide: PG_POOL, useValue: options.pool },
        { provide: GOOGLE_CLIENT_ID, useValue: options.googleClientId },
        { provide: JWT_SECRET, useValue: options.jwtSecret },
        { provide: GOOGLE_FETCH, useValue: globalThis.fetch },
      ],
    };
  }
}
