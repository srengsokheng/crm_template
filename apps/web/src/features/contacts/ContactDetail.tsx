import { useParams, useNavigate, Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Plus, Trash2, Building2 } from 'lucide-react';
import { api } from '../../lib/api.ts';
import { date, personName } from '../../lib/format.ts';
import { useCan, useDictLabel, useUserName } from '../../lib/hooks.ts';
import type { Method } from '../../lib/types.ts';
import { Button, Card, IconButton, Input, Select, Textarea } from '../../components/ui/primitives.tsx';
import { Menu } from '../../components/ui/overlays.tsx';
import { MultiEntityPicker, type PickerItem } from '../../components/ui/EntityPicker.tsx';
import { useCreate } from '../../app/create.tsx';
import { DictSelect, MethodsEditor, methodsPayload, UserSelect } from '../records/form.tsx';
import { CustomFieldsRows, EditRow, RecordError, RecordShell, RecordSkeleton, useDeleteWithUndo } from '../records/record.tsx';
import { MethodsView } from '../records/MethodsView.tsx';
import { RelatedDeals, type RelatedDeal } from '../records/RelatedDeals.tsx';
import { Timeline } from '../records/Timeline.tsx';

interface Contact {
  id: number; version: number; firstName: string | null; lastName: string | null; jobTitle: string | null; birthday: string | null; typeId: number | null;
  sourceId: number | null; ownerId: number; visibility: string; description: string | null; custom: Record<string, unknown>; createdAt: string;
  methods: Method[]; companies: { id: number; name: string }[]; deals: RelatedDeal[]; primaryCompanyId: number | null;
}

export function ContactDetail() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const can = useCan();
  const create = useCreate();
  const label = useDictLabel();
  const userName = useUserName();
  const q = useQuery({ queryKey: ['contact', id], queryFn: () => api.get<Contact>(`/contacts/${id}`) });
  const del = useDeleteWithUndo('contacts', 'Contact', () => nav('/contacts'));
  if (q.isLoading) return <RecordSkeleton />;
  if (q.error || !q.data) return <RecordError error={q.error} back="/contacts" />;
  const c = q.data;
  const edit = can('contact', 'edit', c.ownerId, c.visibility);
  const patch = async (body: Record<string, unknown>) => {
    await api.patch(`/contacts/${id}`, body);
    await qc.invalidateQueries({ queryKey: ['contact', id] });
    qc.invalidateQueries({ queryKey: ['timeline', 'contact', id] });
    qc.invalidateQueries({ queryKey: ['contacts'] });
  };
  const name = personName(c.firstName, c.lastName);
  return (
    <RecordShell back={{ to: '/contacts', label: 'Contacts' }} title={name}
      subtitle={<>{c.jobTitle && <span>{c.jobTitle}</span>}{c.companies[0] && <Link to={`/companies/${c.companies[0].id}`} className="inline-flex items-center gap-1 hover:underline"><Building2 className="size-3.5" />{c.companies[0].name}</Link>}<span>Owner: {userName(c.ownerId)}</span></>}
      actions={<>
        {can('deal', 'create') && <Button icon={<Plus className="size-4" />} onClick={() => create.open('deal', { contacts: [{ id, label: name }], company: c.companies[0] ? { id: c.companies[0].id, label: c.companies[0].name } : undefined })}>New deal</Button>}
        <Menu trigger={<IconButton label="More actions"><MoreHorizontal className="size-4" /></IconButton>}
          items={[{ label: 'Delete contact', icon: <Trash2 className="size-4" />, danger: true, hidden: !can('contact', 'delete', c.ownerId, c.visibility), onSelect: () => del(id) }]} />
      </>}
      left={<>
        <Card title="Details">
          <div className="divide-y divide-[var(--border)]">
            <EditRow label="First name" value={c.firstName ?? ''} canEdit={edit} display={c.firstName ?? <span className="text-muted">—</span>} renderEditor={(v, s) => <Input autoFocus value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ firstName: v || null, version: c.version })} />
            <EditRow label="Last name" value={c.lastName ?? ''} canEdit={edit} display={c.lastName ?? <span className="text-muted">—</span>} renderEditor={(v, s) => <Input autoFocus value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ lastName: v || null, version: c.version })} />
            <EditRow label="Job title" value={c.jobTitle ?? ''} canEdit={edit} display={c.jobTitle ?? <span className="text-muted">—</span>} renderEditor={(v, s) => <Input autoFocus value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ jobTitle: v || null })} />
            <EditRow label="Contact details" value={c.methods} canEdit={edit} display={<MethodsView methods={c.methods} />} renderEditor={(v, s) => <MethodsEditor value={v} onChange={s} kinds={['email', 'phone', 'messenger']} />} onSave={(v) => patch({ methods: methodsPayload(v) })} />
            <EditRow<PickerItem[]> label="Companies" value={c.companies.map((x) => ({ id: x.id, label: x.name }))} canEdit={edit}
              display={c.companies.length ? <div className="flex flex-wrap gap-x-2">{c.companies.map((x) => <Link key={x.id} className="text-brand-600 hover:underline" to={`/companies/${x.id}`}>{x.name}</Link>)}</div> : <span className="text-muted">—</span>}
              renderEditor={(v, s) => <MultiEntityPicker entity="companies" value={v} onChange={s} placeholder="Add company" />}
              onSave={(v) => patch({ companyIds: v.map((x) => x.id), primaryCompanyId: v[0]?.id ?? null })} />
            <EditRow label="Type" value={c.typeId} canEdit={edit} display={label(c.typeId)} renderEditor={(v, s) => <DictSelect kind="contact_type" value={v} onChange={s} />} onSave={(v) => patch({ typeId: v })} />
            <EditRow label="Source" value={c.sourceId} canEdit={edit} display={label(c.sourceId)} renderEditor={(v, s) => <DictSelect kind="lead_source" value={v} onChange={s} />} onSave={(v) => patch({ sourceId: v })} />
            <EditRow label="Birthday" value={c.birthday ?? ''} canEdit={edit} display={date(c.birthday)} renderEditor={(v, s) => <Input type="date" value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ birthday: v || null })} />
            <EditRow label="Owner" value={c.ownerId} canEdit={edit} display={userName(c.ownerId)} renderEditor={(v, s) => <UserSelect value={v} onChange={(x) => s(x ?? v)} />} onSave={(v) => patch({ ownerId: v })} />
            <EditRow label="Visibility" value={c.visibility} canEdit={edit} display={c.visibility === 'private' ? 'Private (owner & admins)' : 'Shared'} renderEditor={(v, s) => <Select value={v} onChange={(e) => s(e.target.value)}><option value="shared">Shared</option><option value="private">Private</option></Select>} onSave={(v) => patch({ visibility: v })} />
            <EditRow label="Notes" value={c.description ?? ''} canEdit={edit} display={c.description ? <span className="whitespace-pre-wrap">{c.description}</span> : <span className="text-muted">—</span>} renderEditor={(v, s) => <Textarea autoFocus value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ description: v || null })} />
            <CustomFieldsRows entity="contact" custom={c.custom} canEdit={edit} onSave={(p) => patch({ custom: p })} />
          </div>
        </Card>
        <RelatedDeals deals={c.deals} onAdd={can('deal', 'create') ? () => create.open('deal', { contacts: [{ id, label: name }], stay: true }) : undefined} />
      </>}
      right={<Timeline type="contact" id={id} />} />
  );
}
