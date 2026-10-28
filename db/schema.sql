-- vchat schema v1 (Bước 3). Nguồn duy nhất cho DDL; tài liệu tham chiếu file này.
-- Chạy bằng role sở hữu (postgres trên Supabase) qua DIRECT_URL. Sau đó chạy roles.sql.
-- Schema riêng "app" (không phải public): Supabase Data API mặc định chỉ expose public.
-- UUID do app sinh; thời gian do DB cấp; seq BIGINT trả qua API dạng string.

CREATE SCHEMA app;

CREATE TABLE app.users (
  id uuid PRIMARY KEY,
  username varchar(30),
  display_name varchar(80),
  avatar_key text,
  password_hash text,
  pepper_version varchar(16),
  status varchar(12) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','deleting','deleted')),
  pending_expires_at timestamptz,
  deletion_due_at timestamptz,
  deleted_at timestamptz,
  profile_version integer NOT NULL DEFAULT 1 CHECK (profile_version > 0),
  change_seq bigint NOT NULL DEFAULT 0 CHECK (change_seq >= 0),
  -- user_changes có seq <= floor đã bị dọn; cursor < floor -> 410 SYNC_CURSOR_EXPIRED.
  changes_floor_seq bigint NOT NULL DEFAULT 0 CHECK (changes_floor_seq >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT username_format CHECK (
    username IS NULL OR (username = lower(username)
      AND username ~ '^[a-z0-9_][a-z0-9_.]{1,28}[a-z0-9_]$'
      AND username !~ '\.\.')),
  CONSTRAINT deleted_user_anonymous CHECK (
    status <> 'deleted' OR (username IS NULL AND display_name IS NULL
      AND avatar_key IS NULL AND password_hash IS NULL AND pepper_version IS NULL)),
  CONSTRAINT pending_has_expiry CHECK (status <> 'pending' OR pending_expires_at IS NOT NULL),
  CONSTRAINT changes_floor_le_seq CHECK (changes_floor_seq <= change_seq)
);
CREATE UNIQUE INDEX users_username_unique ON app.users (username) WHERE username IS NOT NULL;
CREATE INDEX users_pending_expiry ON app.users (pending_expires_at) WHERE status = 'pending';
CREATE INDEX users_deletion_due ON app.users (deletion_due_at) WHERE status = 'deleting';

CREATE TABLE app.identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users(id),
  type varchar(16) NOT NULL CHECK (type IN ('email','phone')),
  value text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_canonical CHECK (value = lower(btrim(value)) AND length(value) BETWEEN 3 AND 320),
  CONSTRAINT identities_type_value_unique UNIQUE (type, value)
);
CREATE INDEX identities_user_id_idx ON app.identities (user_id);

