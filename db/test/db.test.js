// Kiểm tra DDL Bước 3 trên Postgres thật (harness.js: TEST_DATABASE_URL hoặc embedded-postgres).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, teardown, h } from './harness.js';

before(setup, { timeout: 120_000 });
after(teardown);
const { friendsWithConversation, send } = h;
const owner = new Proxy({}, { get: (_, k) => h.owner[k].bind(h.owner) });
const app = new Proxy({}, { get: (_, k) => h.app[k].bind(h.app) });
const anon = new Proxy({}, { get: (_, k) => h.anon[k].bind(h.anon) });

test('50 lần gửi đồng thời cùng hội thoại: seq 1..50 không trùng, không hụt', async () => {
  const { a, b, conv } = await friendsWithConversation();
  const res = await Promise.all(Array.from({ length: 50 }, (_, i) =>
    send(conv, i % 2 ? a : b, randomUUID(), `m${i}`)));
  const seqs = res.map((r) => Number(r.seq)).sort((x, y) => x - y);
  assert.deepEqual(seqs, Array.from({ length: 50 }, (_, i) => i + 1));
  const { rows } = await owner.query(
    'SELECT last_seq, (SELECT count(*) FROM app.conversation_changes WHERE conversation_id=$1)::int n FROM app.conversations WHERE id=$1', [conv]);
  assert.equal(Number(rows[0].last_seq), 50);
  assert.equal(rows[0].n, 50);
});

test('gửi lặp cùng clientMsgId đồng thời: 1 tin, cùng seq, không tốn seq', async () => {
  const { a, conv } = await friendsWithConversation();
  const cid = randomUUID();
  const res = await Promise.all(Array.from({ length: 20 }, () => send(conv, a, cid, 'hello')));
  assert.equal(new Set(res.map((r) => r.message_id)).size, 1);
  assert.equal(new Set(res.map((r) => String(r.seq))).size, 1);
  assert.equal(res.filter((r) => !r.duplicate).length, 1);
  const next = await send(conv, a, randomUUID(), 'next');
  assert.equal(Number(next.seq), 2); // không hụt seq sau các bản lặp
});

test('cùng clientMsgId khác nội dung -> VC409', async () => {
  const { a, conv } = await friendsWithConversation();
  const cid = randomUUID();
  await send(conv, a, cid, 'one');
  await assert.rejects(send(conv, a, cid, 'two'), { code: 'VC409' });
});

test('bị chặn hoặc không phải thành viên -> VC403, không tốn seq', async () => {
  const { a, b, conv } = await friendsWithConversation();
  await assert.rejects(send(conv, randomUUID(), randomUUID(), 'x'), { code: 'VC403' });
  await owner.query('INSERT INTO app.user_blocks VALUES ($1,$2)', [b, a]);
  await assert.rejects(send(conv, a, randomUUID(), 'x'), { code: 'VC403' });
  const { rows } = await owner.query('SELECT last_seq FROM app.conversations WHERE id=$1', [conv]);
  assert.equal(Number(rows[0].last_seq), 0);
});

test('change log đã dọn: cursor cũ -> VC410; cursor mới vẫn đọc được', async () => {
  const { a, conv } = await friendsWithConversation();
  for (let i = 0; i < 3; i++) await send(conv, a, randomUUID(), `m${i}`);
  await owner.query(`UPDATE app.conversation_changes SET changed_at = now() - interval '100 days'
                      WHERE conversation_id=$1 AND seq <= 2`, [conv]);
  await app.query(`SELECT app.prune_conversation_changes(interval '90 days')`);
  await assert.rejects(app.query('SELECT * FROM app.conversation_changes_since($1, 1, 100)', [conv]), { code: 'VC410' });
  const { rows } = await app.query('SELECT * FROM app.conversation_changes_since($1, 2, 100)', [conv]);
  assert.deepEqual(rows.map((r) => Number(r.seq)), [3]);
});

