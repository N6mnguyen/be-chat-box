# Bước 2 — Kiến trúc (đã xác nhận, cập nhật)

## 2.1 Thành phần và triển khai

```mermaid
flowchart LR
  subgraph Desktop["Desktop"]
    UI["Angular + Dexie"] <-->|IPC| MAIN["Electron main + safeStorage<br/>Upload/download presigned"]
  end
  UI -->|HTTPS/WSS| LB["TLS + WS upgrade"]
  LB --> APP["NestJS APP_ROLE=all<br/>REST + Socket.IO + jobs"]
  APP --> PG[("PostgreSQL<br/>source of truth + jobs")]
  APP --> MEM["PresenceStore + RateLimitStore<br/>in-memory (1 process)"]
  APP --> S3[("Private object storage<br/>S3 compatible")]
  MAIN -->|presigned PUT/GET| S3
  APP --> MAIL["Mail provider<br/>SPF/DKIM/DMARC"]
  PAY["Payment provider (later)"] -->|signed webhook| LB
  SEC["Secret store<br/>JWT keys + versioned peppers"] -.-> APP
  APP -.-> OBS["Metrics + redacted logs"]

  APP -.->|"scale: APP_ROLE=api / worker"| SPLIT["N API + M worker<br/>same image"]
  SPLIT -.-> REDIS[("Redis: Socket.IO adapter,<br/>PresenceStore, RateLimitStore,<br/>revocation fan-out")]
  SPLIT --> PG
```

- **D10:** MVP chỉ một tiến trình, presence/typing có TTL trong bộ nhớ qua `PresenceStore`; rate limits và token revocation dùng store trong bộ nhớ. Khi >1 tiến trình, thay các store + Socket.IO adapter bằng Redis. Restart làm mất presence và bộ đếm tạm; token được kiểm tra trạng thái `devices.revoked_at`/`users.status` trong Postgres ở mỗi thao tác nhạy cảm và khi WS xác thực lại.
- **D13:** Một image: MVP `APP_ROLE=all` (REST, WS, xử lý job trong cùng tiến trình); sau tách `APP_ROLE=api|worker`. Job bền nằm trong bảng Postgres, lấy bằng `FOR UPDATE SKIP LOCKED`, **không dùng BullMQ khi chưa có Redis** (D14). Khi scale nhiều API instance, cần Redis; vẫn có thể giữ hàng đợi Postgres. `APP_ROLE=migrate` **chỉ chạy một lần** như bước deploy riêng trước khi khởi động phiên bản mới; không cho từng replica tự migrate. Migration dùng `DIRECT_URL` session pooler hoặc kết nối trực tiếp; runtime dùng `DATABASE_URL` transaction pooler, không dùng session locks/prepared statements.
- **D11:** Room Socket.IO `user:<userId>` và `device:<deviceId>`; fan-out 1-1 gửi cho hai user rooms. WS handshake kiểm JWT, trạng thái user/device. Hết hạn access token: server yêu cầu `auth:refresh`, cho thời gian ngắn rồi chủ động ngắt nếu không xác thực lại; client lấy access token mới qua REST và gửi lại. Logout từ xa/reset mật khẩu: ngắt socket ngay; kể cả bỏ lỡ sự kiện ngắt, server kiểm trạng thái device trước mọi write và ở lần re-auth. Khi có nhóm đông sau MVP, phát theo từng user room tốn O(thành viên); lúc đó cân nhắc room theo hội thoại và giới hạn kích thước nhóm.
- **D12:** Electron **main process** gọi presigned PUT/GET, stream file, báo tiến trình qua IPC; hủy bằng AbortController; tiếp tục sau mất mạng: multipart upload nếu storage hỗ trợ hoặc upload lại từ đầu với file nhỏ, giữ `uploadId`/trạng thái local. Mỗi phần có checksum, xác nhận qua HEAD/complete. **Bản web sau này sẽ cần CORS** trên bucket cho origin đã duyệt.
- Màn hình onboarding, giao diện thông báo và **trang tải app** phải nói rõ: **đóng hẳn app thì không nhận thông báo**; mở lại sẽ sync và hiện badge.

## 2.2 Đăng ký và đăng nhập

```mermaid
sequenceDiagram
  autonumber
  participant C as Desktop
  participant A as NestJS
  participant M as In-memory rate limits
  participant DB as Postgres
  participant J as DB jobs + mail worker
  C->>A: POST /v1/auth/register {username,email,password}
  A->>M: rate limit trước Argon2
  A->>A: semaphore Argon2; hết slot: 503 + Retry-After
  A->>DB: pending (+24h), identity, OTP HMAC; email active -> registrationId giả
  A->>J: enqueue OTP hoặc mail cảnh báo (theo trần)
  A-->>C: 202 {registrationId}
  C->>A: POST /v1/auth/register/verify {registrationId,code}
  A->>DB: consume OTP; active; tạo device + refresh + deviceToken
  A-->>C: access + refresh + deviceToken
  C->>C: main lưu refresh/deviceToken trong safeStorage
  C->>A: POST /v1/auth/login {identifier,password,deviceToken?}
  A->>M: rate limits IP/identifier; trusted device chỉ miễn khóa identifier
  A->>A: Argon2 thật/giả dưới semaphore
  alt sai hoặc không active
    A-->>C: 401 INVALID_CREDENTIALS
  else thiết bị mới và newDeviceOtp=true
    A->>J: enqueue OTP thiết bị
    A-->>C: challengeId
    C->>A: POST /v1/auth/login/otp {challengeId,code}
  end
  A->>DB: device limit; phát refresh family và deviceToken
  A-->>C: access + refresh + deviceToken
  C->>A: POST /v1/auth/refresh {refreshToken}
  A->>DB: atomic rotation; reuse => revoke family
  A-->>C: access + refresh mới hoặc 401
```