CREATE TABLE app.reserved_usernames (
  username varchar(30) PRIMARY KEY,
  reserved_until timestamptz NOT NULL,
  previous_user_id uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reserved_usernames_expiry ON app.reserved_usernames (reserved_until);

CREATE TABLE app.user_settings (
  user_id uuid PRIMARY KEY REFERENCES app.users(id),
  new_device_otp boolean NOT NULL DEFAULT true,
  locale varchar(8) NOT NULL DEFAULT 'vi',
  notifications_enabled boolean NOT NULL DEFAULT true,
  -- ai tìm/mời được tôi; 'nobody': lời mời vẫn lưu nhưng suppressed (không lộ cài đặt)
  discoverable varchar(8) NOT NULL DEFAULT 'everyone' CHECK (discoverable IN ('everyone','nobody')),
  read_receipts boolean NOT NULL DEFAULT true, -- đối xứng: tắt thì không gửi, không nhận readSeq
  hide_online boolean NOT NULL DEFAULT false,  -- ẩn online/typing với mọi bạn bè
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.devices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users(id),
  name varchar(120) NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  token_pepper_version varchar(16) NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX devices_user_active ON app.devices (user_id) WHERE revoked_at IS NULL;
CREATE INDEX devices_revoked ON app.devices (revoked_at) WHERE revoked_at IS NOT NULL;

CREATE TABLE app.refresh_tokens (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES app.devices(id),
  family_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  pepper_version varchar(16) NOT NULL,
  replaced_by uuid REFERENCES app.refresh_tokens(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX refresh_family_live ON app.refresh_tokens (family_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX refresh_device_family ON app.refresh_tokens (device_id, family_id);
CREATE INDEX refresh_expiry ON app.refresh_tokens (expires_at);

CREATE TABLE app.auth_challenges (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES app.users(id),
  purpose varchar(16) NOT NULL CHECK (purpose IN ('register','device','reset','email_change')),
  target_email text NOT NULL,
  code_hash bytea NOT NULL,
  pepper_version varchar(16) NOT NULL,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  pending_device_name varchar(120),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_challenges_user_open ON app.auth_challenges (user_id, purpose, expires_at)
  WHERE consumed_at IS NULL;
CREATE INDEX auth_challenges_expiry ON app.auth_challenges (expires_at);

CREATE TABLE app.recovery_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users(id),
  code_hash bytea NOT NULL UNIQUE,
  pepper_version varchar(16) NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_codes_user ON app.recovery_codes (user_id);

CREATE TABLE app.friend_requests (
  id uuid PRIMARY KEY,
  sender_id uuid NOT NULL REFERENCES app.users(id),
  recipient_id uuid NOT NULL REFERENCES app.users(id),
  status varchar(10) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','declined','cancelled','expired')),
  -- true: gửi khi có block (hai chiều) hoặc người nhận discoverable='nobody'.
  -- Người nhận không thấy; người gửi thấy như lời mời đang chờ. Không bao giờ đổi lại false.
  suppressed boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id)
);
CREATE UNIQUE INDEX friend_requests_one_pending ON app.friend_requests (sender_id, recipient_id)
  WHERE status = 'pending';
CREATE INDEX friend_requests_inbox ON app.friend_requests (recipient_id, created_at DESC)
  WHERE status = 'pending' AND NOT suppressed;
CREATE INDEX friend_requests_outbox ON app.friend_requests (sender_id, created_at DESC)
  WHERE status = 'pending';
CREATE INDEX friend_requests_expiry ON app.friend_requests (expires_at) WHERE status = 'pending';

CREATE TABLE app.friendships (
  user_low uuid NOT NULL REFERENCES app.users(id),
  user_high uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_low, user_high),
  CHECK (user_low < user_high)
);
CREATE INDEX friendships_high ON app.friendships (user_high, user_low);

CREATE TABLE app.user_blocks (
  blocker_id uuid NOT NULL REFERENCES app.users(id),
  blocked_id uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX user_blocks_blocked ON app.user_blocks (blocked_id, blocker_id);

CREATE TABLE app.conversations (
  id uuid PRIMARY KEY,
  type varchar(8) NOT NULL CHECK (type IN ('direct','group')), -- group: chừa chỗ, API chưa tạo
  direct_user_low uuid REFERENCES app.users(id),
  direct_user_high uuid REFERENCES app.users(id),
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  -- conversation_changes có seq <= floor đã bị dọn; cursor < floor -> 410.
  changes_floor_seq bigint NOT NULL DEFAULT 0 CHECK (changes_floor_seq >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'direct' AND direct_user_low IS NOT NULL AND direct_user_high IS NOT NULL
          AND direct_user_low < direct_user_high)
      OR (type = 'group' AND direct_user_low IS NULL AND direct_user_high IS NULL)),
  CHECK (changes_floor_seq <= last_seq)
);
CREATE UNIQUE INDEX conversations_one_direct ON app.conversations (direct_user_low, direct_user_high)
  WHERE type = 'direct';

CREATE TABLE app.conversation_members (
  conversation_id uuid NOT NULL REFERENCES app.conversations(id),
  user_id uuid NOT NULL REFERENCES app.users(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  muted boolean NOT NULL DEFAULT false,
  pinned_at timestamptz,
  hidden_at timestamptz,
  -- Chỉ tăng (UPDATE ... GREATEST), kẹp <= conversations.last_seq. Không ràng buộc read <= delivered:
  -- đọc trên máy khác có thể báo trước delivered.
  last_delivered_seq bigint NOT NULL DEFAULT 0 CHECK (last_delivered_seq >= 0),
  last_read_seq bigint NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user ON app.conversation_members (user_id, conversation_id);

CREATE TABLE app.messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES app.conversations(id),
  sender_id uuid NOT NULL REFERENCES app.users(id),
  client_msg_id uuid NOT NULL,
  -- SHA-256 của payload canonical; retry cùng client_msg_id khác payload -> 409.
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  created_seq bigint NOT NULL CHECK (created_seq > 0),
  latest_seq bigint NOT NULL, -- seq của thay đổi gần nhất (= created_seq khi chưa thu hồi/purge)
  -- Trích dẫn đọc từ tin gốc lúc truy vấn; KHÔNG sao chép nội dung gốc vào đây.
  reply_to_id uuid,
  body text,
  body_deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_conversation_seq_unique UNIQUE (conversation_id, created_seq),
  CONSTRAINT messages_conversation_client_id_unique UNIQUE (conversation_id, client_msg_id),
  CONSTRAINT messages_conversation_id_unique UNIQUE (conversation_id, id),
  CONSTRAINT messages_reply_same_conversation FOREIGN KEY (conversation_id, reply_to_id)
    REFERENCES app.messages (conversation_id, id),
  CHECK (body_deleted_at IS NULL OR body IS NULL),
  CHECK (latest_seq >= created_seq),
  CHECK (reply_to_id IS NULL OR reply_to_id <> id)
);
CREATE INDEX messages_sender ON app.messages (sender_id, id);

-- Change log: chỉ id, loại, seq. Không body (trạng thái hiện tại đọc từ messages).
CREATE TABLE app.conversation_changes (
  conversation_id uuid NOT NULL REFERENCES app.conversations(id),
  seq bigint NOT NULL CHECK (seq > 0),
  message_id uuid NOT NULL,
  kind varchar(12) NOT NULL CHECK (kind IN ('created','recalled','purged','redacted')),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq),
  FOREIGN KEY (conversation_id, message_id) REFERENCES app.messages (conversation_id, id)
);
CREATE INDEX conversation_changes_changed_at ON app.conversation_changes (changed_at);

CREATE TABLE app.message_hidden_for (
  message_id uuid NOT NULL REFERENCES app.messages(id),
  user_id uuid NOT NULL REFERENCES app.users(id),
  hidden_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_hidden_for_user ON app.message_hidden_for (user_id, message_id);

-- Báo cáo vi phạm. vchat_app chỉ INSERT (qua app.create_report); chỉ vchat_moderator đọc (roles.sql).
-- ⚖ snapshot là bản sao nội dung tin (gồm vài tin liền kề); không bị purge xóa; thời hạn chờ pháp lý.
CREATE TABLE app.reports (
  id uuid PRIMARY KEY, -- = Idempotency-Key của client
  reporter_id uuid NOT NULL REFERENCES app.users(id),
  target_user_id uuid REFERENCES app.users(id),
  message_id uuid,
  conversation_id uuid REFERENCES app.conversations(id),
  reason varchar(16) NOT NULL CHECK (reason IN ('spam','harassment','other')),
  note varchar(1000),
  snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  status varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK ((target_user_id IS NULL) <> (message_id IS NULL)),
  CHECK ((message_id IS NULL) = (conversation_id IS NULL)),
  CHECK (status <> 'closed' OR closed_at IS NOT NULL)
);
CREATE INDEX reports_open ON app.reports (created_at) WHERE status = 'open';
CREATE INDEX reports_closed ON app.reports (closed_at) WHERE status = 'closed';

CREATE TABLE app.user_changes (
  user_id uuid NOT NULL REFERENCES app.users(id),
  seq bigint NOT NULL CHECK (seq > 0),
  entity_type varchar(24) NOT NULL CHECK (entity_type IN
    ('profile','settings','device','friend_request','friendship','block',
     'conversation','message_visibility')),
  entity_id uuid NOT NULL,
  kind varchar(8) NOT NULL CHECK (kind IN ('upsert','delete')),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, seq)
);
CREATE INDEX user_changes_changed_at ON app.user_changes (changed_at);

-- Chừa chỗ cho file đính kèm (sau MVP đợt đầu). API chưa bật.
CREATE TABLE app.attachments (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES app.users(id),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  object_key text NOT NULL UNIQUE,
  file_name varchar(255) NOT NULL,
  mime_type varchar(100) NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  status varchar(10) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','verifying','ready','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, sha256)
);
CREATE TABLE app.message_attachments (
  message_id uuid NOT NULL REFERENCES app.messages(id),
  attachment_id uuid NOT NULL REFERENCES app.attachments(id),
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 19),
  PRIMARY KEY (message_id, attachment_id),
  UNIQUE (message_id, position)
);
CREATE INDEX message_attachments_attachment ON app.message_attachments (attachment_id);

CREATE TABLE app.plans (
  id varchar(32) PRIMARY KEY,
  max_devices smallint NOT NULL CHECK (max_devices > 0),
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE app.licenses (
  user_id uuid PRIMARY KEY REFERENCES app.users(id),
  plan_id varchar(32) NOT NULL REFERENCES app.plans(id),
  status varchar(12) NOT NULL CHECK (status IN ('active','expired','suspended')),
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.billing_events (
  provider varchar(64) NOT NULL,
  event_id varchar(255) NOT NULL,
  user_id uuid NOT NULL REFERENCES app.licenses(user_id),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE app.feature_flags (
  name varchar(80) PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only với vchat_app (roles.sql); dọn qua app.prune_audit_logs().
-- metadata allowlist: không body, password, OTP, token, email, tên file.
CREATE TABLE app.audit_logs (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES app.users(id),
  subject_id uuid REFERENCES app.users(id),
  action varchar(80) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_subject ON app.audit_logs (subject_id, created_at DESC);
CREATE INDEX audit_logs_created ON app.audit_logs (created_at);

-- Sổ xóa: chỉ id, không PII. Bản sao ngoài DB (job export) để áp lại sau khi khôi phục backup.
CREATE TABLE app.deletion_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_type varchar(16) NOT NULL CHECK (subject_type IN ('account','messages_purge')),
  subject_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  exported_at timestamptz
);
CREATE INDEX deletion_ledger_unexported ON app.deletion_ledger (id) WHERE exported_at IS NULL;

-- Hàng đợi job. kind do app validate (zod); payload chỉ id, không PII.
CREATE TABLE app.jobs (
  id uuid PRIMARY KEY,
  kind varchar(40) NOT NULL,
  idempotency_key varchar(200) NOT NULL UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(10) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','done','failed')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts smallint NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  run_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  locked_until timestamptz,
  last_error varchar(500),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'running' OR (lease_token IS NOT NULL AND locked_until IS NOT NULL)),
  CHECK (attempts <= max_attempts)
);
CREATE INDEX jobs_claimable ON app.jobs (run_at, id) WHERE status IN ('queued','running');
CREATE INDEX jobs_finished ON app.jobs (finished_at) WHERE status IN ('done','failed');

-- ===== Gửi tin: cấp seq không trùng/không hụt, idempotent theo client_msg_id =====
-- Lỗi trả SQLSTATE riêng, NestJS map sang HTTP: VC403 -> 403, VC409 -> 409, VC410 -> 410.
-- Thứ tự khóa cố định: advisory lock cặp user -> row lock conversation.
-- Mọi thao tác chặn/hủy bạn phải lấy cùng advisory lock cặp (app.pair_lock_key) trước.
CREATE FUNCTION app.pair_lock_key(a uuid, b uuid) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended(least(a, b)::text || greatest(a, b)::text, 0)
$$;

-- p_request_hash do app tính: SHA-256(canonical {body, replyToId, attachments}).
CREATE FUNCTION app.send_direct_message(
  p_id uuid, p_conversation uuid, p_sender uuid,
  p_client_msg_id uuid, p_request_hash bytea, p_body text, p_reply_to uuid DEFAULT NULL)
RETURNS TABLE (message_id uuid, seq bigint, duplicate boolean)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  c app.conversations%ROWTYPE;
  m record;
  new_seq bigint;
BEGIN
  SELECT * INTO c FROM app.conversations WHERE id = p_conversation;
  IF NOT FOUND OR c.type <> 'direct'
     OR p_sender NOT IN (c.direct_user_low, c.direct_user_high) THEN
    RAISE EXCEPTION USING ERRCODE = 'VC403', MESSAGE = 'FORBIDDEN';
  END IF;

  PERFORM pg_advisory_xact_lock(app.pair_lock_key(c.direct_user_low, c.direct_user_high));
  PERFORM 1 FROM app.conversations WHERE id = p_conversation FOR UPDATE;

  -- Kiểm trùng SAU khi giữ khóa: bản gửi lặp đồng thời thấy bản đầu đã commit.
  SELECT id, created_seq, request_hash INTO m
    FROM app.messages WHERE conversation_id = p_conversation AND client_msg_id = p_client_msg_id;
  IF FOUND THEN
    IF m.request_hash <> p_request_hash THEN
      RAISE EXCEPTION USING ERRCODE = 'VC409', MESSAGE = 'IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN QUERY SELECT m.id, m.created_seq, true;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app.users WHERE id = p_sender AND status = 'active')
     OR NOT EXISTS (SELECT 1 FROM app.friendships
                     WHERE user_low = c.direct_user_low AND user_high = c.direct_user_high)
     OR EXISTS (SELECT 1 FROM app.user_blocks
                 WHERE (blocker_id = c.direct_user_low AND blocked_id = c.direct_user_high)
                    OR (blocker_id = c.direct_user_high AND blocked_id = c.direct_user_low)) THEN
    RAISE EXCEPTION USING ERRCODE = 'VC403', MESSAGE = 'FRIENDSHIP_REQUIRED';
  END IF;

  -- Reply: cùng hội thoại, chưa thu hồi, chưa bị người gửi ẩn. Sai -> VC400 (VALIDATION_FAILED).
  IF p_reply_to IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app.messages r
        WHERE r.conversation_id = p_conversation AND r.id = p_reply_to AND r.body_deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM app.message_hidden_for h
                           WHERE h.message_id = r.id AND h.user_id = p_sender)) THEN
    RAISE EXCEPTION USING ERRCODE = 'VC400', MESSAGE = 'INVALID_REPLY';
  END IF;

  UPDATE app.conversations SET last_seq = last_seq + 1, updated_at = now()
   WHERE id = p_conversation RETURNING last_seq INTO new_seq;
  INSERT INTO app.messages (id, conversation_id, sender_id, client_msg_id, request_hash,
                            created_seq, latest_seq, reply_to_id, body)
  VALUES (p_id, p_conversation, p_sender, p_client_msg_id, p_request_hash,
          new_seq, new_seq, p_reply_to, p_body);
  INSERT INTO app.conversation_changes (conversation_id, seq, message_id, kind)
  VALUES (p_conversation, new_seq, p_id, 'created');
  RETURN QUERY SELECT p_id, new_seq, false;
END $$;

-- ===== Thu hồi: người gửi, trong p_window (24h) theo giờ server; seq mới, xóa body =====
-- VC404: không có tin / không phải thành viên. VC403: không phải người gửi. VC422: quá hạn.
-- Thu hồi lần 2: idempotent, trả seq đã có, không cấp seq mới.
CREATE FUNCTION app.recall_message(p_conversation uuid, p_message uuid, p_user uuid, p_window interval)
RETURNS TABLE (message_id uuid, seq bigint, already boolean)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  c app.conversations%ROWTYPE;
  m app.messages%ROWTYPE;
  new_seq bigint;
BEGIN
  SELECT * INTO c FROM app.conversations WHERE id = p_conversation;
  IF NOT FOUND OR p_user NOT IN (c.direct_user_low, c.direct_user_high) THEN
    RAISE EXCEPTION USING ERRCODE = 'VC404', MESSAGE = 'NOT_FOUND';
  END IF;
  -- Cùng thứ tự khóa với send_direct_message: cặp -> conversation.
  PERFORM pg_advisory_xact_lock(app.pair_lock_key(c.direct_user_low, c.direct_user_high));
  PERFORM 1 FROM app.conversations WHERE id = p_conversation FOR UPDATE;

  SELECT * INTO m FROM app.messages WHERE conversation_id = p_conversation AND id = p_message;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'VC404', MESSAGE = 'NOT_FOUND'; END IF;
  IF m.sender_id <> p_user THEN RAISE EXCEPTION USING ERRCODE = 'VC403', MESSAGE = 'FORBIDDEN'; END IF;
  IF m.body_deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT m.id, m.latest_seq, true; RETURN;
  END IF;
  IF m.created_at < now() - p_window THEN
    RAISE EXCEPTION USING ERRCODE = 'VC422', MESSAGE = 'RECALL_WINDOW_EXPIRED';
  END IF;

  UPDATE app.conversations SET last_seq = last_seq + 1, updated_at = now()
   WHERE id = p_conversation RETURNING last_seq INTO new_seq;
  UPDATE app.messages SET body = NULL, body_deleted_at = now(), latest_seq = new_seq, updated_at = now()
   WHERE id = p_message;
  DELETE FROM app.message_attachments WHERE message_id = p_message;
  INSERT INTO app.conversation_changes (conversation_id, seq, message_id, kind)
  VALUES (p_conversation, new_seq, p_message, 'recalled');
  RETURN QUERY SELECT p_message, new_seq, false;
END $$;

-- ===== Lời mời kết bạn: một đường SQL, luôn tạo bản ghi (suppressed nếu bị chặn/ẩn) =====
-- Cùng code path, cùng số round-trip cho mọi trường hợp -> không lộ quan hệ chặn qua thời gian.
-- Trả: 'created' | 'suppressed' | 'auto_accepted' | 'noop' (người nhận không tồn tại/không active,
-- đã là bạn, đã có lời mời chờ). API luôn 202, không trả giá trị này ra ngoài.
CREATE FUNCTION app.send_friend_request(p_id uuid, p_sender uuid, p_username text, p_ttl interval)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  rcp uuid; lo uuid; hi uuid; blocked boolean; hidden boolean; reverse_id uuid;
BEGIN
  SELECT u.id INTO rcp FROM app.users u
   WHERE u.username = lower(p_username) AND u.status = 'active' AND u.id <> p_sender;
  IF rcp IS NULL THEN RETURN 'noop'; END IF;
  lo := least(p_sender, rcp); hi := greatest(p_sender, rcp);
  PERFORM pg_advisory_xact_lock(app.pair_lock_key(lo, hi));

  IF EXISTS (SELECT 1 FROM app.friendships WHERE user_low = lo AND user_high = hi)
     OR EXISTS (SELECT 1 FROM app.friend_requests
                 WHERE sender_id = p_sender AND recipient_id = rcp AND status = 'pending') THEN
    RETURN 'noop';
  END IF;

  blocked := EXISTS (SELECT 1 FROM app.user_blocks
                      WHERE (blocker_id = rcp AND blocked_id = p_sender)
                         OR (blocker_id = p_sender AND blocked_id = rcp));
  hidden := EXISTS (SELECT 1 FROM app.user_settings WHERE user_id = rcp AND discoverable = 'nobody');

  -- Hai bên cùng mời (bản kia không suppressed, không bị chặn) -> kết bạn luôn.
  SELECT id INTO reverse_id FROM app.friend_requests
   WHERE sender_id = rcp AND recipient_id = p_sender AND status = 'pending' AND NOT suppressed
     AND expires_at > now();
  IF reverse_id IS NOT NULL AND NOT blocked THEN
    UPDATE app.friend_requests SET status = 'accepted', updated_at = now() WHERE id = reverse_id;
    INSERT INTO app.friendships (user_low, user_high) VALUES (lo, hi);
    RETURN 'auto_accepted';
  END IF;

  INSERT INTO app.friend_requests (id, sender_id, recipient_id, suppressed, expires_at)
  VALUES (p_id, p_sender, rcp, blocked OR hidden, now() + p_ttl);
  RETURN CASE WHEN blocked OR hidden THEN 'suppressed' ELSE 'created' END;
END $$;

-- ===== Chặn: hủy bạn + lời mời chờ hai chiều, cùng advisory lock với gửi tin =====
CREATE FUNCTION app.block_user(p_blocker uuid, p_blocked uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_blocker = p_blocked THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(app.pair_lock_key(p_blocker, p_blocked));
  DELETE FROM app.friendships
   WHERE user_low = least(p_blocker, p_blocked) AND user_high = greatest(p_blocker, p_blocked);
  UPDATE app.friend_requests SET status = 'cancelled', updated_at = now()
   WHERE status = 'pending'
     AND ((sender_id = p_blocker AND recipient_id = p_blocked)
       OR (sender_id = p_blocked AND recipient_id = p_blocker AND NOT suppressed));
  -- Lời mời suppressed từ người bị chặn giữ nguyên: người gửi vẫn thấy "đang chờ" tới khi hết hạn.
  INSERT INTO app.user_blocks (blocker_id, blocked_id) VALUES (p_blocker, p_blocked)
  ON CONFLICT DO NOTHING;
END $$;

-- ===== Báo cáo: server tự chụp tin + tối đa p_context tin liền kề mỗi phía =====
-- VC404 nếu người báo cáo không thuộc hội thoại hoặc tin không tồn tại. Idempotent theo p_id.
CREATE FUNCTION app.create_report(
  p_id uuid, p_reporter uuid, p_target_user uuid, p_message uuid,
  p_reason text, p_note text, p_context int)
-- SECURITY DEFINER: vchat_app không có quyền nào trên reports; chỉ ghi được qua hàm này.
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE conv uuid; ms bigint; snap jsonb := '[]'::jsonb;
BEGIN
  IF p_message IS NOT NULL THEN
    SELECT m.conversation_id, m.created_seq INTO conv, ms
      FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id
     WHERE m.id = p_message AND p_reporter IN (c.direct_user_low, c.direct_user_high);
    IF conv IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'VC404', MESSAGE = 'NOT_FOUND'; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', m.id, 'senderId', m.sender_id, 'seq', m.created_seq::text,
             'body', m.body, 'createdAt', m.created_at) ORDER BY m.created_seq), '[]'::jsonb)
      INTO snap
      FROM app.messages m
     WHERE m.conversation_id = conv AND m.created_seq BETWEEN ms - p_context AND ms + p_context;
  ELSIF NOT EXISTS (SELECT 1 FROM app.users WHERE id = p_target_user) THEN
    RAISE EXCEPTION USING ERRCODE = 'VC404', MESSAGE = 'NOT_FOUND';
  END IF;
  INSERT INTO app.reports (id, reporter_id, target_user_id, message_id, conversation_id, reason, note, snapshot)
  VALUES (p_id, p_reporter, p_target_user, p_message, conv, p_reason, p_note, snap)
  ON CONFLICT (id) DO NOTHING;
  RETURN p_id;
END $$;

-- ===== Mã khôi phục: xóa bộ cũ + chèn bộ mới trong một transaction (9.11) =====
CREATE FUNCTION app.replace_recovery_codes(p_user uuid, p_hashes bytea[], p_pepper varchar)
RETURNS void LANGUAGE sql AS $$
  DELETE FROM app.recovery_codes WHERE user_id = p_user;
  INSERT INTO app.recovery_codes (id, user_id, code_hash, pepper_version)
  SELECT gen_random_uuid(), p_user, h, p_pepper FROM unnest(p_hashes) AS h;
$$;

-- ===== Đọc change log; cursor cũ hơn phần đã dọn -> VC410 (HTTP 410 SYNC_CURSOR_EXPIRED) =====
-- STABLE: một snapshot cho cả kiểm floor lẫn đọc, không lệch với job dọn chạy song song.
CREATE FUNCTION app.conversation_changes_since(p_conversation uuid, p_after bigint, p_limit int)
RETURNS TABLE (seq bigint, message_id uuid, kind varchar)
LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
BEGIN
  IF p_after < (SELECT changes_floor_seq FROM app.conversations WHERE id = p_conversation) THEN
    RAISE EXCEPTION USING ERRCODE = 'VC410', MESSAGE = 'SYNC_CURSOR_EXPIRED';
  END IF;
  RETURN QUERY
    SELECT cc.seq, cc.message_id, cc.kind FROM app.conversation_changes cc
     WHERE cc.conversation_id = p_conversation AND cc.seq > p_after
     ORDER BY cc.seq LIMIT p_limit;
END $$;

CREATE FUNCTION app.user_changes_since(p_user uuid, p_after bigint, p_limit int)
RETURNS TABLE (seq bigint, entity_type varchar, entity_id uuid, kind varchar)
LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
BEGIN
  IF p_after < (SELECT changes_floor_seq FROM app.users WHERE id = p_user) THEN
    RAISE EXCEPTION USING ERRCODE = 'VC410', MESSAGE = 'SYNC_CURSOR_EXPIRED';
  END IF;
  RETURN QUERY
    SELECT uc.seq, uc.entity_type, uc.entity_id, uc.kind FROM app.user_changes uc
     WHERE uc.user_id = p_user AND uc.seq > p_after
     ORDER BY uc.seq LIMIT p_limit;
END $$;

-- ===== Dọn change log: xóa tiền tố cũ, nâng floor trong cùng transaction =====
-- ponytail: một transaction cho toàn bộ; khi bảng lớn thì chia lô theo conversation.
CREATE FUNCTION app.prune_conversation_changes(older_than interval) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE r record; n bigint := 0; d bigint;
BEGIN
  FOR r IN SELECT conversation_id, max(seq) AS upto FROM app.conversation_changes
            WHERE changed_at < now() - older_than GROUP BY conversation_id LOOP
    UPDATE app.conversations SET changes_floor_seq = greatest(changes_floor_seq, r.upto)
     WHERE id = r.conversation_id;
    DELETE FROM app.conversation_changes WHERE conversation_id = r.conversation_id AND seq <= r.upto;
    GET DIAGNOSTICS d = ROW_COUNT; n := n + d;
  END LOOP;
  RETURN n;
END $$;

CREATE FUNCTION app.prune_user_changes(older_than interval) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE r record; n bigint := 0; d bigint;
BEGIN
  FOR r IN SELECT user_id, max(seq) AS upto FROM app.user_changes
            WHERE changed_at < now() - older_than GROUP BY user_id LOOP
    UPDATE app.users SET changes_floor_seq = greatest(changes_floor_seq, r.upto) WHERE id = r.user_id;
    DELETE FROM app.user_changes WHERE user_id = r.user_id AND seq <= r.upto;
    GET DIAGNOSTICS d = ROW_COUNT; n := n + d;
  END LOOP;
  RETURN n;
END $$;

-- ===== Hàng đợi job: SKIP LOCKED, visibility timeout (lease), số lần thử tối đa =====
-- Enqueue idempotent: INSERT ... ON CONFLICT (idempotency_key) DO NOTHING.
CREATE FUNCTION app.claim_jobs(p_limit int, p_lease interval)
RETURNS SETOF app.jobs LANGUAGE plpgsql AS $$
BEGIN
  -- Lease hết hạn mà đã hết lượt thử -> failed (worker chết giữa chừng quá nhiều lần).
  UPDATE app.jobs SET status = 'failed', finished_at = now(), updated_at = now(),
         last_error = coalesce(last_error, 'lease expired')
   WHERE status = 'running' AND locked_until < now() AND attempts >= max_attempts;

  RETURN QUERY
  WITH c AS (
    SELECT id FROM app.jobs
     WHERE ((status = 'queued' AND run_at <= now())
         OR (status = 'running' AND locked_until < now()))
       AND attempts < max_attempts
     ORDER BY run_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit)
  UPDATE app.jobs j
     SET status = 'running', attempts = j.attempts + 1, lease_token = gen_random_uuid(),
         locked_until = now() + p_lease, updated_at = now()
    FROM c WHERE j.id = c.id
  RETURNING j.*;
END $$;

-- Trả false nếu lease không còn thuộc worker này (đã bị worker khác nhận lại).
CREATE FUNCTION app.complete_job(p_id uuid, p_lease uuid) RETURNS boolean
LANGUAGE sql AS $$
  WITH u AS (
    UPDATE app.jobs SET status = 'done', finished_at = now(), updated_at = now(),
           lease_token = NULL, locked_until = NULL
     WHERE id = p_id AND lease_token = p_lease AND status = 'running' RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$$;

-- Backoff mũ: 30s * 2^(attempts-1), trần 1h.
CREATE FUNCTION app.fail_job(p_id uuid, p_lease uuid, p_error text) RETURNS boolean
LANGUAGE sql AS $$
  WITH u AS (
    UPDATE app.jobs SET
      status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
      finished_at = CASE WHEN attempts >= max_attempts THEN now() END,
      run_at = now() + least(interval '1 hour', interval '30 seconds' * power(2, attempts - 1)),
      last_error = left(p_error, 500), lease_token = NULL, locked_until = NULL, updated_at = now()
     WHERE id = p_id AND lease_token = p_lease AND status = 'running' RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$$;

-- Dọn audit log quá hạn: chạy với quyền owner, vì vchat_app không có DELETE trên audit_logs.
CREATE FUNCTION app.prune_audit_logs(older_than interval)
RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  WITH d AS (DELETE FROM app.audit_logs WHERE created_at < now() - older_than RETURNING 1)
  SELECT count(*) FROM d;
$$;
