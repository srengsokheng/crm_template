-- Email delivery: each member can turn activity-reminder emails off for a workspace (in-app notifications stay).
ALTER TABLE memberships ADD COLUMN email_reminders boolean NOT NULL DEFAULT true;
