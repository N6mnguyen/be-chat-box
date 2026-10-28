CREATE TABLE app.google_identities (
  google_sub varchar(255) PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON app.google_identities TO vchat_app;
ALTER TABLE app.google_identities ENABLE ROW LEVEL SECURITY;
CREATE POLICY vchat_app_all ON app.google_identities TO vchat_app USING (true) WITH CHECK (true);
