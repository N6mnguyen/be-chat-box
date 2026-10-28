# Bước 3 — Cơ sở dữ liệu (đã xác nhận về thiết kế; kiểm chứng DB đang chờ)

> PostgreSQL thuần trên Supabase; UUID do app sinh (`crypto.randomUUID()`), thời gian do DB cấp; `BIGINT` seq trả qua API dạng **string**. DDL chuẩn: [schema.sql](../db/schema.sql), role/grant/RLS: [roles.sql](../db/roles.sql). Nơi host NestJS chưa chốt.

## 3.1 Quy tắc dữ liệu

- `conversation_changes.seq` tăng liên tục theo hội thoại (gửi, thu hồi, purge); `user_changes.seq` tăng liên tục theo user (hội thoại, bạn bè, block, settings). Không dùng giờ client hoặc `updated_at` làm cursor.
- `messages.created_seq` là seq ban đầu, không đổi; `messages` giữ bản mới nhất. `conversation_changes` **chỉ có id, loại thay đổi, seq, timestamp, không có body**. Tin bị purge không còn bản sao nội dung trong change log.
- Khóa chính UUID; `seq` BIGINT. `client_msg_id` unique theo hội thoại. `group` chỉ là giá trị chừa chỗ, API MVP không tạo được.
- `users` đã xóa giữ hàng tombstone không PII. Người nhận vẫn thấy tin cũ dưới tên "Người dùng đã xóa" (policy `retain`, chờ pháp lý ⚖).

## 3.2 ERD

```mermaid
erDiagram
  users ||--o{ identities : owns
  users ||--o{ devices : owns
  devices ||--o{ refresh_tokens : rotates
  users ||--o{ auth_challenges : requests
  users ||--o{ recovery_codes : has
  users ||--|| user_settings : configures
  users ||--o{ user_changes : syncs
  users ||--o{ user_blocks : blocks
  users ||--o{ friend_requests : sends
  users ||--o{ friendships : belongs
  users ||--o{ conversation_members : joins
  conversations ||--o{ conversation_members : has
  conversations ||--o{ messages : has
  conversations ||--o{ conversation_changes : ordered_events
  messages ||--o{ conversation_changes : changes
  messages ||--o{ message_attachments : includes
  attachments ||--o{ message_attachments : attached
  users ||--o{ attachments : uploads
  users ||--o{ audit_logs : audited
  users ||--o{ deletion_ledger : erased
  plans ||--o{ licenses : assigns
  users ||--|| licenses : subscribes
  billing_events }o--|| licenses : updates
```

## 3.3 DDL, ràng buộc, index

- [schema.sql](../db/schema.sql): bảng, PK/FK/CHECK/index, `unique(conversation_id, created_seq)`, `unique(conversation_id, client_msg_id)`, hàm cấp seq, cursor, dọn change log và claim/complete/fail job.
- [roles.sql](../db/roles.sql): role `vchat_app`, GRANT, RLS.
- Schema riêng `app`, không dùng `public`; Supabase Data API mặc định chỉ expose `public`.
- Những ràng buộc liên bảng xử lý trong transaction và test: đúng 2 member cho `direct`, quyền bạn bè/chặn, giữ chỗ username.
- **File đính kèm dời khỏi MVP đợt đầu.** Giữ `attachments`, `message_attachments` và interface `StorageService` làm chỗ cắm; API chưa bật. Đây là hạng mục đầu tiên sau MVP.

## 3.4 Cấp seq không trùng, không hụt

Hàm `app.send_direct_message` chạy trong transaction của NestJS:
1. Kiểm người gửi thuộc cặp `direct` (nếu không: `VC403`).
2. Lấy `pg_advisory_xact_lock(pair_lock_key(a,b))`. Chặn/hủy kết bạn phải lấy cùng khóa này trước khi đổi trạng thái quan hệ.
3. Khóa hàng hội thoại bằng `FOR UPDATE`, rồi kiểm trùng `client_msg_id`.
4. Trùng cùng `request_hash` thì trả tin cũ; trùng khác hash thì `VC409`.
5. Kiểm user active, còn bạn bè, không bị chặn. Sai thì `VC403`.
6. Tăng `last_seq`, ghi `messages` và `conversation_changes` trong cùng transaction.

Khóa hàng giữ tới commit. Rollback thì counter rollback; gửi lặp không tăng seq. Chỉ dùng khóa theo transaction nên tương thích transaction pooler Supabase. NestJS map `VC403/VC409/VC410` sang HTTP `403/409/410`. Thu hồi và purge cũng lấy khóa rồi cấp seq mới cho mỗi tin.

