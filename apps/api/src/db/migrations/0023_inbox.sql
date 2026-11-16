-- Inbox: messaging channels (website chat, Telegram bots), the conversations that arrive through them, and messages.

CREATE TABLE channels (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id   bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('webchat','telegram_bot')),
  name           text NOT NULL,
  -- Random, public: the website widget's key and the Telegram webhook path segment.
  public_key     text NOT NULL UNIQUE,
  -- Non-secret settings: greeting, colour, allowed origins, bot username, delivery mode, polling offset.
  config         jsonb NOT NULL DEFAULT '{}',
  -- Credentials (the bot token), encrypted with SECRETS_KEY (AES-256-GCM). Never returned by the API.
  secret         text,
  -- Telegram sends this back in X-Telegram-Bot-Api-Secret-Token on every webhook call.
  webhook_secret text,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','error')),
  last_error     text,
  created_by     bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channels_workspace ON channels (workspace_id);

CREATE TABLE conversations (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id         bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id           bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  -- The chat on the platform: Telegram chat id; for website chat a hash of the visitor's token.
  external_id          text NOT NULL,
  kind                 text NOT NULL DEFAULT 'direct' CHECK (kind IN ('direct','group')),
  title                text NOT NULL,
  -- What we know about the other side: name, username, email, phone (as given by the platform or the visitor).
  profile              jsonb NOT NULL DEFAULT '{}',
  contact_id           bigint REFERENCES contacts(id) ON DELETE SET NULL,
  lead_id              bigint REFERENCES leads(id) ON DELETE SET NULL,
  assignee_id          bigint REFERENCES users(id) ON DELETE SET NULL,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  unread               int NOT NULL DEFAULT 0,
  last_message_at      timestamptz NOT NULL DEFAULT now(),
  last_message_preview text NOT NULL DEFAULT '',
  last_direction       text NOT NULL DEFAULT 'in' CHECK (last_direction IN ('in','out')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, external_id)
);
CREATE INDEX conversations_inbox ON conversations (workspace_id, status, last_message_at DESC);
CREATE INDEX conversations_contact ON conversations (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX conversations_lead ON conversations (lead_id) WHERE lead_id IS NOT NULL;

CREATE TABLE messages (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id    bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction       text NOT NULL CHECK (direction IN ('in','out')),
  -- The platform's message id (deduplicates webhook retries); null until an outgoing message is delivered.
  external_id     text,
  sender_name     text NOT NULL DEFAULT '',
  author_id       bigint REFERENCES users(id) ON DELETE SET NULL,
  body            text NOT NULL,
  status          text NOT NULL DEFAULT 'received' CHECK (status IN ('received','pending','sent','failed')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, direction, external_id)
);
CREATE INDEX messages_conversation ON messages (conversation_id, id);

-- New permission "conversation" (view = read the inbox, edit = reply, assign, close, link). Scope is by assignee;
-- unassigned conversations count as everyone's so they can be picked up. Custom roles start without it.
INSERT INTO role_grants (role_id, entity, action, scope)
SELECT r.id, 'conversation', a.action, CASE
    WHEN r.name = 'Manager' THEN 'all'
    WHEN r.name = 'Sales rep' THEN 'team'
    WHEN r.name = 'Viewer' AND a.action = 'view' THEN 'all'
    ELSE 'none' END
FROM roles r CROSS JOIN (VALUES ('view'), ('edit')) AS a(action)
WHERE r.is_system AND NOT r.is_admin
ON CONFLICT DO NOTHING;
