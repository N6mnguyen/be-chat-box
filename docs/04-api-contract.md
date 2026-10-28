# Bước 4 — Hợp đồng API (REST + WebSocket)

> Trạng thái: **ĐÃ XÁC NHẬN (v2, 2026-10-28)**, áp dụng Q1–Q7 và (a)–(e). Chỉ thiết kế; chưa có code NestJS. Migration §9 đã làm, test DB 18/18 qua; contract 17/17 test qua.
> Nguồn chuẩn (code): [`vchat/packages/api-contracts`](../../vchat/packages/api-contracts). Zod schema → type TS → [`openapi.yaml`](../../vchat/packages/api-contracts/openapi.yaml) (sinh tự động, 49 operation). 13 test hợp đồng qua; `tsc --strict` sạch.
> Đối chiếu với [`db/schema.sql`](../db/schema.sql) đã qua 9/9 test DB. Chỗ lệch giữa contract và schema được liệt kê ở §9; schema chưa bị sửa.

## 1. Quy ước chung

| Mục | Quy tắc |
|---|---|
| Phiên bản | Tiền tố `/v1`. Thay đổi **tương thích** (thêm endpoint, thêm trường response, thêm giá trị enum ở response mà client bỏ qua được, nới ràng buộc request) giữ `/v1`. Thay đổi **phá vỡ** (xóa hoặc đổi tên trường, siết validate, đổi nghĩa mã lỗi) thì làm `/v2` và chạy song song ≥ 1 chu kỳ phát hành desktop. Client phải bỏ qua trường lạ và sự kiện WS lạ |
| Định dạng | JSON UTF-8. Request body bị strip trường thừa: zod mặc định bỏ key lạ, nên `status`, `senderId` gửi lên sẽ bị bỏ |
| Xác thực | `Authorization: Bearer <access JWT>` (~10 phút). `auth = public | token | token+password` (token + nhập lại mật khẩu trong body) |
| Thời gian | ISO 8601 UTC `...Z` do server cấp. **Thứ tự chỉ dựa vào seq**, không dựa vào thời gian |
| Seq | Chuỗi số thập phân (`"42"`), vì BIGINT vượt `Number.MAX_SAFE_INTEGER` |
| Danh tính | `userId`/`senderId` **luôn lấy từ token**. Không body nào có các trường này (có test kiểm) |
| Request ID | Header `X-Request-Id` (server tạo nếu thiếu), có trong mọi lỗi |
| Lỗi | `{ "error": { "code", "message", "requestId", "details?" } }`. `message` bằng tiếng Việt, cố định theo `code`, không chèn dữ liệu người dùng |
| Phân trang | `?cursor=&limit=` → `{ items, nextCursor }`. `nextCursor = null` là hết. Cursor là chuỗi opaque base64url do server **ký HMAC**, client không tự tạo. Không dùng offset. Giới hạn `limit`: danh sách 100 (mặc định 30), tin nhắn 100 (mặc định 50), change log và sync 200 (mặc định 100) |
| Rate limit | `429 RATE_LIMITED` + `Retry-After` (giây). Hết slot Argon2 thì `503 SERVER_BUSY` + `Retry-After`. Rate limit được kiểm **trước** Argon2 |

### 1.1 Mã lỗi

| HTTP | `code` | Khi nào | Gộp? |
|---|---|---|---|
| 400 | `VALIDATION_FAILED` | Sai schema; `details.fields` chỉ liệt kê tên trường, không lặp lại giá trị | — |
| 401 | `UNAUTHENTICATED` | Thiếu/sai token, thiết bị bị thu hồi, user không `active` | **BẮT BUỘC gộp**: không phân biệt token sai hay thiết bị đã thu hồi. Token `scope:"restore"` gọi API ngoài `/me` và `/me/restore` cũng nhận mã này |
| 401 | `TOKEN_EXPIRED` | Access token hết hạn (client gọi refresh) | — |
| 401 | `TOKEN_REUSED` | Refresh token bị dùng lại, cả family bị thu hồi | — |
| 401 | `INVALID_CREDENTIALS` | Mọi trường hợp đăng nhập hoặc khôi phục sai | **BẮT BUỘC gộp**: sai username, sai mật khẩu, pending, deleted, đang khóa tạm theo identifier. Tài khoản `deleting` với mật khẩu **đúng** thì không lỗi, nhận token `scope:"restore"` |
| 403 | `FORBIDDEN` | Gửi tin khi không còn là bạn, **bị chặn**, hoặc mật khẩu xác nhận sai | **BẮT BUỘC gộp**: chặn và không-còn-bạn trả y hệt nhau |
| 404 | `NOT_FOUND` | Tài nguyên không tồn tại **hoặc** không có quyền xem | **BẮT BUỘC gộp**: user không tồn tại / pending / deleted / đã chặn mình / `discoverable=nobody`; hội thoại hoặc tin của người khác |
| 409 | `USERNAME_TAKEN` | Đăng ký username đã có người dùng | Chấp nhận lộ, vì username là thông tin công khai |
| 409 | `IDEMPOTENCY_CONFLICT` | Cùng `clientMsgId` hoặc `Idempotency-Key` nhưng payload khác | — |
| 409 | `VERSION_CONFLICT` | `expectedVersion` lệch, `details.current` chứa bản hiện tại | — |
| 410 | `SYNC_CURSOR_EXPIRED` | Con trỏ cũ hơn change log còn giữ (90 ngày) | — |
| 422 | `OTP_INVALID` | OTP sai, hết hạn, đã dùng, quá 5 lần, hoặc `registrationId`/`challengeId` giả | **BẮT BUỘC gộp** |
| 422 | `RECALL_WINDOW_EXPIRED` | Thu hồi tin quá 24 giờ | — |
| 422 | `GROUP_NOT_SUPPORTED` | `POST /v1/conversations {type:"group"}` | — |
| 403 | `DEVICE_LIMIT_REACHED` | Vượt số thiết bị của gói; `details.devices` chứa danh sách | Chỉ trả sau khi mật khẩu đúng, nên không lộ thông tin cho người lạ |
| 429 | `RATE_LIMITED` | Vượt ngưỡng | Với gửi OTP theo email thì **không** trả 429 mà vẫn 202 im lặng (xem §1.3) |
| 503 | `SERVER_BUSY` | Hết slot Argon2, DB quá tải | — |
| 500 | `INTERNAL` | Lỗi không lường trước; không kèm stack trace | — |

