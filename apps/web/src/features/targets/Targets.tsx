import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Target } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { money } from '../../lib/format.ts';
import { Button, Card, EmptyState, ErrorState, IconButton, Input, Skeleton } from '../../components/ui/primitives.tsx';
import { AdminOnly } from '../settings/SettingsLayout.tsx';

interface Row { userId: number; name: string; target: string | null; won: string; wonCount: number; pct: number | null }
interface Targets { month: string; baseCurrency: string; canEdit: boolean; team: { target: string | null; won: string; wonCount: number; pct: number | null }; people: Row[]; me: Row | null }

const thisMonth = () => new Date().toISOString().slice(0, 7);
function shift(month: string, by: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}
const monthName = (month: string) => new Date(`${month}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const useTargets = (month: string) => useQuery({ queryKey: ['targets', month], queryFn: () => api.get<Targets>(`/targets?month=${month}`) });

/** A progress bar: brand colour up to 100 %, green once the target is reached. */
function Progress({ pct, label }: { pct: number | null; label: string }) {
  const v = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-2)]" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? 0}>
      <div className={cn('h-full rounded-full', (pct ?? 0) >= 100 ? 'bg-emerald-500' : 'bg-brand-600')} style={{ width: `${v}%` }} />
    </div>
  );
}

/** Dashboard card: this month's targets for the people this user may see. Hidden when no target is set. */
export function TargetsCard() {
  const month = thisMonth();
  const q = useTargets(month);
  if (q.isLoading) return <Card title="Targets"><Skeleton className="h-24" /></Card>;
  if (q.isError) return <Card title="Targets"><ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /></Card>;
  const t = q.data!;
  const withTargets = t.people.filter((p) => p.target);
  if (!t.team.target && withTargets.length === 0) {
    return t.canEdit ? (
      <Card title={<span className="flex items-center gap-1.5"><Target className="size-4 text-muted" />Targets</span>}>
        <p className="text-sm text-muted">Set a monthly sales target for each person and see progress here. <Link className="text-brand-600 underline underline-offset-2 dark:text-brand-200" to="/settings/targets">Set targets</Link></p>
      </Card>
    ) : null;
  }
  const cur = t.baseCurrency;
  return (
    <Card title={<span className="flex items-center gap-1.5"><Target className="size-4 text-muted" />Targets — {monthName(month)}</span>}
      actions={t.canEdit && <Link className="text-xs text-brand-600 hover:underline dark:text-brand-200" to="/settings/targets">Edit</Link>}>
      <div className="space-y-4">
        {t.team.target && (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2 text-sm"><span className="font-medium">Whole team</span><span className="tabular text-muted">{money(t.team.won, cur)} of {money(t.team.target, cur)} · <span className="font-medium text-[var(--text)]">{t.team.pct}%</span></span></div>
            <Progress pct={t.team.pct} label={`Whole team: ${t.team.pct}% of target`} />
          </div>
        )}
        {withTargets.length > 0 && (
          <ul className="space-y-3">
            {withTargets.map((p) => (
              <li key={p.userId} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className={cn('min-w-0 truncate', p.userId === t.me?.userId && 'font-medium')}>{p.name}{p.userId === t.me?.userId ? ' (you)' : ''}</span>
                  <span className="shrink-0 tabular text-muted">{money(p.won, cur)} of {money(p.target, cur)} · <span className="font-medium text-[var(--text)]">{p.pct}%</span></span>
                </div>
                <Progress pct={p.pct} label={`${p.name}: ${p.pct}% of target`} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** Settings → Sales targets (admins): amounts per person per month. */
export function TargetsSettings() {
  const qc = useQueryClient();
  const [month, setMonth] = useState(thisMonth());
  const q = useTargets(month);
  const prev = useTargets(shift(month, -1));
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyOf = (uid: number | null) => (uid === null ? 'team' : String(uid));
  const initial = useMemo(() => {
    const m: Record<string, string> = { team: q.data?.team.target ? String(Number(q.data.team.target)) : '' };
    for (const p of q.data?.people ?? []) m[keyOf(p.userId)] = p.target ? String(Number(p.target)) : '';
    return m;
  }, [q.data]);
  useEffect(() => { setDraft(initial); setError(null); }, [initial]);
  const dirty = Object.keys(initial).some((k) => (draft[k] ?? '') !== initial[k]);
  const save = async () => {
    setSaving(true); setError(null);
    try {
      const targets = Object.keys(initial).filter((k) => (draft[k] ?? '') !== initial[k])
        .map((k) => ({ userId: k === 'team' ? null : Number(k), amount: draft[k]?.trim() ? draft[k].trim() : null }));
      await api.put('/targets', { month, targets });
      await qc.invalidateQueries({ queryKey: ['targets'] });
      toast.success('Targets saved');
    } catch (e) { setError(e instanceof ApiError ? e.message : errorMessage(e)); } finally { setSaving(false); }
  };
  const copyPrevious = () => {
    if (!prev.data) return;
    const m: Record<string, string> = { ...draft, team: prev.data.team.target ? String(Number(prev.data.team.target)) : draft.team ?? '' };
    for (const p of prev.data.people) if (p.target && keyOf(p.userId) in initial) m[keyOf(p.userId)] = String(Number(p.target));
    setDraft(m);
  };
  const prevHasTargets = !!prev.data && (!!prev.data.team.target || prev.data.people.some((p) => p.target));
  const cur = q.data?.baseCurrency ?? '';
  return (
    <AdminOnly>
      <Card title="Sales targets" actions={
        <div className="flex items-center gap-1">
          <IconButton size="sm" label="Previous month" onClick={() => setMonth(shift(month, -1))}><ChevronLeft className="size-4" /></IconButton>
          <span className="min-w-[8.5rem] text-center text-sm font-medium" aria-live="polite">{monthName(month)}</span>
          <IconButton size="sm" label="Next month" onClick={() => setMonth(shift(month, 1))}><ChevronRight className="size-4" /></IconButton>
        </div>}>
        <p className="mb-4 text-sm text-muted">What each person should win this month, in {cur || 'the base currency'}. Progress counts deals marked won in the month, converted like the dashboard. Leave a box empty for no target.</p>
        {q.isLoading ? <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
          : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
          : q.data!.people.length === 0 ? <EmptyState title="No active users" />
          : (
            <div className="space-y-4">
              <div className="overflow-x-auto rounded-md border border-base">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--surface-2)]/60 text-left text-xs text-muted"><tr><th className="px-3 py-2 font-medium">Person</th><th className="px-3 py-2 font-medium">Target ({cur})</th><th className="px-3 py-2 text-right font-medium">Won</th></tr></thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    <tr className="bg-[var(--surface-2)]/30">
                      <td className="px-3 py-2 font-medium">Whole team</td>
                      <td className="px-3 py-2"><Input aria-label="Target for the whole team" inputMode="decimal" className="w-24 sm:w-40" value={draft.team ?? ''} onChange={(e) => setDraft({ ...draft, team: e.target.value })} /></td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular">{money(q.data!.team.won, cur)}</td>
                    </tr>
                    {q.data!.people.map((p) => (
                      <tr key={p.userId}>
                        <td className="max-w-[8rem] truncate px-3 py-2 sm:max-w-[14rem]">{p.name}</td>
                        <td className="px-3 py-2"><Input aria-label={`Target for ${p.name}`} inputMode="decimal" className="w-24 sm:w-40" value={draft[keyOf(p.userId)] ?? ''} onChange={(e) => setDraft({ ...draft, [keyOf(p.userId)]: e.target.value })} /></td>
                        <td className="whitespace-nowrap px-3 py-2 text-right tabular">{money(p.won, cur)}{p.wonCount ? <span className="text-muted max-sm:hidden"> · {p.wonCount} deal{p.wonCount === 1 ? '' : 's'}</span> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {error && <p className="text-sm text-rose-600" role="alert">{error}</p>}
              <div className="flex flex-wrap justify-end gap-2">
                <Button disabled={!prevHasTargets} onClick={copyPrevious}>Copy {monthName(shift(month, -1)).split(' ')[0]}’s targets</Button>
                <Button variant="primary" disabled={!dirty} loading={saving} onClick={save}>Save</Button>
              </div>
            </div>
          )}
      </Card>
    </AdminOnly>
  );
}
