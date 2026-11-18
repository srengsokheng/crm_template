-- Sales targets: an amount to win per person per month (and optionally for the whole workspace, user_id NULL),
-- in the workspace's base currency. Progress = deals won that month, converted like the dashboard does.
CREATE TABLE sales_targets (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  month        date NOT NULL CHECK (extract(day FROM month) = 1),
  user_id      bigint REFERENCES users(id) ON DELETE CASCADE,
  amount       numeric(18,2) NOT NULL CHECK (amount > 0),
  updated_by   bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sales_targets_one ON sales_targets (workspace_id, month, coalesce(user_id, 0));
