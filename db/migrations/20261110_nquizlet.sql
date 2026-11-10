ALTER TABLE app.users
  ADD COLUMN IF NOT EXISTS is_bot boolean NOT NULL DEFAULT false;

ALTER TABLE app.messages
  ADD COLUMN IF NOT EXISTS message_type varchar(24) NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS structured_payload jsonb,
  ADD COLUMN IF NOT EXISTS study_session_id uuid;

ALTER TABLE app.messages
  DROP CONSTRAINT IF EXISTS messages_structured_payload_check;
ALTER TABLE app.messages
  ADD CONSTRAINT messages_structured_payload_check CHECK (
    (message_type = 'text' AND structured_payload IS NULL AND study_session_id IS NULL)
    OR (
      message_type = 'study_result'
      AND jsonb_typeof(structured_payload) = 'object'
      AND study_session_id IS NOT NULL
    )
  );
ALTER TABLE app.messages
  DROP CONSTRAINT IF EXISTS messages_message_type_check;
ALTER TABLE app.messages
  ADD CONSTRAINT messages_message_type_check
    CHECK (message_type IN ('text', 'study_result'));

CREATE UNIQUE INDEX IF NOT EXISTS messages_study_session_unique
  ON app.messages (study_session_id)
  WHERE study_session_id IS NOT NULL;

INSERT INTO app.users (id, username, display_name, avatar_key, status, is_bot)
VALUES (
  'b1000000-0000-4000-8000-000000000001',
  'nquizlet',
  'NQuizlet',
  'nquizlet',
  'active',
  true
)
ON CONFLICT (id) DO UPDATE SET
  username = EXCLUDED.username,
  display_name = EXCLUDED.display_name,
  avatar_key = EXCLUDED.avatar_key,
  status = 'active',
  is_bot = true,
  updated_at = now();

INSERT INTO app.user_settings (user_id, discoverable)
VALUES ('b1000000-0000-4000-8000-000000000001', 'nobody')
ON CONFLICT (user_id) DO UPDATE SET
  discoverable = 'nobody',
  updated_at = now();
