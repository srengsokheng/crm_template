import { normalizeContactValue, type ContactMethodInput } from '@crm/shared';
import { q, sql, type Db, pool } from '../db/index.ts';

export interface Method { id: number; kind: string; label: string; value: string; is_primary: boolean }

export async function replaceMethods(db: Db, workspaceId: number, partyType: string, partyId: number, methods: ContactMethodInput[] | undefined): Promise<void> {
  if (!methods) return;
  await q(sql`DELETE FROM contact_methods WHERE party_type = ${partyType} AND party_id = ${partyId}`, db);
  const seenKind = new Set<string>();
  let i = 0;
  for (const m of methods) {
    const primary = !seenKind.has(m.kind);
    seenKind.add(m.kind);
    await q(sql`INSERT INTO contact_methods (workspace_id, party_type, party_id, kind, label, value, normalized, is_primary, sort)
      VALUES (${workspaceId}, ${partyType}, ${partyId}, ${m.kind}, ${m.label || 'work'}, ${m.value.trim()},
              ${normalizeContactValue(m.kind, m.value)}, ${primary}, ${i++})`, db);
  }
}

export async function loadMethods(partyType: string, ids: number[], db: Db = pool): Promise<Record<number, Method[]>> {
  const out: Record<number, Method[]> = {};
  if (!ids.length) return out;
  const rows = await q<Method & { party_id: number }>(sql`SELECT id, party_id, kind, label, value, is_primary FROM contact_methods
    WHERE party_type = ${partyType} AND party_id = ANY(${ids}) ORDER BY sort, id`, db);
  for (const r of rows) { const { party_id, ...m } = r; (out[party_id] ??= []).push(m); }
  return out;
}

export async function copyMethods(db: Db, workspaceId: number, fromType: string, fromId: number, toType: string, toId: number, kinds?: string[]): Promise<void> {
  await q(sql`INSERT INTO contact_methods (workspace_id, party_type, party_id, kind, label, value, normalized, is_primary, sort)
    SELECT ${workspaceId}, ${toType}, ${toId}, kind, label, value, normalized, is_primary, sort FROM contact_methods
    WHERE party_type = ${fromType} AND party_id = ${fromId} ${kinds ? sql`AND kind = ANY(${kinds})` : sql``}`, db);
}

export interface DuplicateHit { entityType: string; id: number; title: string; matchedOn: string; value: string }

/** Exact match on normalised email/phone across leads/contacts/companies, plus close name matches. */
export async function findDuplicates(workspaceId: number, input: { emails?: string[]; phones?: string[]; name?: string; companyName?: string },
  exclude?: { entityType: string; id: number }): Promise<DuplicateHit[]> {
  const values = [
    ...(input.emails ?? []).filter(Boolean).map((v) => normalizeContactValue('email', v)),
    ...(input.phones ?? []).filter(Boolean).map((v) => normalizeContactValue('phone', v)),
  ].filter((v) => v.length >= 5);
  const hits: DuplicateHit[] = [];
  if (values.length) {
    const rows = await q<{ party_type: string; party_id: number; kind: string; value: string; title: string }>(sql`
      SELECT cm.party_type, cm.party_id, cm.kind, cm.value,
        CASE cm.party_type
          WHEN 'contact' THEN (SELECT trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) FROM contacts c WHERE c.id = cm.party_id AND c.deleted_at IS NULL)
          WHEN 'company' THEN (SELECT name FROM companies c WHERE c.id = cm.party_id AND c.deleted_at IS NULL)
          ELSE (SELECT title FROM leads l WHERE l.id = cm.party_id AND l.deleted_at IS NULL AND l.status = 'open')
        END AS title
      FROM contact_methods cm
      WHERE cm.workspace_id = ${workspaceId} AND cm.normalized = ANY(${values})
      LIMIT 20`);
    for (const r of rows) if (r.title) hits.push({ entityType: r.party_type, id: r.party_id, title: r.title, matchedOn: r.kind, value: r.value });
  }
  if (input.name && input.name.trim().length >= 3) {
    const rows = await q<{ id: number; title: string }>(sql`
      SELECT id, trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) AS title FROM contacts
      WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
        AND lower(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))) = lower(${input.name.trim()}) LIMIT 5`);
    for (const r of rows) hits.push({ entityType: 'contact', id: r.id, title: r.title, matchedOn: 'name', value: r.title });
  }
  if (input.companyName && input.companyName.trim().length >= 2) {
    const rows = await q<{ id: number; title: string }>(sql`
      SELECT id, name AS title FROM companies WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
        AND (lower(name) = lower(${input.companyName.trim()}) OR similarity(name, ${input.companyName.trim()}) > 0.6) LIMIT 5`);
    for (const r of rows) hits.push({ entityType: 'company', id: r.id, title: r.title, matchedOn: 'company name', value: r.title });
  }
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = `${h.entityType}:${h.id}`;
    if (exclude && exclude.entityType === h.entityType && exclude.id === h.id) return false;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
