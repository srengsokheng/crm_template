import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Check, Info, X } from 'lucide-react';
import { api, errorMessage, qsOf } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { date, money } from '../../lib/format.ts';
import { useDictLabel, useUserName } from '../../lib/hooks.ts';
import type { FieldDef, Method } from '../../lib/types.ts';
import { Badge, Button, ErrorState, IconButton, Skeleton } from '../../components/ui/primitives.tsx';
import { Dialog } from '../../components/ui/overlays.tsx';
import { EntityPicker, type PickerItem } from '../../components/ui/EntityPicker.tsx';
import { customDisplay } from './form.tsx';

export type MergeEntity = 'contact' | 'company' | 'lead';
interface MergeRecord extends Record<string, unknown> {
  id: number; title: string; createdAt: string; custom: Record<string, unknown>; methods: Method[];
  related: Record<string, number>; canKeep: boolean; canRemove: boolean; blocked: string | null;
}
interface Compare { records: MergeRecord[]; fields: { key: string; label: string; locked?: boolean }[]; customFields: (FieldDef & { locked?: boolean })[]; max: number }

const NOUN: Record<MergeEntity, { one: string; many: string; path: string; picker: 'contacts' | 'companies' | 'leads' }> = {
  contact: { one: 'contact', many: 'contacts', path: '/contacts', picker: 'contacts' },
  company: { one: 'company', many: 'companies', path: '/companies', picker: 'companies' },
  lead: { one: 'lead', many: 'leads', path: '/leads', picker: 'leads' },
};
const RELATED_LABEL: Record<string, [string, string]> = {
  deals: ['deal', 'deals'], companies: ['company', 'companies'], contacts: ['contact', 'contacts'], activities: ['activity', 'activities'],
  notes: ['note', 'notes'], products: ['product', 'products'],
};
const MOVES: Record<MergeEntity, string> = { contact: 'Deals, companies', company: 'Deals, contacts', lead: 'Products (if the kept lead has none)' };

/** Merge the current record with one or more others: pick them, choose what to keep, confirm. */
export function MergeDialog({ entity, open, onOpenChange, current, initialOther, onMerged }: {
  entity: MergeEntity; open: boolean; onOpenChange: (v: boolean) => void;
  current: { id: number; name: string; emails: string[]; phones: string[]; websites?: string[] };
  /** Skip the pick step and compare with this record straight away. */
  initialOther?: PickerItem;
  /** Called with the kept record's id instead of opening it. */
  onMerged?: (id: number) => void;
}) {
  const [others, setOthers] = useState<PickerItem[]>(initialOther ? [initialOther] : []);
  const close = (v: boolean) => { onOpenChange(v); if (!v) setOthers(initialOther ? [initialOther] : []); };
  const n = NOUN[entity];
  return (
    <Dialog open={open} onOpenChange={close} size="lg" title={others.length ? `Merge ${n.many}` : `Merge “${current.name}” with…`}
      description={others.length ? undefined : `Pick the duplicate ${n.one}. You choose which one to keep and which values win on the next step; you can add more ${n.many} there.`}>
      {others.length
        ? <CompareStep entity={entity} ids={[current.id, ...others.map((o) => o.id)]} onAdd={(p) => setOthers([...others, p])}
            onRemove={(id) => setOthers(others.filter((o) => o.id !== id))}
            onBack={initialOther ? () => close(false) : () => setOthers([])} onDone={() => close(false)} onMerged={onMerged} backLabel={initialOther ? 'Cancel' : undefined} />
        : <Pick entity={entity} current={current} onPick={(p) => setOthers([p])} />}
    </Dialog>
  );
}

