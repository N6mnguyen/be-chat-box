# Bước 1 — Phân tích yêu cầu, user stories, bảng quyết định, rủi ro

> Trạng thái: **v3 — ĐÃ XÁC NHẬN**. Tên kỹ thuật tiếng Anh, diễn giải tiếng Việt.
>
> Đã chốt: không sinh client từ OpenAPI; MVP chưa partition `messages`; OTP qua email; tài khoản username + email + password; chỉ bạn bè mới nhắn tin được; người đã xóa tài khoản hiển thị "Người dùng đã xóa"; có tính năng chặn trong MVP; tin của người đã xóa tài khoản mặc định giữ nguyên (`retain`); nơi host chưa chốt.
>
> Phạm vi v3: ứng dụng chat 1-1 giữa bạn bè trên desktop. Không có phạm vi AI.

## 0. Hiện trạng workspace

| Mục | Thực tế | Hệ quả thiết kế |
|---|---|---|
| `vchat/` | Nx 24, Angular 22, TypeScript ~6.0, Vitest, npm workspaces | Backend đặt ở `vchat/apps/api`; lib chia sẻ nằm trong cùng workspace |
| Client storage | Dexie (IndexedDB) | Client local-first nên sync delta theo seq |
| `be/` | Chỉ chứa tài liệu thiết kế | — |
| TS 6 | NestJS hỗ trợ chính thức TS 5.x | R12: chạy thử scaffold sớm |
| Hosting | Chưa chốt, chờ tư vấn pháp lý | Dev dùng docker-compose (Postgres, MinIO, Mailpit); Redis chỉ thêm khi chạy nhiều instance hoặc tách worker. Không phụ thuộc vị trí hay nhà cung cấp |

## 1. Phân tích yêu cầu

### 1.1 Chức năng (theo module)

| Module | Cốt lõi MVP | Để chỗ (đã có schema/contract, chưa có logic) |
|---|---|---|
| auth | Đăng ký username + email + password, xác minh bằng OTP email. Đăng nhập bằng "username hoặc email" + password. Quên mật khẩu, đổi mật khẩu, đổi email, OTP cho thiết bị mới. Access JWT + refresh xoay vòng theo thiết bị. Danh sách thiết bị, đăng xuất từ xa. Rate limit, khóa tạm | `OtpChannel` cho SMS/ZNS; mã khôi phục (§1.7) |
| users | Hồ sơ, settings đồng bộ (có `newDeviceOtp`), xuất dữ liệu (job), xóa toàn bộ tin tôi đã gửi (job), xóa tài khoản: xóa mềm rồi xóa cứng (job), kèm audit | — |
| friends | Tìm theo username/QR, lời mời kết bạn, hủy kết bạn, **chặn/bỏ chặn** | Báo cáo vi phạm |
| presence | Online và "đang gõ", chỉ gửi cho bạn bè; chỉ trong bộ nhớ sau interface `PresenceStore` | "Lần cuối truy cập" |
| conversations/messages | `type ∈ {direct, group}`. `direct` là chat 1-1 giữa bạn bè. `group` **chỉ để chỗ trong schema, chưa có logic**; API từ chối tạo. Seq tăng đơn điệu theo từng hội thoại. Idempotent bằng `clientMsgId`. Phân trang cursor. Thu hồi tin, xóa phía tôi | reactions, pins, logic group |
| attachments | Upload qua presigned URL (S3 API), khử trùng SHA-256 **trong phạm vi từng user**, giới hạn dung lượng, kiểm magic bytes, link tải có chữ ký | Quét virus |
| sync | Delta theo `seq`/`updatedAt` (giờ server), tombstone, optimistic `version` | — |
| notifications | Đăng ký thiết bị nhận thông báo, tắt thông báo theo hội thoại. App tự hiện thông báo khay hệ thống từ sự kiện WS | Web Push/FCM |
| licensing | Trạng thái gói, giới hạn số thiết bị, interface webhook | Tích hợp cổng thanh toán cụ thể |
| admin/ops | health, metrics, audit log, feature flags | Admin UI |

### 1.2 Luồng tài khoản

