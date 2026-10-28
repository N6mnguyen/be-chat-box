ALTER TABLE app.messages ADD COLUMN IF NOT EXISTS edited_at timestamptz;

ALTER TABLE app.conversation_changes
  DROP CONSTRAINT IF EXISTS conversation_changes_kind_check;
ALTER TABLE app.conversation_changes
  ADD CONSTRAINT conversation_changes_kind_check
  CHECK (kind IN ('created','edited','recalled','purged','redacted'));

CREATE TABLE IF NOT EXISTS app.message_reactions (
  message_id uuid NOT NULL REFERENCES app.messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app.users(id),
  emoji varchar(16) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS message_reactions_message ON app.message_reactions (message_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON app.message_reactions TO vchat_app;
ALTER TABLE app.message_reactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vchat_app_all ON app.message_reactions;
CREATE POLICY vchat_app_all ON app.message_reactions
  TO vchat_app USING (true) WITH CHECK (true);
