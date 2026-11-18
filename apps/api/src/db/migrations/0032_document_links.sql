-- Customer links for quotes and invoices: a page where the customer views the document, accepts or declines a quote,
-- or pays an invoice by KHQR. The link token is stored hashed (to find the document) and encrypted (to show it again).
ALTER TABLE documents
  ADD COLUMN public_token_hash   text UNIQUE,
  ADD COLUMN public_token_sealed text,
  ADD COLUMN viewed_at           timestamptz,   -- first time the customer opened the link
  ADD COLUMN responded_at        timestamptz,   -- quote accepted or declined online
  ADD COLUMN responded_by_name   text,          -- the name the customer typed
  ADD COLUMN customer_note       text;          -- their note, or why they declined