**Ràng buộc định danh**
- `username`: 3–30 ký tự `[a-z0-9_.]`, lưu dạng lowercase, unique, không phân biệt hoa thường. Không bắt đầu hoặc kết thúc bằng `.`, không có `..`. Chặn danh sách từ khóa cấm (file config) và username đang bị giữ chỗ (`reserved_usernames`).
- `email`: trim và lowercase để so sánh, không gộp alias, unique trên các email đã xác minh.
- `password`: 8–128 ký tự Unicode, chuẩn hóa NFKC. Chặn mật khẩu phổ biến (danh sách đóng gói sẵn ~100k), chặn mật khẩu trùng username hoặc trùng phần trước `@` của email. Không áp quy tắc bắt buộc loại ký tự.

**Băm mật khẩu và pepper**
- `hash = Argon2id(HMAC-SHA256(pepper[v], NFKC(password)))`. Lưu `password_hash` (dạng PHC, đã chứa tham số) cùng `pepper_version`.
- Pepper nằm trong **kho bí mật** (secret manager ở production; dev dùng `.env`): `PEPPERS={"v1":"…","v2":"…"}`, `PEPPER_CURRENT=v2`. Không bao giờ lưu trong DB.
- **Xoay pepper:** thêm `v2` và đặt làm current. Khi user đăng nhập thành công với hash `v1`, server băm lại bằng `v2` (kèm tham số Argon2 mới nếu đã đổi). Chỉ gỡ `v1` khi không còn hash nào dùng nó; tài khoản còn sót lại bị buộc reset mật khẩu. HMAC của OTP, refresh token, deviceToken và mã khôi phục dùng chung cơ chế có phiên bản này.
- Tham số Argon2 lấy từ env, khởi điểm theo OWASP (kiểm tra khuyến nghị hiện hành).

**Bảo vệ CPU** (thứ tự cố định cho mọi endpoint có băm)
1. Kiểm tra rate limit (IP, identifier, IP + identifier) và trạng thái khóa tạm. Vượt thì trả 429 **trước khi băm**.
2. Xin một slot của semaphore Argon2 trong instance (`ARGON2_MAX_CONCURRENCY`, mặc định = số CPU). Chờ quá `ARGON2_QUEUE_TIMEOUT_MS` thì trả 503 kèm `Retry-After`.
3. Băm (băm thật, hoặc băm giả khi không có tài khoản), rồi trả slot.

**Đăng ký** — `POST /v1/auth/register {username, email, password}` → `202 {registrationId}` (ngoài lỗi validate và `409 USERNAME_TAKEN`)
- Email đã thuộc tài khoản `active`: không tạo gì, đưa mail cảnh báo cho chủ email vào hàng đợi. Phản hồi giống hệt bình thường; `registrationId` khi đó là giá trị giả nên verify luôn thất bại.
- Email đang `pending`: đăng ký đè (thay username, password; hủy OTP cũ).
- Còn lại: tạo user `pending` (hết hạn sau 24h, cấu hình được) và gửi OTP 6 số.
- `POST /v1/auth/register/verify {registrationId, code}` → chuyển `active`, cấp token và deviceToken. Job dọn dẹp xóa các pending đã hết hạn.

**Tài khoản `pending` không có quyền gì**
- Không bao giờ được cấp access token, refresh token hay deviceToken. Chỉ dùng được `registrationId` cho `verify` và `resend`.
- Không xuất hiện khi tìm theo username, không nhận được lời mời kết bạn, không có hội thoại. Đăng nhập thì trả `INVALID_CREDENTIALS`.
- Guard xác thực kiểm tra `status = 'active'` (claim trong token, kết hợp danh sách thu hồi trong bộ nhớ cho `deleting`/`deleted`; chuyển sang Redis khi có nhiều instance). Có test e2e riêng cho điều này.

**Đăng nhập** — `POST /v1/auth/login {identifier, password, deviceToken?}`
- `identifier` có `@` thì tìm theo email, ngược lại tìm theo username. Không tìm thấy hoặc tài khoản không `active`: băm giả rồi trả `401 INVALID_CREDENTIALS` (một mã lỗi duy nhất).
- Đúng mật khẩu, `newDeviceOtp` đang bật và không có `deviceToken` hợp lệ → `200 {challenge:'device_otp', challengeId}` và gửi OTP.