Không tồn tại các mã `USER_NOT_FOUND`, `BLOCKED`, `EMAIL_TAKEN`, `NOT_FRIENDS`, `ACCOUNT_PENDING`; có test kiểm điều này. Lỗi SQL được map như sau: `VC403 → 403 FORBIDDEN`, `VC409 → 409 IDEMPOTENCY_CONFLICT`, `VC410 → 410 SYNC_CURSOR_EXPIRED`.

### 1.2 Idempotency

| Thao tác | Cơ chế |
|---|---|
| Gửi tin (REST + WS) | `clientMsgId` (UUID do client sinh, unique theo hội thoại trong DB). Gửi lại cùng payload thì `201` + `duplicate:true`, giữ seq cũ. Khác payload thì `409` |
| Purge, báo cáo | Header `Idempotency-Key` (UUID). Server lưu key 24h, gắn với `jobs.idempotency_key` / report. Gửi lại thì trả lại kết quả cũ |
| Tạo mã khôi phục | **Cố ý không idempotent**: mỗi lần gọi phải tạo bộ mã mới, và mã cũ không lưu dạng đọc được để trả lại |
| Còn lại (`natural`) | Idempotent theo bản chất: chấp nhận/từ chối lời mời, chặn, bỏ chặn, hủy kết bạn, ẩn tin, thu hồi (lần 2 trả tin đã thu hồi), receipts (`GREATEST`), đăng xuất thiết bị, xóa/hủy xóa tài khoản |

### 1.3 Rate limit khởi điểm (cấu hình qua env, áp dụng cho một instance)

| Nhóm | Ngưỡng | Endpoint |
|---|---|---|
| `login` | IP 20/phút & 200/giờ; identifier 10 lần sai/15 phút thì **khóa tạm** 1→5→15→60 phút (thiết bị tin cậy được miễn); IP+identifier 5 lần sai/15 phút | login, recover, đổi mật khẩu |
| `register` | IP 5/giờ, 20/ngày | register |
| `otp-send` | email 5/giờ & 10/ngày & cách nhau ≥ 60s; IP 20/ngày; thiết bị 10/ngày; trần toàn hệ thống/ngày | resend-otp, forgot, email/change. Vượt trần **theo email** thì vẫn 202 nhưng không gửi |
| `otp-verify` | 5 lần sai/mã; IP 30/giờ | verify-email, verify-device, reset, email/confirm |
| `refresh` | thiết bị 30/phút | refresh |
| `user-search` | user 60/giờ, IP 120/giờ | users/by-username |
| `friend-request` | user 30/ngày, **tính cả lời mời bị nuốt im lặng** | friend-requests |
| `block` | user 60/giờ | blocks |
| `message-send` | user 30/10 giây, 1.000/giờ; REST và WS dùng chung bộ đếm | messages, WS `message.send` |
| `receipt` | user 120/phút | receipts, WS `receipt.update` |
| `report` | user 20/ngày | reports |
| `recovery-codes` | user 5/ngày | recovery-codes |

## 2. Endpoint REST

Cột: **Auth** (P = public, T = token, T+P = token + mật khẩu trong body) · **Idem** (C = clientMsgId, K = Idempotency-Key, N = tự nhiên, — = không) · **RL** = nhóm rate limit. Schema đầy đủ của request/response nằm trong `openapi.yaml`; tên ở đây là tên schema.

### 2.1 auth

