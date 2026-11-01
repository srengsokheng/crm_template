import { useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Circle, ListTodo, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, errorMessage, qsOf } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { dateTime, dueLabel, relative } from '../../lib/format.ts';
import { useCan, useMeta } from '../../lib/hooks.ts';
import type { Activity, ListResponse } from '../../lib/types.ts';
import { Badge, Button, Card, EmptyState, ErrorState, IconButton, PageHeader, Select, Skeleton } from '../../components/ui/primitives.tsx';
import { Pagination } from '../../components/ui/DataTable.tsx';
import { useCreate } from '../../app/create.tsx';
import { ACTIVITY_ICON } from '../records/Timeline.tsx';
import { FilterSelect, SearchBox, Toolbar, useListParams } from '../records/list.tsx';

const BUCKETS = [
  { value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Today' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'nodate', label: 'No date' }, { value: 'done', label: 'Done' },
] as const;
const PATH: Record<string, string> = { deal: 'deals', lead: 'leads', contact: 'contacts', company: 'companies' };

export function ActivitiesPage() {
  const can = useCan();
  const create = useCreate();
  const qc = useQueryClient();
  const { data: meta } = useMeta();
  const lp = useListParams({ sort: '' });
  const bucket = lp.get('bucket') || 'today';
  const params = { ...lp.params, bucket, sort: lp.get('sort') || undefined, assigneeId: lp.get('assigneeId') || 'me' };
  const counts = useQuery({ queryKey: ['activity-counts'], queryFn: () => api.get<Record<string, number>>('/activities/counts') });
  const q = useQuery({ queryKey: ['activities', params], placeholderData: keepPreviousData, queryFn: () => api.get<ListResponse<Activity>>(`/activities${qsOf(params)}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['activities'] }); qc.invalidateQueries({ queryKey: ['activity-counts'] }); qc.invalidateQueries({ queryKey: ['timeline'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); };
  const setStatus = async (a: Activity, status: 'open' | 'done') => {
    try {
      await api.patch(`/activities/${a.id}`, { status }); refresh();
      if (status === 'done') toast.success('Marked as done', { action: { label: 'Undo', onClick: () => setStatus(a, 'open') } });
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const [busyId, setBusyId] = useState<number | null>(null);
  const remove = async (a: Activity) => { setBusyId(a.id); try { await api.del(`/activities/${a.id}`); refresh(); toast.success('Activity deleted'); } catch (e) { toast.error(errorMessage(e)); } finally { setBusyId(null); } };
  return (
    <div>
      <PageHeader title="Activities" subtitle="Your calls, meetings, tasks and deadlines"
        actions={can('activity', 'create') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => create.open('activity')}>New activity</Button>} />
      <div className="mb-3 flex gap-1 overflow-x-auto border-b border-base" role="tablist">
        {BUCKETS.map((b) => (
          <button key={b.value} type="button" role="tab" aria-selected={bucket === b.value} onClick={() => lp.set({ bucket: b.value === 'today' ? null : b.value })}
            className={cn('-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium', bucket === b.value ? 'border-brand-600 text-brand-700 dark:text-brand-200' : 'border-transparent text-muted hover:text-[var(--text)]')}>
            {b.label}
            {b.value !== 'done' && counts.data && counts.data[b.value] > 0 && <span className={cn('rounded-full px-1.5 text-[11px]', b.value === 'overdue' ? 'bg-rose-500 text-white' : 'bg-[var(--surface-2)]')}>{counts.data[b.value]}</span>}
          </button>
        ))}
      </div>
      <Toolbar>
        <SearchBox value={lp.get('q')} onChange={(v) => lp.set({ q: v })} placeholder="Search activities" />
        <Select aria-label="Assigned to" className="w-auto min-w-40" value={lp.get('assigneeId') || 'me'} onChange={(e) => lp.set({ assigneeId: e.target.value === 'me' ? null : e.target.value })}>
          <option value="me">Assigned to me</option><option value="all">Everyone I can see</option>
          {(meta?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
        <FilterSelect label="Type" value={lp.get('kind')} onChange={(v) => lp.set({ kind: v })} options={['task', 'call', 'meeting', 'email', 'deadline'].map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) }))} />
      </Toolbar>
      <Card padded={false}>
        {q.isLoading ? <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
          : q.error ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
          : !q.data?.data.length ? <EmptyState icon={<ListTodo className="size-5" />} title={bucket === 'overdue' ? 'Nothing overdue' : bucket === 'done' ? 'Nothing completed yet' : 'Nothing here'} description={bucket === 'today' ? 'Plan your next steps from any deal or lead.' : undefined} />
          : (
            <ul className="divide-y divide-[var(--border)]">
              {q.data.data.map((a) => {
                const Icon = ACTIVITY_ICON[a.kind];
                const due = dueLabel(a.dueAt);
                const done = a.status === 'done';
                return (
                  <li key={a.id} className="flex items-start gap-3 px-4 py-3">
                    <button type="button" onClick={() => setStatus(a, done ? 'open' : 'done')} aria-label={done ? `Reopen ${a.subject}` : `Complete ${a.subject}`} className={cn('mt-0.5', done ? 'text-emerald-600' : 'text-muted hover:text-emerald-600')}>
                      {done ? <CheckCircle2 className="size-[18px]" /> : <Circle className="size-[18px]" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className={cn('flex flex-wrap items-center gap-1.5 text-sm font-medium', done && 'text-muted line-through')}>
                        <Icon className="size-3.5 text-muted" />{a.subject}{a.priority === 'high' && !done && <Badge tone="red">High</Badge>}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
                        <span className={cn(!done && due.tone === 'overdue' && 'font-medium text-rose-600', !done && due.tone === 'today' && 'font-medium text-amber-600')}>{done ? `Completed ${relative(a.completedAt)}` : a.dueAt ? dateTime(a.dueAt) : 'No due date'}</span>
                        {a.assigneeName && <span>· {a.assigneeName}</span>}
                        {a.links.map((l) => <Link key={`${l.entityType}-${l.entityId}`} to={`/${PATH[l.entityType]}/${l.entityId}`} className="text-brand-600 hover:underline">· {l.title}</Link>)}
                      </div>
                      {a.description && <p className="mt-1 line-clamp-2 text-[13px] text-muted">{a.description}</p>}
                    </div>
                    {!done && <IconButton size="sm" label="Edit activity" onClick={() => create.open('activity', { activity: a })}><Pencil className="size-3.5" /></IconButton>}
                    <IconButton size="sm" label="Delete activity" disabled={busyId === a.id} onClick={() => remove(a)}><Trash2 className="size-3.5" /></IconButton>
                  </li>
                );
              })}
            </ul>
          )}
        <Pagination page={lp.page} pageSize={lp.pageSize} total={q.data?.total ?? 0} onPage={(p) => lp.set({ page: p }, false)} />
      </Card>
    </div>
  );
}
