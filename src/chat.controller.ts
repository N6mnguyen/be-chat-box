import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, QueryResultRow } from 'pg';
import { AppJwtGuard, AuthenticatedRequest } from './app-jwt.guard.js';
import { PG_POOL } from './google-auth.service.js';

type JsonRecord = Record<string, unknown>;

interface ApiMessageRow extends QueryResultRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  client_msg_id: string;
  created_seq: string;
  latest_seq: string;
  body: string | null;
  body_deleted_at: Date | null;
  edited_at: Date | null;
  created_at: Date;
  updated_at: Date;
  sender_name: string;
  reply_to_id: string | null;
  reply_sender_id: string | null;
  reply_body: string | null;
  reply_deleted_at: Date | null;
  reply_hidden: boolean;
  reactions: Array<{ emoji: string; count: number; mine: boolean }> | null;
  delivery_status: 'sent' | 'delivered' | 'seen';
}

@Controller('v1')
@UseGuards(AppJwtGuard)
export class ChatController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  @Get('me')
  async getMe(@Req() request: AuthenticatedRequest) {
    const result = await this.pool.query(
      `SELECT u.id, u.username, u.display_name, u.status, u.deletion_due_at,
              u.profile_version, i.value AS email,
              s.new_device_otp, s.locale, s.notifications_enabled, s.discoverable,
              s.read_receipts, s.hide_online, s.version
       FROM app.users u
       JOIN app.identities i ON i.user_id = u.id AND i.type = 'email'
       JOIN app.user_settings s ON s.user_id = u.id
       WHERE u.id = $1 AND u.status IN ('active', 'deleting')`,
      [request.userId],
    );
    if (!result.rowCount) {
      throw apiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Không tìm thấy tài khoản.');
    }
    const row = result.rows[0];
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      status: row.status,
      deletionDueAt: iso(row.deletion_due_at),
      profileVersion: row.profile_version,
      settings: {
        newDeviceOtp: row.new_device_otp,
        locale: row.locale,
        notificationsEnabled: row.notifications_enabled,
        privacy: {
          discoverable: row.discoverable,
          readReceipts: row.read_receipts,
          hideOnline: row.hide_online,
        },
        version: row.version,
      },
    };
  }

  @Get('conversations')
  async listConversations(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    const limit = parseLimit(query.limit, 50, 100);
    const offset = decodeOffset(query.cursor);
    const result = await this.pool.query(
      `SELECT c.id, c.last_seq::text, c.created_at, cm.muted, cm.pinned_at,
              cm.last_delivered_seq::text, cm.last_read_seq::text,
              peer.id AS peer_id, peer.username AS peer_username,
              peer.display_name AS peer_display_name, peer.status AS peer_status,
              pcm.last_delivered_seq::text AS peer_delivered_seq,
              CASE WHEN ps.read_receipts THEN pcm.last_read_seq::text ELSE NULL END AS peer_read_seq,
              COALESCE(unread.total, 0)::int AS unread_count,
              lm.id AS last_id, lm.sender_id AS last_sender_id, lm.client_msg_id AS last_client_msg_id,
              lm.created_seq::text AS last_created_seq, lm.latest_seq::text AS last_latest_seq,
              lm.body AS last_body, lm.body_deleted_at AS last_deleted_at,
              lm.edited_at AS last_edited_at, lm.created_at AS last_created_at,
              lm.updated_at AS last_updated_at, lm.sender_name AS last_sender_name,
              lm.reply_to_id AS last_reply_to_id, lm.reply_sender_id AS last_reply_sender_id,
              lm.reply_body AS last_reply_body, lm.reply_deleted_at AS last_reply_deleted_at,
              lm.reply_hidden AS last_reply_hidden, lm.reactions AS last_reactions,
              lm.delivery_status AS last_delivery_status
       FROM app.conversation_members cm
       JOIN app.conversations c ON c.id = cm.conversation_id AND c.type = 'direct'
       LEFT JOIN app.users peer ON peer.id = CASE
         WHEN c.direct_user_low = cm.user_id THEN c.direct_user_high ELSE c.direct_user_low END
       LEFT JOIN app.conversation_members pcm ON pcm.conversation_id = c.id AND pcm.user_id <> cm.user_id
       LEFT JOIN app.user_settings ps ON ps.user_id = pcm.user_id
       LEFT JOIN LATERAL (
         SELECT count(*) AS total FROM app.messages um
         WHERE um.conversation_id = c.id AND um.sender_id <> cm.user_id
           AND um.created_seq > cm.last_read_seq AND um.body_deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM app.message_hidden_for uh
                           WHERE uh.message_id = um.id AND uh.user_id = cm.user_id)
       ) unread ON true
       LEFT JOIN LATERAL (${MESSAGE_SELECT}
         WHERE m.conversation_id = c.id
           AND NOT EXISTS (SELECT 1 FROM app.message_hidden_for hidden
                           WHERE hidden.message_id = m.id AND hidden.user_id = $1)
         ORDER BY m.created_seq DESC LIMIT 1) lm ON true
       WHERE cm.user_id = $1 AND cm.hidden_at IS NULL
       ORDER BY (cm.pinned_at IS NOT NULL) DESC, c.updated_at DESC, c.id
       OFFSET $2 LIMIT $4`,
      [request.userId, offset, request.userId, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map((row) => mapConversation(row, request.userId)),
      nextCursor: result.rows.length > limit ? encodeOffset(offset + limit) : null,
    };
  }

  @Post('conversations')
  @HttpCode(HttpStatus.OK)
  async createConversation(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const payload = record(body);
    if (payload.type === 'group') {
      throw apiError(HttpStatus.UNPROCESSABLE_ENTITY, 'GROUP_NOT_SUPPORTED', 'Hội thoại nhóm chưa được hỗ trợ.');
    }
    if (payload.type !== 'direct' || !isUuid(payload.peerId) || payload.peerId === request.userId) {
      throw validationError();
    }
    const client = await this.pool.connect();
    let conversationId: string;
    try {
      await client.query('BEGIN');
      const peerId = payload.peerId;
      await client.query(
        'SELECT pg_advisory_xact_lock(app.pair_lock_key($1::uuid, $2::uuid))',
        [request.userId, peerId],
      );
      const friendship = await client.query(
        `SELECT 1 FROM app.friendships
         WHERE user_low = LEAST($1::uuid, $2::uuid) AND user_high = GREATEST($1::uuid, $2::uuid)`,
        [request.userId, peerId],
      );
      if (!friendship.rowCount) {
        throw apiError(HttpStatus.FORBIDDEN, 'FRIENDSHIP_REQUIRED', 'Chỉ có thể nhắn tin với bạn bè.');
      }
      const blocked = await client.query(
        `SELECT 1 FROM app.user_blocks WHERE
           (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [request.userId, peerId],
      );
      if (blocked.rowCount) {
        throw apiError(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Không thể tạo hội thoại với tài khoản này.');
      }
      const created = await client.query<{ id: string }>(
        `INSERT INTO app.conversations (id, type, direct_user_low, direct_user_high)
         VALUES ($1, 'direct', LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid))
         ON CONFLICT (direct_user_low, direct_user_high) WHERE type = 'direct'
         DO UPDATE SET updated_at = app.conversations.updated_at
         RETURNING id`,
        [randomUUID(), request.userId, peerId],
      );
      conversationId = created.rows[0].id;
      await client.query(
        `INSERT INTO app.conversation_members (conversation_id, user_id)
         VALUES ($1, $2), ($1, $3)
         ON CONFLICT (conversation_id, user_id) DO UPDATE SET hidden_at = NULL`,
        [conversationId, request.userId, peerId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return this.getConversation(request.userId, conversationId);
  }

  @Get('conversations/:conversationId')
  async getConversationRoute(
    @Req() request: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
  ) {
    requireUuid(conversationId);
    return this.getConversation(request.userId, conversationId);
  }

  @Patch('conversations/:conversationId')
  async patchConversation(
    @Req() request: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    requireUuid(conversationId);
    const payload = record(body);
    const keys = Object.keys(payload);
    if (
      keys.length === 0 ||
      keys.some((key) => key !== 'pinned' && key !== 'muted') ||
      (payload.pinned !== undefined && typeof payload.pinned !== 'boolean') ||
      (payload.muted !== undefined && typeof payload.muted !== 'boolean')
    ) {
      throw validationError();
    }
    const result = await this.pool.query(
      `UPDATE app.conversation_members
       SET pinned_at = CASE WHEN $3::boolean IS NULL THEN pinned_at
                            WHEN $3::boolean THEN COALESCE(pinned_at, now()) ELSE NULL END,
           muted = COALESCE($4::boolean, muted)
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, request.userId, payload.pinned ?? null, payload.muted ?? null],
    );
    if (!result.rowCount) {
      throw notFound();
    }
    return this.getConversation(request.userId, conversationId);
  }

  @Get('conversations/:conversationId/messages')
  async getMessages(
    @Req() request: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Query() query: Record<string, unknown>,
  ) {
    requireUuid(conversationId);
    const member = await this.pool.query(
      'SELECT 1 FROM app.conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, request.userId],
    );
    if (!member.rowCount) {
      throw notFound();
    }
    const limit = parseLimit(query.limit, 50, 100);
    const beforeSeq = decodeMessageCursor(query.cursor);
    const result = await this.pool.query<ApiMessageRow>(
      `${MESSAGE_SELECT}
       WHERE m.conversation_id = $1 AND m.created_seq < COALESCE($2::bigint, 9223372036854775807)
         AND NOT EXISTS (SELECT 1 FROM app.message_hidden_for hidden
                         WHERE hidden.message_id = m.id AND hidden.user_id = $3)
       ORDER BY m.created_seq DESC LIMIT $4`,
      [conversationId, beforeSeq, request.userId, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map(mapMessage),
      nextCursor: result.rows.length > limit
        ? encodeMessageCursor(rows[rows.length - 1].created_seq)
        : null,
    };
  }

  @Post('conversations/:conversationId/messages')
  @HttpCode(HttpStatus.CREATED)
  async sendMessage(
    @Req() request: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    requireUuid(conversationId);
    const payload = record(body);
    if (
      !isUuid(payload.clientMsgId) ||
      typeof payload.body !== 'string' ||
      !payload.body.trim() ||
      payload.body.length > 10_000 ||
      (payload.replyToId !== null && payload.replyToId !== undefined && !isUuid(payload.replyToId)) ||
      (payload.attachments !== undefined && (!Array.isArray(payload.attachments) || payload.attachments.length > 0))
    ) {
      throw validationError();
    }
    const text = payload.body;
    const replyToId = typeof payload.replyToId === 'string' ? payload.replyToId : null;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ body: text, replyToId, attachments: [] }))
      .digest();
    const sent = await this.pool.query<{ message_id: string; duplicate: boolean }>(
      `SELECT message_id, duplicate FROM app.send_direct_message($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), conversationId, request.userId, payload.clientMsgId, requestHash, text, replyToId],
    );
    const message = await this.getMessage(request.userId, conversationId, sent.rows[0].message_id);
    return { message, duplicate: sent.rows[0].duplicate };
  }

  @Patch('conversations/:conversationId/messages/:messageId')
  async editMessage(
    @Req() request: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ) {
    requireUuid(conversationId);
    requireUuid(messageId);
    const payload = record(body);
    if (typeof payload.body !== 'string' || !payload.body.trim() || payload.body.length > 10_000) {
      throw validationError();
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const participants = await client.query<{ direct_user_low: string; direct_user_high: string }>(
        `SELECT c.direct_user_low, c.direct_user_high
         FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id
         WHERE m.id = $1 AND m.conversation_id = $2
           AND $3 IN (c.direct_user_low, c.direct_user_high)`,
        [messageId, conversationId, request.userId],
      );
      if (!participants.rowCount) {
        throw notFound();
      }
      await client.query(
        'SELECT pg_advisory_xact_lock(app.pair_lock_key($1::uuid, $2::uuid))',
        [participants.rows[0].direct_user_low, participants.rows[0].direct_user_high],
      );
      const current = await client.query(
        `SELECT m.sender_id, m.body_deleted_at, c.direct_user_low, c.direct_user_high
         FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id
         WHERE m.id = $1 AND m.conversation_id = $2 FOR UPDATE OF m, c`,
        [messageId, conversationId],
      );
      if (!current.rowCount || ![current.rows[0].direct_user_low, current.rows[0].direct_user_high].includes(request.userId)) {
        throw notFound();
      }
      if (current.rows[0].sender_id !== request.userId || current.rows[0].body_deleted_at) {
        throw apiError(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Không thể sửa tin nhắn này.');
      }
      const sequence = await client.query<{ last_seq: string }>(
        `UPDATE app.conversations SET last_seq = last_seq + 1, updated_at = now()
         WHERE id = $1 RETURNING last_seq::text`,
        [conversationId],
      );
      const seq = sequence.rows[0].last_seq;
      await client.query(
        `UPDATE app.messages SET body = $3, edited_at = now(), latest_seq = $4, updated_at = now()
         WHERE id = $1 AND conversation_id = $2`,
        [messageId, conversationId, payload.body.trim(), seq],
      );
      await client.query(
        `INSERT INTO app.conversation_changes (conversation_id, seq, message_id, kind)
         VALUES ($1, $2, $3, 'edited')`,
        [conversationId, seq, messageId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return this.getMessage(request.userId, conversationId, messageId);
  }

  @Post('conversations/:conversationId/messages/:messageId/recall')
  @HttpCode(HttpStatus.OK)
  async recallMessage(
    @Req() request: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ) {
    requireUuid(conversationId);
    requireUuid(messageId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT * FROM app.recall_message($1, $2, $3, interval '24 hours')`,
        [conversationId, messageId, request.userId],
      );
      await client.query('DELETE FROM app.message_reactions WHERE message_id = $1', [messageId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return this.getMessage(request.userId, conversationId, messageId);
  }

  @Post('conversations/:conversationId/messages/:messageId/hide')
  @HttpCode(HttpStatus.NO_CONTENT)
  async hideMessage(
    @Req() request: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ): Promise<void> {
    requireUuid(conversationId);
    requireUuid(messageId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO app.message_hidden_for (message_id, user_id)
         SELECT m.id, $3 FROM app.messages m
         JOIN app.conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $3
         WHERE m.id = $2 AND m.conversation_id = $1
         ON CONFLICT DO NOTHING`,
        [conversationId, messageId, request.userId],
      );
      if (!result.rowCount) {
        const exists = await client.query(
          `SELECT 1 FROM app.messages m
           JOIN app.conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $3
           WHERE m.id = $2 AND m.conversation_id = $1`,
          [conversationId, messageId, request.userId],
        );
        if (!exists.rowCount) {
          throw notFound();
        }
      } else {
        await client.query(
          `UPDATE app.users SET change_seq = change_seq + 1 WHERE id = $1`,
          [request.userId],
        );
        await client.query(
          `INSERT INTO app.user_changes (user_id, seq, entity_type, entity_id, kind)
           SELECT id, change_seq, 'message_visibility', $2, 'delete'
           FROM app.users WHERE id = $1`,
          [request.userId, messageId],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  @Post('conversations/:conversationId/messages/:messageId/reactions')
  async toggleReaction(
    @Req() request: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ) {
    requireUuid(conversationId);
    requireUuid(messageId);
    const payload = record(body);
    if (typeof payload.emoji !== 'string' || Array.from(payload.emoji).length < 1 || Array.from(payload.emoji).length > 8) {
      throw validationError();
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const membership = await client.query(
        `SELECT 1 FROM app.messages m JOIN app.conversation_members cm
       ON cm.conversation_id = m.conversation_id AND cm.user_id = $3
       WHERE m.id = $2 AND m.conversation_id = $1 AND m.body_deleted_at IS NULL
       FOR UPDATE OF m`,
        [conversationId, messageId, request.userId],
      );
      if (!membership.rowCount) {
        throw notFound();
      }
      const removed = await client.query(
        `DELETE FROM app.message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
        [messageId, request.userId, payload.emoji],
      );
      if (!removed.rowCount) {
        await client.query(
          `INSERT INTO app.message_reactions (message_id, user_id, emoji)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [messageId, request.userId, payload.emoji],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return this.getMessage(request.userId, conversationId, messageId);
  }

  @Put('conversations/:conversationId/receipts')
  async updateReceipts(
    @Req() request: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    requireUuid(conversationId);
    const payload = record(body);
    const deliveredSeq = parseSequence(payload.deliveredSeq);
    const readSeq = parseSequence(payload.readSeq);
    if (deliveredSeq === null && readSeq === null) {
      throw validationError();
    }
    const updated = await this.pool.query(
      `UPDATE app.conversation_members cm
       SET last_delivered_seq = CASE WHEN $3::bigint IS NULL THEN cm.last_delivered_seq
             ELSE GREATEST(cm.last_delivered_seq, LEAST($3::bigint, c.last_seq)) END,
           last_read_seq = CASE WHEN $4::bigint IS NULL OR NOT s.read_receipts THEN cm.last_read_seq
             ELSE GREATEST(cm.last_read_seq, LEAST($4::bigint, c.last_seq)) END
       FROM app.conversations c, app.user_settings s
       WHERE cm.conversation_id = $1 AND cm.user_id = $2 AND c.id = cm.conversation_id
         AND s.user_id = cm.user_id
       RETURNING cm.last_delivered_seq::text, cm.last_read_seq::text, cm.user_id`,
      [conversationId, request.userId, deliveredSeq, readSeq],
    );
    if (!updated.rowCount) {
      throw notFound();
    }
    return {
      conversationId,
      userId: request.userId,
      deliveredSeq: updated.rows[0].last_delivered_seq,
      readSeq: updated.rows[0].last_read_seq,
      updatedAt: new Date().toISOString(),
    };
  }

  @Get('users/by-username/:username')
  async findUser(@Req() request: AuthenticatedRequest, @Param('username') username: string) {
    if (!USERNAME_PATTERN.test(username)) {
      throw validationError();
    }
    const result = await this.pool.query(
      `SELECT u.id, u.username, u.display_name
       FROM app.users u JOIN app.user_settings s ON s.user_id = u.id
       WHERE u.username = lower($1) AND u.status = 'active' AND s.discoverable = 'everyone'
         AND NOT EXISTS (SELECT 1 FROM app.user_blocks b
                         WHERE (b.blocker_id = u.id AND b.blocked_id = $2)
                            OR (b.blocker_id = $2 AND b.blocked_id = u.id))`,
      [username, request.userId],
    );
    if (!result.rowCount) {
      throw notFound();
    }
    return publicUser(result.rows[0]);
  }

  @Get('users')
  async listDiscoverableUsers(
    @Req() request: AuthenticatedRequest,
    @Query() query: Record<string, unknown>,
  ) {
    const limit = parseLimit(query.limit, 30, 100);
    const offset = decodeOffset(query.cursor);
    const search = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
    if (query.q !== undefined && (typeof query.q !== 'string' || search.length < 2 || search.length > 80)) {
      throw validationError();
    }

    const result = await this.pool.query(
      `SELECT u.id, u.username, u.display_name
       FROM app.users u
       JOIN app.user_settings s ON s.user_id = u.id
       WHERE u.status = 'active' AND u.username IS NOT NULL
         AND u.id <> $1 AND s.discoverable = 'everyone'
         AND ($3::text = '' OR position($3::text in lower(u.username)) > 0
           OR position($3::text in lower(COALESCE(u.display_name, ''))) > 0)
         AND NOT EXISTS (
           SELECT 1 FROM app.user_blocks b
           WHERE (b.blocker_id = u.id AND b.blocked_id = $1)
              OR (b.blocker_id = $1 AND b.blocked_id = u.id)
         )
         AND NOT EXISTS (
           SELECT 1 FROM app.friendships f
           WHERE f.user_low = LEAST(u.id, $1::uuid) AND f.user_high = GREATEST(u.id, $1::uuid)
         )
         AND NOT EXISTS (
           SELECT 1 FROM app.friend_requests fr
           WHERE fr.status = 'pending' AND fr.expires_at > now()
             AND ((fr.sender_id = $1 AND fr.recipient_id = u.id)
               OR (fr.sender_id = u.id AND fr.recipient_id = $1))
         )
       ORDER BY lower(COALESCE(u.display_name, u.username)), u.username, u.id
       OFFSET $2 LIMIT $4`,
      [request.userId, offset, search, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map(publicUser),
      nextCursor: result.rows.length > limit ? encodeOffset(offset + limit) : null,
    };
  }

  @Post('friend-requests')
  @HttpCode(HttpStatus.ACCEPTED)
  async sendFriendRequest(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const payload = record(body);
    if (typeof payload.username !== 'string' || !USERNAME_PATTERN.test(payload.username)) {
      throw validationError();
    }
    const outcome = await this.pool.query<{ send_friend_request: string }>(
      `SELECT app.send_friend_request($1, $2, $3, interval '30 days')`,
      [randomUUID(), request.userId, payload.username],
    );
    if (outcome.rows[0].send_friend_request === 'auto_accepted') {
      await this.createDirectConversation(request.userId, payload.username);
    }
    return { accepted: true };
  }

  @Get('friend-requests/incoming')
  async incomingRequests(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    return this.friendRequestPage(request.userId, 'incoming', query);
  }

  @Get('friend-requests/outgoing')
  async outgoingRequests(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    return this.friendRequestPage(request.userId, 'outgoing', query);
  }

  @Post('friend-requests/:requestId/accept')
  @HttpCode(HttpStatus.OK)
  async acceptFriendRequest(
    @Req() request: AuthenticatedRequest,
    @Param('requestId') requestId: string,
  ) {
    requireUuid(requestId);
    const client = await this.pool.connect();
    let conversationId: string;
    try {
      await client.query('BEGIN');
      const participants = await client.query<{
        sender_id: string;
        recipient_id: string;
        status: string;
        suppressed: boolean;
        expires_at: Date;
      }>(
        `SELECT sender_id, recipient_id, status, suppressed, expires_at
         FROM app.friend_requests WHERE id = $1 AND recipient_id = $2`,
        [requestId, request.userId],
      );
      if (
        !participants.rowCount ||
        participants.rows[0].suppressed ||
        participants.rows[0].expires_at.getTime() <= Date.now() ||
        !['pending', 'accepted'].includes(participants.rows[0].status)
      ) {
        throw notFound();
      }
      if (participants.rows[0].status === 'accepted') {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM app.conversations
           WHERE type = 'direct'
             AND direct_user_low = LEAST($1::uuid, $2::uuid)
             AND direct_user_high = GREATEST($1::uuid, $2::uuid)`,
          [participants.rows[0].sender_id, participants.rows[0].recipient_id],
        );
        if (!existing.rowCount) {
          throw notFound();
        }
        conversationId = existing.rows[0].id;
        await client.query('COMMIT');
        return this.getConversation(request.userId, conversationId);
      }
      await client.query(
        `SELECT pg_advisory_xact_lock(app.pair_lock_key($1::uuid, $2::uuid))`,
        [participants.rows[0].sender_id, participants.rows[0].recipient_id],
      );
      const invite = await client.query<{ sender_id: string; recipient_id: string }>(
        `UPDATE app.friend_requests SET status = 'accepted', updated_at = now()
         WHERE id = $1 AND recipient_id = $2 AND status = 'pending'
           AND NOT suppressed AND expires_at > now()
         RETURNING sender_id, recipient_id`,
        [requestId, request.userId],
      );
      if (!invite.rowCount) {
        throw notFound();
      }
      const { sender_id: senderId, recipient_id: recipientId } = invite.rows[0];
      await client.query(
        `INSERT INTO app.friendships (user_low, user_high)
         VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))
         ON CONFLICT DO NOTHING`,
        [senderId, recipientId],
      );
      const conversation = await client.query<{ id: string }>(
        `INSERT INTO app.conversations (id, type, direct_user_low, direct_user_high)
         VALUES ($1, 'direct', LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid))
         ON CONFLICT (direct_user_low, direct_user_high) WHERE type = 'direct'
         DO UPDATE SET updated_at = app.conversations.updated_at
         RETURNING id`,
        [randomUUID(), senderId, recipientId],
      );
      conversationId = conversation.rows[0].id;
      await client.query(
        `INSERT INTO app.conversation_members (conversation_id, user_id)
         VALUES ($1, $2), ($1, $3)
         ON CONFLICT (conversation_id, user_id) DO UPDATE SET hidden_at = NULL`,
        [conversationId, senderId, recipientId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return this.getConversation(request.userId, conversationId);
  }

  @Post('friend-requests/:requestId/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  async declineFriendRequest(@Req() request: AuthenticatedRequest, @Param('requestId') requestId: string) {
    await this.updateFriendRequestStatus(requestId, request.userId, 'recipient_id', 'declined');
  }

  @Post('friend-requests/:requestId/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelFriendRequest(@Req() request: AuthenticatedRequest, @Param('requestId') requestId: string) {
    await this.updateFriendRequestStatus(requestId, request.userId, 'sender_id', 'cancelled');
  }

  @Get('friends')
  async listFriends(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    const limit = parseLimit(query.limit, 50, 100);
    const offset = decodeOffset(query.cursor);
    const result = await this.pool.query(
      `SELECT u.id, u.username, u.display_name, f.created_at
       FROM app.friendships f JOIN app.users u
         ON u.id = CASE WHEN f.user_low = $1 THEN f.user_high ELSE f.user_low END
       WHERE $1 IN (f.user_low, f.user_high) AND u.status = 'active'
       ORDER BY f.created_at DESC, u.id OFFSET $2 LIMIT $3`,
      [request.userId, offset, limit + 1],
    );
    return {
      items: result.rows.slice(0, limit).map((row) => ({
        user: publicUser(row),
        since: iso(row.created_at),
      })),
      nextCursor: result.rows.length > limit ? encodeOffset(offset + limit) : null,
    };
  }

  @Delete('friends/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeFriend(@Req() request: AuthenticatedRequest, @Param('userId') userId: string): Promise<void> {
    requireUuid(userId);
    if (userId === request.userId) {
      throw validationError();
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(app.pair_lock_key($1::uuid, $2::uuid))',
        [request.userId, userId],
      );
      const removed = await client.query(
        `DELETE FROM app.friendships
         WHERE user_low = LEAST($1::uuid, $2::uuid)
           AND user_high = GREATEST($1::uuid, $2::uuid)`,
        [request.userId, userId],
      );
      if (removed.rowCount) {
        await client.query(
          `UPDATE app.conversation_members cm SET hidden_at = now()
           FROM app.conversations c
           WHERE c.id = cm.conversation_id AND c.type = 'direct'
             AND c.direct_user_low = LEAST($1::uuid, $2::uuid)
             AND c.direct_user_high = GREATEST($1::uuid, $2::uuid)
             AND cm.user_id IN ($1, $2)`,
          [request.userId, userId],
        );
        await client.query(
          `WITH changed AS (
             UPDATE app.users SET change_seq = change_seq + 1
             WHERE id IN ($1, $2)
             RETURNING id, change_seq
           )
           INSERT INTO app.user_changes (user_id, seq, entity_type, entity_id, kind)
           SELECT id, change_seq, 'friendship',
                  CASE WHEN id = $1::uuid THEN $2::uuid ELSE $1::uuid END,
                  'delete'
           FROM changed`,
          [request.userId, userId],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async getConversation(userId: string, conversationId: string) {
    const result = await this.pool.query(
      `SELECT c.id, c.last_seq::text, c.created_at, cm.muted, cm.pinned_at,
              cm.last_delivered_seq::text, cm.last_read_seq::text,
              peer.id AS peer_id, peer.username AS peer_username,
              peer.display_name AS peer_display_name, peer.status AS peer_status,
              pcm.last_delivered_seq::text AS peer_delivered_seq,
              CASE WHEN ps.read_receipts THEN pcm.last_read_seq::text ELSE NULL END AS peer_read_seq,
              COALESCE(unread.total, 0)::int AS unread_count,
              lm.id AS last_id, lm.sender_id AS last_sender_id, lm.client_msg_id AS last_client_msg_id,
              lm.created_seq::text AS last_created_seq, lm.latest_seq::text AS last_latest_seq,
              lm.body AS last_body, lm.body_deleted_at AS last_deleted_at,
              lm.edited_at AS last_edited_at, lm.created_at AS last_created_at,
              lm.updated_at AS last_updated_at, lm.sender_name AS last_sender_name,
              lm.reply_to_id AS last_reply_to_id, lm.reply_sender_id AS last_reply_sender_id,
              lm.reply_body AS last_reply_body, lm.reply_deleted_at AS last_reply_deleted_at,
              lm.reply_hidden AS last_reply_hidden, lm.reactions AS last_reactions,
              lm.delivery_status AS last_delivery_status
       FROM app.conversation_members cm
       JOIN app.conversations c ON c.id = cm.conversation_id AND c.type = 'direct'
       LEFT JOIN app.users peer ON peer.id = CASE
         WHEN c.direct_user_low = cm.user_id THEN c.direct_user_high ELSE c.direct_user_low END
       LEFT JOIN app.conversation_members pcm ON pcm.conversation_id = c.id AND pcm.user_id <> cm.user_id
       LEFT JOIN app.user_settings ps ON ps.user_id = pcm.user_id
       LEFT JOIN LATERAL (
         SELECT count(*) AS total FROM app.messages um
         WHERE um.conversation_id = c.id AND um.sender_id <> cm.user_id
           AND um.created_seq > cm.last_read_seq AND um.body_deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM app.message_hidden_for uh
                           WHERE uh.message_id = um.id AND uh.user_id = cm.user_id)
       ) unread ON true
       LEFT JOIN LATERAL (${MESSAGE_SELECT}
         WHERE m.conversation_id = c.id
           AND NOT EXISTS (SELECT 1 FROM app.message_hidden_for hidden
                           WHERE hidden.message_id = m.id AND hidden.user_id = $1)
         ORDER BY m.created_seq DESC LIMIT 1) lm ON true
       WHERE cm.user_id = $1 AND c.id = $2 AND cm.hidden_at IS NULL`,
      [userId, conversationId, userId],
    );
    if (!result.rowCount) {
      throw notFound();
    }
    return mapConversation(result.rows[0], userId);
  }

  private async createDirectConversation(userId: string, username: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const peer = await client.query<{ id: string }>(
        `SELECT id FROM app.users WHERE username = lower($1) AND status = 'active'`,
        [username],
      );
      if (peer.rowCount) {
        await client.query(
          `SELECT pg_advisory_xact_lock(app.pair_lock_key($1::uuid, $2::uuid))`,
          [userId, peer.rows[0].id],
        );
        const available = await client.query(
          `SELECT 1 FROM app.friendships
           WHERE user_low = LEAST($1::uuid, $2::uuid) AND user_high = GREATEST($1::uuid, $2::uuid)
             AND NOT EXISTS (SELECT 1 FROM app.user_blocks
                             WHERE (blocker_id = $1 AND blocked_id = $2)
                                OR (blocker_id = $2 AND blocked_id = $1))`,
          [userId, peer.rows[0].id],
        );
        if (!available.rowCount) {
          await client.query('COMMIT');
          return;
        }
        const conversation = await client.query<{ id: string }>(
          `INSERT INTO app.conversations (id, type, direct_user_low, direct_user_high)
           VALUES ($1, 'direct', LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid))
           ON CONFLICT (direct_user_low, direct_user_high) WHERE type = 'direct'
           DO UPDATE SET updated_at = app.conversations.updated_at
           RETURNING id`,
          [randomUUID(), userId, peer.rows[0].id],
        );
        await client.query(
          `INSERT INTO app.conversation_members (conversation_id, user_id)
           VALUES ($1, $2), ($1, $3)
           ON CONFLICT (conversation_id, user_id) DO UPDATE SET hidden_at = NULL`,
          [conversation.rows[0].id, userId, peer.rows[0].id],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async getMessage(userId: string, conversationId: string, messageId: string) {
    const result = await this.pool.query<ApiMessageRow>(
      `${MESSAGE_SELECT}
       WHERE m.conversation_id = $1 AND m.id = $2
         AND EXISTS (SELECT 1 FROM app.conversation_members cm
                     WHERE cm.conversation_id = m.conversation_id AND cm.user_id = $3)`,
      [conversationId, messageId, userId],
    );
    if (!result.rowCount) {
      throw notFound();
    }
    return mapMessage(result.rows[0]);
  }

  private async friendRequestPage(
    userId: string,
    direction: 'incoming' | 'outgoing',
    query: Record<string, unknown>,
  ) {
    const limit = parseLimit(query.limit, 50, 100);
    const offset = decodeOffset(query.cursor);
    const owner = direction === 'incoming' ? 'recipient_id' : 'sender_id';
    const otherOwner = direction === 'incoming' ? 'sender_id' : 'recipient_id';
    const hiddenFilter = direction === 'incoming' ? 'AND NOT fr.suppressed' : 'AND NOT fr.suppressed';
    const result = await this.pool.query(
      `SELECT fr.id, fr.created_at, fr.expires_at,
              sender.id AS sender_id, sender.username AS sender_username, sender.display_name AS sender_name,
              recipient.id AS recipient_id, recipient.username AS recipient_username, recipient.display_name AS recipient_name
       FROM app.friend_requests fr
       JOIN app.users sender ON sender.id = fr.sender_id
       JOIN app.users recipient ON recipient.id = fr.recipient_id
       WHERE fr.${owner} = $1 AND fr.${otherOwner} <> $1 AND fr.status = 'pending'
         AND fr.expires_at > now() ${hiddenFilter}
       ORDER BY fr.created_at DESC, fr.id OFFSET $2 LIMIT $3`,
      [userId, offset, limit + 1],
    );
    return {
      items: result.rows.slice(0, limit).map((row) => ({
        id: row.id,
        sender: { id: row.sender_id, username: row.sender_username, displayName: row.sender_name },
        recipient: { id: row.recipient_id, username: row.recipient_username, displayName: row.recipient_name },
        status: 'pending',
        createdAt: iso(row.created_at),
        expiresAt: iso(row.expires_at),
      })),
      nextCursor: result.rows.length > limit ? encodeOffset(offset + limit) : null,
    };
  }

  private async updateFriendRequestStatus(
    requestId: string,
    userId: string,
    ownerColumn: 'sender_id' | 'recipient_id',
    status: 'declined' | 'cancelled',
  ): Promise<void> {
    requireUuid(requestId);
    const result = await this.pool.query(
      `UPDATE app.friend_requests SET status = $3, updated_at = now()
       WHERE id = $1 AND ${ownerColumn} = $2 AND status = 'pending'`,
      [requestId, userId, status],
    );
    if (!result.rowCount) {
      throw notFound();
    }
  }
}

const MESSAGE_SELECT = `
  SELECT m.id, m.conversation_id, m.sender_id, m.client_msg_id,
         m.created_seq::text, m.latest_seq::text, m.body, m.body_deleted_at,
         m.edited_at, m.created_at, m.updated_at,
         COALESCE(sender.display_name, sender.username, email.value, 'Tài khoản đã xóa') AS sender_name,
         m.reply_to_id, reply.sender_id AS reply_sender_id,
         CASE WHEN reply.body_deleted_at IS NULL AND NOT COALESCE(reply_hidden.hidden, false)
              THEN left(reply.body, 200) ELSE NULL END AS reply_body,
         reply.body_deleted_at AS reply_deleted_at,
         COALESCE(reply_hidden.hidden, false) AS reply_hidden,
         COALESCE(reaction_list.items, '[]'::jsonb) AS reactions,
         CASE WHEN m.sender_id = current_member.user_id THEN
           CASE WHEN COALESCE(peer_settings.read_receipts, false)
                      AND peer_member.last_read_seq >= m.created_seq THEN 'seen'
                WHEN peer_member.last_delivered_seq >= m.created_seq THEN 'delivered'
                ELSE 'sent' END
           ELSE 'seen' END AS delivery_status
  FROM app.messages m
  JOIN app.conversations c ON c.id = m.conversation_id
  JOIN app.conversation_members current_member
    ON current_member.conversation_id = m.conversation_id AND current_member.user_id = $3
  LEFT JOIN app.conversation_members peer_member
    ON peer_member.conversation_id = m.conversation_id AND peer_member.user_id <> $3
  LEFT JOIN app.user_settings peer_settings ON peer_settings.user_id = peer_member.user_id
  LEFT JOIN app.users sender ON sender.id = m.sender_id
  LEFT JOIN app.identities email ON email.user_id = sender.id AND email.type = 'email'
  LEFT JOIN app.messages reply ON reply.id = m.reply_to_id AND reply.conversation_id = m.conversation_id
  LEFT JOIN LATERAL (
    SELECT EXISTS (SELECT 1 FROM app.message_hidden_for h
                   WHERE h.message_id = reply.id AND h.user_id = $3) AS hidden
  ) reply_hidden ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'emoji', grouped.emoji, 'count', grouped.total, 'mine', grouped.mine
    ) ORDER BY grouped.emoji) AS items
    FROM (
      SELECT r.emoji, count(*)::int AS total,
             bool_or(r.user_id = $3) AS mine
      FROM app.message_reactions r
      WHERE r.message_id = m.id
      GROUP BY r.emoji
    ) grouped
  ) reaction_list ON true`;

function mapMessage(row: ApiMessageRow): JsonRecord {
  const deleted = row.body_deleted_at !== null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    clientMsgId: row.client_msg_id,
    createdSeq: row.created_seq,
    latestSeq: row.latest_seq,
    body: deleted ? null : row.body,
    deleted,
    replyTo: row.reply_to_id
      ? {
          id: row.reply_to_id,
          senderId: row.reply_sender_id,
          available: !row.reply_deleted_at && !row.reply_hidden && row.reply_body !== null,
          body: row.reply_body,
        }
      : null,
    attachments: [],
    reactions: row.reactions ?? [],
    status: row.delivery_status,
    editedAt: iso(row.edited_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapConversation(row: QueryResultRow, _userId: string): JsonRecord {
  const lastMessage = row.last_id
    ? mapMessage({
        id: row.last_id,
        conversation_id: row.id,
        sender_id: row.last_sender_id,
        client_msg_id: row.last_client_msg_id,
        created_seq: row.last_created_seq,
        latest_seq: row.last_latest_seq,
        body: row.last_body,
        body_deleted_at: row.last_deleted_at,
        edited_at: row.last_edited_at,
        created_at: row.last_created_at,
        updated_at: row.last_updated_at,
        sender_name: row.last_sender_name,
        reply_to_id: row.last_reply_to_id,
        reply_sender_id: row.last_reply_sender_id,
        reply_body: row.last_reply_body,
        reply_deleted_at: row.last_reply_deleted_at,
        reply_hidden: row.last_reply_hidden,
        reactions: row.last_reactions,
        delivery_status: row.last_delivery_status,
      } as ApiMessageRow)
    : null;
  const peerExists = row.peer_status && row.peer_status !== 'deleted';
  return {
    id: row.id,
    type: 'direct',
    peer: peerExists
      ? { id: row.peer_id, username: row.peer_username, displayName: row.peer_display_name }
      : null,
    peerDeleted: !peerExists,
    lastSeq: row.last_seq,
    lastDeliveredSeq: row.last_delivered_seq,
    lastReadSeq: row.last_read_seq,
    peerDeliveredSeq: row.peer_delivered_seq,
    peerReadSeq: row.peer_read_seq,
    unreadCount: row.unread_count,
    lastMessage,
    pinned: row.pinned_at !== null,
    muted: row.muted,
    createdAt: iso(row.created_at),
  };
}

function publicUser(row: QueryResultRow) {
  return { id: row.id, username: row.username, displayName: row.display_name };
}

function record(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validationError();
  }
  return value as JsonRecord;
}

function parseLimit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw validationError();
  }
  return parsed;
}

function decodeOffset(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== 'string' || value.length > 64) {
    throw validationError();
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { offset?: unknown };
    if (!Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0) {
      throw validationError();
    }
    return parsed.offset as number;
  } catch {
    throw validationError();
  }
}

function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

function decodeMessageCursor(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || value.length > 128) {
    throw validationError();
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { seq?: unknown };
    const seq = parseSequence(parsed.seq);
    if (seq === null) {
      throw validationError();
    }
    return seq;
  } catch {
    throw validationError();
  }
}

function encodeMessageCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ seq })).toString('base64url');
}

function parseSequence(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  const parsed = typeof value === 'number' ? String(value) : value;
  return typeof parsed === 'string' && /^(0|[1-9]\d{0,18})$/.test(parsed) ? parsed : null;
}

function requireUuid(value: string): void {
  if (!isUuid(value)) {
    throw validationError();
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const USERNAME_PATTERN = /^[a-z0-9_][a-z0-9_.]{1,28}[a-z0-9_]$/;

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function validationError(): HttpException {
  return apiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Dữ liệu yêu cầu không hợp lệ.');
}

function notFound(): HttpException {
  return apiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Không tìm thấy tài nguyên.');
}

function apiError(status: number, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}
