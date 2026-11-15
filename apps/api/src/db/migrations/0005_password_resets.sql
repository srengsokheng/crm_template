-- Password reset by email. Only a hash of the token is stored; a token works once and expires after an hour.
CREATE TABLE password_resets (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user ON password_resets (user_id, created_at DESC);
