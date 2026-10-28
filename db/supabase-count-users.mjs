import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL in be-chat-box/.env to the Supabase vchat_app connection.');
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const result = await pool.query('SELECT count(*)::text AS count FROM app.users');
  console.log(`app.users records: ${result.rows[0].count}`);
} finally {
  await pool.end();
}
