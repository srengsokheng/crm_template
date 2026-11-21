-- Daily digest of overdue activities (per member, on by default) and admin-visible failed email deliveries.
ALTER TABLE memberships ADD COLUMN email_digest boolean NOT NULL DEFAULT true;
-- The workspace-local date of the last digest check for this member (at most one digest per day).
ALTER TABLE memberships ADD COLUMN digest_sent_on date;

-- Email jobs remember their workspace so admins can see (and retry) failed deliveries.
ALTER TABLE jobs ADD COLUMN workspace_id bigint REFERENCES workspaces(id) ON DELETE CASCADE;
CREATE INDEX jobs_failed_email ON jobs (workspace_id, id DESC) WHERE type = 'email.send' AND status = 'failed';