**deviceToken (thiết bị tin cậy)**
- Chỉ được cấp **sau khi đăng nhập thành công**. Là chuỗi opaque 256-bit; server lưu HMAC, gắn với một hàng `devices`.
- App lưu bằng Electron `safeStorage`. Mỗi lần dùng, server kiểm tra token có thuộc đúng `devices.id` đó không.
- Bị thu hồi khi: đăng xuất từ xa, tự đăng xuất, reset mật khẩu, xóa tài khoản.
- Quyền lợi **duy nhất**: miễn khóa tạm theo identifier và không phải nhập OTP thiết bị mới. Vẫn chịu rate limit theo IP, rate limit chung và semaphore CPU.

**Quên mật khẩu**: `forgot {email}` luôn trả 202; chỉ gửi OTP nếu email `active`. `reset {email, code, newPassword}` → **thu hồi mọi refresh token và deviceToken**, ngắt WS, gửi mail thông báo.

**Đổi mật khẩu**: cần mật khẩu cũ; thu hồi refresh và deviceToken của các thiết bị khác.

**Đổi email**: cần mật khẩu; OTP gửi tới **email mới**; xác nhận xong thì báo cho **email cũ**. Nếu email mới đã thuộc người khác: vẫn trả 202 và không gửi OTP.

**OTP**: 6 số, sinh bằng CSPRNG, server lưu HMAC có phiên bản. Hết hạn sau ~10 phút, tối đa 5 lần nhập sai, chỉ dùng một lần. Mỗi mã gắn `purpose ∈ {register, device, reset, email_change}`. Gửi qua `OtpChannel` (MVP: `EmailOtpChannel`).

### 1.3 Rate limit và trần gửi mail (giá trị khởi điểm, cấu hình qua env)

| Khóa | Ngưỡng | Khi vượt |
|---|---|---|
| login theo IP | 20/phút, 200/giờ | 429 + `Retry-After` (áp cả với thiết bị tin cậy) |
| login theo identifier | 10 lần sai/15 phút | Khóa tạm 1→5→15→60 phút, không bao giờ vĩnh viễn; thiết bị tin cậy được miễn |
| login theo IP + identifier | 5 lần sai/15 phút | 429 |
| Mail OTP theo email | 5/giờ, 10/ngày, giãn cách ≥ 60 giây | Vẫn trả 202 nhưng không gửi |
| Mail OTP theo IP / theo thiết bị | 20/ngày / 10/ngày | 429 |
| Mail OTP toàn hệ thống | Trần/ngày theo hạn mức nhà cung cấp mail (kiểm tra tài liệu hiện hành) | Cảnh báo ops; ưu tiên mail reset và OTP |
| Nhập sai OTP | 5 lần/mã | Hủy mã |
| Lời mời kết bạn | 30/ngày/user | 429 |

Bộ đếm sliding window trong bộ nhớ sau interface `RateLimitStore` (MVP một tiến trình). Khi có nhiều instance thì chuyển sang Redis; lúc đó nếu Redis lỗi: endpoint gửi mail **fail-closed**, login dùng giới hạn trong bộ nhớ của từng instance. Mail gửi từ tên miền riêng, cấu hình **SPF, DKIM, DMARC** (bắt đầu `p=none` rồi nâng dần). Dev dùng Mailpit.

### 1.4 Bạn bè, chặn, chat 1-1

- `GET /v1/users/by-username/:username` chỉ trả thông tin công khai. QR chứa `vchat://u/<username>`.
- Lời mời kết bạn: `pending → accepted | declined`. Hai bên cùng mời nhau thì tự chấp nhận.
- **Chỉ bạn bè mới nhắn được**; server kiểm tra ở mọi lần ghi tin. Sau khi hủy kết bạn vẫn đọc được lịch sử nhưng không gửi được tin mới.
- Mỗi cặp user có đúng một hội thoại `direct`.

**Chặn** — `user_blocks(blocker_id, blocked_id)`

