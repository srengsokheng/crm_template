-- Payments against invoices (partial payments), and when a document was last emailed from the CRM.
CREATE TABLE document_payments (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id  bigint NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  amount       numeric(18,2) NOT NULL CHECK (amount > 0),
  paid_on      date NOT NULL,
  method       text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  created_by   bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_payments_doc ON document_payments (document_id, paid_on, id);

-- Sum of payments, kept on the document so lists can sort and total by balance.
ALTER TABLE documents ADD COLUMN paid_amount numeric(18,2) NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN last_emailed_at timestamptz;

-- Invoices marked as paid before payments existed: record the full amount as one payment.
INSERT INTO document_payments (workspace_id, document_id, amount, paid_on, method, created_by)
SELECT workspace_id, id, total, coalesce(status_changed_at::date, issue_date, created_at::date), 'Marked as paid', created_by
FROM documents WHERE kind = 'invoice' AND status = 'paid' AND total > 0;
UPDATE documents SET paid_amount = total WHERE kind = 'invoice' AND status = 'paid';

CREATE INDEX documents_list ON documents (workspace_id, kind, status, due_date);
