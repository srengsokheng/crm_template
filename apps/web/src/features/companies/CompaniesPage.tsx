import { useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Building2, Plus, Upload } from 'lucide-react';
import { api, errorMessage, qsOf } from '../../lib/api.ts';
import { relative } from '../../lib/format.ts';
import { useCan, useDict, useDictLabel } from '../../lib/hooks.ts';
import type { ListResponse } from '../../lib/types.ts';
import { Button, EmptyState, PageHeader } from '../../components/ui/primitives.tsx';
import { DataTable, Pagination, type Column } from '../../components/ui/DataTable.tsx';
import { useCreate } from '../../app/create.tsx';
import { BulkBar, FilterSelect, SearchBox, Toolbar, useListParams } from '../records/list.tsx';

interface Row { id: number; name: string; typeId: number | null; industryId: number | null; website: string | null; phone: string | null; ownerName: string | null; contactsCount: number; openDealsCount: number; createdAt: string }

export function CompaniesPage() {
  const nav = useNavigate();
  const can = useCan();
  const create = useCreate();
  const label = useDictLabel();
  const types = useDict('company_type');
  const industries = useDict('industry');
  const lp = useListParams({ sort: '-createdAt' });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const q = useQuery({ queryKey: ['companies', lp.params], queryFn: () => api.get<ListResponse<Row>>(`/companies${qsOf(lp.params)}`), placeholderData: keepPreviousData });
  const cols: Column<Row>[] = [
    { key: 'name', header: 'Company', sortKey: 'name', cell: (r) => (
      <div className="flex items-center gap-2.5"><span className="flex size-7 items-center justify-center rounded-md bg-[var(--surface-2)] text-muted"><Building2 className="size-4" /></span>
        <div className="min-w-0"><div className="truncate font-medium">{r.name}</div>{r.website && <div className="truncate text-xs text-muted">{r.website.replace(/^https?:\/\//, '')}</div>}</div></div>) },
    { key: 'type', header: 'Type', cell: (r) => label(r.typeId) },
    { key: 'industry', header: 'Industry', hideOnMobile: true, cell: (r) => label(r.industryId) },
    { key: 'contacts', header: 'Contacts', align: 'right', hideOnMobile: true, cell: (r) => r.contactsCount },
    { key: 'deals', header: 'Open deals', align: 'right', cell: (r) => r.openDealsCount },
    { key: 'owner', header: 'Owner', sortKey: 'owner', hideOnMobile: true, cell: (r) => r.ownerName ?? '—' },
    { key: 'created', header: 'Added', sortKey: 'createdAt', hideOnMobile: true, cell: (r) => <span className="text-muted">{relative(r.createdAt)}</span> },
  ];
  return (
    <div>
      <PageHeader title="Companies" subtitle="Organisations you do business with" actions={<>
        {can('company', 'import') && <Button icon={<Upload className="size-4" />} onClick={() => nav('/import/company')}>Import</Button>}
        {can('company', 'create') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => create.open('company')}>New company</Button>}
      </>} />
      <Toolbar>
        <SearchBox value={lp.get('q')} onChange={(v) => lp.set({ q: v })} placeholder="Search name, website, phone" />
        <FilterSelect label="Owner" value={lp.get('ownerId')} onChange={(v) => lp.set({ ownerId: v })} options={[{ value: 'me', label: 'Me' }]} />
        <FilterSelect label="Type" value={lp.get('typeId')} onChange={(v) => lp.set({ typeId: v })} options={types.map((t) => ({ value: String(t.id), label: t.label }))} />
        <FilterSelect label="Industry" value={lp.get('industryId')} onChange={(v) => lp.set({ industryId: v })} options={industries.map((t) => ({ value: String(t.id), label: t.label }))} />
      </Toolbar>
      <BulkBar entityPath="companies" selected={selected} clear={() => setSelected(new Set())} canDelete={can('company', 'delete')} canEdit={can('company', 'edit')} />
      <DataTable columns={cols} rows={q.data?.data ?? []} loading={q.isLoading} error={q.error ? errorMessage(q.error) : null} onRetry={() => q.refetch()}
        sort={lp.sort} onSort={(s) => lp.set({ sort: s })} onRowClick={(r) => nav(`/companies/${r.id}`)} selected={selected} onSelect={setSelected}
        empty={<EmptyState icon={<Building2 className="size-5" />} title={lp.get('q') ? 'No companies match your search' : 'No companies yet'}
          action={!lp.get('q') && can('company', 'create') ? <Button variant="primary" onClick={() => create.open('company')}>Add a company</Button> : undefined} />}
        footer={<Pagination page={lp.page} pageSize={lp.pageSize} total={q.data?.total ?? 0} onPage={(p) => lp.set({ page: p }, false)} onPageSize={(n) => lp.set({ pageSize: n })} />} />
    </div>
  );
}