| Method & path | Auth | Request → Response | Lỗi | RL | Idem | Quyền / ghi chú |
|---|---|---|---|---|---|---|
| `POST /v1/auth/register` | P | `{username,email,password,deviceName}` → **202** `{registrationId}` | 400, 409 `USERNAME_TAKEN`, 429, 503 | register | N | `registrationId` **luôn ngẫu nhiên**. Email đã active: không lưu gì, chỉ đưa mail cảnh báo vào job. Email pending: đè. Luôn 202 cùng hình dạng |
| `POST /v1/auth/verify-email` | P | `{registrationId, code}` → 200 `TokenPair` (+`deviceToken`) | 400, 422 `OTP_INVALID`, 429 | otp-verify | — | Chuyển `pending → active`; thiết bị này thành tin cậy |
| `POST /v1/auth/resend-otp` | P | `{purpose:"register",registrationId}` hoặc `{purpose:"device",challengeId}` → 202 | 400, 429 | otp-send | N | Id giả hoặc hết hạn vẫn 202 |
| `POST /v1/auth/login` | P | `{identifier,password,deviceName,deviceToken?}` → 200 `TokenPair` **hoặc** `OtpChallenge` | 400, 401 `INVALID_CREDENTIALS`, 403 `DEVICE_LIMIT_REACHED`, 429, 503 | login | — | Thứ tự: rate limit → semaphore → Argon2 (thật/giả) → so sánh. Tài khoản `deleting` + mật khẩu đúng: `TokenPair{scope:"restore"}`, không hỏi OTP thiết bị, không cấp deviceToken. Thiết bị mới + `newDeviceOtp` thì trả challenge. Trạng thái "OTP_REQUIRED" được biểu diễn bằng body 200 `{challenge:"device_otp"}`, không phải lỗi (Q1) |
| `POST /v1/auth/login/verify-device` | P | `{challengeId, code}` → 200 `TokenPair` (+`deviceToken`) | 400, 403, 422, 429 | otp-verify | — | Cấp `deviceToken` mới |
| `POST /v1/auth/refresh` | P | `{refreshToken}` → 200 `TokenPair` | 400, 401 `TOKEN_REUSED`/`UNAUTHENTICATED`, 429 | refresh | — | Xoay vòng nguyên tử. Reuse thì thu hồi family + phát `session.revoked` |
| `POST /v1/auth/logout` | T | → 204 | 401 | — | N | Thu hồi refresh family và deviceToken của thiết bị hiện tại |
| `POST /v1/auth/password/forgot` | P | `{email}` → 202 | 400, 429 | otp-send | N | Chỉ gửi OTP khi email active |
| `POST /v1/auth/password/reset` | P | `{email,code,newPassword}` → 204 | 400, 422, 429, 503 | otp-verify | — | Thu hồi **mọi** refresh và deviceToken, ngắt WS, gửi mail báo |
| `POST /v1/auth/recover` | P | `{identifier,recoveryCode,newPassword}` → 200 `TokenPair` | 400, 401 `INVALID_CREDENTIALS`, 429, 503 | login | — | Sau MVP đợt đầu; contract đã chốt |

### 2.2 me

| Method & path | Auth | Request → Response | Lỗi | RL | Idem | Ghi chú |
|---|---|---|---|---|---|---|
| `GET /v1/me` | T | → `Me` | 401 | — | — | Có `settings.privacy` |
| `PATCH /v1/me/profile` | T | `{displayName, expectedVersion}` → `Me` | 400, 401, 409 `VERSION_CONFLICT` | — | — | |
| `PATCH /v1/me/settings` | T | partial + `expectedVersion`; `currentPassword` bắt buộc khi tắt `newDeviceOtp` → `Settings` | 400, 401, 403, 409, 429, 503 | — | — | `privacy.discoverable: everyone/nobody`; `privacy.readReceipts` đối xứng |
| `POST /v1/me/email/change` | T+P | `{newEmail,password}` → 202 | 400, 401, 403, 429, 503 | otp-send | N | Email mới đã có chủ thì vẫn 202, không gửi |
| `POST /v1/me/email/confirm` | T | `{code}` → 204 | 400, 401, 422, 429 | otp-verify | — | Đổi identity; gửi mail tới email **cũ** |
| `POST /v1/me/password` | T+P | `{currentPassword,newPassword}` → 204 | 400, 401, 403, 429, 503 | login | — | Thu hồi refresh và deviceToken của các thiết bị **khác** |
| `GET /v1/me/devices` | T | → `{items: Device[]}` | 401 | — | — | `current: true` cho thiết bị đang gọi |
| `DELETE /v1/me/devices/{deviceId}` | T | → 204 | 401, 404 | — | N | Chỉ xóa thiết bị của mình (của người khác trả 404). Ngắt `device:<id>` + phát `session.revoked` |
| `POST /v1/me/messages/purge` ⚖ | T+P | `{password}` + `Idempotency-Key` → 202 `JobAccepted` | 400, 401, 403, 429, 503 | — | K | Job theo lô; mỗi tin `kind=purged`, seq mới. Khi xong phát **một** `messages.purged {conversationId,lastSeq}` cho mỗi hội thoại bị ảnh hưởng (không phát từng tin) |
| `GET /v1/me/messages/purge/{jobId}` | T | → `JobAccepted` | 401, 404 | — | — | Chỉ job của mình |
| `DELETE /v1/me` | T+P | `{password}` → 202 `Me` (`deleting`, `deletionDueAt`) | 400, 401, 403, 429, 503 | — | N | Ân hạn 30 ngày; thu hồi token các thiết bị khác; thiết bị hiện tại còn dùng được để restore |
| `POST /v1/me/restore` | T (scope `restore` hoặc `full`) | → `TokenPair{scope:"full"}` | 401, 409 | — | N | Chỉ khi đang `deleting`; thu hồi token scope `restore`, cấp cặp token mới |
| `POST /v1/me/recovery-codes` | T+P | `{password}` → 201 `{codes[10],createdAt}` | 400, 401, 403, 429, 503 | recovery-codes | — | Hiện một lần; vô hiệu bộ cũ |

### 2.3 users, friends, blocks

