-- Field-level permissions per role: { "deal": { "amount": "readonly", "custom.margin": "hidden" }, ... }.
-- Standard fields can be read-only; custom fields can be read-only or hidden. Admin roles ignore these rules.
ALTER TABLE roles ADD COLUMN field_rules jsonb NOT NULL DEFAULT '{}'::jsonb;
