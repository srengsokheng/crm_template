-- Inbox: Facebook Messenger, Instagram and WhatsApp (Meta's official APIs). For these channels, `secret` holds the
-- encrypted access token and app secret, `webhook_secret` the verify token Meta sends when the webhook is set up,
-- and config.accountId the Facebook Page id, Instagram account id or WhatsApp phone number id.
ALTER TABLE channels DROP CONSTRAINT channels_kind_check;
ALTER TABLE channels ADD CONSTRAINT channels_kind_check CHECK (kind IN ('webchat','telegram_bot','messenger','instagram','whatsapp'));
-- Webhooks are routed by account id.
CREATE INDEX channels_meta_account ON channels (kind, (config->>'accountId')) WHERE kind IN ('messenger','instagram','whatsapp');
