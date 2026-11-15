import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Bot, Download, ScrollText } from 'lucide-react';
import { api, errorMessage, qsOf } from '../../lib/api.ts';
import { dateTime, relative } from '../../lib/format.ts';
import { useMediaQuery, useMeta } from '../../lib/hooks.ts';
import type { ListResponse } from '../../lib/types.ts';
import { Avatar, Badge, EmptyState, ErrorState, Input, Skeleton } from '../../components/ui/primitives.tsx';
import { DataTable, Pagination, type Column } from '../../components/ui/DataTable.tsx';
import { describeEvent } from '../records/Timeline.tsx';
import { FilterSelect, SearchBox, Toolbar, useListParams } from '../records/list.tsx';
import { AdminOnly } from './SettingsLayout.tsx';

interface Row {
  id: number; createdAt: string; action: string; entityType: string; entityId: number; changes: Record<string, unknown>;
  actorType: string; actorId: number | null; actorName: string | null; title: string | null; gone: boolean;
}

const TYPE_LABEL: Record<string, string> = { export: 'Export', deal: 'Deal', lead: 'Lead', contact: 'Contact', company: 'Company', product: 'Product', import: 'Import', activity: 'Activity' };
const PATH: Record<string, (id: number) => string> = {
  deal: (id) => `/deals/${id}`, lead: (id) => `/leads/${id}`, contact: (id) => `/contacts/${id}`, company: (id) => `/companies/${id}`, import: (id) => `/imports/${id}`,
};
const EXPORT_NOUN: Record<string, string> = { contact: 'contacts', company: 'companies', lead: 'leads', deal: 'deals' };
const ACTION_LABEL = (a: string) => a.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function AuditLog() {
  const { data: meta } = useMeta();
  const lp = useListParams({ sort: '-createdAt', pageSize: 50 });
  const facets = useQuery({ queryKey: ['audit-facets'], queryFn: () => api.get<{ actions: string[]; entityTypes: string[] }>('/audit-log/facets') });
  const q = useQuery({ queryKey: ['audit-log', lp.params], placeholderData: keepPreviousData, queryFn: () => api.get<ListResponse<Row>>(`/audit-log${qsOf(lp.params)}`) });
  const userName = (id: number) => meta?.users.find((u) => u.id === id)?.name ?? 'Unknown';
  const wide = useMediaQuery('(min-width: 768px)');
  const filtered = ['q', 'entityType', 'action', 'actorId', 'from', 'to'].some((k) => lp.get(k));
  const what = (r: Row) => {
    const ev = describeEvent({ ...r, changes: r.changes ?? {} }, userName);
    const imp = (r.changes as { _import?: { file: string } })._import;
    const text = r.entityType === 'import' && r.action === 'imported'
      ? `Import finished: ${r.changes.created_count ?? 0} created, ${r.changes.updated_count ?? 0} updated, ${r.changes.failed_count ?? 0} failed`
      : r.entityType === 'import' && r.action === 'undone' ? `Import undone: ${r.changes.deleted ?? 0} records moved to the recycle bin`
      : r.entityType === 'export' ? `Exported ${r.changes.count ?? 0} ${EXPORT_NOUN[String(r.changes.entity)] ?? 'records'} to CSV${r.changes.truncated ? ' (limit reached)' : ''}` : ev.text;
    return `${text}${imp && !text.includes(imp.file) ? ` (import of ${imp.file})` : ''}`;
  };
  const who = (r: Row) => (r.actorType === 'automation' ? 'Automation' : r.actorName ?? 'System');
  const record = (r: Row) => {
    const label = r.entityType === 'export' ? (EXPORT_NOUN[String(r.changes.entity)] ?? 'records') : r.title ?? `#${r.entityId}`;
    const to = PATH[r.entityType]?.(r.entityId);
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Badge>{TYPE_LABEL[r.entityType] ?? r.entityType}</Badge>
        {to && !r.gone ? <Link to={to} className="truncate font-medium text-brand-600 hover:underline dark:text-brand-200">{label}</Link>
          : <span className="truncate font-medium">{label}{r.gone && <span className="ml-1 text-xs font-normal text-muted">(deleted)</span>}</span>}
      </div>
    );
  };
  const cols: Column<Row>[] = [
    { key: 'when', header: 'When', className: 'w-36', cell: (r) => <span title={dateTime(r.createdAt)} className="whitespace-nowrap text-muted">{relative(r.createdAt)}</span> },
    { key: 'who', header: 'Who', className: 'w-44', cell: (r) => r.actorType === 'automation'
      ? <span className="inline-flex items-center gap-2 text-violet-700 dark:text-violet-300"><Bot className="size-4" />Automation</span>
      : <span className="inline-flex min-w-0 items-center gap-2"><Avatar name={r.actorName ?? 'System'} size="xs" /><span className="truncate">{r.actorName ?? 'System'}</span></span> },
    { key: 'record', header: 'Record', cell: record },
    { key: 'what', header: 'What happened', cell: (r) => <span className="line-clamp-2 break-words text-[13px]" title={what(r)}>{what(r)}</span> },
  ];
  return (
    <AdminOnly>
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">Audit log</h2>
            <p className="text-sm text-muted">Every change in this workspace: who did what, and when.</p>
          </div>
          <a href={`/api/v1/audit-log${qsOf({ ...lp.params, page: undefined, pageSize: undefined, format: 'csv' })}`} download
            className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-base surface px-3 text-[13px] font-medium hover:bg-[var(--surface-2)]">
            <Download className="size-4" />Export CSV
          </a>
        </div>
        <Toolbar>
          <SearchBox value={lp.get('q')} onChange={(v) => lp.set({ q: v })} placeholder="Search record name" />
          <FilterSelect label="Type" value={lp.get('entityType')} onChange={(v) => lp.set({ entityType: v })}
            options={(facets.data?.entityTypes ?? []).map((t) => ({ value: t, label: TYPE_LABEL[t] ?? t }))} />
          <FilterSelect label="Action" value={lp.get('action')} onChange={(v) => lp.set({ action: v })}
            options={(facets.data?.actions ?? []).map((a) => ({ value: a, label: ACTION_LABEL(a) }))} />
          <FilterSelect label="Who" value={lp.get('actorId')} onChange={(v) => lp.set({ actorId: v })}
            options={[{ value: 'automation', label: 'Automation' }, ...(meta?.users ?? []).map((u) => ({ value: String(u.id), label: u.name }))]} />
          <div className="flex items-center gap-1.5">
            <Input type="date" aria-label="From date" className="w-auto" value={lp.get('from')} onChange={(e) => lp.set({ from: e.target.value })} />
            <span className="text-muted">–</span>
            <Input type="date" aria-label="To date" className="w-auto" value={lp.get('to')} onChange={(e) => lp.set({ to: e.target.value })} />
          </div>
        </Toolbar>
        {!wide && (
        <div>
          <div className="surface overflow-hidden rounded-[var(--radius-card)] border border-base">
            {q.isLoading ? <div className="space-y-2 p-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>
              : q.error ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
              : !q.data?.data.length ? <EmptyState icon={<ScrollText className="size-5" />} title={filtered ? 'No changes match these filters' : 'No changes yet'}
            description={filtered ? 'Try a wider date range or clear a filter.' : 'Changes to records appear here as people work.'} />
              : (
                <ul className="divide-y divide-[var(--border)]">
                  {q.data.data.map((r) => (
                    <li key={r.id} className="space-y-1 px-3 py-2.5 text-sm">
                      {record(r)}
                      <p className="break-words text-[13px]">{what(r)}</p>
                      <p className="text-xs text-muted">{who(r)} · <span title={dateTime(r.createdAt)}>{relative(r.createdAt)}</span></p>
                    </li>
                  ))}
                </ul>
              )}
            <Pagination page={lp.page} pageSize={lp.pageSize} total={q.data?.total ?? 0} onPage={(p) => lp.set({ page: p }, false)} />
          </div>
        </div>
        )}
        {wide && (
        <div>
        <DataTable columns={cols} rows={q.data?.data ?? []} loading={q.isLoading} error={q.error ? errorMessage(q.error) : null} onRetry={() => q.refetch()}
          empty={<EmptyState icon={<ScrollText className="size-5" />} title={filtered ? 'No changes match these filters' : 'No changes yet'}
            description={filtered ? 'Try a wider date range or clear a filter.' : 'Changes to records appear here as people work.'} />}
          footer={<Pagination page={lp.page} pageSize={lp.pageSize} total={q.data?.total ?? 0} onPage={(p) => lp.set({ page: p }, false)} onPageSize={(n) => lp.set({ pageSize: n })} />} />
        </div>
        )}
      </div>
    </AdminOnly>
  );
}
