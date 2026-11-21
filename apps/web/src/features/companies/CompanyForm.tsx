import { useNavigate } from 'react-router';
import { api } from '../../lib/api.ts';
import { useAction, useFields, useMe, useFieldLock } from '../../lib/hooks.ts';
import type { Method } from '../../lib/types.ts';
import { Button, Field, Input } from '../../components/ui/primitives.tsx';
import { Drawer } from '../../components/ui/overlays.tsx';
import { changes, clean, CustomFieldInput, DictSelect, DuplicateHint, MethodsEditor, methodsPayload, UserSelect, useForm } from '../records/form.tsx';

/** The company as its page has it; passing one turns the drawer into "Edit company". */
export interface CompanyRecord {
  id: number; version: number; name: string; typeId: number | null; industryId: number | null; sizeId: number | null; ownerId: number;
  methods: Method[]; custom: Record<string, unknown>;
}

export function CompanyForm({ open, onClose, defaults, record }: { open: boolean; onClose: () => void; defaults?: Record<string, unknown>; record?: CompanyRecord }) {
  const { data: me } = useMe();
  const nav = useNavigate();
  const defs = useFields('company');
  const locked = useFieldLock();
  const initial = record ? {
    name: record.name, typeId: record.typeId, industryId: record.industryId, sizeId: record.sizeId, ownerId: record.ownerId as number | null,
    methods: record.methods.map(({ kind, label, value }) => ({ kind, label, value })) as Method[], custom: { ...record.custom } as Record<string, unknown>,
  } : {
    name: (defaults?.name as string) ?? '', typeId: null as number | null, industryId: null as number | null, sizeId: null as number | null,
    ownerId: me?.user.id ?? null as number | null,
    methods: [{ kind: 'website', label: 'work', value: '' }, { kind: 'phone', label: 'work', value: '' }] as Method[],
    custom: {} as Record<string, unknown>,
  };
  const f = useForm(initial);
  const v = f.values;
  /** Edit: only the changed fields, with the loaded version (409 if someone saved since). */
  const update = useAction(() => {
    const body: Record<string, unknown> = clean(changes(initial, v) as Record<string, unknown>);
    if ('methods' in body) body.methods = methodsPayload(v.methods);
    return Object.keys(body).length ? api.patch(`/companies/${record!.id}`, { ...body, version: record!.version }) : Promise.resolve(null);
  }, {
    success: 'Company saved', invalidate: [['company', record?.id], ['companies'], ['timeline', 'company', record?.id]],
    onSuccess: () => onClose(),
    onError: (e) => { f.fromError(e); return false; },
  });
  const create = useAction(() => api.post<{ id: number; name: string }>('/companies', clean({
    name: v.name, typeId: v.typeId, industryId: v.industryId, sizeId: v.sizeId, ownerId: v.ownerId, methods: methodsPayload(v.methods), custom: v.custom,
  })), {
    success: 'Company created', invalidate: [['companies']],
    onSuccess: (r) => { onClose(); (defaults?.onCreated as ((x: { id: number; name: string }) => void) | undefined)?.(r); if (!defaults?.stay) nav(`/companies/${r.id}`); },
    onError: (e) => { f.fromError(e); return false; },
  });
  const save = record ? update : create;
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} title={record ? 'Edit company' : 'New company'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>{record ? 'Save changes' : 'Create company'}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <Field label="Company name" required htmlFor="co-name" error={f.errors.name}><Input id="co-name" autoFocus value={v.name} invalid={!!f.errors.name} onChange={(e) => f.set('name', e.target.value)} /></Field>
        {!record && <DuplicateHint companyName={v.name} phones={v.methods.filter((m) => m.kind === 'phone').map((m) => m.value)} />}
        <Field label="Website & phone"><MethodsEditor value={v.methods} onChange={(m) => f.set('methods', m)} errors={f.errors} kinds={['website', 'phone', 'email']} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          {!locked('company', 'typeId') && <Field label="Type" htmlFor="co-type"><DictSelect id="co-type" kind="company_type" value={v.typeId} onChange={(x) => f.set('typeId', x)} /></Field>}
          {!locked('company', 'industryId') && <Field label="Industry" htmlFor="co-ind"><DictSelect id="co-ind" kind="industry" value={v.industryId} onChange={(x) => f.set('industryId', x)} /></Field>}
          {!locked('company', 'sizeId') && <Field label="Size" htmlFor="co-size"><DictSelect id="co-size" kind="company_size" value={v.sizeId} onChange={(x) => f.set('sizeId', x)} /></Field>}
          {!locked('company', 'ownerId') && <Field label="Owner" htmlFor="co-owner"><UserSelect id="co-owner" value={v.ownerId} onChange={(x) => f.set('ownerId', x)} /></Field>}
        </div>
        {defs.filter((d) => !locked('company', `custom.${d.key}`)).map((d) => (
          <Field key={d.id} label={d.label} required={d.required === 'always'} htmlFor={`cof-${d.key}`} error={f.errors[`custom.${d.key}`]} hint={d.helpText ?? undefined}>
            <CustomFieldInput id={`cof-${d.key}`} def={d} value={v.custom[d.key]} onChange={(x) => f.set('custom', { ...v.custom, [d.key]: x })} />
          </Field>
        ))}
        <button type="submit" className="hidden" />
      </form>
    </Drawer>
  );
}
