-- Quotes and invoices, created from a deal. A document gets its number when it is first sent, so deleting drafts never
-- leaves gaps in the numbering. Sent documents are not edited; invoices are voided instead.
CREATE TABLE documents (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id          bigint NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('quote','invoice')),
  number           text,
  status           text NOT NULL DEFAULT 'draft',
  currency         char(3) NOT NULL,
  issue_date       date,
  due_date         date,                 -- "valid until" for quotes
  bill_to_name     text NOT NULL DEFAULT '',
  bill_to_details  text NOT NULL DEFAULT '',
  notes            text NOT NULL DEFAULT '',
  list_total       numeric(18,2) NOT NULL DEFAULT 0,
  discount         numeric(18,2) NOT NULL DEFAULT 0,
  tax              numeric(18,2) NOT NULL DEFAULT 0,
  total            numeric(18,2) NOT NULL DEFAULT 0,
  source_quote_id  bigint REFERENCES documents(id) ON DELETE SET NULL,
  status_changed_at timestamptz,
  created_by       bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, number),
  CHECK ((kind = 'quote' AND status IN ('draft','sent','accepted','declined'))
      OR (kind = 'invoice' AND status IN ('draft','sent','paid','void'))),
  CHECK (status = 'draft' OR number IS NOT NULL)
);
CREATE INDEX documents_deal ON documents (workspace_id, deal_id, created_at DESC);

CREATE TABLE document_items (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id    bigint NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  product_id     bigint REFERENCES products(id) ON DELETE SET NULL,
  name           text NOT NULL,
  unit_price     numeric(18,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  quantity       numeric(14,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit           text NOT NULL DEFAULT 'pcs',
  discount_type  text CHECK (discount_type IN ('percent','amount')),
  discount_value numeric(18,2) NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  tax_rate       numeric(5,2) CHECK (tax_rate >= 0 AND tax_rate <= 100),
  tax_included   boolean NOT NULL DEFAULT false,
  line_total     numeric(18,2) NOT NULL DEFAULT 0,
  sort           int NOT NULL DEFAULT 0
);
CREATE INDEX document_items_doc ON document_items (document_id, sort);

-- Per-workspace running numbers (row-locked while a number is taken).
CREATE TABLE document_counters (
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  last_no      int NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, kind)
);
