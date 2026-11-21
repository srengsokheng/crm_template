-- Inbox saved replies: text the team inserts into replies. Personal (owner only) or shared with the workspace.
CREATE TABLE saved_replies (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared       boolean NOT NULL DEFAULT false,
  title        text NOT NULL CHECK (length(trim(title)) > 0),
  body         text NOT NULL CHECK (length(trim(body)) > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_replies_workspace ON saved_replies (workspace_id, lower(title));
