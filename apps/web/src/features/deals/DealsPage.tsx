import { useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Handshake, KanbanSquare, List, Plus } from 'lucide-react';
import { api, errorMessage, qsOf } from '../../lib/api.ts';
import { date, money, relative } from '../../lib/format.ts';
import { useCan, useMe, usePipelines } from '../../lib/hooks.ts';
import type { ListResponse, NextActivity } from '../../lib/types.ts';
import { Badge, Button, EmptyState, ErrorState, PageHeader, Segmented, Select, Skeleton } from '../../components/ui/primitives.tsx';
import { DataTable, Pagination, type Column } from '../../components/ui/DataTable.tsx';
import { StageBadge } from '../../components/ui/StageBadge.tsx';
import { useCreate } from '../../app/create.tsx';
import { BulkBar, FilterSelect, SearchBox, Toolbar, useListParams } from '../records/list.tsx';
import { Board, type BoardCard, type BoardStat } from './Board.tsx';
import { useStageMove } from './useStageMove.tsx';

interface DealRow {
  id: number; title: string; amount: string; currency: string; status: string; stageId: number; stageName: string; stageColor: string; rotDays: number | null;
  ownerName: string | null; ownerId: number; companyName: string | null; contactName: string | null; expectedCloseDate: string | null;
  nextActivity: NextActivity | null; stageChangedAt: string; createdAt: string;
}

