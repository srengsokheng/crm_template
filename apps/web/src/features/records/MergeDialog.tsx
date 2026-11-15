import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Check, Info } from 'lucide-react';
import { api, errorMessage, qsOf } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { date, money } from '../../lib/format.ts';
import { useDictLabel, useUserName } from '../../lib/hooks.ts';
import type { FieldDef, Method } from '../../lib/types.ts';
import { Badge, Button, ErrorState, Skeleton } from '../../components/ui/primitives.tsx';
import { Dialog } from '../../components/ui/overlays.tsx';
import { EntityPicker, type PickerItem } from '../../components/ui/EntityPicker.tsx';
import { customDisplay } from './form.tsx';

type Entity = 'contact' | 'company';
interface MergeRecord extends Record<string, unknown> {
  id: number; title: string; createdAt: string; custom: Record<string, unknown>; methods: Method[];
  related: Record<string, number>; canKeep: boolean; canRemove: boolean;
}
interface Compare { records: [MergeRecord, MergeRecord]; fields: { key: string; label: string }[]; customFields: FieldDef[] }

const NOUN = { contact: { one: 'contact', many: 'contacts', path: '/contacts' }, company: { one: 'company', many: 'companies', path: '/companies' } };
const RELATED_LABEL: Record<string, [string, string]> = {
  deals: ['deal', 'deals'], companies: ['company', 'companies'], contacts: ['contact', 'contacts'], activities: ['activity', 'activities'], notes: ['note', 'notes'],
};

/** Merge the current record with another one: pick it, choose what to keep, confirm. */
export function MergeDialog({ entity, open, onOpenChange, current }: {
  entity: Entity; open: boolean; onOpenChange: (v: boolean) => void;
  current: { id: number; name: string; emails: string[]; phones: string[]; websites?: string[] };
}) {
  const [other, setOther] = useState<PickerItem | null>(null);
  const close = (v: boolean) => { onOpenChange(v); if (!v) setOther(null); };
  const n = NOUN[entity];
  return (
    <Dialog open={open} onOpenChange={close} size="lg" title={other ? `Merge ${n.many}` : `Merge “${current.name}” with…`}
      description={other ? undefined : `Pick the duplicate ${n.one}. You choose which one to keep and which values win on the next step.`}>
      {other
        ? <Compare entity={entity} ids={[current.id, other.id]} onBack={() => setOther(null)} onDone={() => close(false)} />
        : <Pick entity={entity} current={current} onPick={setOther} />}
    </Dialog>
  );
}

