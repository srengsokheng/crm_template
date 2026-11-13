-- CSV import of contacts, companies and leads.
-- One row per uploaded file. The parsed cells are kept so mapping can be changed before running and so the
-- report can show the original values of failed rows; the purge job clears them 30 days after the import finished.
CREATE TABLE imports (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type   text NOT NULL CHECK (entity_type IN ('contact','company','lead')),
  file_name     text NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','running','done','failed','canceled')),
  headers       jsonb NOT NULL,                 -- string[]
  rows          jsonb,                          -- string[][]; NULL once purged
  row_numbers   jsonb NOT NULL DEFAULT '[]',    -- spreadsheet row number of each data row
  row_count     int NOT NULL,
  mapping       jsonb NOT NULL DEFAULT '[]',    -- (target key | null)[] per column
  options       jsonb NOT NULL DEFAULT '{}',
  processed     int NOT NULL DEFAULT 0,
  created_count int NOT NULL DEFAULT 0,
  updated_count int NOT NULL DEFAULT 0,
  skipped_count int NOT NULL DEFAULT 0,
  failed_count  int NOT NULL DEFAULT 0,
  results       jsonb NOT NULL DEFAULT '[]',    -- [{i, action, id?, message?}] per processed row
  error         text,
  undone_at     timestamptz,
  created_by    bigint NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
CREATE INDEX imports_workspace ON imports (workspace_id, created_at DESC);

-- New "import" permission (lead/contact/company). Built-in Manager roles get it; other roles start without it
-- (admins can grant it in Settings → Roles). Admin roles bypass grants.
INSERT INTO role_grants (role_id, entity, action, scope)
SELECT r.id, e.entity, 'import', 'all'
FROM roles r CROSS JOIN (VALUES ('lead'), ('contact'), ('company')) AS e(entity)
WHERE r.is_system AND NOT r.is_admin AND r.name = 'Manager'
ON CONFLICT DO NOTHING;