export function DealsPage() {
  const nav = useNavigate();
  const can = useCan();
  const create = useCreate();
  const { data: me } = useMe();
  const pipelines = usePipelines('deal');
  const lp = useListParams({ sort: '-createdAt' });
  const view = (lp.get('view') || 'board') as 'board' | 'list';
  const pipelineId = Number(lp.get('pipelineId')) || pipelines.find((p) => p.isDefault)?.id || pipelines[0]?.id;
  const pipeline = pipelines.find((p) => p.id === pipelineId);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const qc = useQueryClient();
  const filters = { q: lp.get('q'), ownerId: lp.get('ownerId'), pipelineId };
  const boardKey = ['deals-board', filters];
  const board = useQuery({
    queryKey: boardKey, enabled: view === 'board' && !!pipelineId, placeholderData: keepPreviousData,
    queryFn: () => api.get<{ stats: BoardStat[]; deals: DealRow[] }>(`/deals/board${qsOf(filters)}`),
  });
  const list = useQuery({
    queryKey: ['deals', { ...lp.params, pipelineId }], enabled: view === 'list', placeholderData: keepPreviousData,
    queryFn: () => api.get<ListResponse<DealRow>>(`/deals${qsOf({ ...lp.params, pipelineId })}`),
  });
  const mover = useStageMove('deal', {
    onOptimistic: (id, stageId) => qc.setQueryData<{ stats: BoardStat[]; deals: DealRow[] }>(boardKey, (old) => old && ({
      ...old, deals: old.deals.map((d) => (d.id === id ? { ...d, stageId } : d)).filter((d) => pipeline?.stages.find((s) => s.id === d.stageId)?.kind === 'open'),
    })),
  });
  const currency = me?.workspace.baseCurrency ?? 'USD';
  const cards: BoardCard[] = (board.data?.deals ?? []).map((d) => ({
    id: d.id, title: d.title, amount: d.amount, currency: d.currency, stageId: d.stageId, ownerName: d.ownerName, ownerId: d.ownerId,
    subtitle: [d.companyName, d.contactName].filter(Boolean).join(' · ') || null, nextActivity: d.nextActivity, stageChangedAt: d.stageChangedAt, rotDays: d.rotDays, href: `/deals/${d.id}`,
  }));
  const cols: Column<DealRow>[] = [
    { key: 'title', header: 'Deal', sortKey: 'title', cell: (r) => <div className="min-w-0"><div className="truncate font-medium">{r.title}</div><div className="truncate text-xs text-muted">{[r.companyName, r.contactName].filter(Boolean).join(' · ')}</div></div> },
    { key: 'stage', header: 'Stage', sortKey: 'stage', cell: (r) => <StageBadge name={r.stageName} color={r.stageColor} /> },
    { key: 'amount', header: 'Amount', sortKey: 'amount', align: 'right', cell: (r) => money(r.amount, r.currency) },
    { key: 'next', header: 'Next step', hideOnMobile: true, cell: (r) => r.nextActivity ? <span className="text-[13px]">{r.nextActivity.subject} <span className="text-muted">· {relative(r.nextActivity.dueAt)}</span></span> : r.status === 'open' ? <Badge tone="amber">None</Badge> : <span className="text-muted">—</span> },
    { key: 'close', header: 'Expected close', sortKey: 'expectedCloseDate', hideOnMobile: true, cell: (r) => <span className={r.status === 'open' && r.expectedCloseDate && r.expectedCloseDate < new Date().toISOString().slice(0, 10) ? 'text-rose-600' : ''}>{date(r.expectedCloseDate)}</span> },
    { key: 'owner', header: 'Owner', sortKey: 'owner', hideOnMobile: true, cell: (r) => r.ownerName ?? '—' },
  ];
  const statusOptions = [{ value: 'open', label: 'Open' }, { value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' }];
  return (
    <div>
      <PageHeader title="Deals" actions={<>
        <Segmented value={view} onChange={(v) => lp.set({ view: v === 'board' ? null : v })} options={[{ value: 'board', label: 'Board', icon: <KanbanSquare className="size-4" /> }, { value: 'list', label: 'List', icon: <List className="size-4" /> }]} />
        {can('deal', 'create') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => create.open('deal', { pipelineId })}>New deal</Button>}
      </>} />
      <Toolbar right={view === 'list' && list.data?.aggregates && <span className="text-[13px] text-muted">Total <span className="font-semibold text-[var(--text)] tabular">{money(list.data.aggregates.amountSum, currency)}</span></span>}>
        {pipelines.length > 1 && (
          <Select aria-label="Pipeline" className="w-auto min-w-40" value={pipelineId ?? ''} onChange={(e) => lp.set({ pipelineId: e.target.value })}>
            {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        )}
        <SearchBox value={lp.get('q')} onChange={(v) => lp.set({ q: v })} placeholder="Search deals, companies, contacts" />
        <FilterSelect label="Owner" value={lp.get('ownerId')} onChange={(v) => lp.set({ ownerId: v })} options={[{ value: 'me', label: 'Me' }]} />
        {view === 'list' && <FilterSelect label="Status" value={lp.get('status')} onChange={(v) => lp.set({ status: v })} options={statusOptions} />}
      </Toolbar>
      {view === 'board' ? (
        board.isLoading || !pipeline ? <div className="flex gap-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-96 w-[17rem]" />)}</div>
          : board.error ? <ErrorState message={errorMessage(board.error)} onRetry={() => board.refetch()} />
          : (
            <>
              {cards.length === 0 && !lp.get('q') && (
                <div className="mb-3 rounded-lg border border-dashed border-base p-4 text-sm text-muted">No open deals in this pipeline yet. Use <b>Add</b> on a stage or <b>New deal</b> to create one.</div>
              )}
              <Board stages={pipeline.stages} cards={cards} stats={board.data?.stats ?? []} currency={currency}
                canDrag={(c) => can('deal', 'edit', c.ownerId)}
                onMove={(card, to) => mover.move(card.id, card.title, pipeline.stages.find((s) => s.id === card.stageId), to)}
                onQuickAdd={can('deal', 'create') ? (s) => create.open('deal', { pipelineId, stageId: s.id, stay: true }) : undefined}
                closedZones={{ won: pipeline.stages.find((s) => s.kind === 'won'), lost: pipeline.stages.find((s) => s.kind === 'lost'), wonLabel: 'Won', lostLabel: 'Lost' }} />
            </>
          )
      ) : (
        <>
          <BulkBar entityPath="deals" selected={selected} clear={() => setSelected(new Set())} canDelete={can('deal', 'delete')} canEdit={can('deal', 'edit')} />
          <DataTable columns={cols} rows={list.data?.data ?? []} loading={list.isLoading} error={list.error ? errorMessage(list.error) : null} onRetry={() => list.refetch()}
            sort={lp.sort} onSort={(s) => lp.set({ sort: s })} onRowClick={(r) => nav(`/deals/${r.id}`)} selected={selected} onSelect={setSelected}
            empty={<EmptyState icon={<Handshake className="size-5" />} title="No deals found" description="Try clearing filters, or create a new deal." />}
            footer={<Pagination page={lp.page} pageSize={lp.pageSize} total={list.data?.total ?? 0} onPage={(p) => lp.set({ page: p }, false)} onPageSize={(n) => lp.set({ pageSize: n })} />} />
        </>
      )}
      {mover.dialogs}
    </div>
  );
}