| Quy tắc | Cách thực hiện |
|---|---|
| Chặn sẽ hủy kết bạn và mọi lời mời đang chờ, cả hai chiều | Cùng transaction với việc tạo block |
| Bên bị chặn không gửi được lời mời | Vẫn trả **202 như thành công** nhưng không tạo gì |
| Bên bị chặn không gửi được tin | `403 FRIENDSHIP_REQUIRED`, giống hệt khi không còn là bạn bè |
| Không thấy online/"đang gõ" của người chặn | Lọc ở khâu fan-out presence |
| Không tìm thấy người chặn | `by-username` trả `404 NOT_FOUND`, giống username không tồn tại |
| Không biết mình bị chặn | Không có sự kiện hay mã lỗi nào riêng cho việc bị chặn |
| Bỏ chặn không khôi phục tình bạn | Chỉ xóa hàng block |
| Người chặn | Vẫn xem được lịch sử và danh sách người mình đã chặn |

Giới hạn chấp nhận: lỗi `409 USERNAME_TAKEN` khi đăng ký cho biết username tồn tại. Chấp nhận được vì username là thông tin công khai.

### 1.5 Xóa dữ liệu và xóa tài khoản

**Màn hình xác nhận xóa tài khoản** hiển thị: *"Tin bạn đã gửi vẫn hiển thị với người nhận dưới tên 'Người dùng đã xóa'. Nếu không muốn, hãy dùng 'Xóa toàn bộ tin tôi đã gửi' trước."* ⚖ **Câu chữ chờ ý kiến pháp lý.**

**Xóa toàn bộ tin tôi đã gửi** — `POST /v1/me/messages/purge` (cần nhập lại mật khẩu; chạy bằng job; idempotent)
- Mọi tin user này đã gửi trở thành tombstone đối với **tất cả** các bên: xóa nội dung, gỡ liên kết file. Mỗi tin bị xóa nhận `seq` mới để các thiết bị đồng bộ được.
- Dùng được độc lập, không cần xóa tài khoản. Audit chỉ ghi số lượng tin.

**Xóa tài khoản** — `DELETE /v1/me` (cần nhập lại mật khẩu)
- Chuyển sang `deleting`, có thời gian ân hạn (cấu hình được); đăng nhập lại thì hủy được. Hết hạn thì job xóa cứng: identities, password hash, devices, token, settings, quan hệ bạn bè, block, file chỉ mình sở hữu.
- Giữ một **tombstone** của `users` (`id`, `status='deleted'`, không còn PII). Client hiển thị "Người dùng đã xóa".
- Tin đã gửi được xử lý theo `DELETED_USER_MESSAGES = retain | redact_content`, mặc định `retain`. ⚖ **Chờ ý kiến pháp lý.**
- **Giữ chỗ username**: `reserved_usernames.reserved_until = now + USERNAME_HOLD_DAYS` (đề xuất 180 ngày, cấu hình được), để chống mạo danh. Hết hạn thì job giải phóng.

### 1.6 Phi chức năng

| Thuộc tính | Mục tiêu MVP | Ghi chú |
|---|---|---|
| Tải | 10k user, 2k WS đồng thời | ~150k tin/ngày, ~55M tin/năm; một node Postgres là đủ |
| Scale ngang | MVP: 1 tiến trình `APP_ROLE=all`. Scale: nhiều instance + Redis (Socket.IO adapter, `PresenceStore`, `RateLimitStore`) | Chỉ transport `websocket`, không cần sticky session |
| Độ trễ | p95 REST < 200ms (trừ các endpoint có băm mật khẩu), fan-out WS < 300ms | — |
| Bền vững | Tin đã ack thì không mất; ghi trùng là no-op | — |
| Thời gian | Giờ server là nguồn chân lý | — |
| Riêng tư | Log không chứa nội dung tin, mật khẩu, OTP, token | — |

### 1.7 Mất quyền truy cập email

**MVP:** còn thiết bị tin cậy thì vẫn đăng nhập và đổi email được. Không còn thiết bị tin cậy nào thì chỉ còn hỗ trợ thủ công.

