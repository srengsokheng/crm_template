import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, CalendarClock, Circle, Plus, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, qsOf } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { dueLabel, money, relative } from '../../lib/format.ts';
import { useCan, useLocalStorage, useMe, usePipelines } from '../../lib/hooks.ts';
import { Button, Card, ErrorState, Segmented, Select, Skeleton } from '../../components/ui/primitives.tsx';
import { useCreate } from '../../app/create.tsx';
import { ACTIVITY_ICON } from '../records/Timeline.tsx';

interface Dashboard {
  period: { from: string; to: string };
  kpis: { openAmount: string; openCount: number; weightedAmount: string; wonAmount: string; wonCount: number; lostCount: number; winRate: number | null; overdueDeals: number; overdueActivities: number; openLeads: number | null; newLeads: number | null };
  byStage: { id: number; name: string; count: number; amount: string }[];
  trend: { month: string; won: string; lost: string }[];
  myDay: { id: number; kind: keyof typeof ACTIVITY_ICON; subject: string; dueAt: string | null; link: { entityType: string; entityId: number } | null }[];
  recent: { id: number; action: string; changes: Record<string, unknown>; createdAt: string; actorName: string | null; title: string; entityId: number }[];
}

// Validated categorical slots 1–2 (see dataviz palette): light / dark variants.
const SERIES = { won: { light: '#2a78d6', dark: '#3987e5' }, lost: { light: '#eb6834', dark: '#d95926' } };
const isDark = () => document.documentElement.dataset.theme === 'dark';

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' }) {
  return (
    <div className="surface rounded-[var(--radius-card)] border border-base p-4">
      <div className="text-[13px] text-muted">{label}</div>
      <div className={cn('mt-1 text-2xl font-semibold tracking-tight tabular', tone === 'warn' && 'text-rose-600')}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function HomePage() {
  const { data: me } = useMe();
  const can = useCan();
  const create = useCreate();
  const qc = useQueryClient();
  const pipelines = usePipelines('deal');
  const [scope, setScope] = useLocalStorage<'me' | 'team' | 'all'>('dash-scope', 'all');
  const [pipelineId, setPipelineId] = useLocalStorage<number | null>('dash-pipeline', null);
  const pid = pipelines.some((p) => p.id === pipelineId) ? pipelineId : null;
  const q = useQuery({ queryKey: ['dashboard', scope, pid], queryFn: () => api.get<Dashboard>(`/dashboard${qsOf({ scope, pipelineId: pid })}`) });
  const cur = me?.workspace.baseCurrency ?? 'USD';
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const complete = async (id: number) => {
    try { await api.patch(`/activities/${id}`, { status: 'done' }); qc.invalidateQueries({ queryKey: ['dashboard'] }); qc.invalidateQueries({ queryKey: ['activity-counts'] }); toast.success('Marked as done'); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const k = q.data?.kpis;
  const dark = isDark();
  const maxStage = Math.max(1, ...(q.data?.byStage ?? []).map((s) => Number(s.amount)));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{greet}, {me?.user.name.split(' ')[0]}</h1>
          <p className="text-sm text-muted">Here’s where things stand{q.data ? ` · ${new Date(q.data.period.from).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}` : ''}.</p>
        </div>
        <Segmented value={scope} onChange={setScope} options={[{ value: 'me', label: 'Me' }, { value: 'team', label: 'My team' }, { value: 'all', label: 'Everyone' }]} />
      </div>

      {q.error ? <Card><ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /></Card> : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {!k ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />) : <>
            <Kpi label="Open pipeline" value={money(k.openAmount, cur, { compact: true })} sub={`${k.openCount} deals · ${money(k.weightedAmount, cur, { compact: true })} weighted`} />
            <Kpi label="Won this month" value={money(k.wonAmount, cur, { compact: true })} sub={`${k.wonCount} deal${k.wonCount === 1 ? '' : 's'}`} />
            <Kpi label="Win rate" value={k.winRate === null ? '—' : `${k.winRate}%`} sub={`${k.wonCount} won · ${k.lostCount} lost this month`} />
            <Kpi label="Overdue" value={String(k.overdueActivities)} sub={`activities · ${k.overdueDeals} deals past close date`} tone={k.overdueActivities ? 'warn' : undefined} />
          </>}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <div className="min-w-0 space-y-4">
          <Card title="Pipeline by stage" actions={pipelines.length > 1 && (
            <Select aria-label="Pipeline" className="h-8 w-auto text-xs" value={pid ?? ''} onChange={(e) => setPipelineId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Default pipeline</option>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          )}>
            {!q.data ? <Skeleton className="h-40" /> : q.data.byStage.every((s) => s.count === 0) ? (
              <div className="py-8 text-center text-sm text-muted">No open deals yet. {can('deal', 'create') && <button type="button" className="font-medium text-brand-600" onClick={() => create.open('deal')}>Create one</button>}</div>
            ) : (
              <ul className="space-y-2.5" aria-label="Open deal value by stage">
                {q.data.byStage.map((s) => (
                  <li key={s.id} className="grid grid-cols-[minmax(6rem,9rem)_1fr_auto] items-center gap-3 text-sm">
                    <span className="truncate text-muted">{s.name}</span>
                    <div className="h-5 rounded-r-[4px] bg-[var(--surface-2)]" title={`${s.name}: ${money(s.amount, cur)} across ${s.count} deals`}>
                      <div className="h-full rounded-r-[4px]" style={{ width: `${(Number(s.amount) / maxStage) * 100}%`, minWidth: Number(s.amount) > 0 ? 4 : 0, background: dark ? SERIES.won.dark : SERIES.won.light }} />
                    </div>
                    <span className="w-28 text-right tabular"><span className="font-medium">{money(s.amount, cur, { compact: true })}</span> <span className="text-xs text-muted">· {s.count}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={<span className="flex items-center gap-1.5"><TrendingUp className="size-4 text-muted" />Won vs lost — last 6 months</span>}>
            {!q.data ? <Skeleton className="h-56" /> : (
              <>
                <div className="h-56" role="img" aria-label="Bar chart of won and lost deal value per month">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={q.data.trend.map((t) => ({ month: new Date(`${t.month}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short' }), Won: Number(t.won), Lost: Number(t.lost) }))} barGap={2} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="var(--border)" />
                      <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                      <YAxis tickLine={false} axisLine={false} width={56} tick={{ fill: 'var(--muted)', fontSize: 12 }} tickFormatter={(v: number) => money(v, cur, { compact: true })} />
                      <Tooltip cursor={{ fill: 'var(--surface-2)' }} formatter={(v) => money(Number(v), cur)} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)' }} />
                      <Legend iconType="square" wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span style={{ color: 'var(--muted)' }}>{v}</span>} />
                      <Bar dataKey="Won" fill={dark ? SERIES.won.dark : SERIES.won.light} radius={[4, 4, 0, 0]} maxBarSize={28} />
                      <Bar dataKey="Lost" fill={dark ? SERIES.lost.dark : SERIES.lost.light} radius={[4, 4, 0, 0]} maxBarSize={28} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <table className="sr-only"><caption>Won and lost value per month</caption><thead><tr><th>Month</th><th>Won</th><th>Lost</th></tr></thead>
                  <tbody>{q.data.trend.map((t) => <tr key={t.month}><td>{t.month}</td><td>{money(t.won, cur)}</td><td>{money(t.lost, cur)}</td></tr>)}</tbody></table>
              </>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <Card title={<span className="flex items-center gap-1.5"><CalendarClock className="size-4 text-brand-600" />My day</span>} padded={false}
            actions={can('activity', 'create') && <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => create.open('activity')}>Add</Button>}>
            {!q.data ? <div className="p-4"><Skeleton className="h-24" /></div> : q.data.myDay.length ? (
              <ul className="divide-y divide-[var(--border)]">
                {q.data.myDay.map((a) => {
                  const due = dueLabel(a.dueAt);
                  const Icon = ACTIVITY_ICON[a.kind];
                  const href = a.link ? `/${a.link.entityType === 'company' ? 'companies' : a.link.entityType + 's'}/${a.link.entityId}` : '/activities';
                  return (
                    <li key={a.id} className="flex items-start gap-3 px-4 py-2.5">
                      <button type="button" aria-label={`Complete ${a.subject}`} onClick={() => complete(a.id)} className="mt-0.5 text-muted hover:text-emerald-600"><Circle className="size-[18px]" /></button>
                      <Link to={href} className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-sm font-medium"><Icon className="size-3.5 shrink-0 text-muted" /><span className="truncate">{a.subject}</span></div>
                        <div className={cn('text-xs', due.tone === 'overdue' ? 'text-rose-600' : 'text-muted')}>{due.tone === 'overdue' ? `Overdue · ${due.text}` : due.text}</div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="px-4 py-6 text-center text-sm text-muted">Nothing due today. 🎉</p>}
          </Card>
          <Card title="Recent deal activity" padded={false}>
            {!q.data ? <div className="p-4"><Skeleton className="h-24" /></div> : q.data.recent.length ? (
              <ul className="divide-y divide-[var(--border)]">
                {q.data.recent.map((r) => {
                  const stage = r.changes?.stage as [string | null, string] | undefined;
                  const text = r.action === 'created' ? 'created' : r.action === 'won' ? 'won 🎉' : r.action === 'lost' ? 'lost' : r.action === 'reopened' ? 'reopened' : `moved to ${stage?.[1] ?? 'a new stage'}`;
                  return (
                    <li key={r.id} className="px-4 py-2.5 text-sm">
                      <Link to={`/deals/${r.entityId}`} className="font-medium hover:underline">{r.title}</Link> <span className="text-muted">{text}</span>
                      <div className="text-xs text-muted">{r.actorName ?? 'Automation'} · {relative(r.createdAt)}</div>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="px-4 py-6 text-center text-sm text-muted">No deal activity yet.</p>}
          </Card>
          {k && k.openLeads !== null && me?.workspace.useLeads && (
            <Card>
              <div className="flex items-center justify-between text-sm">
                <div><div className="text-muted">Open leads</div><div className="text-xl font-semibold tabular">{k.openLeads}</div></div>
                <div className="text-right"><div className="text-muted">New this month</div><div className="text-xl font-semibold tabular">{k.newLeads}</div></div>
              </div>
              {k.openLeads > 0 && <Link to="/leads" className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-brand-600 hover:underline"><AlertTriangle className="size-3.5" />Review leads</Link>}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