## 2.3 Gửi tin, fan-out và đồng bộ

```mermaid
sequenceDiagram
  autonumber
  participant C as Sender desktop
  participant A as NestJS WS
  participant DB as Postgres
  participant R as Recipient desktop
  C->>A: message:send {conversationId,clientMsgId,body,attachmentIds} (ack)
  A->>DB: BEGIN; khóa conversation + cặp friendship/block theo thứ tự cố định
  A->>DB: kiểm idempotency, quyền thành viên, bạn bè, không chặn
  alt clientMsgId đã tồn tại
    A-->>C: ack {messageId,seq cũ}
  else hợp lệ
    A->>DB: tăng last_seq; INSERT messages + change event; COMMIT
    A-->>C: ack {messageId,seq,serverTime}
    A-->>R: message:new (room user:recipient)
  end
  Note over C,R: Fan-out sau commit; thất lạc sự kiện được bù bằng sync
  R->>A: reconnect WS (để nhận sự kiện mới)
  R->>A: GET /v1/sync?cursor=...
  A->>DB: snapshot delta của user + last_seq từng conversation
  A-->>R: entities, tombstones, lastSeq, nextCursor
  loop hội thoại có lastSeq > localSeq
    R->>A: GET /v1/conversations/:id/changes?afterSeq=localSeq
    A-->>R: messages + edits/revokes/purge, nextSeq
  end
  R->>R: Dexie upsert theo event seq, bỏ trùng
```

- Seq theo hội thoại, cấp trong transaction sau khi kiểm trùng; rollback không tạo lỗ. **Bước 3** chốt cách không hụt seq với edit/purge và chính sách xóa sự kiện.
- Chặn/hủy bạn xảy ra đồng thời với gửi tin: transaction khóa hàng **theo thứ tự cố định** để không lọt tin sau chặn và tránh deadlock. Không tin thông tin quan hệ từ client.
- Sync cursor thực thể không dùng đồng hồ client; dùng change log theo offset server cho membership/friends/settings, riêng tin dùng seq. Không dựa vào `updated_at` đơn lẻ (có thể bỏ sót commit muộn).

## 2.4 Upload file

```mermaid
sequenceDiagram
  autonumber
  participant M as Electron main
  participant A as NestJS
  participant DB as Postgres
  participant S as S3-compatible storage
  M->>M: SHA-256, size, MIME candidate
  M->>A: POST /v1/attachments {sha256,size,mime,fileName}
  A->>DB: quota + dedup theo owner
  A-->>M: attachmentId + presigned PUT hoặc multipart uploadId
  M->>S: PUT/parts (progress, cancel, resume qua IPC)
  M->>A: POST /v1/attachments/:id/complete
  A->>S: HEAD/checksum; thiếu checksum -> worker tự băm
  A->>DB: status=verifying; enqueue verify job
  A-->>M: 202
  A->>S: worker kiểm magic bytes; reject/delete hoặc ready
  A-->>M: attachment:updated qua WS
  M->>A: GET /v1/attachments/:id/download
  A->>DB: owner hoặc thành viên hội thoại được phép đọc tin có file
  A-->>M: presigned GET TTL ngắn, Content-Disposition attachment
  M->>S: GET (có thể resume qua Range nếu storage hỗ trợ)
```

## 2.5 Thông báo

```mermaid
flowchart LR
  TX["COMMIT tin mới"] --> WS["Socket.IO room user:recipient"]
  WS --> ON{"App còn chạy?"}
  ON -->|Có| MU{"Đang xem hội thoại<br/>hoặc đã mute?"}
  MU -->|Có| BADGE["Chỉ cập nhật badge"]
  MU -->|Không| TRAY["Electron tray notification"]
  ON -->|Không| NONE["Không push ở MVP;<br/>mở lại sẽ sync + badge"]
  NONE -.-> LATER["Sau MVP: Web Push/FCM"]
```

## 2.6 Purge và xóa tài khoản

```mermaid
flowchart LR
  P["POST /v1/me/messages/purge"] --> Q["Postgres job idempotent<br/>xử lý theo lô"]
  Q --> T["Tombstone mỗi tin;<br/>cấp seq mới + COMMIT"]
  T --> WS["message:updated tới user rooms<br/>của mọi thành viên, gồm người nhận"]
  D["DELETE /v1/me"] --> S["deleting; revoke tokens/WS"]
  S -->|"hết ân hạn"| HD["Job xóa PII, quan hệ, file;<br/>users tombstone; giữ username 180 ngày"]
  S -->|"hủy trong ân hạn"| AC["active"]
  HD --> POLICY{"DELETED_USER_MESSAGES"}
  POLICY -->|retain mặc định| KEEP["Giữ nội dung tin đã gửi"]
  POLICY -->|redact_content| T
```

⚖ **Chờ ý kiến pháp lý:** quyền xóa tin của người gửi có thể xung đột với bản chụp tin nhắn đã được báo cáo để xử lý vi phạm. MVP chưa có tính năng báo cáo; nếu có yêu cầu bảo toàn chứng cứ từ bên ngoài, cần chính sách lưu giữ tách biệt, kiểm soát truy cập và thời hạn rõ ràng trước khi bật purge trên dữ liệu đó.
