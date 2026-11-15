-- "Not a duplicate": pairs hidden from the find-duplicates page. a_id < b_id.
CREATE TABLE duplicate_dismissals (
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type  text NOT NULL CHECK (entity_type IN ('contact','company')),
  a_id         bigint NOT NULL,
  b_id         bigint NOT NULL CHECK (b_id > a_id),
  dismissed_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_type, a_id, b_id)
);
