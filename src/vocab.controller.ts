import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Pool, QueryResultRow } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { AppJwtGuard, AuthenticatedRequest } from './app-jwt.guard.js';
import { PG_POOL } from './google-auth.service.js';
import { RealtimeInterceptor } from './realtime.interceptor.js';

interface VocabTopicRow extends QueryResultRow {
  id: string;
  slug: string;
  name: string;
  icon: string;
  description: string;
  word_count: number;
  mastered_count: number;
  learning_count: number;
}

interface StudyDayRow extends QueryResultRow {
  study_date: string;
  local_today: string;
}

interface VocabWordRow extends QueryResultRow {
  id: string;
  word: string;
  phonetic: string;
  part_of_speech: string;
  meaning_vi: string;
  example_en: string;
  example_vi: string;
  audio_url: string | null;
  alternative_answers: string[];
}

interface WrongWordRow extends VocabWordRow {
  user_answer: string;
}

@Controller('v1/vocab')
@UseGuards(AppJwtGuard)
export class VocabController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('overview')
  async getOverview(@Req() request: AuthenticatedRequest) {
    const [topicsResult, dueResult, daysResult] = await Promise.all([
      this.pool.query<VocabTopicRow>(
        `SELECT t.id, t.slug, t.name, t.icon, t.description,
                COUNT(w.id)::int AS word_count,
                COUNT(w.id) FILTER (WHERE p.status = 'mastered')::int AS mastered_count,
                COUNT(w.id) FILTER (WHERE p.status = 'learning')::int AS learning_count
         FROM app.vocab_topics t
         JOIN app.vocab_words w ON w.topic_id = t.id
         LEFT JOIN app.vocab_user_word_progress p
           ON p.word_id = w.id AND p.user_id = $1
         GROUP BY t.id
         ORDER BY t.display_order`,
        [request.userId],
      ),
      this.pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM app.vocab_user_word_progress
         WHERE user_id = $1 AND status <> 'new' AND next_review_at <= now()`,
        [request.userId],
      ),
      this.pool.query<StudyDayRow>(
        `SELECT d.study_date::text AS study_date,
                (now() AT TIME ZONE COALESCE(s.timezone, 'Asia/Ho_Chi_Minh'))::date::text AS local_today
         FROM app.vocab_daily_stats d
         LEFT JOIN app.vocab_user_settings s ON s.user_id = d.user_id
         WHERE d.user_id = $1
           AND d.study_date >=
             (now() AT TIME ZONE COALESCE(s.timezone, 'Asia/Ho_Chi_Minh'))::date - 365
         ORDER BY d.study_date DESC`,
        [request.userId],
      ),
    ]);

    const topics = topicsResult.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      icon: row.icon,
      description: row.description,
      wordCount: row.word_count,
      masteredCount: row.mastered_count,
      learningCount: row.learning_count,
      progressPercent: row.word_count === 0 ? 0 : Math.round((row.mastered_count / row.word_count) * 100),
    }));

    const today = daysResult.rows[0]?.local_today ?? localCalendarDate('Asia/Ho_Chi_Minh');
    const studyDays = new Set(daysResult.rows.map((row) => row.study_date));
    const streak = calculateStreak(studyDays, today);
    const continueTopic = [...topics]
      .filter((topic) => topic.learningCount > 0)
      .sort((left, right) => right.learningCount - left.learningCount)[0] ?? null;

    return {
      topics,
      summary: {
        streak,
        dueToday: dueResult.rows[0]?.count ?? 0,
        continueTopicId: continueTopic?.id ?? null,
      },
    };
  }

  @Post('sessions')
  async startSession(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = requestRecord(body);
    const wordCount = parseWordCount(input.wordCount);
    const mode = input.mode === 'flashcard' || input.mode === 'fill_blank' || input.mode === 'listen_fill'
      ? input.mode
      : null;
    if (!isUuid(input.topicId) || mode === null || wordCount === null) {
      throw validationError();
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const topic = await client.query<{ id: string; name: string }>(
        'SELECT id, name FROM app.vocab_topics WHERE id = $1',
        [input.topicId],
      );
      if (!topic.rowCount) {
        throw notFound();
      }

      const sessionId = randomUUID();
      const words = await client.query<VocabWordRow>(
        `SELECT w.id, w.word, w.phonetic, w.part_of_speech, w.meaning_vi,
                w.example_en, w.example_vi, w.audio_url, w.alternative_answers
         FROM app.vocab_words w
         LEFT JOIN app.vocab_user_word_progress p
           ON p.word_id = w.id AND p.user_id = $1
         WHERE w.topic_id = $2
         ORDER BY
           CASE WHEN p.next_review_at <= now() AND p.status <> 'new' THEN 0
                WHEN p.status = 'learning' THEN 1
                WHEN p.status IS NULL OR p.status = 'new' THEN 2
                ELSE 3 END,
           COALESCE(p.wrong_count, 0) DESC,
           w.display_order
         LIMIT $3`,
        [request.userId, input.topicId, wordCount],
      );
      if (words.rowCount !== wordCount) {
        throw apiError(HttpStatus.CONFLICT, 'INSUFFICIENT_WORDS', 'Chủ đề chưa có đủ từ cho bài học này.');
      }

      const created = await client.query<{ started_at: Date }>(
        `INSERT INTO app.vocab_study_sessions (id, user_id, topic_id, mode, word_count)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING started_at`,
        [sessionId, request.userId, input.topicId, mode, wordCount],
      );
      await client.query('COMMIT');
      return {
        sessionId,
        topicId: topic.rows[0].id,
        topic: topic.rows[0].name,
        mode,
        wordCount,
        startedAt: created.rows[0].started_at.toISOString(),
        words: words.rows.map((row) => ({
          id: row.id,
          word: row.word,
          phonetic: row.phonetic,
          partOfSpeech: row.part_of_speech,
          meaningVi: row.meaning_vi,
          exampleEn: row.example_en,
          exampleVi: row.example_vi,
          audioUrl: row.audio_url,
          alternativeAnswers: row.alternative_answers,
        })),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  @Post('sessions/:sessionId/answers')
  async saveAnswer(
    @Req() request: AuthenticatedRequest,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
  ) {
    const input = requestRecord(body);
    if (
      !isUuid(sessionId)
      || !isUuid(input.wordId)
      || !Number.isInteger(input.questionIndex)
      || (input.questionIndex as number) < 1
      || (input.questionIndex as number) > 1000
      || typeof input.isCorrect !== 'boolean'
      || typeof input.userAnswer !== 'string'
      || input.userAnswer.length > 500
      || (input.hintCount !== undefined
        && (!Number.isInteger(input.hintCount) || (input.hintCount as number) < 0 || (input.hintCount as number) > 20))
    ) {
      throw validationError();
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query<{ topic_id: string; word_count: number; finished_at: Date | null }>(
        `SELECT topic_id, word_count, finished_at
         FROM app.vocab_study_sessions
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [sessionId, request.userId],
      );
      if (!session.rowCount) {
        throw notFound();
      }
      if (session.rows[0].finished_at) {
        throw apiError(HttpStatus.CONFLICT, 'SESSION_FINISHED', 'Bài học này đã kết thúc.');
      }
      if ((input.questionIndex as number) > session.rows[0].word_count * 2) {
        throw validationError();
      }

      const duplicate = await client.query(
        `SELECT 1 FROM app.vocab_session_answers
         WHERE session_id = $1 AND question_index = $2`,
        [sessionId, input.questionIndex],
      );
      if (duplicate.rowCount) {
        await client.query('COMMIT');
        return { saved: true, duplicate: true };
      }

      const word = await client.query<{ word: string }>(
        'SELECT word FROM app.vocab_words WHERE id = $1 AND topic_id = $2',
        [input.wordId, session.rows[0].topic_id],
      );
      if (!word.rowCount) {
        throw validationError();
      }
      const hintCount = input.hintCount === undefined ? 0 : input.hintCount as number;
      if (hintCount > Array.from(word.rows[0].word).length) {
        throw validationError();
      }

      await client.query(
        `INSERT INTO app.vocab_session_answers
           (session_id, user_id, word_id, question_index, user_answer, is_correct, hint_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          sessionId,
          request.userId,
          input.wordId,
          input.questionIndex,
          input.userAnswer,
          input.isCorrect,
          hintCount,
        ],
      );
      await client.query(
        `INSERT INTO app.vocab_user_word_progress AS progress
           (user_id, word_id, status, correct_count, wrong_count,
            review_interval_days, last_reviewed_at, next_review_at)
         VALUES (
           $1, $2, 'learning',
           CASE WHEN $3 THEN 1 ELSE 0 END,
           CASE WHEN $3 THEN 0 ELSE 1 END,
           1, now(), now() + interval '1 day'
         )
         ON CONFLICT (user_id, word_id) DO UPDATE SET
           status = CASE
             WHEN $3 AND progress.correct_count >= 2
                    AND progress.review_interval_days >= 3
               THEN 'mastered'
             ELSE 'learning'
           END,
           correct_count = progress.correct_count + CASE WHEN $3 THEN 1 ELSE 0 END,
           wrong_count = progress.wrong_count + CASE WHEN $3 THEN 0 ELSE 1 END,
           review_interval_days = CASE
             WHEN NOT $3 THEN 1
             WHEN progress.review_interval_days = 0 THEN 1
             WHEN progress.review_interval_days = 1 THEN 3
             WHEN progress.review_interval_days < 7 THEN 7
             ELSE LEAST(progress.review_interval_days * 2, 30)
           END,
           last_reviewed_at = now(),
           next_review_at = now() + (
             CASE
               WHEN NOT $3 THEN 1
               WHEN progress.review_interval_days = 0 THEN 1
               WHEN progress.review_interval_days = 1 THEN 3
               WHEN progress.review_interval_days < 7 THEN 7
               ELSE LEAST(progress.review_interval_days * 2, 30)
             END * interval '1 day'
           ),
           updated_at = now()`,
        [request.userId, input.wordId, input.isCorrect],
      );

      await client.query('COMMIT');
      return { saved: true, duplicate: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  @Post('sessions/:sessionId/finish')
  async finishSession(@Req() request: AuthenticatedRequest, @Param('sessionId') sessionId: string) {
    if (!isUuid(sessionId)) {
      throw validationError();
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query<{
        topic_id: string;
        word_count: number;
        score: number;
        total_questions: number;
        mode: 'flashcard' | 'fill_blank' | 'listen_fill';
        duration_sec: number | null;
        started_at: Date;
        finished_at: Date | null;
      }>(
        `SELECT topic_id, word_count, score, total_questions, mode, duration_sec, started_at, finished_at
         FROM app.vocab_study_sessions
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [sessionId, request.userId],
      );
      if (!session.rowCount) {
        throw notFound();
      }

      let completed = session.rows[0];
      if (!completed.finished_at) {
        const answerCount = await client.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
           FROM app.vocab_session_answers
           WHERE session_id = $1 AND question_index BETWEEN 1 AND $2`,
          [sessionId, completed.word_count],
        );
        if (answerCount.rows[0].count !== completed.word_count) {
          throw apiError(HttpStatus.CONFLICT, 'SESSION_INCOMPLETE', 'Hãy hoàn thành tất cả thẻ trước khi kết thúc.');
        }

        const update = await client.query(
          `UPDATE app.vocab_study_sessions s
           SET score = (
                 SELECT COALESCE(SUM(
                   CASE WHEN a.is_correct
                     THEN GREATEST(0::numeric, 1 - a.hint_count * 0.1)
                     ELSE 0::numeric
                   END
                 ), 0)::numeric(5,2)
                 FROM app.vocab_session_answers a
                 WHERE a.session_id = s.id
                   AND a.question_index BETWEEN 1 AND s.word_count
                   AND a.is_correct
               ),
               total_questions = s.word_count,
               duration_sec = GREATEST(0, floor(EXTRACT(EPOCH FROM (now() - s.started_at)))::int),
               finished_at = now()
           WHERE s.id = $1 AND s.user_id = $2
           RETURNING s.topic_id, s.word_count, s.score, s.total_questions, s.mode, s.duration_sec, s.started_at, s.finished_at`,
          [sessionId, request.userId],
        );
        completed = update.rows[0];
        await client.query(
          `INSERT INTO app.vocab_daily_stats
             (user_id, study_date, sessions, words, correct, total, minutes)
           SELECT s.user_id,
                  (now() AT TIME ZONE COALESCE(settings.timezone, 'Asia/Ho_Chi_Minh'))::date,
                  1, s.word_count, s.score, s.total_questions, floor(s.duration_sec / 60.0)::int
           FROM app.vocab_study_sessions s
           LEFT JOIN app.vocab_user_settings settings ON settings.user_id = s.user_id
           WHERE s.id = $1
           ON CONFLICT (user_id, study_date) DO UPDATE SET
             sessions = app.vocab_daily_stats.sessions + EXCLUDED.sessions,
             words = app.vocab_daily_stats.words + EXCLUDED.words,
             correct = app.vocab_daily_stats.correct + EXCLUDED.correct,
             total = app.vocab_daily_stats.total + EXCLUDED.total,
             minutes = app.vocab_daily_stats.minutes + EXCLUDED.minutes`,
          [sessionId],
        );
      }

      const topic = await client.query<{ name: string }>(
        'SELECT name FROM app.vocab_topics WHERE id = $1',
        [completed.topic_id],
      );
      const wrongWords = await client.query<WrongWordRow>(
        `SELECT DISTINCT ON (w.id) w.id, w.word, w.phonetic, w.part_of_speech, w.meaning_vi,
                w.example_en, w.example_vi, w.audio_url, w.alternative_answers, a.user_answer
         FROM app.vocab_session_answers a
         JOIN app.vocab_words w ON w.id = a.word_id
         WHERE a.session_id = $1
           AND a.question_index BETWEEN 1 AND $2
           AND NOT a.is_correct
         ORDER BY w.id, a.question_index`,
        [sessionId, completed.word_count],
      );
      await client.query('COMMIT');
      return {
        sessionId,
        topic: topic.rows[0].name,
        mode: completed.mode,
        wordCount: completed.word_count,
        score: Number(completed.score),
        total: completed.total_questions,
        durationSec: completed.duration_sec ?? 0,
        wrongWords: wrongWords.rows.map((row) => ({
          id: row.id,
          word: row.word,
          phonetic: row.phonetic,
          partOfSpeech: row.part_of_speech,
          meaningVi: row.meaning_vi,
          exampleEn: row.example_en,
          exampleVi: row.example_vi,
          audioUrl: row.audio_url,
          alternativeAnswers: row.alternative_answers,
          userAnswer: row.user_answer,
        })),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  @Post('study-result')
  @UseInterceptors(RealtimeInterceptor)
  async sendStudyResult(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = requestRecord(body);
    if (!isUuid(input.sessionId)) {
      throw validationError();
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sessionResult = await client.query<{
        topic_id: string;
        topic: string;
        mode: 'flashcard' | 'fill_blank' | 'listen_fill';
        word_count: number;
        score: number;
        total_questions: number;
        duration_sec: number | null;
        finished_at: Date | null;
      }>(
        `SELECT s.topic_id, t.name AS topic, s.mode, s.word_count, s.score,
                s.total_questions, s.duration_sec, s.finished_at
         FROM app.vocab_study_sessions s
         JOIN app.vocab_topics t ON t.id = s.topic_id
         WHERE s.id = $1 AND s.user_id = $2
         FOR UPDATE OF s`,
        [input.sessionId, request.userId],
      );
      if (!sessionResult.rowCount) {
        throw notFound();
      }

      const existing = await client.query<{ conversation_id: string; id: string; fallback_text: string | null }>(
        `SELECT conversation_id, id, COALESCE(body, structured_payload->>'fallbackText') AS fallback_text
         FROM app.messages
         WHERE study_session_id = $1`,
        [input.sessionId],
      );
      if (existing.rowCount) {
        await client.query('COMMIT');
        return {
          conversationId: existing.rows[0].conversation_id,
          messageId: existing.rows[0].id,
          fallbackText: existing.rows[0].fallback_text,
          duplicate: true,
        };
      }

      const session = sessionResult.rows[0];
      if (!session.finished_at) {
        throw apiError(HttpStatus.CONFLICT, 'SESSION_NOT_FINISHED', 'Hãy hoàn thành bài học trước khi gửi kết quả.');
      }

      const wrongWords = await client.query<WrongWordRow>(
        `SELECT DISTINCT ON (w.id) w.id, w.word, w.phonetic, w.part_of_speech, w.meaning_vi,
                w.example_en, w.example_vi, w.audio_url, w.alternative_answers, a.user_answer
         FROM app.vocab_session_answers a
         JOIN app.vocab_words w ON w.id = a.word_id
         WHERE a.session_id = $1
           AND a.question_index BETWEEN 1 AND $2
           AND NOT a.is_correct
         ORDER BY w.id, a.question_index`,
        [input.sessionId, session.word_count],
      );
      const daysResult = await client.query<StudyDayRow>(
        `SELECT d.study_date::text AS study_date,
                (now() AT TIME ZONE COALESCE(s.timezone, 'Asia/Ho_Chi_Minh'))::date::text AS local_today
         FROM app.vocab_daily_stats d
         LEFT JOIN app.vocab_user_settings s ON s.user_id = d.user_id
         WHERE d.user_id = $1
           AND d.study_date >=
             (now() AT TIME ZONE COALESCE(s.timezone, 'Asia/Ho_Chi_Minh'))::date - 365
         ORDER BY d.study_date DESC`,
        [request.userId],
      );
      const today = daysResult.rows[0]?.local_today ?? localCalendarDate('Asia/Ho_Chi_Minh');
      const streak = calculateStreak(new Set(daysResult.rows.map((row) => row.study_date)), today);

      const bot = await client.query<{ id: string }>(
        `SELECT id FROM app.users
         WHERE username = 'nquizlet' AND is_bot = true AND status = 'active'`,
      );
      if (!bot.rowCount) {
        throw apiError(HttpStatus.SERVICE_UNAVAILABLE, 'BOT_UNAVAILABLE', 'Chưa thể gửi kết quả cho NQuizlet.');
      }
      const botId = bot.rows[0].id;
      await client.query(
        'SELECT pg_advisory_xact_lock(app.pair_lock_key($1::uuid, $2::uuid))',
        [request.userId, botId],
      );
      const blocked = await client.query(
        `SELECT 1 FROM app.user_blocks
         WHERE (blocker_id = $1 AND blocked_id = $2)
            OR (blocker_id = $2 AND blocked_id = $1)`,
        [request.userId, botId],
      );
      if (blocked.rowCount) {
        throw apiError(HttpStatus.FORBIDDEN, 'BOT_BLOCKED', 'Không thể gửi kết quả trong hội thoại NQuizlet.');
      }
      const conversation = await client.query<{ id: string }>(
        `INSERT INTO app.conversations (id, type, direct_user_low, direct_user_high)
         VALUES ($1, 'direct', LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid))
         ON CONFLICT (direct_user_low, direct_user_high) WHERE type = 'direct'
         DO UPDATE SET updated_at = app.conversations.updated_at
         RETURNING id`,
        [randomUUID(), request.userId, botId],
      );
      const conversationId = conversation.rows[0].id;
      await client.query(
        `INSERT INTO app.conversation_members (conversation_id, user_id, pinned_at)
         VALUES ($1, $2, now())
         ON CONFLICT (conversation_id, user_id) DO UPDATE SET hidden_at = NULL`,
        [conversationId, request.userId],
      );
      await client.query(
        `INSERT INTO app.conversation_members (conversation_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (conversation_id, user_id) DO UPDATE SET hidden_at = NULL`,
        [conversationId, botId],
      );

      const score = Number(session.score);
      const total = session.total_questions;
      const percent = total ? Math.round((score / total) * 100) : 0;
      const wrong = wrongWords.rows.map((row) => ({
        word: row.word,
        meaningVi: row.meaning_vi,
        correctAnswer: row.word,
        userAnswer: row.user_answer,
        exampleEn: row.example_en,
        audioUrl: row.audio_url,
      }));
      const botText = percent >= 80
        ? 'Làm tốt lắm! Bạn đang tiến bộ từng ngày. 🐵💙'
        : percent >= 50
          ? 'Bạn đã có nền tảng tốt rồi, mình cùng ôn thêm một chút nhé! 💪'
          : 'Đừng nản nhé! Mình đã lưu các từ cần ôn để bạn luyện lại. 🌱';
      const fallbackText =
        `Kết quả bài ${session.topic} – ${modeLabel(session.mode)} (${session.word_count} từ): ` +
        `${score}/${total} (${percent}%). Thời gian ${formatDuration(session.duration_sec ?? 0)}. ${botText}`;
      const structuredPayload = {
        sessionId: input.sessionId,
        topic: session.topic,
        mode: session.mode,
        wordCount: session.word_count,
        score,
        total,
        percent,
        durationSec: session.duration_sec ?? 0,
        streak,
        wrongWords: wrong,
        botText,
        fallbackText,
      };
      const requestHash = createHash('sha256')
        .update(JSON.stringify({ sessionId: input.sessionId, structuredPayload }))
        .digest();
      const sequence = await client.query<{ last_seq: string }>(
        `UPDATE app.conversations
         SET last_seq = last_seq + 1, updated_at = now()
         WHERE id = $1
         RETURNING last_seq::text`,
        [conversationId],
      );
      const seq = sequence.rows[0].last_seq;
      const messageId = randomUUID();
      await client.query(
        `INSERT INTO app.messages
           (id, conversation_id, sender_id, client_msg_id, request_hash,
            created_seq, latest_seq, body, message_type, structured_payload, study_session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 'study_result', $8, $9)`,
        [
          messageId,
          conversationId,
          botId,
          randomUUID(),
          requestHash,
          seq,
          fallbackText,
          structuredPayload,
          input.sessionId,
        ],
      );
      await client.query(
        `INSERT INTO app.conversation_changes (conversation_id, seq, message_id, kind)
         VALUES ($1, $2, $3, 'created')`,
        [conversationId, seq, messageId],
      );
      await client.query('COMMIT');
      return { conversationId, messageId, fallbackText, duplicate: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function requestRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validationError();
  }
  return value as Record<string, unknown>;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseWordCount(value: unknown): 10 | 15 | 30 | null {
  return value === 10 || value === 15 || value === 30 ? value : null;
}

function validationError(): HttpException {
  return apiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Dữ liệu yêu cầu không hợp lệ.');
}

function notFound(): HttpException {
  return apiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Không tìm thấy tài nguyên.');
}

function apiError(status: HttpStatus, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

function calculateStreak(studyDays: ReadonlySet<string>, today: string): number {
  const todayDate = new Date(`${today}T00:00:00.000Z`);
  const yesterday = new Date(todayDate.getTime() - 86_400_000).toISOString().slice(0, 10);
  let date = studyDays.has(today) ? todayDate : new Date(`${yesterday}T00:00:00.000Z`);
  if (!studyDays.has(date.toISOString().slice(0, 10))) {
    return 0;
  }

  let streak = 0;
  while (studyDays.has(date.toISOString().slice(0, 10))) {
    streak += 1;
    date = new Date(date.getTime() - 86_400_000);
  }
  return streak;
}

function localCalendarDate(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values['year']}-${values['month']}-${values['day']}`;
}

function modeLabel(mode: 'flashcard' | 'fill_blank' | 'listen_fill'): string {
  if (mode === 'fill_blank') {
    return 'Điền từ';
  }
  return mode === 'listen_fill' ? 'Nghe và điền từ' : 'Flashcard';
}

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)} phút ${seconds % 60} giây`;
}
