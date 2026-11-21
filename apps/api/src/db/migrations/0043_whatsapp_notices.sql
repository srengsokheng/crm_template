-- WhatsApp payment reminders and booking confirmations: an approved template per booking page (reminders keep theirs
-- in the workspace's document settings), and how many WhatsApp chats each reminder went to.
ALTER TABLE booking_pages ADD COLUMN whatsapp jsonb;
ALTER TABLE invoice_reminders ADD COLUMN whatsapp int NOT NULL DEFAULT 0;
