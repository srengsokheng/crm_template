import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRightCircle, Ban, MoreHorizontal, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.ts';
import { money, personName } from '../../lib/format.ts';
import { useCan, useDictLabel, usePipelines, useUserName } from '../../lib/hooks.ts';
import type { LineItem, Method } from '../../lib/types.ts';
import { Badge, Button, Card, IconButton, Input, Select, Textarea } from '../../components/ui/primitives.tsx';
import { Menu } from '../../components/ui/overlays.tsx';
import { StageBar } from '../../components/ui/StageBar.tsx';
import { DictSelect, MethodsEditor, methodsPayload, UserSelect } from '../records/form.tsx';
import { CustomFieldsRows, EditRow, RecordError, RecordShell, RecordSkeleton, useDeleteWithUndo } from '../records/record.tsx';
import { MethodsView } from '../records/MethodsView.tsx';
import { Timeline } from '../records/Timeline.tsx';
import { LineItemsEditor, saveLineItems } from '../products/LineItemsEditor.tsx';
import { useStageMove } from '../deals/useStageMove.tsx';
import { ConvertDialog } from './ConvertDialog.tsx';

interface Lead {
  id: number; version: number; title: string; firstName: string | null; lastName: string | null; jobTitle: string | null; companyName: string | null;
  stageId: number; pipelineId: number; status: 'open' | 'won' | 'lost'; sourceId: number | null; sourceDetails: string | null; amount: string | null; currency: string;
  ownerId: number; visibility: string; description: string | null; custom: Record<string, unknown>; methods: Method[]; lineItems: LineItem[];
  converted: { deal: { id: number; title: string } | null; contact: { id: number; name: string } | null; company: { id: number; name: string } | null };
}

