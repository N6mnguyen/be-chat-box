import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Client, Pool } from 'pg';
import { createApp } from './bootstrap.js';
import { startEmbeddedPostgres } from '../db/embedded-postgres.js';

const DEV_MODE = process.argv.includes('--dev');

interface EmbeddedDatabase {
  adminUrl: string;
  connectionString: string;
  stop: () => Promise<void>;
  databaseName: string;
}

async function main(): Promise<void> {
  let embedded: EmbeddedDatabase | undefined;
  let pool: Pool | undefined;
  let app: INestApplication | undefined;
  try {
    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    if (!googleClientId) {
      throw new Error('GOOGLE_CLIENT_ID is required.');
    }
    const jwtSecret = process.env.JWT_SECRET ?? (DEV_MODE ? randomBytes(32).toString('base64url') : undefined);
    if (!jwtSecret || Buffer.byteLength(jwtSecret) < 32) {
      throw new Error('JWT_SECRET must be at least 32 bytes.');
    }

    embedded = !process.env.DATABASE_URL && DEV_MODE ? await prepareEmbeddedDatabase() : undefined;
    const connectionString = process.env.DATABASE_URL ?? embedded?.connectionString;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required outside local development.');
    }

    const databasePool = new Pool({ connectionString, max: 10 });
    pool = databasePool;
    await databasePool.query('SELECT 1');
    const application = await createApp(databasePool, googleClientId, jwtSecret);
    app = application;

    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('PORT must be an integer between 1 and 65535.');
    }
    const host = process.env.API_HOST ?? '127.0.0.1';
    await application.listen(port, host);
    console.log(`VChat API listening on http://${host}:${port}`);
    if (embedded) {
      console.warn('Using temporary embedded PostgreSQL; data is NOT stored in Supabase and is discarded when the server stops.');
      console.warn('Set DATABASE_URL in be-chat-box/.env to use persistent PostgreSQL.');
    } else {
      console.log('Using PostgreSQL from DATABASE_URL; connection details are hidden.');
    }
    if (DEV_MODE && !process.env.JWT_SECRET) {
      console.warn('Using a temporary development JWT secret; tokens expire when the server restarts.');
    }

    let stopping = false;
    const shutdown = async () => {
      if (stopping) {
        return;
      }
      stopping = true;
      try {
        await application.close();
        await databasePool.end();
        if (embedded) {
          await dropEmbeddedDatabase(embedded);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Backend shutdown failed: ${message}`);
        process.exitCode = 1;
      }
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  } catch (error) {
    if (app) {
      await app.close();
    }
    if (pool) {
      await pool.end();
    }
    if (embedded) {
      await dropEmbeddedDatabase(embedded);
    }
    throw error;
  }
}

async function prepareEmbeddedDatabase(): Promise<EmbeddedDatabase> {
  const embedded = await startEmbeddedPostgres({ name: 'vchat-api-pg' });
  const databaseName = `vchat_api_${process.pid}`;
  let databaseCreated = false;
  let owner: Pool | undefined;
  try {
    const admin = new Client({ connectionString: embedded.adminUrl });
    await admin.connect();
    try {
      await admin.query(
        `CREATE DATABASE ${databaseName} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
      );
      databaseCreated = true;
    } finally {
      await admin.end();
    }

    const databaseUrl = new URL(embedded.adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    owner = new Pool({ connectionString: databaseUrl.href, max: 2 });
    await owner.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
    await owner.query(await readFile(new URL('../db/roles.sql', import.meta.url), 'utf8'));
    const appPassword = randomBytes(32).toString('hex');
    const roleStatement = await owner.query<{ statement: string }>(
      "SELECT format('ALTER ROLE vchat_app PASSWORD %L', $1::text) AS statement",
      [appPassword],
    );
    await owner.query(roleStatement.rows[0].statement);
    await owner.end();
    owner = undefined;

    const appUrl = new URL(databaseUrl.href);
    appUrl.username = 'vchat_app';
    appUrl.password = appPassword;
    return {
      adminUrl: embedded.adminUrl,
      connectionString: appUrl.href,
      databaseName,
      stop: embedded.stop,
    };
  } catch (error) {
    await owner?.end();
    if (databaseCreated) {
      const admin = new Client({ connectionString: embedded.adminUrl });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
    await embedded.stop();
    throw error;
  }
}

async function dropEmbeddedDatabase(embedded: EmbeddedDatabase): Promise<void> {
  const admin = new Client({ connectionString: embedded.adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${embedded.databaseName} WITH (FORCE)`);
  await admin.end();
  await embedded.stop();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Backend startup failed: ${message}`);
  process.exitCode = 1;
});
