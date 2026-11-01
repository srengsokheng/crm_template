import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BarChart3, Download } from 'lucide-react';
import { api, errorMessage, qsOf } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { date, money } from '../../lib/format.ts';
import { useCan, useMe, usePipelines } from '../../lib/hooks.ts';
import { Card, EmptyState, ErrorState, Input, PageHeader, Select, Skeleton } from '../../components/ui/primitives.tsx';
import { useListParams } from '../records/list.tsx';

const REPORTS = [
  { key: 'won-deals', title: 'Won deals', desc: 'Deals closed as won in the period.' },
  { key: 'deals-by-stage', title: 'Deals by stage', desc: 'Where deals sit across your pipeline stages.' },
  { key: 'deals-by-owner', title: 'Sales by owner', desc: 'Compare people by deals, win rate and revenue.' },
  { key: 'lead-conversion', title: 'Lead conversion', desc: 'How many leads became customers, by source.' },
  { key: 'expected-sales', title: 'Expected sales', desc: 'Open deals by expected close month, weighted by probability.' },
  { key: 'overdue-deals', title: 'Overdue deals', desc: 'Open deals past their expected close date.' },
  { key: 'activities-by-user', title: 'Activities by person', desc: 'Calls, meetings and tasks completed and overdue.' },
  { key: 'product-sales', title: 'Product sales', desc: 'Revenue per product in won deals.' },
] as const;

const MONEY = new Set(['amount', 'totalAmount', 'wonAmount', 'avgWonDeal', 'weighted', 'revenue']);
const PCT = new Set(['share', 'winRate', 'conversionRate']);
const DATE = new Set(['closedAt', 'expectedCloseDate']);
const HIDDEN = new Set(['id', 'currency', 'kind']);
const human = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

function presetRange(p: string): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear(); const m = now.getMonth();
  const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  switch (p) {
    case 'last-month': return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case 'quarter': { const qs = Math.floor(m / 3) * 3; return { from: iso(new Date(y, qs, 1)), to: iso(new Date(y, qs + 3, 0)) }; }
    case 'year': return { from: `${y}-01-01`, to: `${y}-12-31` };
    case 'next-quarter': { const qs = Math.floor(m / 3) * 3 + 3; return { from: iso(new Date(y, qs, 1)), to: iso(new Date(y, qs + 3, 0)) }; }
    default: return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
  }
}

