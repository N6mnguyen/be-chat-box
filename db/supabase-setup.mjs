import { readFile } from 'node:fs/promises';
import pg from 'pg';

const directUrl = process.env.DIRECT_URL;
const databaseUrl = process.env.DATABASE_URL;
const appPassword = process.env.VCHAT_APP_PASSWORD;

if (!directUrl || !databaseUrl || !appPassword) {
  throw new Error('Set DIRECT_URL, DATABASE_URL, and VCHAT_APP_PASSWORD in be-chat-box/.env first.');
}

if (Buffer.byteLength(appPassword) < 16) {
  throw new Error('VCHAT_APP_PASSWORD must be at least 16 bytes.');
}

const directUser = decodeURIComponent(new URL(directUrl).username);
const appUrl = new URL(databaseUrl);
const appUser = decodeURIComponent(appUrl.username);
if (!directUser.startsWith('postgres') || !appUser.startsWith('vchat_app')) {
  throw new Error('DIRECT_URL must use the Supabase postgres role and DATABASE_URL must use vchat_app.');
}
if (decodeURIComponent(appUrl.password) !== appPassword) {
  throw new Error('VCHAT_APP_PASSWORD must match the password in DATABASE_URL.');
}

const pool = new pg.Pool({ connectionString: directUrl, max: 1 });
try {
  const namespace = await pool.query(
    "SELECT oid FROM pg_namespace WHERE nspname = 'app'",
  );
  if (namespace.rowCount) {
    const objects = await pool.query(
      `SELECT
         EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = $1)
         OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = $1)
         OR EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = $1) AS has_objects`,
      [namespace.rows[0].oid],
    );
    if (objects.rows[0].has_objects) {
      throw new Error('Schema app already contains database objects. Initialization stopped; apply only pending migrations.');
    }
  }

  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  const roles = await readFile(new URL('./roles.sql', import.meta.url), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(schema);
    await client.query(roles);
    const passwordStatement = await client.query(
      "SELECT format('ALTER ROLE vchat_app PASSWORD %L', $1::text) AS statement",
      [appPassword],
    );
    await client.query(passwordStatement.rows[0].statement);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  console.log('Supabase schema app initialized successfully.');
} finally {
  await pool.end();
}