## 3.5 Đồng bộ, change log, mã 410

- `conversation_changes`: `(conversation_id, seq, message_id, kind, changed_at)`; `user_changes`: `(user_id, seq, entity_type, entity_id, kind, changed_at)`. Body được đọc từ `messages` hiện tại, nên tin tạo rồi bị thu hồi giữa hai lần sync chỉ hiện tombstone; không replay trạng thái trung gian.
- Giữ log **90 ngày** (cấu hình được). Job `prune_conversation_changes` và `prune_user_changes` dọn tiền tố cũ rồi cập nhật `changes_floor_seq` trong cùng transaction.
- Cursor nhỏ hơn floor: hàm `*_changes_since` trả `VC410`, API trả **`410 SYNC_CURSOR_EXPIRED`**. Client đồng bộ lại từ đầu: tải danh sách hội thoại, rồi tải từng trang tin theo `created_seq`. Hàm `STABLE` đảm bảo việc kiểm floor và việc đọc dùng chung snapshot.
- Profile/settings dùng optimistic `version`; 0 hàng cập nhật thì trả 409 cùng bản hiện tại. Không dùng đồng hồ client.

## 3.6 Hàng đợi job (Postgres, không Redis)

| Cơ chế | Cách làm |
|---|---|
| Nhận job | `FOR UPDATE SKIP LOCKED`; nhiều worker không nhận trùng |
| Visibility timeout | `lease_token` + `locked_until`; hết hạn worker khác có thể nhận lại. Worker cũ không complete/fail được nếu mất lease |
| Thử lại | `max_attempts` mặc định 5; backoff mũ 30s·2^(n−1), trần 1h. Hết lượt thì `failed` + metric/cảnh báo |
| Idempotent | Enqueue bằng `ON CONFLICT (idempotency_key) DO NOTHING`. Handler có thể chạy lại an toàn; purge bỏ qua tin đã tombstone |
| Payload | Chỉ id, không PII. `kind` validate bằng zod ở app |

## 3.7 Lưu giữ và dọn dẹp

Các giá trị đề xuất, cấu hình được; job chạy hằng ngày, theo lô, idempotent.

| Dữ liệu | Thời hạn | Job |
|---|---|---|
| Tài khoản `pending` | 24h | `cleanup_pending` |
| Tài khoản `deleting` | Ân hạn 30 ngày | `delete_account`: xóa PII, giữ tombstone, ghi `deletion_ledger` |
| Username sau xóa | 180 ngày | `release_username` |
| OTP | Hiệu lực 10 phút, xóa hàng sau 24h | `cleanup_auth` |
| Bộ đếm rate limit | Trong bộ nhớ, tự hết theo cửa sổ; mất khi restart | Không cần job |
| Refresh token đã dùng/thu hồi | 30 ngày sau hết hạn/thu hồi để phát hiện reuse | `cleanup_auth` |
| Device đã thu hồi | 90 ngày để tra lịch sử đăng nhập | `cleanup_auth` |
| Change log | 90 ngày | `prune_*_changes` và floor |
| Job `done` / `failed` | 7 ngày / 30 ngày | `cleanup_jobs` |
| Audit log | 180 ngày ⚖ | `prune_audit_logs` |
| Bản chụp tin bị báo cáo | Chưa có ở MVP; đề xuất 180 ngày sau đóng vụ việc ⚖ | Thiết kế khi làm tính năng báo cáo |
| Deletion ledger | Dài hơn backup lâu nhất + 30 ngày | `cleanup_ledger` |
| Tin nhắn | Theo vòng đời tài khoản; `retain`/`redact_content` sau xóa ⚖ | Purge/xóa tài khoản |

