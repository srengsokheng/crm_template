import { useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { KanbanSquare, List, Plus, Zap } from 'lucide-react';
import { api, errorMessage, qsOf } from '../../lib/api.ts';
import { money, personName, relative } from '../../lib/format.ts';
import { useCan, useDict, useMe, usePipelines } from '../../lib/hooks.ts';
import type { ListResponse, NextActivity } from '../../lib/types.ts';
import { Button, EmptyState, ErrorState, PageHeader, Segmented, Skeleton } from '../../components/ui/primitives.tsx';
import { DataTable, Pagination, type Column } from '../../components/ui/DataTable.tsx';
import { StageBadge } from '../../components/ui/StageBadge.tsx';
import { useCreate } from '../../app/create.tsx';
import { BulkBar, FilterSelect, SearchBox, Toolbar, useListParams } from '../records/list.tsx';
import { Board, type BoardCard, type BoardStat } from '../deals/Board.tsx';
import { useStageMove } from '../deals/useStageMove.tsx';

interface LeadRow {
  id: number; title: string; firstName: string | null; lastName: string | null; companyName: string | null; amount: string | null; currency: string;
  status: string; stageId: number; stageName: string; stageColor: string; sourceName: string | null; ownerName: string | null; ownerId: number;
  email: string | null; phone: string | null; nextActivity: NextActivity | null; stageChangedAt: string; createdAt: string;
}

export function LeadsPage() {
  const nav = useNavigate();
  const can = useCan();
  const create = useCreate();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const sources = useDict('lead_source');
  const pipeline = usePipelines('lead')[0];
  const lp = useListParams({ sort: '-createdAt' });
  const view = (lp.get('view') || 'board') as 'board' | 'list';
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const filters = { q: lp.get('q'), ownerId: lp.get('ownerId'), sourceId: lp.get('sourceId') };
  const boardKey = ['leads-board', filters];
  const board = useQuery({ queryKey: boardKey, enabled: view === 'board', placeholderData: keepPreviousData, queryFn: () => api.get<{ stats: BoardStat[]; leads: LeadRow[] }>(`/leads/board${qsOf(filters)}`) });
  const listParams = { status: 'open', ...lp.params };
  const list = useQuery({ queryKey: ['leads', listParams], enabled: view === 'list', placeholderData: keepPreviousData, queryFn: () => api.get<ListResponse<LeadRow>>(`/leads${qsOf(listParams)}`) });
  const mover = useStageMove('lead', {
    onOptimistic: (id, stageId) => qc.setQueryData<{ stats: BoardStat[]; leads: LeadRow[] }>(boardKey, (old) => old && ({ ...old, leads: old.leads.map((l) => (l.id === id ? { ...l, stageId } : l)) })),
  });
  if (me && !me.workspace.useLeads) {
    return <EmptyState icon={<Zap className="size-5" />} title="Leads are turned off" description="Your workspace creates deals directly. An admin can turn leads on in Settings → Workspace." />;
  }
  const cards: BoardCard[] = (board.data?.leads ?? []).map((l) => ({
    id: l.id, title: l.title, amount: l.amount, currency: l.currency, stageId: l.stageId, ownerName: l.ownerName, ownerId: l.ownerId,
    subtitle: [personName(l.firstName, l.lastName) !== 'Unnamed' ? personName(l.firstName, l.lastName) : null, l.sourceName].filter(Boolean).join(' · ') || null,
    nextActivity: l.nextActivity, stageChangedAt: l.stageChangedAt, href: `/leads/${l.id}`,
  }));
  const cols: Column<LeadRow>[] = [
    { key: 'title', header: 'Lead', sortKey: 'title', cell: (r) => <div className="min-w-0"><div className="truncate font-medium">{r.title}</div><div className="truncate text-xs text-muted">{[personName(r.firstName, r.lastName) !== 'Unnamed' && personName(r.firstName, r.lastName), r.email ?? r.phone].filter(Boolean).join(' · ')}</div></div> },
    { key: 'stage', header: 'Stage', sortKey: 'stage', cell: (r) => <StageBadge name={r.stageName} color={r.stageColor} /> },
    { key: 'source', header: 'Source', sortKey: 'source', hideOnMobile: true, cell: (r) => r.sourceName ?? <span className="text-muted">—</span> },
    { key: 'amount', header: 'Value', sortKey: 'amount', align: 'right', hideOnMobile: true, cell: (r) => money(r.amount, r.currency) },
    { key: 'owner', header: 'Owner', sortKey: 'owner', hideOnMobile: true, cell: (r) => r.ownerName ?? '—' },
    { key: 'created', header: 'Created', sortKey: 'createdAt', cell: (r) => <span className="text-muted">{relative(r.createdAt)}</span> },
  ];
  return (
    <div>
      <PageHeader title="Leads" subtitle="New interest to qualify before it becomes a deal" actions={<>
        <Segmented value={view} onChange={(v) => lp.set({ view: v === 'board' ? null : v })} options={[{ value: 'board', label: 'Board', icon: <KanbanSquare className="size-4" /> }, { value: 'list', label: 'List', icon: <List className="size-4" /> }]} />
        {can('lead', 'create') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => create.open('lead')}>New lead</Button>}
      </>} />
      <Toolbar>
        <SearchBox value={lp.get('q')} onChange={(v) => lp.set({ q: v })} placeholder="Search name, company, email, phone" />
        <FilterSelect label="Owner" value={lp.get('ownerId')} onChange={(v) => lp.set({ ownerId: v })} options={[{ value: 'me', label: 'Me' }]} />
        <FilterSelect label="Source" value={lp.get('sourceId')} onChange={(v) => lp.set({ sourceId: v })} options={sources.map((s) => ({ value: String(s.id), label: s.label }))} />
      </Toolbar>
      {view === 'board' ? (
        board.isLoading || !pipeline ? <div className="flex gap-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-96 w-[17rem]" />)}</div>
          : board.error ? <ErrorState message={errorMessage(board.error)} onRetry={() => board.refetch()} />
          : <Board stages={pipeline.stages} cards={cards} stats={board.data?.stats ?? []} currency={me?.workspace.baseCurrency ?? 'USD'}
              canDrag={(c) => can('lead', 'edit', c.ownerId)}
              onMove={(card, to) => mover.move(card.id, card.title, pipeline.stages.find((s) => s.id === card.stageId), to)}
              onQuickAdd={can('lead', 'create') ? (s) => create.open('lead', { stageId: s.id, stay: true }) : undefined}
              closedZones={{ lost: pipeline.stages.find((s) => s.kind === 'lost'), lostLabel: 'Disqualify' }} />
      ) : (
        <>
          <BulkBar entityPath="leads" selected={selected} clear={() => setSelected(new Set())} canDelete={can('lead', 'delete')} canEdit={can('lead', 'edit')} />
          <DataTable columns={cols} rows={list.data?.data ?? []} loading={list.isLoading} error={list.error ? errorMessage(list.error) : null} onRetry={() => list.refetch()}
            sort={lp.sort} onSort={(s) => lp.set({ sort: s })} onRowClick={(r) => nav(`/leads/${r.id}`)} selected={selected} onSelect={setSelected}
            empty={<EmptyState icon={<Zap className="size-5" />} title="No open leads" description="New inquiries show up here. Converted and disqualified leads are hidden." />}
            footer={<Pagination page={lp.page} pageSize={lp.pageSize} total={list.data?.total ?? 0} onPage={(p) => lp.set({ page: p }, false)} onPageSize={(n) => lp.set({ pageSize: n })} />} />
        </>
      )}
      {mover.dialogs}
    </div>
  );
}
