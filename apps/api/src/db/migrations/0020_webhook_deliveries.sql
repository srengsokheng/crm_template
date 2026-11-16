-- Every webhook delivery attempt (automation runs, retries and test sends), shown per rule. Kept 30 days.
CREATE TABLE webhook_deliveries (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_id      bigint REFERENCES automation_rules(id) ON DELETE CASCADE,
  run_id       bigint,
  url          text NOT NULL,
  event        text NOT NULL,
  is_test      boolean NOT NULL DEFAULT false,
  status_code  int,
  ok           boolean NOT NULL,
  error        text,
  duration_ms  int NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_rule ON webhook_deliveries (rule_id, id DESC);
