/**
 * Business-initiated WhatsApp messages (payment reminders, booking confirmations) through an approved template.
 *
 * Who gets it: each contact's WhatsApp chat on the chosen channel; a contact without one is reached on their phone
 * number (a chat is started in the Inbox, with the contact linked); an extra number (e.g. typed when booking) is used
 * only when the contacts can't be reached otherwise, so nobody gets the message twice. The message appears in the conversation and goes out through the normal delivery queue (retries, errors
 * shown on the message). If the channel is off or the template isn't approved any more, nothing is sent — the email
 * still goes — rather than failing the reminder or the booking.
 */
import type { WaTemplateSetting } from '@crm/shared';
import { q, q1, sql, type Db } from '../db/index.ts';
import { listTemplates, renderTemplate } from './meta.ts';
import { preview, type ChannelRow } from './store.ts';

/** WhatsApp addresses are digits only, with the country code (8–15 digits). */
const waNumber = (phone: string) => {
  const d = phone.replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15 ? d : null;
};

interface Target { externalId: string; conversationId: number | null; contactId: number | null; title: string }

async function targetsOf(db: Db, ch: ChannelRow, contactIds: number[], extraPhones: string[], fallbackTitle: string): Promise<Target[]> {
  const out = new Map<string, Target>();
  if (contactIds.length) {
    const convs = await q<{ id: number; external_id: string; contact_id: number; title: string }>(sql`SELECT id, external_id, contact_id, title FROM conversations
      WHERE channel_id = ${ch.id} AND kind = 'direct' AND contact_id = ANY(${contactIds}) ORDER BY last_message_at DESC`, db);
    for (const c of convs) if (!out.has(c.external_id)) out.set(c.external_id, { externalId: c.external_id, conversationId: c.id, contactId: Number(c.contact_id), title: c.title });
    const reached = new Set(convs.map((c) => Number(c.contact_id)));
    const missing = contactIds.filter((id) => !reached.has(id));
    if (missing.length) {
      const phones = await q<{ party_id: number; value: string; name: string }>(sql`SELECT DISTINCT ON (m.party_id) m.party_id, m.value,
          trim(concat_ws(' ', c.first_name, c.last_name)) AS name
        FROM contact_methods m JOIN contacts c ON c.id = m.party_id AND c.deleted_at IS NULL
        WHERE m.workspace_id = ${ch.workspace_id} AND m.party_type = 'contact' AND m.kind = 'phone' AND m.party_id = ANY(${missing})
        ORDER BY m.party_id, m.is_primary DESC, m.sort, m.id`, db);
      for (const p of phones) {
        const n = waNumber(p.value);
        if (n && !out.has(n)) out.set(n, { externalId: n, conversationId: null, contactId: Number(p.party_id), title: p.name || fallbackTitle });
      }
    }
  }
  if (!out.size) for (const phone of extraPhones) {
    const n = waNumber(phone);
    if (n && !out.has(n)) out.set(n, { externalId: n, conversationId: null, contactId: contactIds[0] ?? null, title: fallbackTitle });
  }
  return [...out.values()];
}

/**
 * Sends (queues) the template to the contacts' WhatsApp chats or numbers. `values` fill the blanks per the setting.
 * Returns how many chats it went to (0 when off or not possible). `dryRun` only counts who would get it.
 */
export async function sendWaTemplate(db: Db, o: {
  workspaceId: number; setting: WaTemplateSetting | null | undefined; contactIds: number[]; extraPhones?: string[];
  values: Record<string, string>; senderName: string; authorId?: number | null; title: string; dryRun?: boolean;
}): Promise<number> {
  const s = o.setting;
  if (!s?.channelId || !s.name) return 0;
  const ch = await q1<ChannelRow>(sql`SELECT * FROM channels WHERE id = ${s.channelId} AND workspace_id = ${o.workspaceId} AND kind = 'whatsapp' AND status = 'active'`, db);
  if (!ch) return 0;
  const targets = await targetsOf(db, ch, o.contactIds, o.extraPhones ?? [], o.title);
  if (o.dryRun || !targets.length) return targets.length;
  let template;
  try { template = (await listTemplates(ch)).find((t) => t.name === s.name && t.language === s.language); } catch { return 0; }
  if (!template) return 0;
  // Every blank needs text: WhatsApp refuses empty values.
  const params = Array.from({ length: template.params }, (_, i) => (o.values[s.params[i] ?? ''] ?? '').trim().slice(0, 1000) || '-');
  const body = renderTemplate(template, params);
  for (const t of targets) {
    const convId = t.conversationId ?? (await q1<{ id: number }>(sql`INSERT INTO conversations (workspace_id, channel_id, external_id, kind, title, profile, contact_id, last_direction)
      VALUES (${o.workspaceId}, ${ch.id}, ${t.externalId}, 'direct', ${t.title.slice(0, 200) || t.externalId}, ${JSON.stringify({ phone: `+${t.externalId}` })}, ${t.contactId}, 'out')
      ON CONFLICT (channel_id, external_id) DO UPDATE SET contact_id = coalesce(conversations.contact_id, EXCLUDED.contact_id) RETURNING id`, db))!.id;
    const m = await q1<{ id: number }>(sql`INSERT INTO messages (workspace_id, conversation_id, direction, sender_name, author_id, body, status, template)
      VALUES (${o.workspaceId}, ${convId}, 'out', ${o.senderName}, ${o.authorId ?? null}, ${body}, 'pending',
        ${JSON.stringify({ name: template.name, language: template.language, params })}) RETURNING id`, db);
    await q(sql`UPDATE conversations SET last_message_at = now(), last_message_preview = ${preview(body)}, last_direction = 'out' WHERE id = ${convId}`, db);
    await q(sql`INSERT INTO jobs (type, payload) VALUES ('inbox.send', ${JSON.stringify({ messageId: m!.id })})`, db);
  }
  return targets.length;
}