| Method & path | Auth | Request → Response | Lỗi | RL | Idem | Quyền |
|---|---|---|---|---|---|---|
| `GET /v1/users/by-username/{username}` | T | → `PublicUser` | 400, 401, **404**, 429 | user-search | — | Khớp chính xác (lowercase). 404 khi: không tồn tại, không active, **đã chặn mình**, mình chặn họ, `discoverable=nobody` (trừ khi đã là bạn), hoặc tìm chính mình |
| `POST /v1/friend-requests` | T | `{username}` → **202** | 400, 401, 429 | friend-request | N | Luôn 202. `app.send_friend_request` **luôn tạo bản ghi** khi người nhận active và chưa là bạn; có block (hai chiều) hoặc `discoverable=nobody` thì `suppressed=true`: người nhận không thấy, người gửi thấy như đang chờ, hết hạn sau 30 ngày như lời mời thường, bỏ chặn không đẩy cho người nhận. Hai bên cùng mời (không suppressed) thì tự kết bạn |
| `GET /v1/friend-requests/incoming` | T | → `FriendRequestPage` | 400, 401 | — | — | `recipient = tôi`, pending |
| `GET /v1/friend-requests/outgoing` | T | → `FriendRequestPage` | 400, 401 | — | — | Mọi lời mời pending của tôi, gồm cả suppressed (không có trường phân biệt). Client không cần lưu trạng thái riêng |
| `POST /v1/friend-requests/{id}/accept` | T | → `Conversation` | 401, 404 | — | N | Người nhận, pending. Tạo friendship + get-or-create direct |
| `POST /v1/friend-requests/{id}/decline` | T | → 204 | 401, 404 | — | N | Người nhận |
| `POST /v1/friend-requests/{id}/cancel` | T | → 204 | 401, 404 | — | N | Người gửi |
| `GET /v1/friends` | T | → `FriendPage` | 400, 401 | — | — | |
| `DELETE /v1/friends/{userId}` | T | → 204 | 401 | — | N | Advisory lock theo cặp; không phải bạn vẫn 204 |
| `GET /v1/blocks` | T | → `BlockPage` | 400, 401 | — | — | Chỉ những người **tôi** chặn |
| `POST /v1/blocks` | T | `{username}` → 204 | 400, 401, 429 | block | N | Một transaction: `pair_lock_key` → xóa friendship → lời mời pending hai chiều thành `cancelled` → insert block. Username không tồn tại vẫn 204 |
| `DELETE /v1/blocks/{userId}` | T | → 204 | 401 | — | N | Không khôi phục tình bạn |

Người bị chặn **không nhận sự kiện nào**. Với họ, friendship chỉ biến mất qua `user_changes` kind `delete`, giống hệt khi bị hủy kết bạn.

### 2.4 conversations, messages, receipts

| Method & path | Auth | Request → Response | Lỗi | RL | Idem | Quyền |
|---|---|---|---|---|---|---|
| `GET /v1/conversations` | T | → `ConversationPage` | 400, 401 | — | — | Thành viên. Ghim lên đầu, rồi theo hoạt động mới nhất. `unreadCount` = tin của peer có `createdSeq > lastReadSeq`, chưa thu hồi, chưa ẩn |
| `POST /v1/conversations` | T | `{type:"direct",peerId}` → `Conversation`; `{type:"group"}` → **422** | 400, 401, 403, 422 | — | N | Get-or-create; bắt buộc là bạn, không có block |
| `GET /v1/conversations/{id}` | T | → `Conversation` | 401, 404 | — | — | Thành viên, nếu không 404 |
| `PATCH /v1/conversations/{id}` | T | `{pinned?,muted?}` → `Conversation` | 400, 401, 404 | — | N | Chỉ hàng `conversation_members` của tôi |
| `GET /v1/conversations/{id}/messages` | T | `?cursor&limit` → `MessagePage` (mới → cũ) | 400, 401, 404 | — | — | Lọc `message_hidden_for` của tôi; tin đã thu hồi trả `body:null, deleted:true` |
| `POST /v1/conversations/{id}/messages` | T | `{clientMsgId,body,replyToId?,attachments:[]}` → **201** `{message,duplicate}` | 400, 401, **403**, 404, 409, 429 | message-send | C | `app.send_direct_message`: thành viên, bạn bè, block kiểm **trong transaction**. Bị chặn và hết là bạn trả cùng `403 FORBIDDEN` |
| `POST .../messages/{mid}/recall` | T | → `Message` | 401, 403, 404, 422 `RECALL_WINDOW_EXPIRED` | — | N | Chỉ người gửi, ≤ 24h theo `created_at` server; seq mới, `kind=recalled`, xóa body |
| `POST .../messages/{mid}/hide` | T | → 204 | 401, 404 | — | N | `message_hidden_for` + `user_changes(message_visibility)` + `message.hidden` tới các device **của tôi** |
| `GET /v1/conversations/{id}/changes` | T | `?afterSeq&limit` → `ChangePage` | 400, 401, 404, **410** | — | — | `app.conversation_changes_since`; kèm trạng thái hiện tại của `message` |
| `PUT /v1/conversations/{id}/receipts` | T | `{deliveredSeq?,readSeq?}` → `Receipt` | 400, 401, 404 | receipt | N | `GREATEST(old,new)`, kẹp ≤ `last_seq`; không bao giờ giảm. Tắt "đã xem" thì vẫn lưu `readSeq` (để tính unread) nhưng không phát cho peer |

### 2.5 sync, reports, ops

| Method & path | Auth | Request → Response | Lỗi | RL | Idem | Ghi chú |
|---|---|---|---|---|---|---|
| `GET /v1/sync` | T | `?cursor&limit` → `SyncPage` | 400, 401, **410** | — | — | Không có cursor là lần đầu: `initial:true`, metadata + `conversations[{id,lastSeq}]` + `recentMessages` (≤ 20 tin mỗi hội thoại). Có cursor: `user_changes_since` |
| `POST /v1/reports` ⚖ | T | `{targetUserId? \| messageId?, reason, note?}` + `Idempotency-Key` → 202 | 400, 401, 404, 429 | report | K | Chỉ báo cáo tin trong hội thoại mình là thành viên. Server tự chụp nội dung, **không** nhận nội dung từ client. Cần bảng mới (§9.1) |
| `GET /v1/health/live` | P | → `{ok:true}` | — | — | — | Không chạm DB |
| `GET /v1/health/ready` | P | → `{ok:true}` / 503 | 503 | — | — | `SELECT 1` + phiên bản migration; không lộ chi tiết |

