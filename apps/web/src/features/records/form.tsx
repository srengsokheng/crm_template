import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { api, ApiError, qsOf } from '../../lib/api.ts';
import { useDebounced, useDict, useMeta } from '../../lib/hooks.ts';
import type { FieldDef, Method, Stage } from '../../lib/types.ts';
import { Checkbox, IconButton, Input, Select, Textarea } from '../../components/ui/primitives.tsx';

/** Tiny form state helper with server-side field errors. */
export function useForm<T extends Record<string, unknown>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof T>(k: K, v: T[K]) => {
    setValues((s) => ({ ...s, [k]: v }));
    if (errors[k as string]) setErrors((e) => { const n = { ...e }; delete n[k as string]; return n; });
  };
  const fromError = (e: unknown) => {
    if (e instanceof ApiError && e.fields) setErrors(e.fields);
  };
  return { values, set, setValues, errors, setErrors, fromError };
}

/** Strip empty strings so optional fields are sent as null. */
export function clean<T extends Record<string, unknown>>(v: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = x === '' ? null : x;
  return out as T;
}

const KIND_LABELS: Record<Method['kind'], string> = { phone: 'Phone', email: 'Email', website: 'Website', messenger: 'Messenger' };
const LABELS: Record<Method['kind'], string[]> = {
  phone: ['work', 'mobile', 'home', 'other'], email: ['work', 'personal', 'other'], website: ['work', 'other'], messenger: ['telegram', 'whatsapp', 'other'],
};