export function ReportsPage() {
  const { data: me } = useMe();
  const can = useCan();
  const pipelines = usePipelines('deal');
  const lp = useListParams({ sort: '' });
  const key = lp.get('report') || 'won-deals';
  const report = REPORTS.find((r) => r.key === key) ?? REPORTS[0];
  const preset = lp.get('period') || 'month';
  const range = preset === 'custom' ? { from: lp.get('from') || presetRange('month').from, to: lp.get('to') || presetRange('month').to } : presetRange(preset);
  const params = { ...range, scope: lp.get('scope') || undefined, pipelineId: lp.get('pipelineId') || undefined, groupBy: key === 'lead-conversion' ? lp.get('groupBy') || undefined : undefined };
  const q = useQuery({ queryKey: ['report', key, params], placeholderData: keepPreviousData, queryFn: () => api.get<{ rows: Record<string, unknown>[]; totals?: Record<string, unknown> }>(`/reports/${key}${qsOf(params)}`) });
  const cur = me?.workspace.baseCurrency ?? 'USD';
  const cols = q.data?.rows[0] ? Object.keys(q.data.rows[0]).filter((c) => !HIDDEN.has(c)) : [];
  const fmt = (c: string, v: unknown, row: Record<string, unknown>) => {
    if (v === null || v === undefined) return '—';
    if (MONEY.has(c)) return money(String(v), (row.currency as string) ?? cur);
    if (PCT.has(c)) return `${v}%`;
    if (DATE.has(c)) return date(String(v));
    return String(v);
  };
  const canExport = can('deal', 'export');
  return (
    <div>
      <PageHeader title="Reports" subtitle="Understand your pipeline and team performance" />
      <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <nav aria-label="Reports" className="flex gap-1 overflow-x-auto lg:flex-col">
          {REPORTS.map((r) => (
            <button key={r.key} type="button" onClick={() => lp.set({ report: r.key === 'won-deals' ? null : r.key })}
              className={cn('whitespace-nowrap rounded-md px-3 py-2 text-left text-[13px] font-medium', r.key === key ? 'bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-100' : 'text-muted hover:bg-[var(--surface-2)] hover:text-[var(--text)]')}>
              {r.title}
            </button>
          ))}
        </nav>
        <div className="min-w-0 space-y-3">
          <div>
            <h2 className="text-base font-semibold">{report.title}</h2>
            <p className="text-sm text-muted">{report.desc}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {key !== 'overdue-deals' && (
              <Select aria-label="Period" className="w-auto" value={preset} onChange={(e) => lp.set({ period: e.target.value === 'month' ? null : e.target.value })}>
                <option value="month">This month</option><option value="last-month">Last month</option><option value="quarter">This quarter</option>
                <option value="next-quarter">Next quarter</option><option value="year">This year</option><option value="custom">Custom…</option>
              </Select>
            )}
            {preset === 'custom' && <>
              <Input aria-label="From" type="date" className="w-auto" value={range.from} onChange={(e) => lp.set({ from: e.target.value })} />
              <Input aria-label="To" type="date" className="w-auto" value={range.to} onChange={(e) => lp.set({ to: e.target.value })} />
            </>}
            <Select aria-label="Scope" className="w-auto" value={lp.get('scope')} onChange={(e) => lp.set({ scope: e.target.value })}>
              <option value="">Everyone I can see</option><option value="team">My team</option><option value="me">Only me</option>
            </Select>
            {pipelines.length > 1 && !['lead-conversion', 'activities-by-user'].includes(key) && (
              <Select aria-label="Pipeline" className="w-auto" value={lp.get('pipelineId')} onChange={(e) => lp.set({ pipelineId: e.target.value })}>
                <option value="">All pipelines</option>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            )}
            {key === 'lead-conversion' && (
              <Select aria-label="Group by" className="w-auto" value={lp.get('groupBy')} onChange={(e) => lp.set({ groupBy: e.target.value })}>
                <option value="">By source</option><option value="owner">By owner</option>
              </Select>
            )}
            {canExport && (
              <a href={`/api/v1/reports/${key}${qsOf({ ...params, format: 'csv' })}`} className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md border border-base surface px-3 text-[13px] font-medium hover:bg-[var(--surface-2)]">
                <Download className="size-4" />Export CSV
              </a>
            )}
          </div>
          {q.data?.totals && (
            <div className="flex flex-wrap gap-3">
              {Object.entries(q.data.totals).map(([k, v]) => (
                <div key={k} className="surface rounded-lg border border-base px-4 py-2.5">
                  <div className="text-xs text-muted">{human(k)}</div>
                  <div className="text-lg font-semibold tabular">{MONEY.has(k) ? money(String(v), cur) : PCT.has(k) ? `${v}%` : String(v)}</div>
                </div>
              ))}
            </div>
          )}
          <Card padded={false}>
            {q.isLoading ? <div className="p-4"><Skeleton className="h-40" /></div>
              : q.error ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
              : !q.data?.rows.length ? <EmptyState icon={<BarChart3 className="size-5" />} title="No data for this period" description="Try a wider date range or a different scope." />
              : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead className="border-b border-base bg-[var(--surface-2)]/60 text-left text-xs text-muted">
                      <tr>{cols.map((c) => <th key={c} className={cn('px-3 py-2.5 font-medium', (MONEY.has(c) || PCT.has(c) || typeof q.data!.rows[0][c] === 'number') && 'text-right')}>{human(c)}</th>)}</tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border)]">
                      {q.data.rows.map((r, i) => (
                        <tr key={i}>
                          {cols.map((c) => (
                            <td key={c} className={cn('px-3 py-2', (MONEY.has(c) || PCT.has(c) || typeof r[c] === 'number') && 'text-right tabular')}>
                              {c === 'title' && r.id ? <Link to={`/deals/${r.id}`} className="font-medium text-brand-600 hover:underline">{String(r[c])}</Link> : fmt(c, r[c], r)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Card>
        </div>
      </div>
    </div>
  );
}
