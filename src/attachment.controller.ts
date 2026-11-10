import {
  BadRequestException,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  Body,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AppJwtGuard, AuthenticatedRequest } from './app-jwt.guard.js';
import { AttachmentStorageService } from './attachment-storage.service.js';
import { PG_POOL } from './google-auth.service.js';

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_DOWNLOAD_URLS = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AttachmentRow {
  id: string;
  object_key: string;
  file_name: string;
  mime_type: string;
  byte_size: string;
  status: 'pending' | 'verifying' | 'ready' | 'rejected';
}

@Controller('v1/attachments')
@UseGuards(AppJwtGuard)
export class AttachmentController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly storage: AttachmentStorageService,
  ) {}

  @Post()
  async createUpload(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const payload = asRecord(body);
    const fileName = safeFileName(payload['fileName']);
    const mimeType = payload['mimeType'];
    const byteSize = payload['size'];
    const sha256 = payload['sha256'];
    if (
      !fileName ||
      typeof mimeType !== 'string' ||
      mimeType.length < 1 ||
      mimeType.length > 100 ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ||
      !Number.isSafeInteger(byteSize) ||
      (byteSize as number) < 1 ||
      (byteSize as number) > MAX_FILE_BYTES ||
      typeof sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(sha256)
    ) {
      throw new BadRequestException('Thông tin tệp không hợp lệ.');
    }

    const hash = Buffer.from(sha256, 'hex');
    const existing = await this.pool.query<AttachmentRow>(
      `SELECT id, object_key, file_name, mime_type, byte_size::text, status
       FROM app.attachments WHERE owner_id = $1 AND sha256 = $2`,
      [request.userId, hash],
    );
    if (existing.rowCount && existing.rows[0].status === 'ready') {
      const row = existing.rows[0];
      return {
        id: row.id,
        fileName: row.file_name,
        mimeType: row.mime_type,
        size: Number(row.byte_size),
        alreadyUploaded: true,
      };
    }

    let attachment: AttachmentRow;
    if (existing.rowCount) {
      attachment = existing.rows[0];
      await this.pool.query(
        `UPDATE app.attachments
         SET file_name = $3, mime_type = $4, byte_size = $5, status = 'pending', updated_at = now()
         WHERE id = $1 AND owner_id = $2`,
        [attachment.id, request.userId, fileName, mimeType, byteSize],
      );
    } else {
      const id = randomUUID();
      const objectKey = `${request.userId}/${id}`;
      const inserted = await this.pool.query<AttachmentRow>(
        `INSERT INTO app.attachments
           (id, owner_id, sha256, object_key, file_name, mime_type, byte_size, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         RETURNING id, object_key, file_name, mime_type, byte_size::text, status`,
        [id, request.userId, hash, objectKey, fileName, mimeType, byteSize],
      );
      attachment = inserted.rows[0];
    }

    const upload = await this.storage.createSignedUploadUrl(attachment.object_key);
    return {
      id: attachment.id,
      fileName,
      mimeType,
      size: byteSize,
      alreadyUploaded: false,
      uploadUrl: upload.url,
      uploadApiKey: upload.apiKey,
    };
  }

  @Post(':attachmentId/complete')
  @HttpCode(HttpStatus.OK)
  async completeUpload(
    @Req() request: AuthenticatedRequest,
    @Param('attachmentId') attachmentId: string,
  ) {
    requireUuid(attachmentId);
    const result = await this.pool.query<AttachmentRow>(
      `SELECT id, object_key, file_name, mime_type, byte_size::text, status
       FROM app.attachments WHERE id = $1 AND owner_id = $2`,
      [attachmentId, request.userId],
    );
    const attachment = result.rows[0];
    if (!attachment) {
      throw new NotFoundException('Không tìm thấy tệp.');
    }
    if (attachment.status === 'ready') {
      return { id: attachment.id, ready: true };
    }
    if (attachment.status !== 'pending') {
      throw new ConflictException('Tệp không ở trạng thái có thể hoàn tất.');
    }

    const actualSize = await this.storage.getObjectSize(attachment.object_key);
    if (actualSize !== Number(attachment.byte_size)) {
      await this.storage.removeObject(attachment.object_key);
      await this.pool.query(
        `UPDATE app.attachments SET status = 'rejected', updated_at = now() WHERE id = $1`,
        [attachment.id],
      );
      throw new BadRequestException('Kích thước tệp tải lên không khớp.');
    }

    await this.pool.query(
      `UPDATE app.attachments SET status = 'ready', updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND status = 'pending'`,
      [attachment.id, request.userId],
    );
    return { id: attachment.id, ready: true };
  }

  @Post('download-urls')
  async createDownloadUrls(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const payload = asRecord(body);
    const ids = payload['ids'];
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > MAX_DOWNLOAD_URLS ||
      ids.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id)) ||
      new Set(ids).size !== ids.length
    ) {
      throw new BadRequestException('Danh sách tệp không hợp lệ.');
    }

    const result = await this.pool.query<AttachmentRow>(
      `SELECT DISTINCT a.id, a.object_key, a.file_name, a.mime_type, a.byte_size::text, a.status
       FROM app.attachments a
       JOIN app.message_attachments ma ON ma.attachment_id = a.id
       JOIN app.messages m ON m.id = ma.message_id
       WHERE a.id = ANY($1::uuid[]) AND a.status = 'ready' AND m.body_deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM app.conversation_members cm
           WHERE cm.conversation_id = m.conversation_id AND cm.user_id = $2
         )
         AND NOT EXISTS (
           SELECT 1 FROM app.message_hidden_for hidden
           WHERE hidden.message_id = m.id AND hidden.user_id = $2
         )`,
      [ids, request.userId],
    );
    if (result.rowCount !== ids.length) {
      throw new NotFoundException('Không tìm thấy một hoặc nhiều tệp.');
    }

    const items = await Promise.all(result.rows.map(async (attachment) => ({
      id: attachment.id,
      url: await this.storage.createSignedDownloadUrl(attachment.object_key),
      downloadUrl: await this.storage.createSignedDownloadUrl(
        attachment.object_key,
        attachment.file_name,
      ),
    })));
    return { items };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException('Dữ liệu không hợp lệ.');
  }
  return value as Record<string, unknown>;
}

function safeFileName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const fileName = Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f || character === '/' || character === '\\'
        ? '_'
        : character;
    })
    .join('')
    .trim()
    .slice(0, 255);
  return fileName || null;
}

function requireUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new BadRequestException('Mã tệp không hợp lệ.');
  }
}
