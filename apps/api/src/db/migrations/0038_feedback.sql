-- Customer feedback: some days after a deal is won, the customer gets a link to rate us (1–5) with an optional comment.
-- One request per deal. The salesperson (deal owner when asked) is who the rating counts for.
CREATE TABLE feedback_requests (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id      bigint NOT NULL UNIQUE REFERENCES deals(id) ON DELETE CASCADE,
  contact_id   bigint REFERENCES contacts(id) ON DELETE SET NULL,
  email        text NOT NULL,
  owner_id     bigint REFERENCES users(id) ON DELETE SET NULL,
  token_hash   text NOT NULL UNIQUE,
  sent_by      bigint REFERENCES users(id) ON DELETE SET NULL,   -- null: automatic
  sent_at      timestamptz NOT NULL DEFAULT now(),
  rating       smallint CHECK (rating BETWEEN 1 AND 5),
  comment      text NOT NULL DEFAULT '',
  responded_at timestamptz
);
CREATE INDEX feedback_requests_ws ON feedback_requests (workspace_id, sent_at DESC);
