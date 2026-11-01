import { q, sql, type Db, pool } from '../db/index.ts';
import { AppError, badRequest } from './errors.ts';

export interface FieldDef {
  id: number; entity_type: string; key: string; label: string; type: string;
  options: { id: string; label: string }[]; required: 'never' | 'always' | 'from_stage';
  required_stage_ids: number[]; help_text: string | null; sort: number; is_active: boolean;
}

export async function loadDefs(workspaceId: number, entityType: string, db: Db = pool, includeInactive = false): Promise<FieldDef[]> {
  return q<FieldDef>(sql`SELECT id, entity_type, key, label, type, options, required, required_stage_ids, help_text, sort, is_active
    FROM field_definitions WHERE workspace_id = ${workspaceId} AND entity_type = ${entityType}
    ${includeInactive ? sql`` : sql`AND is_active`} ORDER BY sort, id`, db);
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

function coerce(def: FieldDef, v: unknown): unknown {
  const bad = (msg: string) => { throw badRequest(`${def.label}: ${msg}`, { [`custom.${def.key}`]: msg }); };
  switch (def.type) {
    case 'text': case 'textarea': {
      if (typeof v !== 'string') bad('must be text');
      const s = (v as string).trim();
      if (s.length > (def.type === 'text' ? 500 : 10000)) bad('is too long');
      return s;
    }
    case 'url': {
      if (typeof v !== 'string' || !/^https?:\/\/\S+$/i.test(v.trim())) bad('must be a link starting with http:// or https://');
      return (v as string).trim();
    }
    case 'number': {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) bad('must be a number');
      return n;
    }
    case 'money': {
      const s = String(v).trim();
      if (!/^\d{1,16}(\.\d{1,2})?$/.test(s)) bad('must be an amount like 1500.00');
      return s;
    }
    case 'date': if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) bad('must be a date'); return v;
    case 'datetime': if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) bad('must be a date and time'); return new Date(v as string).toISOString();
    case 'boolean': if (typeof v !== 'boolean') bad('must be yes or no'); return v;
    case 'select': if (!def.options.some((o) => o.id === v)) bad('is not one of the options'); return v;
    case 'multiselect': {
      if (!Array.isArray(v) || v.some((x) => !def.options.some((o) => o.id === x))) bad('contains an unknown option');
      return Array.from(new Set(v as string[]));
    }
    case 'user': { const n = Number(v); if (!Number.isInteger(n) || n <= 0) bad('must be a user'); return n; }
    default: return v;
  }
}

/** Validate & merge custom values. Unknown keys are rejected; empty values remove the key. */
export function mergeCustom(defs: FieldDef[], input: Record<string, unknown> | undefined, existing: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  if (!input) return out;
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const [k, v] of Object.entries(input)) {
    const def = byKey.get(k);
    if (!def) throw badRequest(`Unknown field "${k}"`, { [`custom.${k}`]: 'Unknown field' });
    if (isEmpty(v)) delete out[k];
    else out[k] = coerce(def, v);
  }
  return out;
}

/**
 * Fields still empty that are required for a record at `stageId`.
 * "from_stage" means: required once the record reaches the earliest listed stage (or any later stage in the same
 * pipeline, including won) — but never when the record is lost.
 */
export async function missingRequired(defs: FieldDef[], custom: Record<string, unknown>, stageId?: number | null, db: Db = pool): Promise<FieldDef[]> {
  const fromDefs = defs.filter((d) => d.is_active && d.required === 'from_stage' && d.required_stage_ids.length);
  const info = new Map<number, { pipeline_id: number; sort: number; kind: string }>();
  if (stageId != null && fromDefs.length) {
    const ids = [Number(stageId), ...fromDefs.flatMap((d) => d.required_stage_ids.map(Number))];
    for (const r of await q<{ id: number; pipeline_id: number; sort: number; kind: string }>(sql`SELECT id, pipeline_id, sort, kind FROM stages WHERE id = ANY(${ids})`, db)) info.set(r.id, r);
  }
  const target = stageId != null ? info.get(Number(stageId)) : undefined;
  const reached = (d: FieldDef) => !!target && target.kind !== 'lost' && d.required_stage_ids.map(Number).some((id) => {
    const s = info.get(id);
    return !!s && s.pipeline_id === target.pipeline_id && target.sort >= s.sort;
  });
  return defs.filter((d) => d.is_active && isEmpty(custom[d.key]) && (d.required === 'always' || (d.required === 'from_stage' && reached(d))));
}

export async function assertRequired(defs: FieldDef[], custom: Record<string, unknown>, stageId?: number | null, db: Db = pool): Promise<void> {
  const missing = await missingRequired(defs, custom, stageId, db);
  if (missing.length) {
    throw new AppError(422, 'REQUIRED_FIELDS', `Please fill in: ${missing.map((m) => m.label).join(', ')}`,
      Object.fromEntries(missing.map((m) => [`custom.${m.key}`, 'Required'])),
      missing.map((m) => ({ key: m.key, label: m.label, type: m.type, options: m.options, helpText: m.help_text })));
  }
}
