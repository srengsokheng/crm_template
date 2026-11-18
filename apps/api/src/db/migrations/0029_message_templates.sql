-- WhatsApp template messages (the only way to write after Meta's 24-hour window): which template and its values.
-- The message body holds the text as the customer sees it.
ALTER TABLE messages ADD COLUMN template jsonb;
