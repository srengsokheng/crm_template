import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, CheckCircle2, MoreHorizontal, RotateCcw, Trash2, XCircle } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { date, money, personName } from '../../lib/format.ts';
import { useCan, useDictLabel, usePipelines, useUserName } from '../../lib/hooks.ts';
import type { LineItem, Method } from '../../lib/types.ts';
import { Avatar, Badge, Button, Card, IconButton, Input, Select, Textarea } from '../../components/ui/primitives.tsx';
import { Menu } from '../../components/ui/overlays.tsx';
import { StageBar } from '../../components/ui/StageBar.tsx';
import { EntityPicker, MultiEntityPicker, type PickerItem } from '../../components/ui/EntityPicker.tsx';
import { DictSelect, UserSelect } from '../records/form.tsx';
import { CustomFieldsRows, EditRow, RecordError, RecordShell, RecordSkeleton, useDeleteWithUndo } from '../records/record.tsx';
import { MethodsView } from '../records/MethodsView.tsx';
import { Timeline } from '../records/Timeline.tsx';
import { LineItemsEditor, saveLineItems } from '../products/LineItemsEditor.tsx';
import { useStageMove } from './useStageMove.tsx';

interface Deal {
  id: number; version: number; title: string; amount: string; currency: string; amountMode: string; probability: number | null; expectedCloseDate: string | null;
  closedAt: string | null; status: 'open' | 'won' | 'lost'; stageId: number; pipelineId: number; ownerId: number; visibility: string; description: string | null;
  dealTypeId: number | null; sourceId: number | null; custom: Record<string, unknown>; lostNote: string | null; createdAt: string;
  contacts: { id: number; firstName: string | null; lastName: string | null; jobTitle: string | null; methods: Method[] }[];
  company: { id: number; name: string; methods: Method[] } | null; lineItems: LineItem[]; lead: { id: number; title: string } | null; lostReason: { label: string } | null;
}

