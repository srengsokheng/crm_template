-- Broadcasts: one message to many customers — through a Telegram bot (people who chatted with it), WhatsApp (an
-- approved template) or email (contacts, with an unsubscribe link). Opting out: "STOP" in a chat, or the email link.
ALTER TABLE contacts ADD COLUMN email_opt_out_at timestamptz;
ALTER TABLE conversations ADD COLUMN opted_out_at timestamptz;

CREATE TABLE broadcasts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  channel_kind  text NOT NULL CHECK (channel_kind IN ('telegram_bot', 'whatsapp', 'email')),
  channel_id    bigint REFERENCES channels(id) ON DELETE CASCADE,   -- null for email
  subject       text NOT NULL DEFAULT '',                             -- email
  body          text NOT NULL DEFAULT '',                             -- Telegram and email; {{name}} {{first_name}}
  template      jsonb,                                                -- WhatsApp: { name, language, params }
  contact_type_id bigint REFERENCES dictionary_items(id) ON DELETE SET NULL,                                           -- email: only contacts of this type (optional)
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'canceled')),
  send_at       timestamptz,
  sent_at       timestamptz,
  created_by    bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((channel_kind = 'email') = (channel_id IS NULL))
);
CREATE INDEX broadcasts_due ON broadcasts (send_at) WHERE status IN ('scheduled', 'sending');

CREATE TABLE broadcast_recipients (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  broadcast_id    bigint NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  conversation_id bigint REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id      bigint REFERENCES contacts(id) ON DELETE SET NULL,
  name            text NOT NULL DEFAULT '',
  address         text NOT NULL DEFAULT '',                           -- email address (for email)
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'sent', 'failed', 'skipped')),
  message_id      bigint REFERENCES messages(id) ON DELETE SET NULL,  -- chat: the message in the conversation
  token_hash      text UNIQUE,                                        -- email: the unsubscribe link
  error           text,
  sent_at         timestamptz
);
CREATE INDEX broadcast_recipients_todo ON broadcast_recipients (broadcast_id, id) WHERE status = 'pending';