**Backup và sổ xóa**
- Theo [tài liệu Supabase Backups](https://supabase.com/docs/guides/platform/backups) kiểm tra ngày 2026-10-28: Free không có backup tự động; Pro giữ 7 ngày; Team 14 ngày; Enterprise tối đa 30 ngày. PITR tùy chọn 7/14/28 ngày và thay thế backup hằng ngày. **Phải kiểm tra gói và cấu hình thực tế** trước khi hứa thời hạn cụ thể.
- **Chính sách riêng tư phải ghi rõ** dữ liệu bị xóa có thể còn trong backup tối đa N ngày (N là retention thực tế, mục tiêu ≤30 ngày). Không chỉnh/xóa chọn lọc được một bản backup.
- `deletion_ledger` chỉ có `subject_type`, `subject_id`, `recorded_at`; ghi cho xóa tài khoản và purge tin. Job export sổ sang nơi bền riêng ngoài DB. **Khôi phục backup bắt buộc áp lại sổ xóa trước khi mở lại dịch vụ.** Kiểm chứng bằng diễn tập khôi phục.
- ⚖ Chờ pháp lý: audit 180 ngày, bản chụp báo cáo, tin giữ sau xóa, vùng dữ liệu/host.

**Partition:** MVP không partition. Khi cần: hash theo `conversation_id` để unique vẫn chứa partition key; không partition theo thời gian nếu chưa có bảng idempotency riêng.

## 3.8 Role DB, RLS, kết nối

**`vchat_app`** (NestJS dùng role này, **không dùng `postgres`**): `LOGIN NOINHERIT`, không sở hữu bảng/DDL. Quyền CRUD trong `app`, riêng `audit_logs`/`deletion_ledger` chỉ append; có `EXECUTE` hàm cần thiết. `statement_timeout=5s`, `lock_timeout=3s`, `idle_in_transaction_session_timeout=15s`; job dài dùng `SET LOCAL` trong transaction.

**GRANT và RLS:** phân quyền theo user ở NestJS, không dùng `auth.uid()`. `anon`/`authenticated` không có GRANT trên schema `app`; RLS bật trên mọi bảng và chỉ cho `vchat_app`, làm lớp phòng thủ thứ hai. `postgres` sở hữu bảng và bypass RLS, chỉ dùng cho migration. Mô phỏng trường hợp lỡ GRANT cho `anon` trong test: vẫn thấy 0 hàng.

| Biến | Role | Chế độ | Pool/driver |
|---|---|---|---|
| `DATABASE_URL` | `vchat_app` | Transaction pooler, cổng 6543 | `postgres(url, { prepare: false, max: 10 })`; `?pgbouncer=true` chỉ Prisma đọc, driver này bỏ qua |
| `DIRECT_URL` | `postgres` | Session pooler 5432 hoặc direct khi có IPv6 | Chỉ dùng migration, một lần/deploy |

Chỉ dùng `pg_advisory_xact_lock`, không `LISTEN/NOTIFY` hoặc session lock. `max:10` là giá trị khởi điểm; kiểm tra giới hạn kết nối theo gói Supabase. Mật khẩu chỉ trong secret store/env, không vào repo/log.

Chuỗi kết nối người dùng cung cấp đặt DB ở Tokyo (`ap-northeast-1`), ngoài Việt Nam. ⚖ Cần tư vấn pháp lý về chuyển dữ liệu ra nước ngoài. **Nơi host NestJS** phải hỗ trợ WebSocket sống lâu, gần/cùng vùng với DB; chưa chốt cho tới khi có ý kiến pháp lý.

## 3.9 Điều kiện hoàn thành Bước 3

| # | Kiểm chứng | Test |
|---|---|---|
| 1 | DDL/role chạy sạch trên Postgres Docker | `db/test/db.test.js` before hook |
| 2 | 50 tin đồng thời cùng hội thoại: seq 1..50, không trùng/hụt | Test concurrent send |
| 3 | 20 lần gửi cùng `clientMsgId`: một tin, một seq, tin kế tiếp seq 2 | Test duplicate |
| 4 | Cùng id khác body -> VC409; bị chặn/non-member -> VC403, không tốn seq | 2 test |
| 5 | Cursor đã bị dọn -> VC410 (cả conversation và user) | 2 test |
| 6 | Claim job không trùng; lease hết hạn nhận lại; lease cũ không complete được; hết `max_attempts` thì failed | Test job queue |
| 7 | Anon dù lỡ có GRANT vẫn không đọc được dữ liệu (RLS), không gọi được hàm | Test RLS |
| 8 | App role không sửa/xóa audit; statement timeout 5s | Test role |
| 9 | **Anon key Supabase thật** không đọc được dữ liệu qua Data API | Test thủ công trên project dev sau migrate; schema `app` không được expose |

Chạy: `docker compose up -d`, `npm install`, rồi `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres npm run test:db`. Nếu không có `TEST_DATABASE_URL`, test tự chạy `embedded-postgres` (binary Postgres thật).

**Trạng thái (2026-10-28):** 9/9 test qua trên embedded-postgres 17 (UTF8). Mục 9 (anon key Supabase thật) còn chờ làm thủ công.
