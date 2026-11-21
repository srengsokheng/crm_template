-- Recurring invoices: a schedule made from an invoice; on each date the worker creates a new invoice with the same
-- items and bill-to, as a draft or sent by email.
CREATE TABLE recurring_invoices (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id          bigint NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  source_id        bigint REFERENCES documents(id) ON DELETE SET NULL,
  every_months     int NOT NULL CHECK (every_months IN (1, 2, 3, 6, 12)),
  start_on         date NOT NULL,
  next_run         date NOT NULL,
  ends_after       int CHECK (ends_after BETWEEN 1 AND 120),
  -- next_run = start_on + every_months × period; runs = invoices made (for ends_after). Resuming skips periods.
  period           int NOT NULL DEFAULT 0,
  runs             int NOT NULL DEFAULT 0,
  mode             text NOT NULL CHECK (mode IN ('draft', 'send')),
  email_to         text[] NOT NULL DEFAULT '{}',
  message          text NOT NULL DEFAULT '',
  -- What each new invoice gets (copied from the invoice when the schedule was made).
  currency         char(3) NOT NULL,
  bill_to_name     text NOT NULL DEFAULT '',
  bill_to_details  text NOT NULL DEFAULT '',
  notes            text NOT NULL DEFAULT '',
  items            jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  last_error       text,
  last_document_id bigint REFERENCES documents(id) ON DELETE SET NULL,
  created_by       bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recurring_due ON recurring_invoices (next_run) WHERE status = 'active';
CREATE INDEX recurring_deal ON recurring_invoices (workspace_id, deal_id);
