import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const requestId = this.requestId(request);
    let status = 500;
    let code = 'INTERNAL';
    let message = 'Đã xảy ra lỗi máy chủ.';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string') {
        code = body.code;
      } else if (status === 400) {
        code = 'VALIDATION_FAILED';
        message = 'Dữ liệu yêu cầu không hợp lệ.';
      } else if (status === 401) {
        code = 'UNAUTHENTICATED';
        message = 'Yêu cầu xác thực không hợp lệ.';
      } else if (status === 404) {
        code = 'NOT_FOUND';
        message = 'Không tìm thấy tài nguyên.';
      }

      if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string') {
        message = body.message;
      }
    } else {
      const databaseCode = databaseErrorCode(exception);
      if (databaseCode) {
        ({ status, code, message } = databaseCode);
      } else {
        const diagnostic = exception instanceof Error
          ? {
              name: exception.name,
              message: exception.message.replace(/[\r\n\t]/g, ' ').slice(0, 300),
            }
          : { name: 'UnknownError', message: 'Non-Error exception' };
        const databaseCodeValue = typeof exception === 'object' && exception !== null &&
          'code' in exception && typeof exception.code === 'string'
          ? exception.code
          : undefined;
        console.error(JSON.stringify({
          requestId,
          error: 'INTERNAL',
          ...diagnostic,
          ...(databaseCodeValue ? { databaseCode: databaseCodeValue } : {}),
        }));
      }
    }

    response.setHeader('X-Request-Id', requestId);
    response.status(status).json({ error: { code, message, requestId } });
  }

  private requestId(request: Request): string {
    const candidate = request.header('X-Request-Id');
    return candidate && /^[A-Za-z0-9._-]{1,64}$/.test(candidate) ? candidate : randomUUID();
  }
}

function databaseErrorCode(error: unknown): { status: number; code: string; message: string } | null {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') {
    return null;
  }
  switch (error.code) {
    case 'VC400':
      return { status: 400, code: 'VALIDATION_FAILED', message: 'Dữ liệu yêu cầu không hợp lệ.' };
    case 'VC403':
      return { status: 403, code: 'FORBIDDEN', message: 'Không có quyền thực hiện thao tác này.' };
    case 'VC404':
      return { status: 404, code: 'NOT_FOUND', message: 'Không tìm thấy tài nguyên.' };
    case 'VC409':
      return { status: 409, code: 'IDEMPOTENCY_CONFLICT', message: 'Yêu cầu gửi bị trùng với nội dung khác.' };
    case 'VC410':
      return { status: 410, code: 'SYNC_CURSOR_EXPIRED', message: 'Mốc đồng bộ đã hết hạn.' };
    case 'VC422':
      return { status: 422, code: 'INVALID_STATE', message: 'Thao tác không còn hợp lệ.' };
    case '23505':
      return { status: 409, code: 'CONFLICT', message: 'Dữ liệu đã tồn tại.' };
    default:
      return null;
  }
}
