import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { setup, teardown, h } from '../db/test/harness.js';
import { AuthenticatedRequest } from './app-jwt.guard.js';
import { VocabController } from './vocab.controller.js';

before(async () => {
  await setup();
  await h.owner.query(readFileSync(new URL('../db/migrations/20261110_vocab.sql', import.meta.url), 'utf8'));
  await h.owner.query(readFileSync(new URL('../db/migrations/20261110_nquizlet.sql', import.meta.url), 'utf8'));
}, { timeout: 120_000 });
after(teardown);

function request(userId: string): AuthenticatedRequest {
  return { userId } as AuthenticatedRequest;
}

test('creates one private NQuizlet study-result message per completed session', async () => {
  const userId = await h.activeUser(`v${randomUUID().slice(0, 8)}`);
  const sessionId = randomUUID();
  const topicId = 'a1000000-0000-4000-8000-000000000001';
  const { rows: words } = await h.owner.query(
    'SELECT id, word FROM app.vocab_words WHERE topic_id = $1 ORDER BY display_order LIMIT 1',
    [topicId],
  );
  const userAnswer = 'wrong-answer';

  await h.owner.query(
    `INSERT INTO app.vocab_study_sessions
       (id, user_id, topic_id, mode, word_count, score, total_questions, duration_sec, finished_at)
     VALUES ($1, $2, $3, 'fill_blank', 10, 8, 10, 95, now())`,
    [sessionId, userId, topicId],
  );
  await h.owner.query(
    `INSERT INTO app.vocab_session_answers
       (session_id, user_id, word_id, question_index, user_answer, is_correct)
     VALUES ($1, $2, $3, 1, $4, false)`,
    [sessionId, userId, words[0].id, userAnswer],
  );
  await h.owner.query(
    `INSERT INTO app.vocab_daily_stats (user_id, study_date, sessions, words, correct, total, minutes)
     VALUES ($1, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 1, 10, 8, 10, 1)`,
    [userId],
  );

  const controller = new VocabController(h.app);
  const first = await controller.sendStudyResult(request(userId), { sessionId });
  const retry = await controller.sendStudyResult(request(userId), { sessionId });
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.messageId, first.messageId);
  assert.equal(retry.conversationId, first.conversationId);

  const { rows: messages } = await h.owner.query(
    `SELECT m.sender_id, m.body, m.message_type, m.study_session_id, m.structured_payload,
            c.last_seq::text AS last_seq, cm.pinned_at
     FROM app.messages m
     JOIN app.conversations c ON c.id = m.conversation_id
     JOIN app.conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2
     WHERE m.study_session_id = $1`,
    [sessionId, userId],
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message_type, 'study_result');
  assert.equal(messages[0].study_session_id, sessionId);
  assert.equal(messages[0].body, first.fallbackText);
  assert.equal(Number(messages[0].last_seq), 1);
  assert.ok(messages[0].pinned_at);
  assert.equal(messages[0].structured_payload.wrongWords[0].userAnswer, userAnswer);
  assert.notEqual(messages[0].sender_id, userId);

  await assert.rejects(
    controller.sendStudyResult(request(randomUUID()), { sessionId }),
  );
});
