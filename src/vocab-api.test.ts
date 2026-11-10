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
  await h.owner.query(readFileSync(new URL('../db/migrations/20261110_toeic_business_topics.sql', import.meta.url), 'utf8'));
  await h.owner.query(readFileSync(new URL('../db/migrations/20261110_toeic_topics_catalog.sql', import.meta.url), 'utf8'));
  await h.owner.query(readFileSync(new URL('../db/migrations/20261110_nquizlet.sql', import.meta.url), 'utf8'));
  await h.owner.query(readFileSync(new URL('../db/migrations/20261110_chinese_vocab.sql', import.meta.url), 'utf8'));
}, { timeout: 120_000 });
after(teardown);

function request(userId: string): AuthenticatedRequest {
  return { userId } as AuthenticatedRequest;
}

test('seeds five repeatable TOEIC business topics with thirty original words each', async () => {
  await h.owner.query(readFileSync(new URL('../db/migrations/20261110_toeic_topics_catalog.sql', import.meta.url), 'utf8'));
  const { rows } = await h.owner.query(
    `SELECT t.slug, COUNT(w.id)::int AS word_count
     FROM app.vocab_topics t
     LEFT JOIN app.vocab_words w ON w.topic_id = t.id
     WHERE t.slug = ANY($1::text[])
     GROUP BY t.slug, t.display_order
     ORDER BY t.display_order`,
    [['contracts', 'marketing', 'warranties', 'planning', 'conferences']],
  );
  assert.deepEqual(rows, [
    { slug: 'contracts', word_count: 30 },
    { slug: 'marketing', word_count: 30 },
    { slug: 'warranties', word_count: 30 },
    { slug: 'planning', word_count: 30 },
    { slug: 'conferences', word_count: 30 },
  ]);
});

test('returns the seeded TOEIC topics and per-topic review counts', async () => {
  const userId = await h.activeUser(`v${randomUUID().slice(0, 8)}`);
  const controller = new VocabController(h.app);
  const overview = await controller.getOverview(request(userId));

  assert.ok(overview.topics.length >= 50);
  assert.ok(overview.topics.every((topic) => topic.wordCount >= 30));
  assert.equal(overview.topics.filter((topic) => topic.groupSlug !== 'legacy').length, 50);
  assert.ok(overview.topics.every((topic) => topic.dueCount === 0));
  assert.equal(overview.summary.dueToday, 0);
});

test('continues the latest lesson for the authenticated user and language', async () => {
  const userId = await h.activeUser(`v${randomUUID().slice(0, 8)}`);
  const otherUserId = await h.activeUser(`v${randomUUID().slice(0, 8)}`);
  const firstTopicId = 'a1000000-0000-4000-8000-000000000001';
  const latestTopicId = 'a1000000-0000-4000-8000-000000000002';
  await h.owner.query(
    `INSERT INTO app.vocab_study_sessions (user_id, topic_id, mode, word_count, started_at)
     VALUES
       ($1, $2, 'flashcard', 10, now() - interval '1 day'),
       ($1, $3, 'listen_fill', 15, now() - interval '1 hour'),
       ($4, $2, 'fill_blank', 30, now())`,
    [userId, firstTopicId, latestTopicId, otherUserId],
  );

  const overview = await new VocabController(h.app).getOverview(request(userId));
  assert.equal(overview.summary.continueTopicId, latestTopicId);
  assert.deepEqual(overview.summary.continueLesson, {
    topicId: latestTopicId,
    mode: 'listen_fill',
    wordCount: 15,
  });
  assert.equal(overview.topics.find((topic) => topic.id === latestTopicId)?.language, 'en');
});

test('seeds all HSK topic groups and grammar courses separately from English', async () => {
  const migration = readFileSync(new URL('../db/migrations/20261110_chinese_vocab.sql', import.meta.url), 'utf8');
  await h.owner.query(migration);
  await h.owner.query(migration);
  const userId = await h.activeUser(`v${randomUUID().slice(0, 8)}`);
  const controller = new VocabController(h.app);
  const overview = await controller.getOverview(request(userId), 'zh');
  const grammar = await controller.getGrammar('zh');
  const englishOverview = await controller.getOverview(request(userId));
  const topic = overview.topics.find((item) => item.slug === 'hsk1-greetings');
  assert.ok(topic);
  const session = await controller.startSession(request(userId), {
    topicId: topic.id,
    wordCount: 10,
    mode: 'fill_blank',
  });

  assert.equal(overview.topics.length, 70);
  assert.ok(overview.topics.every((topic) => topic.wordCount >= 30));
  assert.ok(overview.topics.every((topic) => topic.wordCount <= 31));
  assert.deepEqual(
    [...new Set(overview.topics.map((topic) => topic.levelSlug))],
    ['hsk1', 'hsk2', 'hsk3', 'hsk4', 'hsk5', 'hsk6', 'hsk7-9'],
  );
  assert.equal(grammar.courses.length, 7);
  assert.equal(grammar.courses.find((course) => course.level === 'hsk7-9')?.title, 'Ngữ pháp và kỹ năng HSK 7–9');
  assert.ok(englishOverview.topics.every((topic) => topic.language === 'en'));
  assert.ok(overview.topics.every((topic) => topic.language === 'zh'));
  assert.equal(session.language, 'zh');
  assert.equal(session.level, 'hsk1');
  assert.equal(session.words.length, 10);
  assert.ok(session.words.every((word) => word.exampleTarget.includes('我今天学会了')));
  await assert.rejects(controller.getGrammar('zh', 'hsk10'));
  await assert.rejects(controller.getOverview(request(userId), 'ja'));
});

