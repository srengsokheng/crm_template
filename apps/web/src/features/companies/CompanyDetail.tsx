import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.ts';
import { money, personName } from '../../lib/format.ts';
import { useCan, useDictLabel, useUserName } from '../../lib/hooks.ts';
import type { Method } from '../../lib/types.ts';
import { Avatar, Button, Card, IconButton, Input, Select, Textarea } from '../../components/ui/primitives.tsx';
import { Menu } from '../../components/ui/overlays.tsx';
import { useCreate } from '../../app/create.tsx';
import { DictSelect, MethodsEditor, methodsPayload, UserSelect } from '../records/form.tsx';
import { CustomFieldsRows, EditRow, RecordError, RecordShell, RecordSkeleton, useDeleteWithUndo } from '../records/record.tsx';
import { MethodsView } from '../records/MethodsView.tsx';
import { RelatedDeals, type RelatedDeal } from '../records/RelatedDeals.tsx';
import { Timeline } from '../records/Timeline.tsx';

interface Company {
  id: number; version: number; name: string; typeId: number | null; industryId: number | null; sizeId: number | null; sourceId: number | null;
  annualRevenue: string | null; currency: string; ownerId: number; visibility: string; description: string | null; custom: Record<string, unknown>;
  methods: Method[]; contacts: { id: number; firstName: string | null; lastName: string | null; jobTitle: string | null }[]; deals: RelatedDeal[];
}

export function CompanyDetail() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const can = useCan();
  const create = useCreate();
  const label = useDictLabel();
  const userName = useUserName();
  const q = useQuery({ queryKey: ['company', id], queryFn: () => api.get<Company>(`/companies/${id}`) });
  const del = useDeleteWithUndo('companies', 'Company', () => nav('/companies'));
  if (q.isLoading) return <RecordSkeleton />;
  if (q.error || !q.data) return <RecordError error={q.error} back="/companies" />;
  const c = q.data;
  const edit = can('company', 'edit', c.ownerId, c.visibility);
  const patch = async (body: Record<string, unknown>) => {
    await api.patch(`/companies/${id}`, body);
    await qc.invalidateQueries({ queryKey: ['company', id] });
    qc.invalidateQueries({ queryKey: ['timeline', 'company', id] });
    qc.invalidateQueries({ queryKey: ['companies'] });
  };
  const asPicker = { id, label: c.name };
  return (
    <RecordShell back={{ to: '/companies', label: 'Companies' }} title={c.name}
      subtitle={<>{c.industryId && <span>{label(c.industryId)}</span>}{c.typeId && <span>{label(c.typeId)}</span>}<span>Owner: {userName(c.ownerId)}</span></>}
      actions={<>
        {can('deal', 'create') && <Button icon={<Plus className="size-4" />} onClick={() => create.open('deal', { company: asPicker })}>New deal</Button>}
        <Menu trigger={<IconButton label="More actions"><MoreHorizontal className="size-4" /></IconButton>}
          items={[{ label: 'Delete company', icon: <Trash2 className="size-4" />, danger: true, hidden: !can('company', 'delete', c.ownerId, c.visibility), onSelect: () => del(id) }]} />
      </>}
      left={<>
        <Card title="Details">
          <div className="divide-y divide-[var(--border)]">
            <EditRow label="Name" required value={c.name} canEdit={edit} display={c.name} renderEditor={(v, s) => <Input autoFocus value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ name: v, version: c.version })} />
            <EditRow label="Contact details" value={c.methods} canEdit={edit} display={<MethodsView methods={c.methods} />} renderEditor={(v, s) => <MethodsEditor value={v} onChange={s} kinds={['website', 'phone', 'email']} />} onSave={(v) => patch({ methods: methodsPayload(v) })} />
            <EditRow label="Type" value={c.typeId} canEdit={edit} display={label(c.typeId)} renderEditor={(v, s) => <DictSelect kind="company_type" value={v} onChange={s} />} onSave={(v) => patch({ typeId: v })} />
            <EditRow label="Industry" value={c.industryId} canEdit={edit} display={label(c.industryId)} renderEditor={(v, s) => <DictSelect kind="industry" value={v} onChange={s} />} onSave={(v) => patch({ industryId: v })} />
            <EditRow label="Size" value={c.sizeId} canEdit={edit} display={label(c.sizeId)} renderEditor={(v, s) => <DictSelect kind="company_size" value={v} onChange={s} />} onSave={(v) => patch({ sizeId: v })} />
            <EditRow label="Annual revenue" value={c.annualRevenue ?? ''} canEdit={edit} display={money(c.annualRevenue, c.currency)} renderEditor={(v, s) => <Input inputMode="decimal" value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ annualRevenue: v || null })} />
            <EditRow label="Owner" value={c.ownerId} canEdit={edit} display={userName(c.ownerId)} renderEditor={(v, s) => <UserSelect value={v} onChange={(x) => s(x ?? v)} />} onSave={(v) => patch({ ownerId: v })} />
            <EditRow label="Visibility" value={c.visibility} canEdit={edit} display={c.visibility === 'private' ? 'Private (owner & admins)' : 'Shared'} renderEditor={(v, s) => <Select value={v} onChange={(e) => s(e.target.value)}><option value="shared">Shared</option><option value="private">Private</option></Select>} onSave={(v) => patch({ visibility: v })} />
            <EditRow label="About" value={c.description ?? ''} canEdit={edit} display={c.description ? <span className="whitespace-pre-wrap">{c.description}</span> : <span className="text-muted">—</span>} renderEditor={(v, s) => <Textarea autoFocus value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ description: v || null })} />
            <CustomFieldsRows entity="company" custom={c.custom} canEdit={edit} onSave={(p) => patch({ custom: p })} />
          </div>
        </Card>
        <Card title={`People (${c.contacts.length})`} padded={false} actions={can('contact', 'create') && <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => create.open('contact', { company: asPicker, stay: true })}>Add</Button>}>
          {c.contacts.length ? (
            <ul className="divide-y divide-[var(--border)]">
              {c.contacts.map((p) => (
                <li key={p.id}><Link to={`/contacts/${p.id}`} className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-[var(--surface-2)]/60">
                  <Avatar size="sm" name={personName(p.firstName, p.lastName)} /><div className="min-w-0"><div className="truncate text-sm font-medium">{personName(p.firstName, p.lastName)}</div>{p.jobTitle && <div className="truncate text-xs text-muted">{p.jobTitle}</div>}</div>
                </Link></li>
              ))}
            </ul>
          ) : <p className="px-4 py-4 text-sm text-muted">No people linked yet.</p>}
        </Card>
        <RelatedDeals deals={c.deals} onAdd={can('deal', 'create') ? () => create.open('deal', { company: asPicker, stay: true }) : undefined} />
      </>}
      right={<Timeline type="company" id={id} />} />
  );
}
