-- CSV import of product lines onto existing deals ("Products on deals").
ALTER TABLE imports DROP CONSTRAINT imports_entity_type_check;
ALTER TABLE imports ADD CONSTRAINT imports_entity_type_check CHECK (entity_type IN ('contact','company','lead','deal','product','deal_line'));