**Quy trình hỗ trợ thủ công**
1. Người yêu cầu gửi form hỗ trợ từ một email mới.
2. Nhân viên đối chiếu các bằng chứng **không công khai**: thời điểm đăng ký gần đúng, bạn bè gần đây, thiết bị và lần đăng nhập cuối, giao dịch thanh toán nếu có. Không nhận ảnh giấy tờ tùy thân: dễ làm giả, và tạo thêm dữ liệu nhạy cảm phải lưu.
3. Đạt yêu cầu → **chờ 7 ngày**; gửi thông báo tới email cũ và mọi thiết bị còn đăng nhập. Chủ tài khoản thật có thể hủy trong thời gian này.
4. Hết thời gian chờ → đổi email, buộc đặt lại mật khẩu, thu hồi mọi token. MVP **một người duyệt**; audit log bắt buộc ghi người duyệt, loại bằng chứng, thời điểm, và không sửa/xóa được. Thêm người duyệt thứ hai khi đội hỗ trợ có từ 2 người.

**Rủi ro giả mạo chủ tài khoản:** đây là kênh social engineering. Người quen của nạn nhân có thể biết đủ thông tin để vượt qua bước 2. Thời gian chờ, thông báo ra mọi kênh và audit log giúp giảm nhưng không loại bỏ được rủi ro này → R9.

**Mã khôi phục (giai đoạn sớm sau MVP; bảng có sẵn từ MVP)**
- 10 mã ngẫu nhiên (~50 bit mỗi mã), hiển thị **một lần** ngay sau khi xác minh đăng ký, bắt người dùng xác nhận đã lưu. Người dùng cũ được nhắc tạo.
- Server lưu HMAC có phiên bản; mỗi mã dùng một lần; tạo lại thì vô hiệu toàn bộ bộ cũ.
- Dùng: `identifier + mã` → đặt mật khẩu mới và đổi email (OTP tới email mới). Thu hồi mọi token, báo cho email cũ. Rate limit như login.
- Bảng `recovery_codes(user_id, code_hash, pepper_version, used_at)`.

### 1.8 Giả định

- A1. MVP chỉ có hội thoại `direct`, giữa 2 user là bạn bè.
- A2. Ít người ghi đồng thời trên một hội thoại, nên khóa hàng theo hội thoại là chấp nhận được.
- A3. Nội dung tin lưu plaintext, mã hóa at-rest. E2EE ngoài phạm vi.
- A4. Client MVP là desktop; refresh token và deviceToken lưu trong `safeStorage`.
- A5. Giá và hạn mức của bên thứ ba cấu hình được, không hardcode.

### 1.9 Ngoài phạm vi

Logic chat nhóm, gọi thoại/video, nhật ký, admin UI, tích hợp cổng thanh toán cụ thể, E2EE, OAuth/SĐT, TOTP, báo cáo vi phạm.

## 2. User stories

**Tài khoản**
- US1. Đăng ký và kích hoạt bằng OTP. *AC: tài khoản pending không gọi được API nào; bị xóa sau 24h; đăng ký lại cùng email thì đè lên.*
- US2. Đăng ký bằng email đã có chủ: phản hồi giống hệt bình thường; chủ email nhận cảnh báo.
- US3. Đăng nhập bằng username hoặc email. *AC: mọi trường hợp sai đều trả cùng `INVALID_CREDENTIALS`, thời gian phản hồi tương đương.*
- US4. Thiết bị mới phải nhập OTP (mặc định bật); tắt được, cần nhập lại mật khẩu khi tắt.
- US5. Quên mật khẩu. *AC: mọi thiết bị bị đăng xuất và mất trạng thái tin cậy.*
- US6. Đổi email: OTP tới email mới, thông báo tới email cũ.
- US7. Danh sách thiết bị, đăng xuất từ xa. *AC: refresh và deviceToken của thiết bị đó bị thu hồi; WS bị ngắt ngay.*
- US8. Bị khóa tạm vẫn đăng nhập được từ thiết bị tin cậy, nhưng vẫn chịu rate limit theo IP.

