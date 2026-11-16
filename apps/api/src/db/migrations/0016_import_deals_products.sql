-- CSV import of deals and products.
ALTER TABLE imports DROP CONSTRAINT imports_entity_type_check;
ALTER TABLE imports ADD CONSTRAINT imports_entity_type_check CHECK (entity_type IN ('contact','company','lead','deal','product'));
