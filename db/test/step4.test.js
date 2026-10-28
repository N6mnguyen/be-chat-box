// Migration Bước 4: recall, reply, receipts, lời mời suppressed, block, reports, recovery codes.
// Dùng chung harness với db.test.js (tạo DB tạm riêng).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, teardown, h } from './harness.js';

before(setup, { timeout: 120_000 });
after(teardown);

test('recall: người gửi trong 24h -> seq mới, body null, kind recalled; lần 2 idempotent', async () => {
  const { a, conv } = await h.friendsWithConversation();
  const m = await h.send(conv, a, randomUUID(), 'oops');
  const r1 = await h.recall(conv, m.message_id, a);
  assert.deepEqual([Number(r1.seq), r1.already], [2, false]);
  const r2 = await h.recall(conv, m.message_id, a);
  assert.deepEqual([Number(r2.seq), r2.already], [2, true]);
  const { rows } = await h.owner.query('SELECT body, latest_seq, created_seq FROM app.messages WHERE id=$1', [m.message_id]);
  assert.deepEqual([rows[0].body, Number(rows[0].latest_seq), Number(rows[0].created_seq)], [null, 2, 1]);
  const ch = await h.app.query('SELECT kind FROM app.conversation_changes_since($1, 1, 10)', [conv]);
  assert.deepEqual(ch.rows.map((x) => x.kind), ['recalled']);
});

test('recall: người khác -> VC403; quá hạn -> VC422; không phải thành viên -> VC404; không tốn seq', async () => {
  const { a, b, conv } = await h.friendsWithConversation();
  const m = await h.send(conv, a, randomUUID(), 'x');
  await assert.rejects(h.recall(conv, m.message_id, b), { code: 'VC403' });
  await assert.rejects(h.recall(conv, m.message_id, randomUUID()), { code: 'VC404' });
  await h.owner.query(`UPDATE app.messages SET created_at = now() - interval '25 hours' WHERE id=$1`, [m.message_id]);
  await assert.rejects(h.recall(conv, m.message_id, a), { code: 'VC422' });
  const { rows } = await h.owner.query('SELECT last_seq FROM app.conversations WHERE id=$1', [conv]);
  assert.equal(Number(rows[0].last_seq), 1);
});

test('reply: cùng hội thoại, tin còn hiệu lực, không sao chép nội dung; sai -> VC400', async () => {
  const x = await h.friendsWithConversation();
  const y = await h.friendsWithConversation();
  const orig = await h.send(x.conv, x.a, randomUUID(), 'gốc');
  const rep = await h.send(x.conv, x.b, randomUUID(), 'trả lời', orig.message_id);
  const { rows } = await h.owner.query('SELECT reply_to_id, body FROM app.messages WHERE id=$1', [rep.message_id]);
  assert.deepEqual([rows[0].reply_to_id, rows[0].body], [orig.message_id, 'trả lời']);
  const other = await h.send(y.conv, y.a, randomUUID(), 'khác');
  await assert.rejects(h.send(x.conv, x.a, randomUUID(), 'r', other.message_id), { code: 'VC400' });
  await h.recall(x.conv, orig.message_id, x.a);
  await assert.rejects(h.send(x.conv, x.b, randomUUID(), 'r2', orig.message_id), { code: 'VC400' });
});

test('receipts chỉ tăng (GREATEST), kẹp <= last_seq', async () => {
  const { a, conv } = await h.friendsWithConversation();
  for (let i = 0; i < 3; i++) await h.send(conv, a, randomUUID(), `m${i}`);
  const upd = async (d, r) => {
    const { rows } = await h.app.query(
      `UPDATE app.conversation_members cm SET
         last_delivered_seq = greatest(cm.last_delivered_seq, least($3::bigint, c.last_seq)),
         last_read_seq      = greatest(cm.last_read_seq,      least($4::bigint, c.last_seq))
       FROM app.conversations c WHERE c.id = cm.conversation_id AND cm.conversation_id=$1 AND cm.user_id=$2
       RETURNING cm.last_delivered_seq d, cm.last_read_seq r`, [conv, a, d, r]);
    return [Number(rows[0].d), Number(rows[0].r)];
  };
  assert.deepEqual(await upd(2, 1), [2, 1]);
  assert.deepEqual(await upd(1, 0), [2, 1]);
  assert.deepEqual(await upd(99, 99), [3, 3]);
});

test('lời mời tới người đã chặn mình: suppressed; người nhận không thấy; người gửi thấy; bỏ chặn không đẩy', async () => {
  const sName = `s${randomUUID().slice(0, 8)}`, rName = `r${randomUUID().slice(0, 8)}`;
  const s = await h.activeUser(sName), r = await h.activeUser(rName);
  await h.tx((c) => c.query('SELECT app.block_user($1,$2)', [r, s]));
  assert.equal(await h.invite(s, rName), 'suppressed');
  const inbox = await h.app.query(
    `SELECT 1 FROM app.friend_requests WHERE recipient_id=$1 AND status='pending' AND NOT suppressed`, [r]);
  assert.equal(inbox.rows.length, 0);
  const out = await h.app.query(`SELECT suppressed FROM app.friend_requests WHERE sender_id=$1 AND status='pending'`, [s]);
  assert.equal(out.rows.length, 1);
  await h.app.query('DELETE FROM app.user_blocks WHERE blocker_id=$1 AND blocked_id=$2', [r, s]);
  const still = await h.app.query(`SELECT suppressed FROM app.friend_requests WHERE sender_id=$1 AND status='pending'`, [s]);
  assert.equal(still.rows[0].suppressed, true);
  assert.equal(await h.invite(s, rName), 'noop');
});