function Pick({ entity, current, onPick }: { entity: Entity; current: { id: number; name: string; emails: string[]; phones: string[]; websites?: string[] }; onPick: (p: PickerItem) => void }) {
  const hints = useQuery({
    queryKey: ['duplicates', entity, current.id],
    queryFn: () => api.get<{ data: { entityType: string; id: number; title: string; matchedOn: string; value: string }[] }>(`/duplicates${qsOf({
      email: current.emails.join(','), phone: current.phones.join(','), website: (current.websites ?? []).join(','), excludeType: entity, excludeId: current.id,
      ...(entity === 'contact' ? { name: current.name } : { companyName: current.name }),
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
        <EntityPicker entity={entity === 'contact' ? 'contacts' : 'companies'} value={null}
          onChange={(p) => { if (p && p.id !== current.id) onPick(p); }} placeholder={`Find a ${NOUN[entity].one}…`} />
      </section>
    </div>
  );
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)
  || (typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((x) => x === null || x === ''));

function Compare({ entity, ids, onBack, onDone }: { entity: Entity; ids: [number, number]; onBack: () => void; onDone: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const dictLabel = useDictLabel();
  const userName = useUserName();
  const n = NOUN[entity];
  const q = useQuery({ queryKey: ['merge', entity, ids.join(',')], queryFn: () => api.get<Compare>(`/merge/${entity}?ids=${ids.join(',')}`) });
  const [keepIdx, setKeepIdx] = useState<0 | 1 | null>(null);
  const [picked, setPicked] = useState<Record<string, 0 | 1>>({});
  const [busy, setBusy] = useState(false);

  const data = q.data;
  const recs = data?.records;
  // Default: keep the record with more attached to it (then the older one), if the user may.
  const keep: 0 | 1 = keepIdx ?? (() => {
    if (!recs) return 0;
    const ok = (i: 0 | 1) => recs[i].canKeep && recs[i === 0 ? 1 : 0].canRemove;
    if (!ok(0) || !ok(1)) return ok(1) ? 1 : 0;
    const weight = (r: MergeRecord) => Object.values(r.related).reduce((a, b) => a + b, 0);
    const diff = weight(recs[1]) - weight(recs[0]);
    if (diff !== 0) return diff > 0 ? 1 : 0;
    return new Date(recs[1].createdAt) < new Date(recs[0].createdAt) ? 1 : 0;
  })();
  const drop: 0 | 1 = keep === 0 ? 1 : 0;
  const allowed = !!recs && recs[keep].canKeep && recs[drop].canRemove;

  /** Comparable rows: [key, label, value per record, display per record]. */
  const rows = useMemo(() => {
    if (!data) return [];
    const show = (key: string, r: MergeRecord): ReactNode => {
      const v = r[key];
      switch (key) {
        case 'name': return r.title;
        case 'typeId': case 'sourceId': case 'industryId': case 'sizeId': return v ? dictLabel(v as number) : null;
        case 'ownerId': return userName(v as number);
        case 'primaryCompanyId': return (r.companyName as string) ?? null;
        case 'birthday': return v ? date(v as string) : null;
        case 'annualRevenue': return v ? money(v as string, r.currency as string) : null;
        case 'visibility': return v === 'private' ? 'Private' : 'Shared';
        case 'address': return isEmpty(v) ? null : Object.values(v as Record<string, string>).filter(Boolean).join(', ');
        default: return isEmpty(v) ? null : String(v);
      }
    };
    const val = (key: string, r: MergeRecord) => (key === 'name'
      ? (entity === 'contact' ? [r.firstName, r.lastName] : r.name)
      : key === 'annualRevenue' ? (r.annualRevenue ? [r.annualRevenue, r.currency] : null) : r[key]);
    const base = data.fields.map((f) => ({ key: f.key, label: f.label, values: data.records.map((r) => val(f.key, r)), shown: data.records.map((r) => show(f.key, r)) }));
    const custom = data.customFields.map((d) => ({
      key: `custom.${d.key}`, label: d.label, values: data.records.map((r) => r.custom?.[d.key]),
      shown: data.records.map((r) => (isEmpty(r.custom?.[d.key]) ? null : customDisplay(d, r.custom?.[d.key], userName))),
    }));
    return [...base, ...custom];
  }, [data, entity, dictLabel, userName]);
  const differing = rows.filter((r) => JSON.stringify(r.values[0] ?? null) !== JSON.stringify(r.values[1] ?? null));
  const sameCount = rows.length - differing.length;
  const choiceOf = (key: string, values: unknown[]): 0 | 1 => picked[key] ?? (isEmpty(values[keep]) && !isEmpty(values[drop]) ? drop : keep);

  const merge = async () => {
    if (!recs) return;
    setBusy(true);
    try {
      const choose = Object.fromEntries(differing.map((r) => [r.key, choiceOf(r.key, r.values) === keep ? 'survivor' : 'merged']));
      const res = await api.post<{ id: number }>(`/merge/${entity}`, { survivorId: recs[keep].id, mergedId: recs[drop].id, choose });
      for (const k of [n.many, entity, 'deals', 'timeline', 'history', 'duplicates']) qc.invalidateQueries({ queryKey: [k] });
      toast.success(`${n.many[0].toUpperCase()}${n.many.slice(1)} merged`);
      onDone();
      nav(`${n.path}/${res.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };

  if (q.isLoading) return <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-40" /></div>;
  if (q.error || !recs) return <div><ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /><Button icon={<ArrowLeft className="size-4" />} onClick={onBack}>Back</Button></div>;

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-[13px] font-medium">Which {n.one} do you keep?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {recs.map((r, i) => {
            const can = r.canKeep && recs[i === 0 ? 1 : 0].canRemove;
            return (
              <label key={r.id} className={cn('relative flex cursor-pointer flex-col gap-1 rounded-[var(--radius-card)] border p-3 text-sm',
                keep === i ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:bg-brand-600/10' : 'border-base hover:bg-[var(--surface-2)]/60',
                !can && 'cursor-not-allowed opacity-60')}>
                <input type="radio" name="keep" className="sr-only" checked={keep === i} disabled={!can} onChange={() => { setKeepIdx(i as 0 | 1); setPicked({}); }} />
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold">{r.title}</span>
                  {keep === i ? <Badge tone="brand"><Check className="size-3" />Keep</Badge> : <Badge>Merge away</Badge>}
                </span>
                <span className="text-xs text-muted">#{r.id} · added {date(r.createdAt)}</span>
                <span className="text-xs text-muted">{Object.entries(r.related).map(([k, c]) => `${c} ${RELATED_LABEL[k]?.[c === 1 ? 0 : 1] ?? k}`).join(' · ')}</span>
                {!can && <span className="text-xs text-rose-600">You can’t {r.canKeep ? 'remove the other one' : `edit this ${n.one}`}</span>}
              </label>
            );
          })}
        </div>
      </fieldset>

      <section>
        <h3 className="mb-2 text-[13px] font-medium">{differing.length ? 'Choose the values to keep' : 'All fields are the same'}</h3>
        {differing.length > 0 && (
          <div className="divide-y divide-[var(--border)] rounded-[var(--radius-card)] border border-base">
            {differing.map((row) => {
              const choice = choiceOf(row.key, row.values);
              return (
                <div key={row.key} role="radiogroup" aria-label={row.label} className="grid gap-2 px-3 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
                  <span className="text-[13px] font-medium text-muted">{row.label}</span>
                  {([0, 1] as const).map((i) => (
                    <button key={i} type="button" role="radio" aria-checked={choice === i} onClick={() => setPicked({ ...picked, [row.key]: i })}
                      className={cn('flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm',
                        choice === i ? 'border-brand-500 bg-brand-50 dark:bg-brand-600/10' : 'border-base hover:bg-[var(--surface-2)]/60')}>
                      <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border', choice === i ? 'border-brand-600 bg-brand-600 text-white' : 'border-base')}>
                        {choice === i && <Check className="size-3" />}
                      </span>
                      <span className="min-w-0">
                        <span className={cn('block break-words', row.shown[i] === null && 'italic text-muted')}>{row.shown[i] ?? 'empty'}</span>
                        <span className="block truncate text-[11px] text-muted sm:hidden">from {recs[i].title} #{recs[i].id}</span>
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        )}
        {sameCount > 0 && differing.length > 0 && <p className="mt-1.5 text-xs text-muted">{sameCount} other fields are the same or empty in both.</p>}
      </section>

      <p className="flex gap-2 rounded-md bg-[var(--surface-2)] px-3 py-2.5 text-[13px] text-muted">
        <Info className="mt-0.5 size-4 shrink-0" />
        <span>Emails and phones from both are kept. {entity === 'contact' ? 'Deals, companies' : 'Deals, contacts'}, activities and notes move to “{recs[keep].title}”,
          and the history of both is combined. “{recs[drop].title}” is removed. This can’t be undone.</span>
      </p>

      <div className="flex flex-wrap justify-end gap-2 border-t border-base pt-3">
        <Button icon={<ArrowLeft className="size-4" />} onClick={onBack} disabled={busy}>Pick another</Button>
        <Button variant="primary" loading={busy} disabled={!allowed} onClick={merge}>Merge into “{recs[keep].title}”</Button>
      </div>
    </div>
  );
}
