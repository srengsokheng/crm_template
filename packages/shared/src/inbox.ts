import { z } from 'zod';

/** Messaging channels the Inbox can receive from. */
export const CHANNEL_KINDS = ['webchat', 'telegram_bot'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export const CHANNEL_LABELS: Record<ChannelKind, string> = { webchat: 'Website chat', telegram_bot: 'Telegram bot' };

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
]);

export const channelUpdateSchema = z.object({
  name: text(80).min(1).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  greeting: text(300).optional(),
  color: hexColor.optional(),
  allowedOrigins: z.array(origin).max(20).optional(),
});

export const conversationListSchema = z.object({
  status: z.enum(['open', 'closed']).default('open'),
  /** me = assigned to me, unassigned, all = everything I may see. */
  assignee: z.enum(['me', 'unassigned', 'all']).default('all'),
  channelId: id.optional(),
  contactId: id.optional(),
  leadId: id.optional(),
  q: text(200).optional(),
  /** Paging: conversations whose last message is older than this (ISO time) — "Load more". */
  before: z.string().datetime({ offset: true }).optional(),
});

export const conversationUpdateSchema = z.object({
  status: z.enum(['open', 'closed']).optional(),
  assigneeId: id.nullable().optional(),
  contactId: id.nullable().optional(),
  leadId: id.nullable().optional(),
});

export const messageCreateSchema = z.object({ body: text(4000).min(1, 'Write a message') });

/** Website chat widget → API. */
export const webchatMessageSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/).optional(),
  body: text(4000).min(1),
  name: text(100).optional(),
  email: z.email().max(200).optional().or(z.literal('').transform(() => undefined)),
});