## 3. WebSocket (Socket.IO)

Payload TypeScript nằm ở [`src/ws.ts`](../../vchat/packages/api-contracts/src/ws.ts) (`ClientEvents`, `ClientAcks`, `ServerEvents`). Tên sự kiện dùng dấu chấm (`message.new`).

### 3.1 Kết nối và xác thực

- `io(url, { transports: ['websocket'], auth: { accessToken } })`. Không cho long-polling.
- Handshake: verify JWT (chữ ký, `exp`), rồi tra `devices.revoked_at IS NULL` và `users.status = 'active'` (một truy vấn). Token `scope:"restore"` bị từ chối (`UNAUTHENTICATED`). Lỗi thì `connect_error` với `data.code` là `UNAUTHENTICATED` hoặc `TOKEN_EXPIRED`. Sau đó `join('user:<uid>')` và `join('device:<did>')`.
- **Xác thực lại:** trước `exp` 60s, server emit `auth.expiring`. Client refresh qua REST, rồi emit `auth.refresh {accessToken}` (ack `{expiresAt}`). Access token mới phải cùng `deviceId`. Quá `exp` mà chưa xác thực lại thì server `disconnect(true)`.
- **Thu hồi:** đăng xuất từ xa, reset mật khẩu, reuse refresh, xóa tài khoản thì emit `session.revoked {reason}` tới `device:<id>` (hoặc `user:<id>`) rồi `disconnectSockets(true)`. Mỗi lệnh ghi qua WS vẫn kiểm lại trạng thái thiết bị trong transaction, phòng trường hợp lỡ mất sự kiện.
- Heartbeat dùng ping/pong mặc định của Socket.IO (`pingInterval 25s`, `pingTimeout 20s`). `presence.ping` là tầng ứng dụng, gửi mỗi 30s để báo đang hoạt động.
- Nhiều thiết bị cùng tài khoản: mỗi socket một room `device:`, chung room `user:`. Fan-out tới `user:<id>` nên mọi thiết bị đều nhận, kể cả thiết bị gửi (dùng `clientMsgId` để bỏ trùng với ack).

### 3.2 Client → server

| Sự kiện | Payload | Ack | Rate limit | Ghi chú |
|---|---|---|---|---|
| `message.send` | `{conversationId, clientMsgId, body, replyToId?, attachments:[]}` | `{ok:true,data:{messageId,seq,duplicate,createdAt}}` hoặc `{ok:false,error:{code,retryAfterMs?}}` | Chung với REST `message-send` | Giống hệt `POST .../messages`. `code` có thể là `FORBIDDEN`, `NOT_FOUND`, `IDEMPOTENCY_CONFLICT`, `RATE_LIMITED`, `VALIDATION_FAILED` |
| `typing` | `{conversationId, state:'start'\|'stop'}` | `{ok:true}` | 1 lần / 3 giây / hội thoại; vượt thì bỏ im lặng | Không ghi DB. Server tự phát `stop` sau 6s |
| `presence.ping` | `{}` | `{serverTime}` | 1 lần / 20 giây | Gia hạn TTL trong `PresenceStore` |
| `receipt.update` | `{conversationId, deliveredSeq?, readSeq?}` | `Receipt` | Chung với `receipt` (120/phút) | Giống `PUT .../receipts` |
| `auth.refresh` | `{accessToken}` | `{expiresAt}` | 6/phút | |

Ack là **bắt buộc** với `message.send`. Client timeout 10s rồi gửi lại cùng `clientMsgId` (lùi dần 1→2→4→8s, tối đa 30s); sau 5 lần thì chuyển sang REST.

### 3.3 Server → client

| Sự kiện | Payload | Gửi tới | Lọc |
|---|---|---|---|
| `message.new` | `{message: Message}` | `user:` của cả hai thành viên | Sau COMMIT |
| `message.recalled` | `{conversationId, messageId, seq}` | `user:` của cả hai | Một lần thu hồi |
| `messages.purged` | `{conversationId, lastSeq}` | `user:` của cả hai | Một sự kiện mỗi hội thoại khi job purge xong; client gọi `/changes` |
| `message.hidden` | `{conversationId, messageId}` | `user:` của **chính người ẩn** | Không bao giờ tới peer |
| `receipt.updated` | `Receipt` | `user:` của cả hai | `readSeq` chỉ gửi peer khi **cả hai** đều bật "đã xem" |
| `friend.request` | `{request}` | `user:` người nhận | Không phát nếu có block, `discoverable=nobody`, hoặc lời mời bị nuốt |
| `friend.accepted` | `{user, conversationId}` | `user:` của cả hai | |
| `presence` | `{userId, online}` | `user:` của **bạn bè** | Lọc bạn bè + block; `hideOnline=true` thì luôn coi là offline với mọi bạn (cả `typing`) |
| `typing` | `{conversationId, userId, state}` | `user:` của peer | Lọc bạn bè + block |
| `session.revoked` | `{reason}` | `device:` / `user:` | Sau đó server ngắt kết nối |
| `auth.expiring` | `{expiresAt}` | socket | |
| `sync.hint` | `{scope:'user'\|'conversation', conversationId?, seq}` | `user:` | Phát khi có `user_changes` mới (bạn bè, block, settings, thiết bị...) |

