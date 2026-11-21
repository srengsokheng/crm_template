-- Automation: "field changed" trigger and delays counted in working hours.
ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_trigger_check;
ALTER TABLE automation_rules ADD CONSTRAINT automation_rules_trigger_check CHECK (trigger IN ('stage_entered','created','field_changed'));
ALTER TABLE automation_rules ADD COLUMN trigger_field text;          -- column name or custom.<key> (field_changed only)
ALTER TABLE automation_rules ADD COLUMN business_hours boolean NOT NULL DEFAULT false;
ALTER TABLE automation_rules ADD CONSTRAINT automation_rules_field_check CHECK (trigger <> 'field_changed' OR trigger_field IS NOT NULL);
