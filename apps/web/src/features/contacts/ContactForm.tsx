import { useNavigate } from 'react-router';
import { api } from '../../lib/api.ts';
import { useAction, useFields, useMe, useFieldLock } from '../../lib/hooks.ts';
import type { Method } from '../../lib/types.ts';
import { Button, Field, Input, Textarea } from '../../components/ui/primitives.tsx';
import { Drawer } from '../../components/ui/overlays.tsx';
import { EntityPicker, type PickerItem } from '../../components/ui/EntityPicker.tsx';
import { changes, clean, CustomFieldInput, DictSelect, DuplicateHint, MethodsEditor, methodsPayload, UserSelect, useForm } from '../records/form.tsx';

/** The contact as its page has it; passing one turns the drawer into "Edit contact". */
export interface ContactRecord {
  id: number; version: number; firstName: string | null; lastName: string | null; jobTitle: string | null; typeId: number | null; ownerId: number;
  description: string | null; custom: Record<string, unknown>; methods: Method[]; companies: { id: number; name: string }[]; primaryCompanyId: number | null;
}

export function ContactForm({ open, onClose, defaults, record }: { open: boolean; onClose: () => void; defaults?: Record<string, unknown>; record?: ContactRecord }) {
  const { data: me } = useMe();
  const nav = useNavigate();
  const defs = useFields('contact');
  const locked = useFieldLock();
  const primary = record ? record.companies.find((c) => c.id === record.primaryCompanyId) ?? null : null;
  const initial = record ? {
    firstName: record.firstName ?? '', lastName: record.lastName ?? '', jobTitle: record.jobTitle ?? '', typeId: record.typeId, ownerId: record.ownerId as number | null,
    company: primary ? { id: primary.id, label: primary.name } as PickerItem | null : null,
    methods: record.methods.map(({ kind, label, value }) => ({ kind, label, value })) as Method[],
    description: record.description ?? '', custom: { ...record.custom } as Record<string, unknown>,
  } : {
    firstName: '', lastName: '', jobTitle: '', typeId: null as number | null, ownerId: me?.user.id ?? null as number | null,
    company: (defaults?.company as PickerItem | undefined) ?? null as PickerItem | null,
    methods: [{ kind: 'email', label: 'work', value: '' }, { kind: 'phone', label: 'work', value: '' }] as Method[],
    description: '', custom: {} as Record<string, unknown>,
  };
  const f = useForm(initial);
  const v = f.values;
  /** Edit: only the changed fields, with the loaded version (409 if someone saved since). */
  const update = useAction(() => {
    const body: Record<string, unknown> = clean(changes(initial, v) as Record<string, unknown>);
    if ('company' in body) { body.primaryCompanyId = v.company?.id ?? null; delete body.company; }
    if ('methods' in body) body.methods = methodsPayload(v.methods);
    return Object.keys(body).length ? api.patch(`/contacts/${record!.id}`, { ...body, version: record!.version }) : Promise.resolve(null);
  }, {
    success: 'Contact saved', invalidate: [['contact', record?.id], ['contacts'], ['timeline', 'contact', record?.id], ['company']],
    onSuccess: () => onClose(),
    onError: (e) => { f.fromError(e); return false; },
  });
  const create = useAction(() => api.post<{ id: number }>('/contacts', clean({
    firstName: v.firstName, lastName: v.lastName, jobTitle: v.jobTitle, typeId: v.typeId, ownerId: v.ownerId,
    primaryCompanyId: v.company?.id ?? null, methods: methodsPayload(v.methods), custom: v.custom,
  })), {
    success: 'Contact created', invalidate: [['contacts'], ['company']],
    onSuccess: (r) => { onClose(); if (!defaults?.stay) nav(`/contacts/${r.id}`); },
    onError: (e) => { f.fromError(e); return false; },
  });
  const save = record ? update : create;
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} title={record ? 'Edit contact' : 'New contact'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>{record ? 'Save changes' : 'Create contact'}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          {!locked('contact', 'firstName') && <Field label="First name" htmlFor="c-first" error={f.errors.firstName}><Input id="c-first" autoFocus value={v.firstName} invalid={!!f.errors.firstName} onChange={(e) => f.set('firstName', e.target.value)} /></Field>}
          {!locked('contact', 'lastName') && <Field label="Last name" htmlFor="c-last" error={f.errors.lastName}><Input id="c-last" value={v.lastName} onChange={(e) => f.set('lastName', e.target.value)} /></Field>}
        </div>
        {!locked('contact', 'jobTitle') && <Field label="Job title" htmlFor="c-title"><Input id="c-title" value={v.jobTitle} onChange={(e) => f.set('jobTitle', e.target.value)} /></Field>}
        {!locked('contact', 'primaryCompanyId') && <Field label="Company" htmlFor="c-company"><EntityPicker id="c-company" entity="companies" value={v.company} onChange={(x) => f.set('company', x)} placeholder="Search companies" /></Field>}
        <Field label="Email & phone"><MethodsEditor value={v.methods} onChange={(m) => f.set('methods', m)} errors={f.errors} kinds={['email', 'phone', 'messenger']} /></Field>
        {!record && <DuplicateHint emails={v.methods.filter((m) => m.kind === 'email').map((m) => m.value)} phones={v.methods.filter((m) => m.kind === 'phone').map((m) => m.value)}
          name={[v.firstName, v.lastName].filter(Boolean).join(' ')} />}
        <div className="grid gap-3 sm:grid-cols-2">
          {!locked('contact', 'typeId') && <Field label="Type" htmlFor="c-type"><DictSelect id="c-type" kind="contact_type" value={v.typeId} onChange={(x) => f.set('typeId', x)} /></Field>}
          {!locked('contact', 'ownerId') && <Field label="Owner" htmlFor="c-owner"><UserSelect id="c-owner" value={v.ownerId} onChange={(x) => f.set('ownerId', x)} /></Field>}
        </div>
        {record && !locked('contact', 'description') && <Field label="Notes" htmlFor="c-desc"><Textarea id="c-desc" value={v.description} onChange={(e) => f.set('description', e.target.value)} /></Field>}
        {defs.filter((d) => !locked('contact', `custom.${d.key}`)).map((d) => (
          <Field key={d.id} label={d.label} required={d.required === 'always'} htmlFor={`cf-${d.key}`} error={f.errors[`custom.${d.key}`]} hint={d.helpText ?? undefined}>
            <CustomFieldInput id={`cf-${d.key}`} def={d} value={v.custom[d.key]} invalid={!!f.errors[`custom.${d.key}`]} onChange={(x) => f.set('custom', { ...v.custom, [d.key]: x })} />
          </Field>
        ))}
        <button type="submit" className="hidden" />
      </form>
    </Drawer>
  );
}