### 3.4 Thứ tự, mất kết nối, resume

- **Sự kiện WS chỉ là gợi ý.** Fan-out chạy sau COMMIT và có thể bị mất (restart, mất mạng). Nguồn chân lý là REST + seq.
- Client giữ `lastAppliedSeq` cho mỗi hội thoại. Nhận `message.new` với `createdSeq == lastAppliedSeq + 1` thì áp ngay. Nếu lớn hơn thì có lỗ hổng: gọi `GET .../changes?afterSeq=lastAppliedSeq`. Nhỏ hơn hoặc bằng thì bỏ qua.
- **Resume sau mất kết nối:** (1) kết nối lại WS; (2) `GET /v1/sync?cursor=<userCursor>`, nhận `conversations[{id,lastSeq}]`; (3) với mỗi hội thoại có `lastSeq > lastAppliedSeq`, gọi `/changes?afterSeq=` theo trang. Nhận `410` thì làm lại sync lần đầu cho hội thoại đó, hoặc cả user khi `/sync` trả 410.
- Server không đảm bảo thứ tự sự kiện giữa các hội thoại khác nhau; trong một hội thoại, thứ tự đúng là thứ tự seq.

### 3.5 Presence và typing

`PresenceStore` trong bộ nhớ (một instance): `userId → {sockets, lastPingAt}`. Online khi có ít nhất 1 socket và đã ping trong vòng 60s. Khi phát, server tra danh sách bạn và block **từ DB** (cache trong bộ nhớ 30s, bị xóa khi friendship hoặc block thay đổi). Không ghi Postgres. Người bị chặn và người không còn là bạn không nhận được gì; chặn xảy ra thì người bị chặn thấy người chặn **offline** (chấp nhận suy đoán theo thời điểm, Q5). Cài đặt `privacy.hideOnline` ẩn online/typing với mọi bạn bè. **Không có "hoạt động lần cuối"**.

## 4. Chống lộ thông tin

| Tình huống | Bên ngoài thấy | Cách giữ thời gian phản hồi giống nhau |
|---|---|---|
| Đăng ký bằng email đã có chủ | 202 `{registrationId}` giống hệt | Luôn chạy Argon2 dù không lưu; mail đưa vào job. `registrationId` luôn là UUID ngẫu nhiên; với email đã có chủ **không lưu gì**. verify/resend với id không tồn tại xử lý như id hết hạn (verify `OTP_INVALID`, resend 202) |
| Login sai / pending / deleted / không có user | 401 `INVALID_CREDENTIALS` | Luôn Argon2: không có user thì verify với hash giả có cùng tham số |
| Forgot / resend / email change | 202 | Ghi DB + đưa job vào cùng một đường xử lý; việc gửi mail thật chạy ở job, không nằm trên đường request |
| Tìm người đã chặn mình / không tồn tại / ẩn | 404 | **Một câu SQL duy nhất** gộp mọi điều kiện (`username = $1 AND status='active' AND NOT EXISTS block AND (discoverable OR is_friend)`), không rẽ nhánh sớm |
| Mời người đã chặn mình | 202 | `app.send_friend_request`: một hàm, cùng số câu lệnh cho mọi nhánh và **luôn INSERT** (bản suppressed khác bản thường đúng một cờ); người gửi thấy giống hệt. Tính rate limit và trần lời mời chờ như thường |
| Gửi tin cho người đã chặn mình | 403 `FORBIDDEN` | Cùng hàm `send_direct_message`, cùng SQLSTATE `VC403` cho cả "không còn bạn" lẫn "bị chặn" |
| Presence / typing / đã xem | Im lặng | Không phát gì; giống người kia offline hoặc tắt "đã xem" |

Thêm một lớp **đệm thời gian tối thiểu** cho các endpoint P0 (register, login, forgot, resend, by-username, friend-requests): server chờ cho tới `max(thực tế, ngưỡng)`, ngưỡng cấu hình được (ví dụ 300ms cho auth, 50ms cho tìm/mời). **Đệm áp cả khi trả 429/503**, để thời gian không tiết lộ việc bị giới hạn theo identifier hay theo IP. Có test đo phân phối p50/p95 giữa các nhánh (§11).

**Gợi ý UI khi bị khóa tạm:** server chỉ trả `INVALID_CREDENTIALS` (khóa theo identifier không được lộ) hoặc `429 + Retry-After` (giới hạn IP). Với 429, UI hiện "Thử lại sau N phút" kèm đếm ngược từ `Retry-After`. Sau 3 lần `INVALID_CREDENTIALS` liên tiếp, UI chủ động gợi ý "Quên mật khẩu?" và nhắc rằng đăng nhập từ thiết bị đã tin cậy không bị ảnh hưởng. UI không bao giờ hiện "tài khoản bị khóa".

**Bí mật không bao giờ xuất hiện trong** response (trừ `TokenPair`/`RecoveryCodes` trả cho chính phiên đó), log, `details`, thông báo lỗi hay audit metadata. Logger redact theo tên trường: `password*`, `*Token`, `code`, `recoveryCode`, `authorization`, `cookie`. Không log body request và nội dung tin.

## 5. Ma trận quyền

