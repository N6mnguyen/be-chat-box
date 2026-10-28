-- Role tối thiểu cho NestJS. Chạy sau schema.sql, bằng role sở hữu (postgres).
-- Mật khẩu đặt ngoài file này: ALTER ROLE vchat_app PASSWORD '...'; (secret store).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vchat_app') THEN
    CREATE ROLE vchat_app LOGIN NOINHERIT NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

ALTER ROLE vchat_app SET statement_timeout = '5s';
ALTER ROLE vchat_app SET lock_timeout = '3s';
ALTER ROLE vchat_app SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE vchat_app SET search_path = app;

REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO vchat_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO vchat_app;
-- reports: vchat_app không có quyền trực tiếp; chỉ ghi qua app.create_report (SECURITY DEFINER).
-- Chỉ vchat_moderator đọc và đóng vụ việc.
REVOKE ALL ON app.reports FROM vchat_app;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vchat_moderator') THEN
    CREATE ROLE vchat_moderator NOLOGIN; -- cấp cho tài khoản người xử lý bằng GRANT vchat_moderator TO ...
  END IF;
END $$;
GRANT USAGE ON SCHEMA app TO vchat_moderator;
GRANT SELECT ON app.reports TO vchat_moderator;
GRANT UPDATE (status, closed_at) ON app.reports TO vchat_moderator;
-- Append-only: audit_logs không UPDATE/DELETE; deletion_ledger chỉ cập nhật exported_at.
REVOKE UPDATE, DELETE ON app.audit_logs FROM vchat_app;
REVOKE UPDATE, DELETE ON app.deletion_ledger FROM vchat_app;
GRANT UPDATE (exported_at) ON app.deletion_ledger TO vchat_app;
-- Hàm mặc định cho PUBLIC execute; thu lại, chỉ vchat_app được gọi.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO vchat_app;

-- Supabase có sẵn anon/authenticated. Không cấp gì cho chúng trên schema app.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- RLS: lớp phòng thủ thứ hai, không phải phân quyền theo user (phân quyền nằm ở NestJS).
-- Bật RLS mọi bảng; chỉ vchat_app có policy. Role khác dù lỡ được GRANT vẫn thấy 0 hàng.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'app' LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS vchat_app_all ON app.%I', t);
    EXECUTE format('CREATE POLICY vchat_app_all ON app.%I TO vchat_app USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
DROP POLICY IF EXISTS moderator_reports ON app.reports;
CREATE POLICY moderator_reports ON app.reports TO vchat_moderator USING (true) WITH CHECK (true);
