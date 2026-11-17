-- Inbox: a Telegram personal account (Telegram's user API, MTProto). The account owner signs in from Settings with the
-- code Telegram sends them (and their 2FA password if set; never stored). `secret` holds the encrypted api_id/api_hash
-- and session; while signing in, the channel is 'pending'.
ALTER TABLE channels DROP CONSTRAINT channels_kind_check;
ALTER TABLE channels ADD CONSTRAINT channels_kind_check CHECK (kind IN ('webchat','telegram_bot','messenger','instagram','whatsapp','telegram_user'));
ALTER TABLE channels DROP CONSTRAINT channels_status_check;
ALTER TABLE channels ADD CONSTRAINT channels_status_check CHECK (status IN ('active','disabled','error','pending'));
-- How to address the chat on the platform when it needs more than the chat id (Telegram: the peer's access hash).
-- Server-side only; never returned by the API.
ALTER TABLE conversations ADD COLUMN platform_ref text;