| Kiểm tra | Áp dụng cho | Ở đâu |
|---|---|---|
| Token hợp lệ + thiết bị chưa thu hồi + user `active` | Mọi endpoint T, WS handshake, mọi lệnh ghi WS | Guard (JWT) + tra thiết bị/trạng thái trong transaction ghi. Token `scope:"restore"` chỉ qua guard ở `GET /v1/me` và `POST /v1/me/restore`; không vào WS |
| Nhập lại mật khẩu | T+P | Service (Argon2, sau rate limit) |
| Chủ tài nguyên | `devices/{id}`, `purge/{jobId}`, recall (người gửi), friend-request accept/decline (người nhận) / cancel (người gửi) | Điều kiện `WHERE` theo `user_id` từ token. Sai chủ thì 404 |
| Thành viên hội thoại | Mọi `/conversations/{id}/**`, WS `message.send`/`typing`/`receipt.update`, report `messageId` | `direct_user_low/high` hoặc `conversation_members`. Không phải thành viên thì 404 (ghi thì 403 qua `VC403`) |
| Là bạn + không có block (hai chiều) | Gửi tin, tạo direct, typing/presence | **Trong transaction** + `pair_lock_key` (`send_direct_message`); typing/presence dùng cache |
| Không có block + discoverable | Tìm user, mời kết bạn | Một câu SQL (§4) |
| Không thể đổi danh tính qua body | Mọi body | zod strip; `userId` lấy từ token |

## 6. Schema và tài liệu

- `vchat/packages/api-contracts` (npm workspace `@vchat/api-contracts`): `src/{common,auth,me,chat,ws,routes}.ts`. Zod 4 (đã có trong workspace).
- **Angular chỉ dùng `import type { ... } from '@vchat/api-contracts'`**, nên zod không vào bundle. Có lint rule `@typescript-eslint/consistent-type-imports` cho `apps/web` (Bước 7). NestJS import giá trị (schema) để validate.
- `npm run openapi` sinh `openapi.yaml` từ bảng `routes` + `z.toJSONSchema`. Dùng để làm tài liệu và test hợp đồng; **không sinh client**. File được commit; test kiểm số operation khớp và không còn `$ref` hỏng.
- Có thể import `openapi.yaml` vào Postman để mock và test; chưa đẩy lên cloud.

## 7. Ví dụ

**Đăng ký và xác minh**
```http
POST /v1/auth/register
{"username":"lan.nguyen","email":"lan@example.vn","password":"mat-khau-dai-1","deviceName":"Laptop Lan"}
→ 202 {"registrationId":"0b7c…"}             // email đã có chủ: cùng 202, id giả

POST /v1/auth/verify-email
{"registrationId":"0b7c…","code":"483920"}
→ 200 {"accessToken":"eyJ…","accessExpiresAt":"2026-10-28T08:10:00Z","refreshToken":"rt_…",
       "refreshExpiresAt":"2026-11-27T08:00:00Z","deviceId":"5d1e…","deviceToken":"dt_…"}
→ 422 {"error":{"code":"OTP_INVALID","message":"Mã không đúng hoặc đã hết hạn","requestId":"req_9a…"}}
```

**Đăng nhập trên thiết bị mới (OTP)**
```http
POST /v1/auth/login
{"identifier":"lan.nguyen","password":"mat-khau-dai-1","deviceName":"PC công ty"}
→ 200 {"challenge":"device_otp","challengeId":"c41f…","expiresAt":"2026-10-28T08:10:00Z"}

POST /v1/auth/login/verify-device  {"challengeId":"c41f…","code":"118204"}
→ 200 {…TokenPair, "deviceToken":"dt_…"}

// sai mật khẩu, sai username hay tài khoản chưa kích hoạt đều trả:
→ 401 {"error":{"code":"INVALID_CREDENTIALS","message":"Thông tin đăng nhập không đúng","requestId":"req_…"}}
```

**Gửi tin**
```http
POST /v1/conversations/7f3a…/messages
{"clientMsgId":"e1d9…","body":"Chào bạn","replyToId":null,"attachments":[]}
→ 201 {"duplicate":false,"message":{"id":"m01…","conversationId":"7f3a…","senderId":"<từ token>",
       "clientMsgId":"e1d9…","createdSeq":"42","latestSeq":"42","body":"Chào bạn","deleted":false,
       "replyToId":null,"attachments":[],"createdAt":"2026-10-28T08:01:02Z","updatedAt":"2026-10-28T08:01:02Z"}}

// gửi lại cùng clientMsgId + cùng nội dung (mất ack):
→ 201 {"duplicate":true,"message":{…"createdSeq":"42"…}}
// cùng clientMsgId, khác nội dung:
→ 409 {"error":{"code":"IDEMPOTENCY_CONFLICT",…}}
// bị peer chặn HOẶC không còn là bạn (không phân biệt được):
→ 403 {"error":{"code":"FORBIDDEN","message":"Không thể gửi tin trong cuộc trò chuyện này","requestId":"req_…"}}
```
WS tương đương: `socket.emit('message.send', {conversationId, clientMsgId, body}, ack)`, ack trả `{ok:true,data:{messageId,seq:"42",duplicate:false,createdAt}}`.

**Đồng bộ sau offline**
```http
GET /v1/sync?cursor=eyJ1Ijo…
→ 200 {"initial":false,"items":[{"seq":"88","entityType":"friendship","entityId":"…","kind":"delete"}],
       "nextCursor":"eyJ1Ijo…","conversations":[{"id":"7f3a…","lastSeq":"57"}]}

GET /v1/conversations/7f3a…/changes?afterSeq=42&limit=100
→ 200 {"items":[{"seq":"43","messageId":"m02…","kind":"created","message":{…}},
                {"seq":"57","messageId":"m01…","kind":"recalled","message":{…"body":null,"deleted":true}}],
       "nextCursor":null}

// offline > 90 ngày:
→ 410 {"error":{"code":"SYNC_CURSOR_EXPIRED","message":"Cần đồng bộ lại từ đầu","requestId":"req_…"}}
// client: xóa cursor hội thoại, GET /v1/conversations/7f3a…/messages?limit=50, hoặc GET /v1/sync (không cursor)
```

