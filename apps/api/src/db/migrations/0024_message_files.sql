-- Files on Inbox messages: photos, documents, voice notes from Telegram; files the team sends with a reply.
CREATE TABLE message_files (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id       bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_name        text NOT NULL,
  content_type     text NOT NULL,
  size_bytes       bigint,
  -- pending = still being downloaded from the platform; too_large / blocked (virus scanner) / failed are kept so the
  -- thread can say why the file isn't there.
  status           text NOT NULL DEFAULT 'stored' CHECK (status IN ('pending','stored','too_large','blocked','failed')),
  -- Set once stored (files() storage, like record attachments).
  storage_key      text UNIQUE,
  -- The platform's file reference (Telegram file_id), to download incoming files.
  platform_file_id text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_files_message ON message_files (message_id);
