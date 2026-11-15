-- Saved list views: owner_id NULL = shared with the whole workspace (admins create those), otherwise personal.
ALTER TABLE saved_views ADD CONSTRAINT saved_views_entity CHECK (entity_type IN ('lead','deal','contact','company'));
CREATE INDEX saved_views_lookup ON saved_views (workspace_id, entity_type, owner_id);