**Thu hồi tin**
```http
POST /v1/conversations/7f3a…/messages/m01…/recall
→ 200 {"id":"m01…","createdSeq":"42","latestSeq":"57","body":null,"deleted":true,…}
// sau 24h: → 422 RECALL_WINDOW_EXPIRED · tin người khác: → 403 FORBIDDEN
// WS tới cả hai bên: message.recalled {"conversationId":"7f3a…","messageId":"m01…","seq":"57"}
```

## 8. Chỗ cần ý kiến pháp lý ⚖

1. **Purge**: tin đã chụp trong báo cáo có bị purge xóa theo không. Đề xuất: bản chụp báo cáo tách riêng, giữ 180 ngày sau khi đóng vụ việc, purge không xóa.
2. **Báo cáo**: lưu bản chụp nội dung tin của người khác (cả hai bên là chủ thể dữ liệu); cơ sở pháp lý, thời hạn, ai được xem.
3. **Log và audit**: thời hạn audit 180 ngày, IP trong audit có phải dữ liệu cá nhân không.
4. **Tin của người đã xóa tài khoản** (`retain`), và câu chữ trên màn hình xác nhận xóa.

## 9. Migration schema đã làm

| # | Thay đổi | Trạng thái |
|---|---|---|
| 9.1 | `app.reports`, ghi qua `create_report` (`SECURITY DEFINER`), snapshot gồm tin liền kề ⚖; chỉ `vchat_moderator` đọc | Có test |
| 9.2 | `conversation_members.last_delivered_seq`; receipts dùng `GREATEST`, kẹp theo `last_seq` | Có test |
| 9.4 | `messages.reply_to_id`, cùng hội thoại, chỉ tin còn hiệu lực; không sao chép nội dung gốc | Có test |
| 9.5 | `conversation_members.pinned_at` | Schema |
| 9.6 | `user_settings.discoverable`, `read_receipts`, `hide_online` | Schema + test discoverable |
| 9.7 | `app.recall_message`: người gửi, 24h, seq mới, idempotent | Có test |
| Q3 | `friend_requests.suppressed`, `expires_at`; `send_friend_request` luôn tạo bản ghi khi người nhận active | Có test |
| 9.11 | `replace_recovery_codes`: xóa bộ cũ và chèn bộ mới trong một transaction | Có test |

Ghi chú: `USERNAME_TAKEN` vẫn lộ một username đã được dùng; chấp nhận vì username là định danh công khai.

## 10. Quyết định đã chốt

- Q1: `200 {challenge}`.
- Q2: tin thu hồi có `body:null` với cả hai bên.
- Q3: lời mời suppressed được lưu thật, người gửi thấy như đang chờ, người nhận không thấy.
- Q4: `discoverable` chỉ có `everyone/nobody`.
- Q5: chấp nhận suy đoán qua offline; thêm `hideOnline`, không có "hoạt động lần cuối".
- Q6: reply chỉ tới tin cùng hội thoại còn hiệu lực; trích dẫn đọc lúc truy vấn; tin gốc không còn thì hiện "Tin nhắn không còn khả dụng".
- Q7: migration đã làm, DB test 18/18 qua.

## 11. Kế hoạch test hợp đồng (Bước 7)

| Lớp | Công cụ | Nội dung |
|---|---|---|
| Contract tĩnh (đã có) | `node --test` trong `api-contracts` | 17 test: `/v1`, rate limit + 503, không lấy `userId` từ body, strip `senderId`, không có bí mật trong response, lỗi không lộ thông tin, seq là chuỗi, username khớp SQL, reply preview, token restore, lời mời suppressed không lộ, purge event, OpenAPI đồng bộ |
| Response khớp schema | Supertest + zod `parse` trên mọi response trong e2e | Mỗi route trong `routes.ts` có ít nhất 1 test happy path + 1 test cho mỗi mã lỗi đã khai báo |
| Không lộ thông tin | e2e | Cặp request "tồn tại / không tồn tại", "bị chặn / không bạn" phải có **body giống hệt** (trừ `requestId`); đo 200 lần mỗi nhánh, chênh p50 < 15% |
| Bí mật | e2e + log capture | Quét log sau toàn bộ suite: không chuỗi nào khớp password/OTP/token đã dùng trong test |
| Đồng thời | e2e trên Postgres thật | 50 tin song song qua REST + WS trộn lẫn, seq liền mạch; gửi lặp `clientMsgId` qua cả REST và WS chỉ ra 1 tin |
| WS | `socket.io-client` | Handshake sai thì `connect_error`; `auth.expiring` → `auth.refresh`; đăng xuất từ xa thì nhận `session.revoked` rồi bị ngắt; presence/typing không tới người bị chặn |
| 410 | e2e | Chạy `prune_*` với interval 0, rồi gọi `/sync` và `/changes` với cursor cũ, kỳ vọng 410 |
| Postman (tùy chọn) | Import `openapi.yaml` → collection; `postman collection run` trong CI | Chạy smoke test trên môi trường dev. Chưa đẩy lên Postman cloud |
