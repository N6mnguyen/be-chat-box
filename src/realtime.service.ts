import { Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Pool } from 'pg';
import { JWT_SECRET, PG_POOL } from './google-auth.service.js';

/**
 * Báo cho client "có thay đổi, hãy tải lại" qua Supabase Realtime Broadcast (HTTP, hợp serverless).
 * Payload rỗng: dữ liệu thật vẫn đi qua API có xác thực. Topic = HMAC(userId) nên không đoán được.
 */
@Injectable()
export class RealtimeService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(JWT_SECRET) private readonly secret: string,
  ) {}

  topic(userId: string): string {
    return `u-${createHmac('sha256', this.secret).update(`rt:${userId}`).digest('base64url').slice(0, 32)}`;
  }

  config(userId: string): { url: string; key: string; topic: string } | null {
    const { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key } = process.env;
    return url && key ? { url, key, topic: this.topic(userId) } : null;
  }

  /** Không bao giờ ném lỗi: realtime hỏng thì client vẫn còn poll dự phòng. */
  async notify(userIds: Iterable<string>): Promise<void> {
    const { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key } = process.env;
    const ids = [...new Set(userIds)];
    if (!url || !key || !ids.length) {
      return;
    }
    try {
      await fetch(`${url}/realtime/v1/api/broadcast`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: ids.map((id) => ({ topic: this.topic(id), event: 'changed', payload: {}, private: false })),
        }),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // bỏ qua
    }
  }

  /** Những user bị ảnh hưởng bởi một request ghi (ngoài chính người gọi). */
  async affectedUsers(params: Record<string, string>, body: unknown): Promise<string[]> {
    const out: string[] = [];
    try {
      if (params.conversationId) {
        const r = await this.pool.query<{ user_id: string }>(
          'SELECT user_id FROM app.conversation_members WHERE conversation_id = $1',
          [params.conversationId],
        );
        out.push(...r.rows.map((x) => x.user_id));
      }
      if (params.userId) {
        out.push(params.userId);
      }
      if (params.requestId) {
        const r = await this.pool.query<{ sender_id: string; recipient_id: string }>(
          'SELECT sender_id, recipient_id FROM app.friend_requests WHERE id = $1',
          [params.requestId],
        );
        out.push(...r.rows.flatMap((x) => [x.sender_id, x.recipient_id]));
      }
      const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      if (typeof b.peerId === 'string') {
        out.push(b.peerId);
      }
      if (typeof b.username === 'string') {
        const r = await this.pool.query<{ id: string }>('SELECT id FROM app.users WHERE username = $1', [b.username]);
        out.push(...r.rows.map((x) => x.id));
      }
    } catch {
      // bỏ qua
    }
    return out;
  }
}
