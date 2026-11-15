-- Workspace audit-log page: newest events of a workspace first.
CREATE INDEX audit_workspace_created ON audit_events (workspace_id, created_at DESC, id DESC);