export function DealDetail() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const can = useCan();
  const label = useDictLabel();
  const userName = useUserName();
  const pipelines = usePipelines('deal');
  const q = useQuery({ queryKey: ['deal', id], queryFn: () => api.get<Deal>(`/deals/${id}`) });
  const del = useDeleteWithUndo('deals', 'Deal', () => nav('/deals'));
  const mover = useStageMove('deal');
  if (q.isLoading) return <RecordSkeleton />;
  if (q.error || !q.data) return <RecordError error={q.error} back="/deals" />;
  const d = q.data;
  const pipeline = pipelines.find((p) => p.id === d.pipelineId);
  const stages = pipeline?.stages ?? [];
  const stage = stages.find((s) => s.id === d.stageId);
  const edit = can('deal', 'edit', d.ownerId, d.visibility);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['deal', id] });
    qc.invalidateQueries({ queryKey: ['timeline', 'deal', id] });
    qc.invalidateQueries({ queryKey: ['deals'] }); qc.invalidateQueries({ queryKey: ['deals-board'] });
  };
  const patch = async (body: Record<string, unknown>) => { await api.patch(`/deals/${id}`, body); await refresh(); };
  const reopen = async () => {
    try { await api.post(`/deals/${id}/reopen`, {}); await refresh(); toast.success('Deal reopened'); } catch (e) { toast.error(errorMessage(e)); }
  };
  const won = stages.find((s) => s.kind === 'won');
  const lost = stages.find((s) => s.kind === 'lost');
  return (
    <RecordShell back={{ to: '/deals', label: 'Deals' }}
      title={d.title}
      subtitle={<>
        <span className="text-base font-semibold text-[var(--text)] tabular">{money(d.amount, d.currency)}</span>
        {pipeline && pipelines.length > 1 && <span>{pipeline.name}</span>}
        {d.company && <Link to={`/companies/${d.company.id}`} className="inline-flex items-center gap-1 hover:underline"><Building2 className="size-3.5" />{d.company.name}</Link>}
        <span>Owner: {userName(d.ownerId)}</span>
        {d.status === 'won' && <Badge tone="green">Won {date(d.closedAt)}</Badge>}
        {d.status === 'lost' && <Badge tone="red">Lost{d.lostReason ? ` · ${d.lostReason.label}` : ''}</Badge>}
      </>}
      actions={<>
        {edit && d.status === 'open' && won && <Button variant="success" icon={<CheckCircle2 className="size-4" />} onClick={() => mover.move(id, d.title, stage, won)}>Won</Button>}
        {edit && d.status === 'open' && lost && <Button variant="danger" icon={<XCircle className="size-4" />} onClick={() => mover.move(id, d.title, stage, lost)}>Lost</Button>}
        {edit && d.status !== 'open' && <Button icon={<RotateCcw className="size-4" />} onClick={reopen}>Reopen</Button>}
        <Menu trigger={<IconButton label="More actions"><MoreHorizontal className="size-4" /></IconButton>}
          items={[{ label: 'Delete deal', icon: <Trash2 className="size-4" />, danger: true, hidden: !can('deal', 'delete', d.ownerId, d.visibility), onSelect: () => del(id) }]} />
      </>}
      stageBar={stages.length > 0 && <StageBar stages={stages} currentId={d.stageId} status={d.status} disabled={!edit || d.status !== 'open'} onSelect={(s) => mover.move(id, d.title, stage, s)} />}
      left={<>
        <Card title="Details">
          <div className="divide-y divide-[var(--border)]">
            <EditRow label="Deal name" required value={d.title} canEdit={edit} display={d.title} renderEditor={(v, s) => <Input autoFocus value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ title: v, version: d.version })} />
            <EditRow label="Amount" value={d.amount} canEdit={edit} display={<span className="tabular">{money(d.amount, d.currency)}<span className="ml-1.5 text-xs text-muted">{d.amountMode === 'auto' ? '(from products)' : '(manual)'}</span></span>}
              renderEditor={(v, s) => <div className="space-y-1.5"><Input autoFocus inputMode="decimal" value={v} onChange={(e) => s(e.target.value)} />{d.amountMode === 'manual' && d.lineItems.length > 0 && <button type="button" className="text-xs font-medium text-brand-600" onClick={() => patch({ amountMode: 'auto' })}>Calculate from products instead</button>}</div>}
              onSave={(v) => patch({ amount: v || '0' })} />
            <EditRow label="Expected close" value={d.expectedCloseDate ?? ''} canEdit={edit}
              display={<span className={d.status === 'open' && d.expectedCloseDate && d.expectedCloseDate < new Date().toISOString().slice(0, 10) ? 'text-rose-600' : ''}>{date(d.expectedCloseDate)}</span>}
              renderEditor={(v, s) => <Input type="date" autoFocus value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ expectedCloseDate: v || null })} />
            <EditRow label="Probability" value={d.probability ?? ''} canEdit={edit} display={d.probability != null ? `${d.probability}%` : '—'}
              renderEditor={(v, s) => <Input type="number" min={0} max={100} value={v} onChange={(e) => s(e.target.value === '' ? '' : Number(e.target.value))} />} onSave={(v) => patch({ probability: v === '' ? null : v })} />
            {pipelines.length > 1 && (
              <EditRow label="Pipeline" value={d.pipelineId} canEdit={edit && d.status === 'open'} display={pipeline?.name ?? '—'}
                renderEditor={(v, s) => <Select value={v} onChange={(e) => s(Number(e.target.value))}>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}
                onSave={(v) => patch({ pipelineId: v })} />
            )}
            <EditRow label="Owner" value={d.ownerId} canEdit={edit} display={<span className="inline-flex items-center gap-1.5"><Avatar size="xs" name={userName(d.ownerId)} />{userName(d.ownerId)}</span>} renderEditor={(v, s) => <UserSelect value={v} onChange={(x) => s(x ?? v)} />} onSave={(v) => patch({ ownerId: v })} />
            <EditRow label="Deal type" value={d.dealTypeId} canEdit={edit} display={label(d.dealTypeId)} renderEditor={(v, s) => <DictSelect kind="deal_type" value={v} onChange={s} />} onSave={(v) => patch({ dealTypeId: v })} />
            <EditRow label="Source" value={d.sourceId} canEdit={edit} display={label(d.sourceId)} renderEditor={(v, s) => <DictSelect kind="lead_source" value={v} onChange={s} />} onSave={(v) => patch({ sourceId: v })} />
            <EditRow label="Visibility" value={d.visibility} canEdit={edit} display={d.visibility === 'private' ? 'Private (owner & admins)' : 'Shared'} renderEditor={(v, s) => <Select value={v} onChange={(e) => s(e.target.value)}><option value="shared">Shared</option><option value="private">Private</option></Select>} onSave={(v) => patch({ visibility: v })} />
            <EditRow label="Description" value={d.description ?? ''} canEdit={edit} display={d.description ? <span className="whitespace-pre-wrap">{d.description}</span> : <span className="text-muted">—</span>} renderEditor={(v, s) => <Textarea autoFocus value={v} onChange={(e) => s(e.target.value)} />} onSave={(v) => patch({ description: v || null })} />
            <CustomFieldsRows entity="deal" custom={d.custom} stageId={d.stageId} canEdit={edit} onSave={(p) => patch({ custom: p })} />
            {d.lead && <div className="py-2 text-[13px] text-muted">Created from lead <Link className="text-brand-600 hover:underline" to={`/leads/${d.lead.id}`}>{d.lead.title}</Link></div>}
            {d.lostNote && <div className="py-2 text-[13px] text-muted">Lost note: {d.lostNote}</div>}
          </div>
        </Card>
        <Card title="People">
          <div className="space-y-3">
            <EditRow<PickerItem | null> label="Company" value={d.company ? { id: d.company.id, label: d.company.name } : null} canEdit={edit}
              display={d.company ? <div><Link to={`/companies/${d.company.id}`} className="font-medium text-brand-600 hover:underline">{d.company.name}</Link><div className="mt-1 text-[13px]"><MethodsView methods={d.company.methods} /></div></div> : <span className="text-muted">—</span>}
              renderEditor={(v, s) => <EntityPicker entity="companies" value={v} onChange={s} placeholder="Search companies" />} onSave={(v) => patch({ companyId: v?.id ?? null })} />
            <EditRow<PickerItem[]> label="Contacts" value={d.contacts.map((c) => ({ id: c.id, label: personName(c.firstName, c.lastName) }))} canEdit={edit}
              display={d.contacts.length ? (
                <ul className="space-y-3">{d.contacts.map((c) => (
                  <li key={c.id}><Link to={`/contacts/${c.id}`} className="font-medium text-brand-600 hover:underline">{personName(c.firstName, c.lastName)}</Link>{c.jobTitle && <span className="text-xs text-muted"> · {c.jobTitle}</span>}<div className="mt-1 text-[13px]"><MethodsView methods={c.methods} /></div></li>
                ))}</ul>) : <span className="text-muted">—</span>}
              renderEditor={(v, s) => <MultiEntityPicker entity="contacts" value={v} onChange={s} placeholder="Add contact" />} onSave={(v) => patch({ contactIds: v.map((x) => x.id) })} />
          </div>
        </Card>
        <LineItemsEditor items={d.lineItems} currency={d.currency} canEdit={edit} amountMode={d.amountMode}
          onSave={async (items) => { await saveLineItems(`/deals/${id}/line-items`, items); await refresh(); toast.success('Products saved'); }} />
      </>}
      right={<>{mover.dialogs}<Timeline type="deal" id={id} /></>} />
  );
}
