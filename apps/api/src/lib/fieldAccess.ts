/**
 * Field-level permissions (per role). Rules live in roles.field_rules and are loaded into ctx.fieldRules.
 *   readonly — the value is shown but can't be changed (API: 403 when a request would change it)
 *   hidden   — custom fields only: the value and the field itself are left out of every response
 * Admins and background work (systemCtx) have no rules. Only fields whose value actually changes are checked, so forms
 * that send unchanged values keep working.
 */
import { LOCKABLE_FIELDS, type FieldEntity } from '@crm/shared';
import type { Ctx } from './context.ts';
import { AppError } from './errors.ts';

export type FieldRule = 'readonly' | 'hidden';

export function fieldRule(ctx: Ctx, entity: FieldEntity, field: string): FieldRule | undefined {
  if (ctx.isAdmin) return undefined;
  return ctx.fieldRules?.[entity]?.[field];
}

/** Keys (without "custom.") of this entity's custom fields that are hidden for the user. */
export function hiddenCustomKeys(ctx: Ctx, entity: FieldEntity): string[] {
  if (ctx.isAdmin) return [];
  return Object.entries(ctx.fieldRules?.[entity] ?? {}).filter(([k, r]) => r === 'hidden' && k.startsWith('custom.')).map(([k]) => k.slice(7));
}

/** Throws 403 if any of the given fields ("amount", "custom.margin") is read-only or hidden for the user. */
export function assertCanChange(ctx: Ctx, entity: FieldEntity, fields: Iterable<string>): void {
  const locked = Array.from(new Set(fields)).filter((f) => fieldRule(ctx, entity, f));
  if (!locked.length) return;
  const label = (f: string) => LOCKABLE_FIELDS[entity].find((l) => l.key === f)?.label ?? (f.startsWith('custom.') ? f.slice(7) : f);
  throw new AppError(403, 'FIELD_LOCKED', `Your role can't change: ${locked.map(label).join(', ')}`,
    Object.fromEntries(locked.map((f) => [f, 'Read-only for your role'])));
}

const blank = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * On create, a locked field may only be left empty or at the value the server would choose anyway (`defaults`, e.g. the
 * owner being yourself), so ordinary create forms keep working for restricted roles.
 */
export function assertCreateFields(ctx: Ctx, entity: FieldEntity, body: Record<string, unknown>, defaults: Record<string, unknown> = {}): void {
  if (ctx.isAdmin || !ctx.fieldRules?.[entity]) return;
  const fields: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (k === 'custom') {
      for (const [ck, cv] of Object.entries((v ?? {}) as Record<string, unknown>)) if (!blank(cv)) fields.push(`custom.${ck}`);
      continue;
    }
    if (blank(v) || (k in defaults && JSON.stringify(defaults[k]) === JSON.stringify(v))) continue;
    fields.push(k);
  }
  assertCanChange(ctx, entity, fields);
}

/** Custom keys whose value differs between two custom objects. */
export function changedCustomKeys(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return Array.from(keys).filter((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null)).map((k) => `custom.${k}`);
}

/** Changed column names (from audit `diff`) → API field names, using the route's field→column map. */
export function fieldsFromChanges(changes: Record<string, unknown>, cols: Record<string, string>): string[] {
  const byCol = Object.fromEntries(Object.entries(cols).map(([field, col]) => [col, field]));
  const out: string[] = [];
  for (const k of Object.keys(changes)) {
    if (k === 'custom') continue; // checked separately with changedCustomKeys
    if (byCol[k]) out.push(byCol[k]);
    if (k === 'amount_mode') out.push('amount');
  }
  return out;
}

/** Removes hidden custom values from a record-shaped object (snake or camel case, it only touches `custom`). */
export function stripHidden<T>(ctx: Ctx, entity: FieldEntity, obj: T): T {
  const hidden = hiddenCustomKeys(ctx, entity);
  if (!hidden.length || !obj || typeof obj !== 'object') return obj;
  const o = obj as Record<string, unknown>;
  if (o.custom && typeof o.custom === 'object') {
    const custom = { ...(o.custom as Record<string, unknown>) };
    for (const k of hidden) delete custom[k];
    return { ...o, custom } as T;
  }
  return obj;
}

/** Audit change sets: drop hidden custom keys from `custom: [before, after]` and `custom.<key>` entries. */
export function redactChanges(ctx: Ctx, entity: string, changes: unknown): unknown {
  if (!(entity in LOCKABLE_FIELDS) || !changes || typeof changes !== 'object') return changes;
  const hidden = hiddenCustomKeys(ctx, entity as FieldEntity);
  if (!hidden.length) return changes;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(changes as Record<string, unknown>)) {
    if (k.startsWith('custom.') && hidden.includes(k.slice(7))) continue;
    if (k === 'custom' && Array.isArray(v)) {
      const clean = v.map((side) => {
        if (!side || typeof side !== 'object') return side;
        const c = { ...(side as Record<string, unknown>) };
        for (const h of hidden) delete c[h];
        return c;
      });
      if (JSON.stringify(clean[0] ?? {}) === JSON.stringify(clean[1] ?? {})) continue; // only hidden fields changed
      out[k] = clean;
      continue;
    }
    out[k] = v;
  }
  return out;
}
