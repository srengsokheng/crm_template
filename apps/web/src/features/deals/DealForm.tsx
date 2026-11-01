import { useNavigate } from 'react-router';
import { api } from '../../lib/api.ts';
import { useAction, useFields, useMe, usePipelines } from '../../lib/hooks.ts';
import { Button, Field, Input, Select, Textarea } from '../../components/ui/primitives.tsx';
import { Drawer } from '../../components/ui/overlays.tsx';
import { EntityPicker, MultiEntityPicker, type PickerItem } from '../../components/ui/EntityPicker.tsx';
import { clean, CustomFieldInput, DictSelect, useRequiredAt, UserSelect, useForm } from '../records/form.tsx';

export function DealForm({ open, onClose, defaults }: { open: boolean; onClose: () => void; defaults?: Record<string, unknown> }) {
  const { data: me } = useMe();
  const nav = useNavigate();
  const pipelines = usePipelines('deal');
  const req = useRequiredAt();
  const defs = useFields('deal');
  const initialPipeline = pipelines.find((p) => p.id === defaults?.pipelineId) ?? pipelines.find((p) => p.isDefault) ?? pipelines[0];
  const f = useForm({
    title: '', amount: '', currency: me?.workspace.baseCurrency ?? 'USD', pipelineId: (initialPipeline?.id ?? null) as number | null,
    stageId: (defaults?.stageId as number | undefined) ?? initialPipeline?.stages.find((s) => s.kind === 'open')?.id ?? null as number | null,
    expectedCloseDate: '', ownerId: me?.user.id ?? null as number | null, dealTypeId: null as number | null, sourceId: null as number | null,
    company: (defaults?.company as PickerItem | undefined) ?? null as PickerItem | null,
    contacts: (defaults?.contacts as PickerItem[] | undefined) ?? [] as PickerItem[], description: '', custom: {} as Record<string, unknown>,
  });
  const v = f.values;
  const pipeline = pipelines.find((p) => p.id === v.pipelineId);
  const stages = pipeline?.stages.filter((s) => s.kind === 'open') ?? [];
  const save = useAction(() => api.post<{ id: number }>('/deals', clean({
    title: v.title, amount: v.amount, currency: v.currency, pipelineId: v.pipelineId, stageId: v.stageId, expectedCloseDate: v.expectedCloseDate,
    ownerId: v.ownerId, dealTypeId: v.dealTypeId, sourceId: v.sourceId, companyId: v.company?.id ?? null, contactIds: v.contacts.map((c) => c.id),
    description: v.description, custom: v.custom,
  })), {
    success: 'Deal created', invalidate: [['deals'], ['deals-board'], ['contact'], ['company']],
    onSuccess: (r) => { onClose(); if (!defaults?.stay) nav(`/deals/${r.id}`); },
    onError: (e) => { f.fromError(e); return false; },
  });
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} title="New deal"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Create deal</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <Field label="Deal name" required htmlFor="d-title" error={f.errors.title}><Input id="d-title" autoFocus placeholder="e.g. Acme — 3 robotic arms" value={v.title} invalid={!!f.errors.title} onChange={(e) => f.set('title', e.target.value)} /></Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_110px]">
          <Field label="Amount" htmlFor="d-amt" error={f.errors.amount} hint="Leave empty to calculate from products"><Input id="d-amt" inputMode="decimal" placeholder="0.00" value={v.amount} invalid={!!f.errors.amount} onChange={(e) => f.set('amount', e.target.value)} /></Field>
          <Field label="Currency" htmlFor="d-cur"><Select id="d-cur" value={v.currency} onChange={(e) => f.set('currency', e.target.value)}>{['USD', 'EUR', 'GBP', 'KHR', 'THB', 'SGD', 'JPY', 'CNY', 'AUD', 'CAD'].map((c) => <option key={c}>{c}</option>)}</Select></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {pipelines.length > 1 && (
            <Field label="Pipeline" htmlFor="d-pipe"><Select id="d-pipe" value={v.pipelineId ?? ''} onChange={(e) => { const p = pipelines.find((x) => x.id === Number(e.target.value)); f.setValues((s) => ({ ...s, pipelineId: p?.id ?? null, stageId: p?.stages.find((x) => x.kind === 'open')?.id ?? null })); }}>
              {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          )}
          <Field label="Stage" htmlFor="d-stage" error={f.errors.stageId}><Select id="d-stage" value={v.stageId ?? ''} onChange={(e) => f.set('stageId', Number(e.target.value))}>{stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Expected close" htmlFor="d-close" error={f.errors.expectedCloseDate}><Input id="d-close" type="date" value={v.expectedCloseDate} onChange={(e) => f.set('expectedCloseDate', e.target.value)} /></Field>
          <Field label="Owner" htmlFor="d-owner"><UserSelect id="d-owner" value={v.ownerId} onChange={(x) => f.set('ownerId', x)} /></Field>
        </div>
        <Field label="Company" htmlFor="d-co"><EntityPicker id="d-co" entity="companies" value={v.company} onChange={(x) => f.set('company', x)} placeholder="Search companies" /></Field>
        <Field label="Contacts"><MultiEntityPicker entity="contacts" value={v.contacts} onChange={(x) => f.set('contacts', x)} placeholder="Add contact" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Deal type" htmlFor="d-type"><DictSelect id="d-type" kind="deal_type" value={v.dealTypeId} onChange={(x) => f.set('dealTypeId', x)} /></Field>
          <Field label="Source" htmlFor="d-src"><DictSelect id="d-src" kind="lead_source" value={v.sourceId} onChange={(x) => f.set('sourceId', x)} /></Field>
        </div>
        <Field label="Description" htmlFor="d-desc"><Textarea id="d-desc" value={v.description} onChange={(e) => f.set('description', e.target.value)} /></Field>
        {defs.map((d) => (
          <Field key={d.id} label={d.label} required={req.isRequired(d, v.stageId)} htmlFor={`df-${d.key}`} error={f.errors[`custom.${d.key}`]} hint={d.helpText ?? undefined}>
            <CustomFieldInput id={`df-${d.key}`} def={d} value={v.custom[d.key]} invalid={!!f.errors[`custom.${d.key}`]} onChange={(x) => f.set('custom', { ...v.custom, [d.key]: x })} />
          </Field>
        ))}
        <button type="submit" className="hidden" />
      </form>
    </Drawer>
  );
}
