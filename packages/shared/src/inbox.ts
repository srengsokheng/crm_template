import { z } from 'zod';

/** Messaging channels the Inbox can receive from. */
export const CHANNEL_KINDS = ['webchat', 'telegram_bot', 'messenger', 'instagram', 'whatsapp'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export const CHANNEL_LABELS: Record<ChannelKind, string> = {
  webchat: 'Website chat', telegram_bot: 'Telegram bot', messenger: 'Facebook Messenger', instagram: 'Instagram', whatsapp: 'WhatsApp',
};
/** Channels connected through Meta's official APIs (one webhook design, a 24-hour reply window). */
export const META_KINDS = ['messenger', 'instagram', 'whatsapp'] as const;
export type MetaKind = (typeof META_KINDS)[number];
export const isMetaKind = (k: string): k is MetaKind => (META_KINDS as readonly string[]).includes(k);
/** What the account id is called in Meta's dashboards. */
export const META_ACCOUNT_LABELS: Record<MetaKind, string> = {
  messenger: 'Facebook Page ID', instagram: 'Instagram account ID', whatsapp: 'Phone number ID',
};

/** Meta credentials: a long-lived access token and the app secret (checks that webhooks really come from Meta). */
const metaCredentials = {
  accessToken: z.string().trim().min(20, 'Paste the whole access token').max(1000).regex(/^[A-Za-z0-9_|.-]+$/, 'The access token has unexpected characters — copy it again'),
  appSecret: z.string().trim().regex(/^[0-9a-f]{32}$/i, 'The app secret is 32 letters and digits (App settings → Basic)'),
};
const metaAccountId = z.string().trim().regex(/^\d{5,25}$/, 'Use the number shown in Meta’s dashboard');

const id = z.coerce.number().int().positive();
const text = (max: number) => z.string().trim().max(max);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #4f46e5');
/** Origins like https://example.com (scheme + host + optional port, no path). */
const origin = z.string().trim().regex(/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i, 'Use an origin like https://www.example.com');

export const webchatConfigSchema = z.object({
  greeting: text(300).default('Hi! How can we help?'),
  color: hexColor.default('#4f46e5'),
  /** Websites allowed to embed the chat. Empty = any website. */
  allowedOrigins: z.array(origin).max(20).default([]),
});

export const channelCreateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('webchat'), name: text(80).min(1, 'Required') }).extend(webchatConfigSchema.shape),
  z.object({
    kind: z.literal('telegram_bot'),
    name: text(80).optional(),
    /** From @BotFather, e.g. 123456789:AA… */
    token: z.string().trim().regex(/^\d{3,15}:[A-Za-z0-9_-]{20,}$/, 'Paste the token @BotFather gave you (it looks like 123456789:AA…)'),
  }),
  z.object({ kind: z.literal('messenger'), name: text(80).optional(), accountId: metaAccountId, ...metaCredentials }),
  z.object({ kind: z.literal('instagram'), name: text(80).optional(), accountId: metaAccountId, ...metaCredentials }),
  z.object({ kind: z.literal('whatsapp'), name: text(80).optional(), accountId: metaAccountId, ...metaCredentials }),
]);

export const channelUpdateSchema = z.object({
  name: text(80).min(1).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  greeting: text(300).optional(),
  color: hexColor.optional(),
  allowedOrigins: z.array(origin).max(20).optional(),
  /** Meta channels: replace the credentials (e.g. after the token expired); both together. */
  accessToken: metaCredentials.accessToken.optional(),
  appSecret: metaCredentials.appSecret.optional(),
}).refine((v) => (v.accessToken === undefined) === (v.appSecret === undefined), { message: 'Enter the access token and the app secret', path: ['appSecret'] });

export const conversationListSchema = z.object({
  status: z.enum(['open', 'closed', 'all']).default('open'),
  /** me = assigned to me, unassigned, all = everything I may see. */
  assignee: z.enum(['me', 'unassigned', 'all']).default('all'),
  channelId: id.optional(),
  contactId: id.optional(),
  leadId: id.optional(),
  q: text(200).optional(),
  /** Paging (feed cursor from the previous page's nextCursor) — "Load more". */
  before: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const conversationUpdateSchema = z.object({
  status: z.enum(['open', 'closed']).optional(),
  assigneeId: id.nullable().optional(),
  contactId: id.nullable().optional(),
  leadId: id.nullable().optional(),
});

export const messageCreateSchema = z.object({ body: text(4000).min(1, 'Write a message') });
/** Saved replies. Placeholders filled in when inserted: {{first_name}}, {{name}}, {{agent}}. */
export const savedReplySchema = z.object({
  title: text(80).min(1, 'Required'),
  body: text(4000).min(1, 'Required'),
  shared: z.boolean().default(false),
});
// No defaults here: a field left out of an update must stay as it is.
export const savedReplyUpdateSchema = z.object({ title: text(80).min(1).optional(), body: text(4000).min(1).optional(), shared: z.boolean().optional() });

/** Fills a saved reply's placeholders. Unknown placeholders are left as they are. */
export function fillPlaceholders(body: string, v: { name?: string | null; agent?: string | null }): string {
  const name = (v.name ?? '').trim();
  const values: Record<string, string> = { name, first_name: name.split(/\s+/)[0] ?? '', agent: (v.agent ?? '').trim() };
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (k in values ? values[k] : m));
}

/** Text sent with a file (optional). */
export const messageCaptionSchema = z.object({ caption: text(4000) });

/** Website chat widget → API. */
export const webchatMessageSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/).optional(),
  body: text(4000).min(1),
  name: text(100).optional(),
  email: z.email().max(200).optional().or(z.literal('').transform(() => undefined)),
});
