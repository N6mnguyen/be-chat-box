import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { mergeMap } from 'rxjs';
import type { AuthenticatedRequest } from './app-jwt.guard.js';
import { RealtimeService } from './realtime.service.js';

/** Sau mỗi request ghi thành công, ping những người liên quan. Phải await vì serverless đóng băng sau khi trả response. */
@Injectable()
export class RealtimeInterceptor implements NestInterceptor {
  constructor(@Inject(RealtimeService) private readonly realtime: RealtimeService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Receipts bị loại: client tải lại sẽ gửi receipts, ping lại sẽ tạo vòng lặp vô hạn.
    const skip = request.method === 'GET' || request.path.endsWith('/receipts');
    return next.handle().pipe(
      mergeMap(async (result) => {
        if (!skip) {
          const others = await this.realtime.affectedUsers(request.params as Record<string, string>, request.body);
          await this.realtime.notify([request.userId, ...others]);
        }
        return result;
      }),
    );
  }
}
