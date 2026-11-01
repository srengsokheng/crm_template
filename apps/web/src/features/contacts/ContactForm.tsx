import { useNavigate } from 'react-router';
import { api } from '../../lib/api.ts';
import { useAction, useFields, useMe } from '../../lib/hooks.ts';
import type { Method } from '../../lib/types.ts';
import { Button, Field, Input } from '../../components/ui/primitives.tsx';
import { Drawer } from '../../components/ui/overlays.tsx';
import { EntityPicker, type PickerItem } from '../../components/ui/EntityPicker.tsx';
import { clean, CustomFieldInput, DictSelect, DuplicateHint, MethodsEditor, methodsPayload, UserSelect, useForm } from '../records/form.tsx';

export function ContactForm({ open, onClose, defaults }: { open: boolean; onClose: () => void; defaults?: Record<string, unknown> }) {
  const { data: me } = useMe();
  const nav = useNavigate();
  const defs = useFields('contact');
  const f = useForm({
    firstName: '', lastName: '', jobTitle: '', typeId: null as number | null, ownerId: me?.user.id ?? null as number | null,
    company: (defaults?.company as PickerItem | undefined) ?? null as PickerItem | null,
    methods: [{ kind: 'email', label: 'work', value: '' }, { kind: 'phone', label: 'work', value: '' }] as Method[],
    custom: {} as Record<string, unknown>,
  });
  const v = f.values;
  const save = useAction(() => api.post<{ id: number }>('/contacts', clean({
    firstName: v.firstName, lastName: v.lastName, jobTitle: v.jobTitle, typeId: v.typeId, ownerId: v.ownerId,
    primaryCompanyId: v.company?.id ?? null, methods: methodsPayload(v.methods), custom: v.custom,
  })), {
    success: 'Contact created', invalidate: [['contacts'], ['company']],
    onSuccess: (r) => { onClose(); if (!defaults?.stay) nav(`/contacts/${r.id}`); },
    onError: (e) => { f.fromError(e); return false; },
  });
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} title="New contact"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Create contact</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name" htmlFor="c-first" error={f.errors.firstName}><Input id="c-first" autoFocus value={v.firstName} invalid={!!f.errors.firstName} onChange={(e) => f.set('firstName', e.target.value)} /></Field>
          <Field label="Last name" htmlFor="c-last" error={f.errors.lastName}><Input id="c-last" value={v.lastName} onChange={(e) => f.set('lastName', e.target.value)} /></Field>
        </div>
        <Field label="Job title" htmlFor="c-title"><Input id="c-title" value={v.jobTitle} onChange={(e) => f.set('jobTitle', e.target.value)} /></Field>
        <Field label="Company" htmlFor="c-company"><EntityPicker id="c-company" entity="companies" value={v.company} onChange={(x) => f.set('company', x)} placeholder="Search companies" /></Field>
        <Field label="Email & phone"><MethodsEditor value={v.methods} onChange={(m) => f.set('methods', m)} errors={f.errors} kinds={['email', 'phone', 'messenger']} /></Field>
        <DuplicateHint emails={v.methods.filter((m) => m.kind === 'email').map((m) => m.value)} phones={v.methods.filter((m) => m.kind === 'phone').map((m) => m.value)}
          name={[v.firstName, v.lastName].filter(Boolean).join(' ')} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Type" htmlFor="c-type"><DictSelect id="c-type" kind="contact_type" value={v.typeId} onChange={(x) => f.set('typeId', x)} /></Field>
          <Field label="Owner" htmlFor="c-owner"><UserSelect id="c-owner" value={v.ownerId} onChange={(x) => f.set('ownerId', x)} /></Field>
        </div>
        {defs.map((d) => (
          <Field key={d.id} label={d.label} required={d.required === 'always'} htmlFor={`cf-${d.key}`} error={f.errors[`custom.${d.key}`]} hint={d.helpText ?? undefined}>
            <CustomFieldInput id={`cf-${d.key}`} def={d} value={v.custom[d.key]} invalid={!!f.errors[`custom.${d.key}`]} onChange={(x) => f.set('custom', { ...v.custom, [d.key]: x })} />
          </Field>
        ))}
        <button type="submit" className="hidden" />
      </form>
    </Drawer>
  );
}