export function LeadDetail() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const can = useCan();
  const label = useDictLabel();
  const userName = useUserName();
  const pipeline = usePipelines('lead')[0];
  const [converting, setConverting] = useState(false);
  const q = useQuery({ queryKey: ['lead', id], queryFn: () => api.get<Lead>(`/leads/${id}`) });
  const del = useDeleteWithUndo('leads', 'Lead', () => nav('/leads'));
  const mover = useStageMove('lead');
  if (q.isLoading) return <RecordSkeleton />;
  if (q.error || !q.data) return <RecordError error={q.error} back="/leads" />;
  const l = q.data;
  const stages = pipeline?.stages ?? [];
  const stage = stages.find((s) => s.id === l.stageId);
  const edit = can('lead', 'edit', l.ownerId, l.visibility) && l.status !== 'won';
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['lead', id] }); qc.invalidateQueries({ queryKey: ['timeline', 'lead', id] }); qc.invalidateQueries({ queryKey: ['leads'] }); qc.invalidateQueries({ queryKey: ['leads-board'] }); };
  const patch = async (body: Record<string, unknown>) => { await api.patch(`/leads/${id}`, body); await refresh(); };
  const lost = stages.find((s) => s.kind === 'lost');
  const reopen = async () => { const first = stages.find((s) => s.kind === 'open'); if (first) { await api.post(`/leads/${id}/move`, { stageId: first.id }); await refresh(); toast.success('Lead reopened'); } };
  return (
    <RecordShell back={{ to: '/leads', label: 'Leads' }} title={l.title}
      subtitle={<>
        {personName(l.firstName, l.lastName) !== 'Unnamed' && <span>{personName(l.firstName, l.lastName)}</span>}
        {l.companyName && <span>{l.companyName}</span>}
        {l.amount && <span className="font-medium text-[var(--text)] tabular">{money(l.amount, l.currency)}</span>}
        <span>Owner: {userName(l.ownerId)}</span>
        {l.status === 'won' && <Badge tone="green">Converted</Badge>}
        {l.status === 'lost' && <Badge tone="red">Disqualified</Badge>}
      </>}
      actions={<>
        {edit && l.status === 'open' && <Button variant="primary" icon={<ArrowRightCircle className="size-4" />} onClick={() => setConverting(true)}>Convert</Button>}
        {edit && l.status === 'open' && lost && <Button icon={<Ban className="size-4" />} onClick={() => mover.move(id, l.title, stage, lost)}>Disqualify</Button>}
        {can('lead', 'edit', l.ownerId, l.visibility) && l.status === 'lost' && <Button onClick={reopen}>Reopen</Button>}
        <Menu trigger={<IconButton label="More actions"><MoreHorizontal className="size-4" /></IconButton>}
          items={[{ label: 'Delete lead', icon: <Trash2 className="size-4" />, danger: true, hidden: !can('lead', 'delete', l.ownerId, l.visibility), onSelect: () => del(id) }]} />
      </>}
      stageBar={stages.length > 0 && <StageBar stages={stages} currentId={l.stageId} status={l.status} disabled={!edit || l.status !== 'open'} onSelect={(s) => mover.move(id, l.title, stage, s)} />}
      left={<>
        {l.status === 'won' && (
          <Card title="Converted to">
            <ul className="space-y-1.5 text-sm">
              {l.converted.deal && <li>Deal: <Link className="font-medium text-brand-600 hover:underline" to={`/deals/${l.converted.deal.id}`}>{l.converted.deal.title}</Link></li>}
              {l.converted.contact && <li>Contact: <Link className="font-medium text-brand-600 hover:underline" to={`/contacts/${l.converted.contact.id}`}>{l.converted.contact.name}</Link></li>}
              {l.converted.company && <li>Company: <Link className="font-medium text-brand-600 hover:underline" to={`/companies/${l.converted.company.id}`}>{l.converted.company.name}</Link></li>}
            </ul>
          </Card>
        )}
        <Card title="Details">
          <div className="divide-y divide-[var(--border)]">
            <EditRow label="Title" required value={l.title} canEdit={edit} display={l.title} renderEditor={(v, s) => <Input autoFocus value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ title: v, version: l.version })} />
            <EditRow label="First name" value={l.firstName ?? ''} canEdit={edit} display={l.firstName ?? <span className="text-muted">—</span>} renderEditor={(v, s) => <Input value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ firstName: v || null })} />
            <EditRow label="Last name" value={l.lastName ?? ''} canEdit={edit} display={l.lastName ?? <span className="text-muted">—</span>} renderEditor={(v, s) => <Input value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ lastName: v || null })} />
            <EditRow label="Company" value={l.companyName ?? ''} canEdit={edit} display={l.companyName ?? <span className="text-muted">—</span>} renderEditor={(v, s) => <Input value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ companyName: v || null })} />
            <EditRow label="Job title" value={l.jobTitle ?? ''} canEdit={edit} display={l.jobTitle ?? <span className="text-muted">—</span>} renderEditor={(v, s) => <Input value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ jobTitle: v || null })} />
            <EditRow label="Contact details" value={l.methods} canEdit={edit} display={<MethodsView methods={l.methods} />} renderEditor={(v, s) => <MethodsEditor value={v} onChange={s} kinds={['email', 'phone', 'website']} />} onSave={(v) => patch({ methods: methodsPayload(v) })} />
            <EditRow label="Estimated value" value={l.amount ?? ''} canEdit={edit} display={money(l.amount, l.currency)} renderEditor={(v, s) => <Input inputMode="decimal" value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ amount: v || null })} />
            <EditRow label="Source" value={l.sourceId} canEdit={edit} display={label(l.sourceId)} renderEditor={(v, s) => <DictSelect kind="lead_source" value={v} onChange={s} />} onSave={(v) => patch({ sourceId: v })} />
            <EditRow label="Source details" value={l.sourceDetails ?? ''} canEdit={edit} display={l.sourceDetails ?? <span className="text-muted">—</span>} renderEditor={(v, s) => <Input value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ sourceDetails: v || null })} />
            <EditRow label="Owner" value={l.ownerId} canEdit={edit} display={userName(l.ownerId)} renderEditor={(v, s) => <UserSelect value={v} onChange={(x) => s(x ?? v)} />} onSave={(v) => patch({ ownerId: v })} />
            <EditRow label="Visibility" value={l.visibility} canEdit={edit} display={l.visibility === 'private' ? 'Private (owner & admins)' : 'Shared'} renderEditor={(v, s) => <Select value={v} onChange={(e) => s(e.target.value)}><option value="shared">Shared</option><option value="private">Private</option></Select>} onSave={(v) => patch({ visibility: v })} />
            <EditRow label="Notes" value={l.description ?? ''} canEdit={edit} display={l.description ? <span className="whitespace-pre-wrap">{l.description}</span> : <span className="text-muted">—</span>} renderEditor={(v, s) => <Textarea autoFocus value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ description: v || null })} />
            <CustomFieldsRows entity="lead" custom={l.custom} stageId={l.stageId} canEdit={edit} onSave={(p) => patch({ custom: p })} />
          </div>
        </Card>
        <LineItemsEditor items={l.lineItems} currency={l.currency} canEdit={edit}
          onSave={async (items) => { await saveLineItems(`/leads/${id}/line-items`, items); await refresh(); toast.success('Products saved'); }} />
      </>}
      right={<>{mover.dialogs}{converting && <ConvertDialog leadId={id} open onClose={() => setConverting(false)} />}<Timeline type="lead" id={id} /></>} />
  );
}
