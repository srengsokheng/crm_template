-- Automatic payment reminders for sent invoices with a balance: before the due date, on it, and after it.
-- Who gets them: the addresses the invoice was last emailed to (kept on the invoice from now on), and the Telegram bot
-- chats of the deal's contacts. One reminder per step (UNIQUE), so restarts and catch-ups never send twice.
ALTER TABLE documents ADD COLUMN email_to text[] NOT NULL DEFAULT '{}';
ALTER TABLE documents ADD COLUMN reminders_off boolean NOT NULL DEFAULT false;

-- Invoices emailed before this migration: take the recipients from the latest "emailed" event.
UPDATE documents d SET email_to = sub.recipients
FROM (
  SELECT DISTINCT ON ((e.changes->'document'->>'id')::bigint) (e.changes->'document'->>'id')::bigint AS doc_id,
    ARRAY(SELECT jsonb_array_elements_text(e.changes->'to')) AS recipients
  FROM audit_events e
  WHERE e.action = 'invoice_emailed' AND jsonb_typeof(e.changes->'to') = 'array' AND e.changes->'document'->>'id' ~ '^\d+$'
  ORDER BY (e.changes->'document'->>'id')::bigint, e.id DESC
) sub
WHERE d.id = sub.doc_id AND d.kind = 'invoice';

CREATE TABLE invoice_reminders (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id  bigint NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  step         text NOT NULL,              -- 'before:3', 'due', 'after:7' … or 'manual:<timestamp>'
  sent_to      text[] NOT NULL DEFAULT '{}',
  chats        int NOT NULL DEFAULT 0,      -- Telegram chats it went to
  balance      numeric(18,2) NOT NULL,
  sent_by      bigint REFERENCES users(id) ON DELETE SET NULL,   -- null: automatic
  sent_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, step)
);
CREATE INDEX invoice_reminders_doc ON invoice_reminders (document_id, sent_at DESC);