test('lời mời: discoverable=nobody -> suppressed; mời chéo -> kết bạn; không tồn tại -> noop', async () => {
  const aName = `a${randomUUID().slice(0, 8)}`, bName = `b${randomUUID().slice(0, 8)}`, hName = `h${randomUUID().slice(0, 8)}`;
  const a = await h.activeUser(aName), b = await h.activeUser(bName), x = await h.activeUser(hName);
  await h.owner.query(`UPDATE app.user_settings SET discoverable='nobody' WHERE user_id=$1`, [x]);
  assert.equal(await h.invite(a, hName), 'suppressed');
  assert.equal(await h.invite(a, bName), 'created');
  assert.equal(await h.invite(b, aName), 'auto_accepted');
  const [lo, hi] = [a, b].sort();
  const f = await h.app.query('SELECT 1 FROM app.friendships WHERE user_low=$1 AND user_high=$2', [lo, hi]);
  assert.equal(f.rows.length, 1);
  assert.equal(await h.invite(a, 'khong_ton_tai_xyz'), 'noop');
});

test('block: hủy bạn; gửi tin hai chiều sau đó -> VC403', async () => {
  const { a, b, conv } = await h.friendsWithConversation();
  await h.tx((c) => c.query('SELECT app.block_user($1,$2)', [a, b]));
  const [lo, hi] = [a, b].sort();
  const f = await h.app.query('SELECT 1 FROM app.friendships WHERE user_low=$1 AND user_high=$2', [lo, hi]);
  assert.equal(f.rows.length, 0);
  await assert.rejects(h.send(conv, b, randomUUID(), 'hi'), { code: 'VC403' });
  await assert.rejects(h.send(conv, a, randomUUID(), 'hi'), { code: 'VC403' });
});

test('reports: app ghi được nhưng không đọc được; snapshot gồm tin liền kề; idempotent; người ngoài -> VC404', async () => {
  const { a, b, conv } = await h.friendsWithConversation();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await h.send(conv, i % 2 ? a : b, randomUUID(), `m${i}`)).message_id);
  const rid = randomUUID();
  const rep = () => h.tx((c) => c.query(`SELECT app.create_report($1,$2,NULL,$3,'harassment',NULL,1)`, [rid, a, ids[2]]));
  await rep();
  await rep();
  await assert.rejects(h.tx((c) => c.query(`SELECT app.create_report($1,$2,NULL,$3,'spam',NULL,1)`,
    [randomUUID(), randomUUID(), ids[2]])), { code: 'VC404' });
  await assert.rejects(h.app.query('SELECT * FROM app.reports'), { code: '42501' });
  await assert.rejects(h.app.query(`INSERT INTO app.reports (id, reporter_id, target_user_id, reason)
    VALUES ($1,$2,$2,'spam')`, [randomUUID(), a]), { code: '42501' });
  const count = await h.owner.query('SELECT count(*)::int n FROM app.reports WHERE id=$1', [rid]);
  assert.equal(count.rows[0].n, 1);
  const { rows } = await h.owner.query('SELECT snapshot FROM app.reports WHERE id=$1', [rid]);
  assert.deepEqual(rows[0].snapshot.map((m) => m.body), ['m1', 'm2', 'm3']);
  const sender = (await h.owner.query('SELECT sender_id FROM app.messages WHERE id=$1', [ids[2]])).rows[0].sender_id;
  await h.recall(conv, ids[2], sender);
  const again = await h.owner.query('SELECT snapshot FROM app.reports WHERE id=$1', [rid]);
  assert.equal(again.rows[0].snapshot[1].body, 'm2'); // bản chụp không đổi sau thu hồi
});

test('recovery codes: bộ mới thay hoàn toàn bộ cũ', async () => {
  const u = await h.activeUser(`k${randomUUID().slice(0, 8)}`);
  const set = (n) => Array.from({ length: 10 }, (_, i) => h.hash(`${n}-${i}-${u}`));
  await h.tx((c) => c.query('SELECT app.replace_recovery_codes($1,$2,$3)', [u, set('a'), 'v1']));
  await h.tx((c) => c.query('SELECT app.replace_recovery_codes($1,$2,$3)', [u, set('b'), 'v1']));
  const { rows } = await h.owner.query('SELECT code_hash FROM app.recovery_codes WHERE user_id=$1', [u]);
  const fresh = new Set(set('b').map((x) => x.toString('hex')));
  assert.equal(rows.length, 10);
  assert.ok(rows.every((r) => fresh.has(r.code_hash.toString('hex'))));
});
