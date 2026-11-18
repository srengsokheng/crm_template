-- Team notifications on Telegram: a person links their Telegram to the workspace's bot (one-time code through
-- t.me/<bot>?start=<code>), then every in-app notification is also sent to them there.
CREATE TABLE user_telegram (
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id   bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  chat_id      text NOT NULL,
  tg_name      text NOT NULL DEFAULT '',
  linked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE telegram_link_codes (
  code_hash    text PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL
);
-- Notifications already sent to Telegram (or not to send: created before the person linked).
ALTER TABLE notifications ADD COLUMN pushed_at timestamptz;
UPDATE notifications SET pushed_at = created_at;
CREATE INDEX notifications_to_push ON notifications (user_id, id) WHERE pushed_at IS NULL;
