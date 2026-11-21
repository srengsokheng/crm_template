-- Changing your sign-in email: a confirmation link is sent to the new address; the change happens when it's opened.
CREATE TABLE email_changes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  new_email  citext NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_changes_user ON email_changes (user_id, created_at DESC);
