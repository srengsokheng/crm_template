-- What each merge changed, so it can be undone (for 7 days, while the kept record hasn't been edited since).
CREATE TABLE merge_snapshots (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type  text NOT NULL CHECK (entity_type IN ('contact','company','lead')),
  survivor_id  bigint NOT NULL,
  merged_ids   bigint[] NOT NULL,
  snapshot     jsonb NOT NULL,
  created_by   bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  undone_at    timestamptz,
  undone_by    bigint REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX merge_snapshots_survivor ON merge_snapshots (workspace_id, entity_type, survivor_id, id DESC);