test('user change log đã dọn: cursor cũ -> VC410', async () => {
  const { a } = await friendsWithConversation();
  await owner.query(`UPDATE app.users SET change_seq = 2 WHERE id=$1`, [a]);
  await owner.query(`INSERT INTO app.user_changes (user_id, seq, entity_type, entity_id, kind, changed_at)
    VALUES ($1,1,'settings',$1,'upsert', now() - interval '100 days'), ($1,2,'settings',$1,'upsert', now())`, [a]);
  await app.query(`SELECT app.prune_user_changes(interval '90 days')`);
  await assert.rejects(app.query('SELECT * FROM app.user_changes_since($1, 0, 100)', [a]), { code: 'VC410' });
  const { rows } = await app.query('SELECT * FROM app.user_changes_since($1, 1, 100)', [a]);
  assert.equal(rows.length, 1);
});

test('job queue: SKIP LOCKED không nhận trùng; lease hết hạn thì nhận lại; quá max_attempts -> failed', async () => {
  await owner.query('DELETE FROM app.jobs');
  for (let i = 0; i < 10; i++)
    await app.query(`INSERT INTO app.jobs (id, kind, idempotency_key, max_attempts) VALUES ($1,'t',$2,2)
                     ON CONFLICT (idempotency_key) DO NOTHING`, [randomUUID(), `k${i}`]);
  // enqueue lặp idempotent
  await app.query(`INSERT INTO app.jobs (id, kind, idempotency_key) VALUES ($1,'t','k0') ON CONFLICT (idempotency_key) DO NOTHING`, [randomUUID()]);
  const batches = await Promise.all(Array.from({ length: 5 }, () =>
    app.query(`SELECT * FROM app.claim_jobs(4, interval '1 minute')`)));
  const ids = batches.flatMap((r) => r.rows.map((j) => j.id));
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids).size, 10);

  const job = batches.find((r) => r.rows.length).rows[0];
  // lease hết hạn -> worker khác nhận lại (attempt 2); lease cũ không complete được
  await owner.query(`UPDATE app.jobs SET locked_until = now() - interval '1 second' WHERE id=$1`, [job.id]);
  const again = (await app.query(`SELECT * FROM app.claim_jobs(10, interval '1 minute')`)).rows;
  assert.deepEqual(again.map((j) => j.id), [job.id]);
  assert.equal(again[0].attempts, 2);
  assert.equal((await app.query('SELECT app.complete_job($1,$2) ok', [job.id, job.lease_token])).rows[0].ok, false);
  // thất bại ở lần thử cuối -> failed
  await app.query('SELECT app.fail_job($1,$2,$3)', [job.id, again[0].lease_token, 'boom']);
  const { rows } = await owner.query('SELECT status FROM app.jobs WHERE id=$1', [job.id]);
  assert.equal(rows[0].status, 'failed');
});

test('role công khai (anon) không đọc được dữ liệu dù có GRANT: RLS chặn', async () => {
  const { conv } = await friendsWithConversation();
  await send(conv, (await owner.query('SELECT direct_user_low u FROM app.conversations WHERE id=$1', [conv])).rows[0].u, randomUUID(), 'secret');
  for (const t of ['users', 'messages', 'identities', 'refresh_tokens', 'devices']) {
    const { rows } = await anon.query(`SELECT count(*)::int n FROM app.${t}`);
    assert.equal(rows[0].n, 0, `anon thấy dữ liệu bảng ${t}`);
  }
  await assert.rejects(anon.query(`SELECT app.prune_audit_logs(interval '0')`), { code: '42501' });
  await assert.rejects(anon.query(`INSERT INTO app.feature_flags (name) VALUES ('x')`), { code: '42501' });
});

test('vchat_app: audit_logs append-only, có statement_timeout', async () => {
  await app.query(`INSERT INTO app.audit_logs (id, action) VALUES ($1,'t')`, [randomUUID()]);
  await assert.rejects(app.query('DELETE FROM app.audit_logs'), { code: '42501' });
  await assert.rejects(app.query('UPDATE app.audit_logs SET action = $1', ['x']), { code: '42501' });
  const { rows } = await app.query('SHOW statement_timeout');
  assert.equal(rows[0].statement_timeout, '5s');
});
