import { useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, Users } from 'lucide-react';
import { api, errorMessage, qsOf } from '../../lib/api.ts';
import { relative, personName } from '../../lib/format.ts';
import { useCan, useDict } from '../../lib/hooks.ts';
import type { ListResponse } from '../../lib/types.ts';
import { Avatar, Button, EmptyState, PageHeader } from '../../components/ui/primitives.tsx';
import { DataTable, Pagination, type Column } from '../../components/ui/DataTable.tsx';
import { useCreate } from '../../app/create.tsx';
import { BulkBar, FilterSelect, SearchBox, Toolbar, useListParams } from '../records/list.tsx';

interface Row { id: number; firstName: string | null; lastName: string | null; jobTitle: string | null; companyName: string | null; primaryCompanyId: number | null; email: string | null; phone: string | null; ownerName: string | null; ownerId: number; createdAt: string }

export function ContactsPage() {
  const nav = useNavigate();
  const can = useCan();
  const create = useCreate();
  const types = useDict('contact_type');
  const lp = useListParams({ sort: '-createdAt' });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const q = useQuery({ queryKey: ['contacts', lp.params], queryFn: () => api.get<ListResponse<Row>>(`/contacts${qsOf(lp.params)}`), placeholderData: keepPreviousData });
  const cols: Column<Row>[] = [
    { key: 'name', header: 'Name', sortKey: 'name', cell: (r) => (
      <div className="flex items-center gap-2.5"><Avatar name={personName(r.firstName, r.lastName)} size="sm" />
        <div className="min-w-0"><div className="truncate font-medium">{personName(r.firstName, r.lastName)}</div>{r.jobTitle && <div className="truncate text-xs text-muted">{r.jobTitle}</div>}</div></div>) },
    { key: 'company', header: 'Company', sortKey: 'company', cell: (r) => r.companyName ?? <span className="text-muted">—</span> },
    { key: 'email', header: 'Email', hideOnMobile: true, cell: (r) => r.email ? <a href={`mailto:${r.email}`} onClick={(e) => e.stopPropagation()} className="text-brand-600 hover:underline">{r.email}</a> : <span className="text-muted">—</span> },
    { key: 'phone', header: 'Phone', hideOnMobile: true, cell: (r) => r.phone ?? <span className="text-muted">—</span> },
    { key: 'owner', header: 'Owner', sortKey: 'owner', hideOnMobile: true, cell: (r) => r.ownerName ?? '—' },
    { key: 'created', header: 'Added', sortKey: 'createdAt', hideOnMobile: true, cell: (r) => <span className="text-muted">{relative(r.createdAt)}</span> },
  ];
  return (
    <div>
      <PageHeader title="Contacts" subtitle="People you work with" actions={can('contact', 'create') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => create.open('contact')}>New contact</Button>} />
      <Toolbar>
        <SearchBox value={lp.get('q')} onChange={(v) => lp.set({ q: v })} placeholder="Search name, email, phone, company" />
        <FilterSelect label="Owner" value={lp.get('ownerId')} onChange={(v) => lp.set({ ownerId: v })} options={[{ value: 'me', label: 'Me' }]} />
        <FilterSelect label="Type" value={lp.get('typeId')} onChange={(v) => lp.set({ typeId: v })} options={types.map((t) => ({ value: String(t.id), label: t.label }))} />
      </Toolbar>
      <BulkBar entityPath="contacts" selected={selected} clear={() => setSelected(new Set())} canDelete={can('contact', 'delete')} canEdit={can('contact', 'edit')} />
      <DataTable columns={cols} rows={q.data?.data ?? []} loading={q.isLoading} error={q.error ? errorMessage(q.error) : null} onRetry={() => q.refetch()}
        sort={lp.sort} onSort={(s) => lp.set({ sort: s })} onRowClick={(r) => nav(`/contacts/${r.id}`)} selected={selected} onSelect={setSelected}
        empty={<EmptyState icon={<Users className="size-5" />} title={lp.get('q') ? 'No contacts match your search' : 'No contacts yet'}
          description={lp.get('q') ? 'Try a different name, email or phone.' : 'Add the people you sell to, or convert a lead.'}
          action={!lp.get('q') && can('contact', 'create') ? <Button variant="primary" onClick={() => create.open('contact')}>Add a contact</Button> : undefined} />}
        footer={<Pagination page={lp.page} pageSize={lp.pageSize} total={q.data?.total ?? 0} onPage={(p) => lp.set({ page: p }, false)} onPageSize={(n) => lp.set({ pageSize: n })} />} />
    </div>
  );
}
