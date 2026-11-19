-- A drawn signature when a customer accepts a quote online: pen strokes (not an image) in a 300×100 box, drawn as
-- lines on the PDF and as SVG on screen. The IP address and browser are kept with it as evidence of who signed.
ALTER TABLE documents
  ADD COLUMN signature jsonb,
  ADD COLUMN signed_ip text,
  ADD COLUMN signed_user_agent text;