**Bạn bè**
- US9. Tìm theo username/QR; gửi, chấp nhận, từ chối lời mời; hủy kết bạn.
- US10. Chặn. *AC: tình bạn và lời mời bị hủy; bên bị chặn không tìm thấy, không mời được, không nhắn được, không thấy online/"đang gõ" của người chặn, và không có dấu hiệu nào cho thấy mình bị chặn.*
- US11. Bỏ chặn. *AC: không tự thành bạn bè lại.*
- US12. Thấy bạn bè online và "đang gõ" theo thời gian thực.

**Nhắn tin**
- US13. Chat 1-1 với bạn bè. *AC: người không phải bạn bè nhận 403; tin hiện realtime trên mọi thiết bị của cả hai bên.*
- US14. Gửi lại khi mạng chập chờn không bị trùng (cùng `clientMsgId` → trả về tin cũ với cùng `seq`).
- US15. Mở app trên máy khác sau khi offline: nhận đủ delta, không thiếu, không trùng.
- US16. Thu hồi tin hoặc xóa phía tôi.
- US17. Gửi file; file trùng với file mình đã gửi thì không phải upload lại.
- US18. Tắt thông báo theo hội thoại; settings đồng bộ giữa các máy.

**Dữ liệu cá nhân**
- US19. Xuất toàn bộ dữ liệu, nhận link tải có hạn.
- US20. Xóa toàn bộ tin tôi đã gửi. *AC: người nhận thấy tombstone trên mọi thiết bị.*
- US21. Xóa tài khoản: thấy chính sách trên màn hình xác nhận; có ân hạn, hủy được; sau đó hiện "Người dùng đã xóa"; username bị giữ chỗ 180 ngày.
- US22. Vượt số thiết bị cho phép của gói thì bị từ chối, kèm danh sách thiết bị để gỡ.

**Ops**
- US23. health, readiness, metrics: số WS, độ trễ cấp seq, độ sâu hàng đợi, mail bounce, đăng nhập thất bại, số slot Argon2 đang dùng và số lần 503.
- US24. Audit log: các sự kiện auth, đăng xuất từ xa, chặn (chỉ ghi id), xuất dữ liệu, xóa tin hàng loạt, xóa tài khoản, khôi phục thủ công, webhook thanh toán, feature flag.

## 3. Bảng quyết định

| # | Quyết định | Chọn | Lý do chính |
|---|---|---|---|
| D1 | Auth | **Tự quản**: access JWT ~10 phút (ký bất đối xứng, có `kid`), refresh opaque xoay vòng, phát hiện reuse | Đăng nhập bằng username, thiết bị tin cậy, giới hạn số thiết bị đằng nào cũng phải tự làm; không khóa vào nhà cung cấp |
| D1b | Thư viện Argon2 | **`@node-rs/argon2`** | Có binary dựng sẵn, không cần node-gyp |
| D2 | ORM | **Drizzle** | Phần seq/idempotent viết SQL thuần (`ON CONFLICT`, `RETURNING`) |
| D2b | Validation | **zod** trong `api-contracts`, không sinh client | Angular import trực tiếp |
| D3 | Realtime | **Socket.IO**, chỉ transport websocket; Redis adapter khi >1 instance | Có sẵn rooms/ack/heartbeat; resume theo seq |
| D6 | Partition `messages` | **Chưa làm ở MVP** | Unique phải chứa partition key |
| D7 | Mô hình hội thoại | **Một bảng `conversations`**, `type ∈ {direct, group}`, cùng `conversation_members` | `group` chỉ để chỗ. MVP chỉ cho phép `direct` có đúng 2 thành viên (kiểm ở API; Bước 3 có ràng buộc DB) |
| D8 | Người đã xóa | **Tombstone `users`** | Khóa ngoại vẫn hợp lệ, không lặp PII |
| D9 | Dedup file | **Theo từng user**: `unique(owner_id, sha256)` | Dedup chéo user làm lộ việc "ai đó có file này" |
| D10 | Presence | **Trong bộ nhớ sau `PresenceStore`**; Redis (TTL) khi >1 instance | Dữ liệu tạm thời; MVP một tiến trình nên không cần Redis |
| D14 | Hàng đợi job | **Bảng `jobs` trên Postgres** (`FOR UPDATE SKIP LOCKED`), thay BullMQ | Không có Redis ở MVP; job cần bền (xóa cứng sau ân hạn), chạy được nhiều worker. Chỉ cân nhắc BullMQ khi throughput job vượt khả năng Postgres |