function Pick({ entity, current, onPick }: { entity: MergeEntity; current: { id: number; name: string; emails: string[]; phones: string[]; websites?: string[] }; onPick: (p: PickerItem) => void }) {
  const hints = useQuery({
    queryKey: ['duplicates', entity, current.id],
    queryFn: () => api.get<{ data: { entityType: string; id: number; title: string; matchedOn: string; value: string }[] }>(`/duplicates${qsOf({
      email: current.emails.join(','), phone: current.phones.join(','), website: (current.websites ?? []).join(','), excludeType: entity, excludeId: current.id,
      ...(entity === 'company' ? { companyName: current.name } : { name: current.name }),
    })}`),
  });
  const suggestions = (hints.data?.data ?? []).filter((h) => h.entityType === entity && h.id !== current.id);
  return (
    <div className="space-y-4">
      <section>
        <h3 className="mb-2 text-[13px] font-medium">Possible duplicates</h3>
        {hints.isLoading ? <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
          : hints.error ? <ErrorState message={errorMessage(hints.error)} onRetry={() => hints.refetch()} />
          : suggestions.length === 0 ? <p className="rounded-md bg-[var(--surface-2)] px-3 py-2.5 text-sm text-muted">No {NOUN[entity].many} with the same name, email or phone. Search for one below.</p>
          : (
            <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-card)] border border-base">
              {suggestions.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => onPick({ id: s.id, label: s.title })}
                    className="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2.5 text-left text-sm hover:bg-[var(--surface-2)]/70">
                    <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
                    <span className="text-xs text-muted">same {s.matchedOn}{s.matchedOn !== 'name' && s.matchedOn !== 'company name' ? `: ${s.value}` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      </section>
      <section>
        <h3 className="mb-2 text-[13px] font-medium">Or search</h3>
        <EntityPicker entity={NOUN[entity].picker} value={null}
          onChange={(p) => { if (p && p.id !== current.id) onPick(p); }} placeholder={`Find a ${NOUN[entity].one}…`} />
      </section>
    </div>
  );
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)
  || (typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((x) => x === null || x === ''));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function CompareStep({ entity, ids, onAdd, onRemove, onBack, onDone, onMerged, backLabel }: {
  entity: MergeEntity; ids: number[]; onAdd: (p: PickerItem) => void; onRemove: (id: number) => void;
  onBack: () => void; onDone: () => void; onMerged?: (id: number) => void; backLabel?: string;
}) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const dictLabel = useDictLabel();
  const userName = useUserName();
  const n = NOUN[entity];
  const q = useQuery({ queryKey: ['merge', entity, ids.join(',')], queryFn: () => api.get<Compare>(`/merge/${entity}?ids=${ids.join(',')}`) });
  const [keepId, setKeepId] = useState<number | null>(null);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  const data = q.data;
  const recs = data?.records;
  /** Keeping a record needs edit on it and delete on every other one; converted leads can't take part. */
  const keepable = (r: MergeRecord) => !!recs && r.canKeep && !r.blocked && recs.every((o) => o.id === r.id || (o.canRemove && !o.blocked));
  // Default: keep the record with the most attached to it (then the oldest), if the user may.
  const keep = recs?.find((r) => r.id === keepId) ?? (recs ? [...recs].sort((a, b) => {
    const k = Number(keepable(b)) - Number(keepable(a));
    if (k) return k;
    const weight = (r: MergeRecord) => Object.values(r.related).reduce((x, y) => x + y, 0);
    return weight(b) - weight(a) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  })[0] : undefined);
  const others = recs?.filter((r) => r.id !== keep?.id) ?? [];
  const allowed = !!keep && keepable(keep);

  /** Comparable rows: key, label, value per record, display per record. */
  const rows = useMemo(() => {
    if (!data) return [];
    const show = (key: string, r: MergeRecord): ReactNode => {
      const v = r[key];
      switch (key) {
        case 'name': return entity === 'lead' ? ([r.firstName, r.lastName].filter(Boolean).join(' ') || null) : r.title;
        case 'typeId': case 'sourceId': case 'industryId': case 'sizeId': return v ? dictLabel(v as number) : null;
        case 'ownerId': return userName(v as number);
        case 'primaryCompanyId': return (r.companyName as string) ?? null;
        case 'birthday': return v ? date(v as string) : null;
        case 'annualRevenue': return v ? money(v as string, r.currency as string) : null;
        case 'amount': return v && Number(v) ? money(v as string, r.currency as string) : null;
        case 'visibility': return v === 'private' ? 'Private' : 'Shared';
        case 'address': return isEmpty(v) ? null : Object.values(v as Record<string, string>).filter(Boolean).join(', ');
        default: return isEmpty(v) ? null : String(v);
      }
    };
    const val = (key: string, r: MergeRecord) => (key === 'name'
      ? (entity === 'company' ? r.name : [r.firstName, r.lastName])
      : key === 'annualRevenue' ? (r.annualRevenue ? [r.annualRevenue, r.currency] : null)
        : key === 'amount' ? (r.amount && Number(r.amount) ? [r.amount, r.currency] : null) : r[key]);
    const base = data.fields.map((f) => ({ key: f.key, label: f.label, locked: !!f.locked, values: data.records.map((r) => val(f.key, r)), shown: data.records.map((r) => show(f.key, r)) }));
    const custom = data.customFields.map((d) => ({
      key: `custom.${d.key}`, label: d.label, locked: !!d.locked, values: data.records.map((r) => r.custom?.[d.key]),
      shown: data.records.map((r) => (isEmpty(r.custom?.[d.key]) ? null : customDisplay(d, r.custom?.[d.key], userName))),
    }));
    return [...base, ...custom];
  }, [data, entity, dictLabel, userName]);
  const differing = rows.filter((r) => r.values.some((v) => !same(v, r.values[0])));
  const sameCount = rows.length - differing.length;
  const idx = (id: number) => recs?.findIndex((r) => r.id === id) ?? -1;
  /** The record whose value wins: the user's pick, else the kept value, else the first non-empty other value. */
  const choiceOf = (row: { key: string; values: unknown[] }): number => {
    if (!keep || !recs) return 0;
    const p = picked[row.key];
    if (p !== undefined && idx(p) >= 0) return p;
    if (!isEmpty(row.values[idx(keep.id)])) return keep.id;
    return recs.find((r, i) => r.id !== keep.id && !isEmpty(row.values[i]))?.id ?? keep.id;
  };

  const merge = async () => {
    if (!keep) return;
    setBusy(true);
    try {
      const choose = Object.fromEntries(differing.filter((r) => !r.locked).map((r) => [r.key, choiceOf(r)]));
      const res = await api.post<{ id: number }>(`/merge/${entity}`, { survivorId: keep.id, mergedIds: others.map((o) => o.id), choose });
      for (const k of [n.many, entity, 'deals', 'timeline', 'history', 'duplicates', 'duplicate-pairs']) qc.invalidateQueries({ queryKey: [k] });
      toast.success(others.length === 1 ? `${n.many[0].toUpperCase()}${n.many.slice(1)} merged` : `${others.length + 1} ${n.many} merged`);
      onDone();
      if (onMerged) onMerged(res.id); else nav(`${n.path}/${res.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };

  if (q.isLoading) return <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-40" /></div>;
  if (q.error || !recs || !keep) return <div><ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /><Button icon={<ArrowLeft className="size-4" />} onClick={onBack}>Back</Button></div>;
  const max = data?.max ?? 10;

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-[13px] font-medium">Which {n.one} do you keep?</legend>
        <div className={cn('grid gap-2', recs.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3')}>
          {recs.map((r) => {
            const can = keepable(r);
            return (
              <div key={r.id} className="relative">
                <label className={cn('flex h-full cursor-pointer flex-col gap-1 rounded-[var(--radius-card)] border p-3 text-sm',
                  keep.id === r.id ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:bg-brand-600/10' : 'border-base hover:bg-[var(--surface-2)]/60',
                  !can && 'cursor-not-allowed opacity-60')}>
                  <input type="radio" name="keep" className="sr-only" checked={keep.id === r.id} disabled={!can} onChange={() => { setKeepId(r.id); setPicked({}); }} />
                  <span className="flex items-center justify-between gap-2 pr-6">
                    <span className="truncate font-semibold">{r.title || '—'}</span>
                    {keep.id === r.id ? <Badge tone="brand"><Check className="size-3" />Keep</Badge> : <Badge>Merge away</Badge>}
                  </span>
                  <span className="text-xs text-muted">#{r.id} · added {date(r.createdAt)}</span>
                  <span className="text-xs text-muted">{Object.entries(r.related).map(([k, c]) => `${c} ${RELATED_LABEL[k]?.[c === 1 ? 0 : 1] ?? k}`).join(' · ')}</span>
                  {r.blocked && <span className="text-xs text-rose-600">{r.blocked}: can’t be merged</span>}
                  {!r.blocked && !can && <span className="text-xs text-rose-600">You can’t {r.canKeep ? `remove one of the other ${n.many}` : `edit this ${n.one}`}</span>}
                </label>
                {recs.length > 2 && ids[0] !== r.id && (
                  <IconButton size="sm" label={`Leave ${r.title} out`} className="absolute right-1.5 top-1.5" onClick={() => { onRemove(r.id); setPicked({}); if (keepId === r.id) setKeepId(null); }}>
                    <X className="size-3.5" />
                  </IconButton>
                )}
              </div>
            );
          })}
        </div>
        {recs.length < max && (
          <div className="mt-2 max-w-sm">
            <EntityPicker entity={n.picker} value={null} placeholder={`Add another ${n.one}…`}
              onChange={(p) => { if (p && !ids.includes(p.id)) onAdd(p); }} />
          </div>
        )}
      </fieldset>

      <section>
        <h3 className="mb-2 text-[13px] font-medium">{differing.length ? 'Choose the values to keep' : 'All fields are the same'}</h3>
        {differing.length > 0 && (
          <div className="divide-y divide-[var(--border)] rounded-[var(--radius-card)] border border-base">
            {differing.map((row) => {
              const choice = choiceOf(row);
              return (
                <div key={row.key} role="radiogroup" aria-label={row.label} className="grid gap-2 px-3 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-start">
                  <span className="pt-1.5 text-[13px] font-medium text-muted">{row.label}{row.locked && <span className="block text-[11px] font-normal">read-only for your role</span>}</span>
                  <div className={cn('grid gap-2', recs.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3')}>
                    {recs.map((r, i) => (
                      <button key={r.id} type="button" role="radio" aria-checked={choice === r.id} disabled={row.locked}
                        onClick={() => setPicked({ ...picked, [row.key]: r.id })}
                        className={cn('flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm disabled:cursor-not-allowed',
                          choice === r.id ? 'border-brand-500 bg-brand-50 dark:bg-brand-600/10' : 'border-base hover:bg-[var(--surface-2)]/60')}>
                        <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border', choice === r.id ? 'border-brand-600 bg-brand-600 text-white' : 'border-base')}>
                          {choice === r.id && <Check className="size-3" />}
                        </span>
                        <span className="min-w-0">
                          <span className={cn('block break-words', row.shown[i] === null && 'italic text-muted')}>{row.shown[i] ?? 'empty'}</span>
                          <span className={cn('block truncate text-[11px] text-muted', recs.length === 2 && 'sm:hidden')}>from {r.title || '—'} #{r.id}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {sameCount > 0 && differing.length > 0 && <p className="mt-1.5 text-xs text-muted">{sameCount} other fields are the same or empty in all of them.</p>}
      </section>

      <p className="flex gap-2 rounded-md bg-[var(--surface-2)] px-3 py-2.5 text-[13px] text-muted">
        <Info className="mt-0.5 size-4 shrink-0" />
        <span>Emails and phones from all of them are kept. {MOVES[entity]}, activities, notes and files move to “{keep.title}”,
          and their history is combined. {others.length === 1 ? `“${others[0].title}” is` : `The other ${others.length} ${n.many} are`} removed. This can’t be undone.</span>
      </p>

      <div className="flex flex-wrap justify-end gap-2 border-t border-base pt-3">
        <Button icon={backLabel ? undefined : <ArrowLeft className="size-4" />} onClick={onBack} disabled={busy}>{backLabel ?? 'Start over'}</Button>
        <Button variant="primary" loading={busy} disabled={!allowed} onClick={merge}>{others.length === 1 ? 'Merge' : `Merge ${others.length + 1}`} into “{keep.title}”</Button>
      </div>
    </div>
  );
}