export function MethodsEditor({ value, onChange, errors = {}, kinds = ['email', 'phone'] }: {
  value: Method[]; onChange: (v: Method[]) => void; errors?: Record<string, string>; kinds?: Method['kind'][];
}) {
  const update = (i: number, patch: Partial<Method>) => onChange(value.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  return (
    <div className="space-y-2">
      {value.map((m, i) => (
        <div key={i} className="space-y-1">
          <div className="flex gap-2">
            <Select aria-label="Type" className="w-28 shrink-0" value={m.kind} onChange={(e) => update(i, { kind: e.target.value as Method['kind'], label: LABELS[e.target.value as Method['kind']][0] })}>
              {(['email', 'phone', 'website', 'messenger'] as const).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
            </Select>
            <Input aria-label={KIND_LABELS[m.kind]} value={m.value} invalid={!!errors[`methods.${i}.value`]}
              type={m.kind === 'email' ? 'email' : m.kind === 'phone' ? 'tel' : 'text'}
              placeholder={m.kind === 'email' ? 'name@company.com' : m.kind === 'phone' ? '+1 555 010 0199' : m.kind === 'website' ? 'https://' : '@handle'}
              onChange={(e) => update(i, { value: e.target.value })} />
            <Select aria-label="Label" className="w-28 shrink-0 max-sm:hidden" value={m.label} onChange={(e) => update(i, { label: e.target.value })}>
              {LABELS[m.kind].map((l) => <option key={l} value={l}>{l}</option>)}
            </Select>
            <IconButton label="Remove" onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>
          </div>
          {errors[`methods.${i}.value`] && <p className="text-xs text-rose-600">{errors[`methods.${i}.value`]}</p>}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {kinds.map((k) => (
          <button key={k} type="button" onClick={() => onChange([...value, { kind: k, label: LABELS[k][0], value: '' }])}
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"><Plus className="size-3" />Add {KIND_LABELS[k].toLowerCase()}</button>
        ))}
      </div>
    </div>
  );
}
export const methodsPayload = (m: Method[]) => m.filter((x) => x.value.trim()).map(({ kind, label, value }) => ({ kind, label, value: value.trim() }));

export function DictSelect({ kind, value, onChange, id, placeholder = 'Not set', invalid }: {
  kind: string; value: number | null | undefined; onChange: (v: number | null) => void; id?: string; placeholder?: string; invalid?: boolean;
}) {
  const items = useDict(kind);
  return (
    <Select id={id} value={value ?? ''} invalid={invalid} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{placeholder}</option>
      {items.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
    </Select>
  );
}

export function UserSelect({ value, onChange, id, allowEmpty, emptyLabel = 'Unassigned' }: {
  value: number | null | undefined; onChange: (v: number | null) => void; id?: string; allowEmpty?: boolean; emptyLabel?: string;
}) {
  const { data } = useMeta();
  return (
    <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      {allowEmpty && <option value="">{emptyLabel}</option>}
      {(data?.users ?? []).filter((u) => u.status !== 'disabled').map((u) => <option key={u.id} value={u.id}>{u.name}{u.status === 'invited' ? ' (invited)' : ''}</option>)}
    </Select>
  );
}

/** Editor for one custom field value. */
export function CustomFieldInput({ def, value, onChange, invalid, id }: { def: FieldDef; value: unknown; onChange: (v: unknown) => void; invalid?: boolean; id?: string }) {
  const { data } = useMeta();
  switch (def.type) {
    case 'textarea': return <Textarea id={id} invalid={invalid} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'number': return <Input id={id} invalid={invalid} type="number" value={(value as number | string) ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
    case 'money': return <Input id={id} invalid={invalid} inputMode="decimal" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="0.00" />;
    case 'date': return <Input id={id} invalid={invalid} type="date" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'datetime': return <Input id={id} invalid={invalid} type="datetime-local" value={value ? String(value).slice(0, 16) : ''} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)} />;
    case 'boolean': return <Checkbox checked={value === true} onChange={(v) => onChange(v)} label={def.label} />;
    case 'url': return <Input id={id} invalid={invalid} type="url" placeholder="https://" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'select': return (
      <Select id={id} invalid={invalid} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Not set</option>{def.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </Select>
    );
    case 'multiselect': {
      const arr = (value as string[]) ?? [];
      return (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {def.options.map((o) => <Checkbox key={o.id} checked={arr.includes(o.id)} label={o.label} onChange={(v) => onChange(v ? [...arr, o.id] : arr.filter((x) => x !== o.id))} />)}
        </div>
      );
    }
    case 'user': return (
      <Select id={id} invalid={invalid} value={(value as number) ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">Not set</option>{(data?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </Select>
    );
    default: return <Input id={id} invalid={invalid} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

export function customDisplay(def: FieldDef, value: unknown, userName: (id: number) => string): string {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return '—';
  switch (def.type) {
    case 'boolean': return value ? 'Yes' : 'No';
    case 'select': return def.options.find((o) => o.id === value)?.label ?? String(value);
    case 'multiselect': return (value as string[]).map((v) => def.options.find((o) => o.id === v)?.label ?? v).join(', ');
    case 'user': return userName(Number(value));
    case 'date': return new Date(`${value}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    case 'datetime': return new Date(String(value)).toLocaleString('en-US');
    case 'money': return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2 });
    default: return String(value);
  }
}

/** Mirrors the server rule: "from_stage" = required from the earliest listed stage onward (never when lost). */
export function requiredAt(d: FieldDef, stageId: number | null | undefined, stages: Stage[]): boolean {
  if (d.required === 'always') return true;
  if (d.required !== 'from_stage' || stageId == null) return false;
  const target = stages.find((s) => s.id === Number(stageId));
  if (!target || target.kind === 'lost') return false;
  return d.requiredStageIds.map(Number).some((id) => {
    const s = stages.find((x) => x.id === id);
    return !!s && s.pipelineId === target.pipelineId && target.sort >= s.sort;
  });
}
export function useRequiredAt() {
  const { data } = useMeta();
  const stages = (data?.pipelines ?? []).flatMap((p) => p.stages);
  return {
    isRequired: (d: FieldDef, stageId?: number | null) => requiredAt(d, stageId, stages),
    fromLabel: (d: FieldDef) => d.requiredStageIds.map((id) => stages.find((s) => s.id === Number(id))?.name).filter(Boolean).join(' / '),
  };
}

/** Live duplicate warning while typing email/phone/name. */
export function DuplicateHint({ emails = [], phones = [], name, companyName, exclude }: {
  emails?: string[]; phones?: string[]; name?: string; companyName?: string; exclude?: { type: string; id: number };
}) {
  const params = useDebounced({ email: emails.filter((e) => e.includes('@')).join(','), phone: phones.filter((p) => p.replace(/\D/g, '').length >= 6).join(','), name, companyName }, 400);
  const enabled = !!(params.email || params.phone || (params.name && params.name.length >= 3) || (params.companyName && params.companyName.length >= 2));
  const { data } = useQuery({
    queryKey: ['dupes', params, exclude], enabled,
    queryFn: () => api.get<{ data: { entityType: string; id: number; title: string; matchedOn: string; value: string }[] }>(`/duplicates${qsOf({ ...params, excludeType: exclude?.type, excludeId: exclude?.id })}`),
  });
  const hits = enabled ? data?.data ?? [] : [];
  if (!hits.length) return null;
  const path = (t: string) => (t === 'company' ? 'companies' : `${t}s`);
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100" role="status">
      <div className="mb-1 flex items-center gap-1.5 font-medium"><AlertTriangle className="size-4" />Possible duplicate{hits.length > 1 ? 's' : ''}</div>
      <ul className="space-y-0.5">
        {hits.slice(0, 4).map((h) => (
          <li key={`${h.entityType}-${h.id}`}>
            <Link to={`/${path(h.entityType)}/${h.id}`} target="_blank" className="font-medium underline">{h.title}</Link>
            <span className="text-amber-800/80 dark:text-amber-100/70"> · {h.entityType} · same {h.matchedOn}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-amber-800/80 dark:text-amber-100/70">You can still save — this is just a heads-up.</p>
    </div>
  );
}
