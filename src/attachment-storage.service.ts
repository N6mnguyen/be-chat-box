import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SIGNED_URL_TTL_SECONDS = 60 * 60;

@Injectable()
export class AttachmentStorageService {
  private client: SupabaseClient | null = null;
  private bucketName = '';
  private publicKey = '';

  async createSignedUploadUrl(objectKey: string): Promise<{ url: string; apiKey: string }> {
    const { client, bucket } = this.getClient();
    const { data, error } = await client.storage
      .from(bucket)
      .createSignedUploadUrl(objectKey, { upsert: true });
    if (error) {
      throw new ServiceUnavailableException('Không tạo được liên kết tải tệp lên.');
    }
    return { url: data.signedUrl, apiKey: this.publicKey };
  }

  async getObjectSize(objectKey: string): Promise<number> {
    const { client, bucket } = this.getClient();
    const { data, error } = await client.storage.from(bucket).info(objectKey);
    if (error || data.size === undefined) {
      throw new ServiceUnavailableException('Không xác minh được tệp đã tải lên.');
    }
    return data.size;
  }

  async createSignedDownloadUrl(objectKey: string, fileName?: string): Promise<string> {
    const { client, bucket } = this.getClient();
    const { data, error } = await client.storage.from(bucket).createSignedUrl(
      objectKey,
      SIGNED_URL_TTL_SECONDS,
      fileName ? { download: fileName } : undefined,
    );
    if (error) {
      throw new ServiceUnavailableException('Không tạo được liên kết tải tệp xuống.');
    }
    return data.signedUrl;
  }

  async removeObject(objectKey: string): Promise<void> {
    const { client, bucket } = this.getClient();
    const { error } = await client.storage.from(bucket).remove([objectKey]);
    if (error) {
      throw new ServiceUnavailableException('Không thể xóa tệp khỏi nơi lưu trữ.');
    }
  }

  private getClient(): { client: SupabaseClient; bucket: string } {
    if (this.client) {
      return { client: this.client, bucket: this.bucketName };
    }

    const url = process.env.SUPABASE_URL?.trim();
    const serviceKey = (
      process.env.SUPABASE_SECRET_KEY?.trim() ||
      process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
    );
    const publicKey = (
      process.env.SUPABASE_PUBLISHABLE_KEY?.trim() ||
      process.env.SUPABASE_ANON_KEY?.trim()
    );
    const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || 'attachments';
    const missing: string[] = [];
    if (!url) {
      missing.push('SUPABASE_URL');
    }
    if (!serviceKey) {
      missing.push('SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)');
    }
    if (!publicKey) {
      missing.push('SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY)');
    }
    if (!url || !serviceKey || !publicKey) {
      throw new ServiceUnavailableException(
        `Chưa cấu hình nơi lưu trữ tệp. Thiếu: ${missing.join(', ')}.`,
      );
    }

    this.client = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    this.bucketName = bucket;
    this.publicKey = publicKey;
    return { client: this.client, bucket };
  }
}
