-- Personal time zone for emails (activity reminders, daily digest). NULL = the workspace's time zone.
ALTER TABLE users ADD COLUMN timezone text;
