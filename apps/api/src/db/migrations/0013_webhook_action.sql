-- Automation action "Call a webhook". The allow-list and signing secret live in workspaces.settings.webhooks.
ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_action_check;
ALTER TABLE automation_rules ADD CONSTRAINT automation_rules_action_check
  CHECK (action IN ('create_activity','notify','add_note','update_field','assign_owner','move_stage','webhook'));
