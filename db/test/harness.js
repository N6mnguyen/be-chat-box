// Harness Postgres thật dùng chung cho test Bước 3 và Bước 4; mỗi file một DB tạm.
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';

const sql = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const DB = `vchat_test_${process.pid}`;
const APP_PW = 'test_only_pw';
let embedded, adminUrl;
export const h = { owner: null, app: null, anon: null,
  hash: (s) => createHash('sha256').update(s).digest(),
};

export async function setup() {
  adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    embedded = new EmbeddedPostgres({
      databaseDir: `${process.env.TMPDIR ?? process.env.TEMP ?? '/tmp'}/vchat-pg-${process.pid}`,
      user: 'postgres', password: 'postgres', port: 54330 + (process.pid % 1000), persistent: false,
    });
    await embedded.initialise();
    await embedded.start();
    adminUrl = `postgres://postgres:postgres@localhost:${54330 + (process.pid % 1000)}/postgres`;
  }
  const admin = new pg.Client(adminUrl);
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon_login') THEN
      CREATE ROLE anon_login LOGIN PASSWORD 'anon_pw' IN ROLE anon; END IF; END $$`);
  await admin.end();

  const u = new URL(adminUrl); u.pathname = `/${DB}`;
  h.owner = new pg.Pool({ connectionString: u.href, max: 2 });
  await h.owner.query(sql('schema.sql'));
  await h.owner.query(sql('roles.sql'));
  await h.owner.query(`ALTER ROLE vchat_app PASSWORD '${APP_PW}'`);
  await h.owner.query('GRANT USAGE ON SCHEMA app TO anon');
  await h.owner.query('GRANT SELECT ON ALL TABLES IN SCHEMA app TO anon');
  const au = new URL(u.href); au.username = 'vchat_app'; au.password = APP_PW;
  h.app = new pg.Pool({ connectionString: au.href, max: 60 });
  const nu = new URL(u.href); nu.username = 'anon_login'; nu.password = 'anon_pw';
  h.anon = new pg.Client(nu.href);
  await h.anon.connect();
}

export async function teardown() {
  await h.anon?.end(); await h.app?.end(); await h.owner?.end();
  const admin = new pg.Client(adminUrl);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
  // Windows đôi lúc giữ file khi Postgres vừa dừng; EBUSY không phải test lỗi.
  await embedded?.stop().catch((e) => { if (e.code !== 'EBUSY') throw e; });
}

h.tx = async (fn) => {
  const c = await h.app.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
};
h.friendsWithConversation = async () => {
  const [a, b] = [randomUUID(), randomUUID()].sort();
  const conv = randomUUID();
  await h.owner.query(`INSERT INTO app.users (id, username, status) VALUES ($1,$2,'active'),($3,$4,'active')`,
    [a, `u${a.slice(0, 8)}`, b, `u${b.slice(0, 8)}`]);
  await h.owner.query('INSERT INTO app.friendships VALUES ($1,$2)', [a, b]);
  await h.owner.query(`INSERT INTO app.conversations (id, type, direct_user_low, direct_user_high)
    VALUES ($1,'direct',$2,$3)`, [conv, a, b]);
  await h.owner.query('INSERT INTO app.conversation_members (conversation_id, user_id) VALUES ($1,$2),($1,$3)', [conv, a, b]);
  return { a, b, conv };
};
h.send = async (conv, sender, clientMsgId, body, replyTo = null) =>
  h.tx(async (c) => (await c.query('SELECT * FROM app.send_direct_message($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), conv, sender, clientMsgId, h.hash(`${body}|${replyTo}`), body, replyTo])).rows[0]);
h.recall = (conv, msg, user, window = '24 hours') =>
  h.tx(async (c) => (await c.query('SELECT * FROM app.recall_message($1,$2,$3,$4::interval)',
    [conv, msg, user, window])).rows[0]);
h.activeUser = async (name) => {
  const id = randomUUID();
  await h.owner.query(`INSERT INTO app.users (id, username, status) VALUES ($1,$2,'active')`, [id, name]);
  await h.owner.query('INSERT INTO app.user_settings (user_id) VALUES ($1)', [id]);
  return id;
};
h.invite = (sender, username) =>
  h.tx(async (c) => (await c.query(`SELECT app.send_friend_request($1,$2,$3,interval '30 days') r`,
    [randomUUID(), sender, username])).rows[0].r);