(Số D4, D5 bỏ trống vì đã gỡ cùng phạm vi AI; giữ nguyên số để tham chiếu ổn định.)

## 4. Rủi ro

| # | Rủi ro | Mức | Giảm thiểu |
|---|---|---|---|
| R2 | Nội dung tin lưu plaintext | Cao | Mã hóa at-rest, TLS, phân quyền DB tối thiểu, log không chứa nội dung |
| R3 | NĐ 13/2023, Luật Bảo vệ dữ liệu cá nhân (hiệu lực 01/01/2026), NĐ 53/2022. ⚖ **Chờ pháp lý:** nơi host; giữ tin của người đã xóa tài khoản; câu chữ màn hình xóa | Cao | Policy cấu hình được; có "xóa toàn bộ tin tôi đã gửi"; không phụ thuộc nơi host |
| R4 | Credential stuffing | Cao | Rate limit theo IP/identifier; chặn mật khẩu phổ biến; OTP thiết bị mới mặc định bật |
| R5 | Spam mail OTP | Cao | Trần theo email/IP/thiết bị/toàn hệ thống; giãn cách 60 giây; mail không chứa nội dung do người dùng nhập |
| R6 | Lộ `password_hash` | Cao | Argon2id + pepper có phiên bản trong kho bí mật; token và OTP chỉ lưu HMAC; backup được mã hóa |
| R7 | Chiếm chỗ username | TB | Pending chỉ giữ 24h; danh sách từ khóa cấm; thu hồi username theo khiếu nại có audit |
| R8 | Mail vào thư rác | TB | SPF/DKIM/DMARC, tên miền gửi riêng, theo dõi bounce, nút gửi lại |
| R9 | Mất email; giả mạo chủ tài khoản qua kênh hỗ trợ thủ công | Cao | Thiết bị tin cậy; quy trình §1.7; mã khôi phục ngay sau MVP |
| R10 | Khóa tạm bị lợi dụng để khóa tài khoản người khác | TB | Thiết bị tin cậy được miễn; trần 60 phút |
| R11 | Dò email (enumeration) | TB | Phản hồi và thời gian đồng nhất; mail qua hàng đợi; băm giả; `registrationId` giả |
| R12 | NestJS chưa tương thích TS 6 | TB | Chạy thử scaffold sớm; fallback pin TS 5 cho `api` |
| R13 | DoS bằng CPU qua Argon2 | TB | Rate limit trước khi băm; semaphore; 503 kèm `Retry-After` |
| R14 | Quấy rối qua lời mời và tin nhắn | TB | Chỉ bạn bè mới nhắn được; chặn; rate limit lời mời |
| R15 | Trùng/hụt seq; xung đột đa thiết bị | TB | Khóa hàng theo hội thoại; optimistic `version` |
| R16 | Người dùng kỳ vọng riêng tư như E2EE | TB | Chính sách riêng tư nói rõ server đọc được nội dung |
| R17 | Licensing bị bypass trên desktop | TB | Chỉ cưỡng chế phần thuộc server |
| R18 | Connection pooler ở chế độ transaction | TB | Lock theo transaction; không dùng prepared statements; không dùng `LISTEN/NOTIFY` |
| R19 | MVP một tiến trình: là điểm lỗi duy nhất; restart thì mất presence và bộ đếm rate limit | TB | Health check + tự restart; client resume theo seq; job bền trong Postgres. Khi scale: Redis có replica, mail fail-closed |
| R20 | Upload file độc hại | TB | Kiểm magic bytes, allowlist MIME, `Content-Disposition: attachment` |
| R21 | Lộ quan hệ chặn qua kênh phụ (thời gian phản hồi, số đếm) | Thấp | Phản hồi đồng nhất; không trả số bạn bè của người khác |

(R1 đã gỡ cùng phạm vi AI; giữ nguyên số để tham chiếu ổn định.)
