import { Pool } from 'pg';
import { createApp } from '../dist/bootstrap.js';

// Serverless: dựng Nest app một lần mỗi instance, tái dùng cho các request sau.
let handler;
async function init() {
  const { DATABASE_URL, GOOGLE_CLIENT_ID, JWT_SECRET } = process.env;
  if (!DATABASE_URL || !GOOGLE_CLIENT_ID || !JWT_SECRET) {
    throw new Error('DATABASE_URL, GOOGLE_CLIENT_ID, JWT_SECRET are required.');
  }
  const app = await createApp(new Pool({ connectionString: DATABASE_URL, max: 1 }), GOOGLE_CLIENT_ID, JWT_SECRET);
  await app.init();
  return app.getHttpAdapter().getInstance();
}

export default async function (req, res) {
  handler ??= init().catch((error) => {
    handler = undefined;
    throw error;
  });
  return (await handler)(req, res);
}