test('returns a Chinese text-to-speech URL for pronunciation requests', async () => {
  const controller = new VocabController(h.app);
  const result = controller.getPronunciation({ text: '你好' });
  assert.match(result.audioUrl, /^https:\/\/translate\.google\.com\/translate_tts\?/);
  assert.match(result.audioUrl, /tl=zh-CN/);
  assert.match(result.audioUrl, /q=.+/);
  assert.throws(() => controller.getPronunciation({ text: ' ' }));
  assert.throws(() => controller.getPronunciation({ text: '好'.repeat(201) }));
});

test('streams proxied Chinese pronunciation as audio/mpeg', async () => {
  const controller = new VocabController(h.app);
  const originalFetch = globalThis.fetch;
  const audioBytes = new Uint8Array([0xff, 0xfb, 0x90]);
  let statusCode = 0;
  let contentType = '';
  let sent: Buffer | undefined;
  globalThis.fetch = async () => new Response(audioBytes, {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
  });
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    type(value: string) {
      contentType = value;
      return this;
    },
    set() {
      return this;
    },
    send(value: Buffer) {
      sent = value;
      return this;
    },
  } as unknown as Parameters<VocabController['getPronunciationAudio']>[1];

  try {
    await controller.getPronunciationAudio({ text: '你好' }, response);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(statusCode, 200);
  assert.equal(contentType, 'audio/mpeg');
  assert.deepEqual(sent, Buffer.from(audioBytes));
});

test('returns private daily statistics for the selected 7, 14, or 30 day range', async () => {
  const userId = await h.activeUser(`v${randomUUID().slice(0, 8)}`);
  await h.owner.query(
    `INSERT INTO app.vocab_daily_stats (user_id, study_date, sessions, words, correct, total, minutes)
     VALUES
       ($1, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 2, 20, 16, 20, 12),
       ($1, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 7, 1, 10, 5, 10, 6)`,
    [userId],
  );
  await h.owner.query(
    `INSERT INTO app.vocab_daily_stats
       (user_id, study_date, language, sessions, words, correct, total, minutes)
     VALUES ($1, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'zh', 1, 4, 3, 4, 2)`,
    [userId],
  );
  const controller = new VocabController(h.app);

  const stats = await controller.getStats(request(userId), '7');
  assert.equal(stats.days, 7);
  assert.equal(stats.daily.length, 7);
  assert.equal(stats.daily.at(-1)?.wordsStudied, 20);
  assert.equal(stats.summary.totalWords, 20);
  assert.equal(stats.summary.avgScore, 80);
  assert.equal(stats.summary.deltaVsPreviousPercent, 100);
  assert.equal(stats.language, 'en');
  assert.deepEqual(stats.topWrongWords, []);
  const chineseStats = await controller.getStats(request(userId), '7', 'zh');
  assert.equal(chineseStats.summary.totalWords, 4);
  assert.equal(chineseStats.summary.avgScore, 75);
  assert.equal(chineseStats.language, 'zh');
  const otherUserStats = await controller.getStats(request(randomUUID()), '7');
  assert.equal(otherUserStats.summary.totalWords, 0);
  assert.deepEqual(otherUserStats.topWrongWords, []);

  for (const days of ['14', '30']) {
    const ranged = await controller.getStats(request(userId), days);
    assert.equal(ranged.daily.length, Number(days));
  }
  await assert.rejects(controller.getStats(request(userId), '90'));
});

test('returns only the authenticated user’s incorrect words answered today', async () => {
  const userId = await h.activeUser(`v${randomUUID().slice(0, 8)}`);
  const sessionId = randomUUID();
  const topicId = 'a1000000-0000-4000-8000-000000000001';
  const { rows: words } = await h.owner.query(
    'SELECT id, word FROM app.vocab_words WHERE topic_id = $1 ORDER BY display_order LIMIT 2',
    [topicId],
  );
  await h.owner.query(
    `INSERT INTO app.vocab_study_sessions
       (id, user_id, topic_id, mode, word_count, score, total_questions, duration_sec, finished_at)
     VALUES ($1, $2, $3, 'fill_blank', 10, 8, 10, 60, now())`,
    [sessionId, userId, topicId],
  );
  await h.owner.query(
    `INSERT INTO app.vocab_session_answers
       (session_id, user_id, word_id, question_index, user_answer, is_correct, answered_at)
     VALUES
       ($1, $2, $3, 1, 'incorrect one', false, now()),
       ($1, $2, $4, 2, 'incorrect two', false, now())`,
    [sessionId, userId, words[0].id, words[1].id],
  );

  const controller = new VocabController(h.app);
  const ownWords = await controller.getWrongReview(request(userId));
  assert.equal(ownWords.words.length, 2);
  assert.deepEqual(new Set(ownWords.words.map((word) => word.id)), new Set(words.map((word) => word.id)));
  assert.ok(ownWords.words.every((word) => word.topicId === topicId && word.userAnswer.startsWith('incorrect')));

  const otherUserWords = await controller.getWrongReview(request(await h.activeUser(`v${randomUUID().slice(0, 8)}`)));
  assert.deepEqual(otherUserWords.words, []);
  const chineseWords = await controller.getWrongReview(request(userId), 'zh');
  assert.deepEqual(chineseWords.words, []);
});

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
