import { useNavigate } from 'react-router';
import { api } from '../../lib/api.ts';
import { useAction, useFields, useMe, usePipelines } from '../../lib/hooks.ts';
import type { Method } from '../../lib/types.ts';
import { Button, Field, Input, Select, Textarea } from '../../components/ui/primitives.tsx';
import { Drawer } from '../../components/ui/overlays.tsx';
import { clean, CustomFieldInput, DictSelect, DuplicateHint, useRequiredAt, MethodsEditor, methodsPayload, UserSelect, useForm } from '../records/form.tsx';

export function LeadForm({ open, onClose, defaults }: { open: boolean; onClose: () => void; defaults?: Record<string, unknown> }) {
  const { data: me } = useMe();
  const nav = useNavigate();
  const pipelines = usePipelines('lead');
  const pipeline = pipelines.find((p) => p.id === defaults?.pipelineId) ?? pipelines.find((p) => p.isDefault) ?? pipelines[0];
  const openStages = pipeline?.stages.filter((s) => s.kind === 'open') ?? [];
  const req = useRequiredAt();
  const defs = useFields('lead');
  const f = useForm({
    title: '', firstName: '', lastName: '', jobTitle: '', companyName: '', sourceId: null as number | null, sourceDetails: '',
    amount: '', stageId: (defaults?.stageId as number | undefined) ?? openStages[0]?.id ?? null, ownerId: me?.user.id ?? null as number | null,
    description: '',
    methods: [{ kind: 'email', label: 'work', value: '' }, { kind: 'phone', label: 'work', value: '' }] as Method[],
    custom: {} as Record<string, unknown>,
  });
  const v = f.values;
  const save = useAction(() => api.post<{ id: number }>('/leads', clean({
    title: v.title, firstName: v.firstName, lastName: v.lastName, jobTitle: v.jobTitle, companyName: v.companyName, sourceId: v.sourceId,
    sourceDetails: v.sourceDetails, amount: v.amount, pipelineId: pipeline?.id, stageId: v.stageId, ownerId: v.ownerId, description: v.description,
    methods: methodsPayload(v.methods), custom: v.custom,
  })), {
    success: 'Lead created', invalidate: [['leads'], ['leads-board']],
    onSuccess: (r) => { onClose(); if (!defaults?.stay) nav(`/leads/${r.id}`); },
    onError: (e) => { f.fromError(e); return false; },
  });
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} title="New lead"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Create lead</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <p className="text-[13px] text-muted">Enter at least a name, a company or a phone/email. The title is filled in for you if left empty.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name" htmlFor="l-first"><Input id="l-first" autoFocus value={v.firstName} onChange={(e) => f.set('firstName', e.target.value)} /></Field>
          <Field label="Last name" htmlFor="l-last"><Input id="l-last" value={v.lastName} onChange={(e) => f.set('lastName', e.target.value)} /></Field>
          <Field label="Company" htmlFor="l-co"><Input id="l-co" value={v.companyName} onChange={(e) => f.set('companyName', e.target.value)} /></Field>
          <Field label="Job title" htmlFor="l-job"><Input id="l-job" value={v.jobTitle} onChange={(e) => f.set('jobTitle', e.target.value)} /></Field>
        </div>
        <Field label="Email & phone"><MethodsEditor value={v.methods} onChange={(m) => f.set('methods', m)} errors={f.errors} kinds={['email', 'phone', 'website']} /></Field>
        <DuplicateHint emails={v.methods.filter((m) => m.kind === 'email').map((m) => m.value)} phones={v.methods.filter((m) => m.kind === 'phone').map((m) => m.value)}
          name={[v.firstName, v.lastName].filter(Boolean).join(' ')} companyName={v.companyName} />
        <Field label="Lead title" htmlFor="l-title" error={f.errors.title} hint="Optional — e.g. “Website inquiry: 3 robotic arms”"><Input id="l-title" value={v.title} invalid={!!f.errors.title} onChange={(e) => f.set('title', e.target.value)} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Source" htmlFor="l-src"><DictSelect id="l-src" kind="lead_source" value={v.sourceId} onChange={(x) => f.set('sourceId', x)} /></Field>
          <Field label="Estimated value" htmlFor="l-amt" error={f.errors.amount}><Input id="l-amt" inputMode="decimal" placeholder="0.00" value={v.amount} invalid={!!f.errors.amount} onChange={(e) => f.set('amount', e.target.value)} /></Field>
          <Field label="Stage" htmlFor="l-stage"><Select id="l-stage" value={v.stageId ?? ''} onChange={(e) => f.set('stageId', Number(e.target.value))}>{openStages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Owner" htmlFor="l-owner"><UserSelect id="l-owner" value={v.ownerId} onChange={(x) => f.set('ownerId', x)} /></Field>
        </div>
        <Field label="Notes" htmlFor="l-desc"><Textarea id="l-desc" value={v.description} onChange={(e) => f.set('description', e.target.value)} /></Field>
        {defs.map((d) => (
          <Field key={d.id} label={d.label} required={req.isRequired(d, v.stageId)} htmlFor={`lf-${d.key}`} error={f.errors[`custom.${d.key}`]} hint={d.helpText ?? undefined}>
            <CustomFieldInput id={`lf-${d.key}`} def={d} value={v.custom[d.key]} invalid={!!f.errors[`custom.${d.key}`]} onChange={(x) => f.set('custom', { ...v.custom, [d.key]: x })} />
          </Field>
        ))}
        {f.errors._ && <p className="text-sm text-rose-600">{f.errors._}</p>}
        <button type="submit" className="hidden" />
      </form>
    </Drawer>
  );
}
