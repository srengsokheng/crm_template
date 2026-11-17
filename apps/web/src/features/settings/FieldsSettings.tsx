import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { useAction, useMeta, usePipelines } from '../../lib/hooks.ts';
import type { FieldDef } from '../../lib/types.ts';
import { Badge, Button, Card, Checkbox, EmptyState, Field, IconButton, Input, Segmented, Select } from '../../components/ui/primitives.tsx';
import { Drawer } from '../../components/ui/overlays.tsx';
import { useForm } from '../records/form.tsx';
import { AdminOnly } from './SettingsLayout.tsx';

const TYPES: Record<string, string> = {
  text: 'Short text', textarea: 'Long text', number: 'Number', money: 'Money', date: 'Date', datetime: 'Date & time', boolean: 'Yes / no',
  select: 'Dropdown', multiselect: 'Multiple choice', url: 'Link', user: 'Person',
};
type Entity = 'deal' | 'lead' | 'contact' | 'company';

export function FieldsSettings() {
  const [entity, setEntity] = useState<Entity>('deal');
  const { data: meta } = useMeta();
  const [editing, setEditing] = useState<FieldDef | 'new' | null>(null);
  const fields = (meta?.fields ?? []).filter((f) => f.entityType === entity);
  const qc = useQueryClient();
  // Order = how fields appear on records and forms. Move up / down saves the whole order for this record type.
  const move = async (index: number, delta: -1 | 1) => {
    const ids = fields.map((f) => f.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    try { await api.post('/fields/reorder', { ids }); await qc.invalidateQueries({ queryKey: ['meta'] }); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const stageName = (id: number) => meta?.pipelines.flatMap((p) => p.stages).find((s) => s.id === Number(id))?.name ?? '?';
  return (
    <AdminOnly>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented value={entity} onChange={setEntity} options={[{ value: 'deal', label: 'Deals' }, { value: 'lead', label: 'Leads' }, { value: 'contact', label: 'Contacts' }, { value: 'company', label: 'Companies' }]} />
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add field</Button>
        </div>
        <Card padded={false}>
          {fields.length ? (
            <ul className="divide-y divide-[var(--border)]">
              {fields.map((f, i) => (
                <li key={f.id} className="flex items-center">
                  <div className="flex flex-col py-1 pl-2">
                    <IconButton size="sm" label={`Move ${f.label} up`} disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp className="size-4" /></IconButton>
                    <IconButton size="sm" label={`Move ${f.label} down`} disabled={i === fields.length - 1} onClick={() => move(i, 1)}><ChevronDown className="size-4" /></IconButton>
                  </div>
                  <button type="button" onClick={() => setEditing(f)} className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2 px-3 py-3 text-left hover:bg-[var(--surface-2)]/60">
                    <div><div className="font-medium">{f.label} {!f.isActive && <Badge>Archived</Badge>}</div><div className="text-xs text-muted">{TYPES[f.type]} · key <code>{f.key}</code></div></div>
                    <div className="text-xs">
                      {f.required === 'always' && <Badge tone="red">Required</Badge>}
                      {f.required === 'from_stage' && <Badge tone="amber">Required from {f.requiredStageIds.map(stageName).join(', ')}</Badge>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="No custom fields yet" description="Add fields to capture information specific to your business — e.g. “Customer segment” or “Contract length”." />}
        </Card>
      </div>
      {editing && <FieldForm entity={entity} field={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </AdminOnly>
  );
}

function FieldForm({ entity, field, onClose }: { entity: Entity; field: FieldDef | null; onClose: () => void }) {
  const qc = useQueryClient();
  const pipelines = usePipelines(entity === 'lead' ? 'lead' : 'deal');
  const f = useForm({
    label: field?.label ?? '', type: field?.type ?? 'text', options: field?.options ?? [{ id: 'opt1', label: '' }], required: field?.required ?? 'never',
    requiredStageIds: (field?.requiredStageIds ?? []).map(Number), helpText: field?.helpText ?? '', isActive: field?.isActive ?? true,
  });
  const v = f.values;
  const hasOptions = ['select', 'multiselect'].includes(v.type);
  const save = useAction(() => {
    const body = { label: v.label, options: hasOptions ? v.options.filter((o) => o.label.trim()) : [], required: v.required, requiredStageIds: v.required === 'from_stage' ? v.requiredStageIds : [], helpText: v.helpText || null };
    return field ? api.patch(`/fields/${field.id}`, { ...body, isActive: v.isActive }) : api.post('/fields', { ...body, entityType: entity, type: v.type });
  }, { success: field ? 'Field saved' : 'Field added', onSuccess: () => { qc.invalidateQueries({ queryKey: ['meta'] }); onClose(); }, onError: (e) => { f.fromError(e); return false; } });
  const stageOptions = pipelines.flatMap((p) => p.stages.filter((s) => s.kind !== 'lost').map((s) => ({ ...s, pipelineName: p.name })));
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={field ? `Edit “${field.label}”` : 'New field'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Label" required htmlFor="f-label" error={f.errors.label}><Input id="f-label" autoFocus value={v.label} onChange={(e) => f.set('label', e.target.value)} /></Field>
        <Field label="Type" htmlFor="f-type" hint={field ? 'The type can’t be changed after creation.' : undefined}>
          <Select id="f-type" disabled={!!field} value={v.type} onChange={(e) => f.set('type', e.target.value)}>{Object.entries(TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        </Field>
        {hasOptions && (
          <Field label="Options" error={f.errors.options}>
            <div className="space-y-2">
              {v.options.map((o, i) => (
                <div key={o.id} className="flex gap-2">
                  <Input aria-label={`Option ${i + 1}`} value={o.label} onChange={(e) => f.set('options', v.options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                  <IconButton label="Remove option" onClick={() => f.set('options', v.options.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>
                </div>
              ))}
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => f.set('options', [...v.options, { id: `opt${Date.now().toString(36)}`, label: '' }])}>Add option</Button>
            </div>
          </Field>
        )}
        <Field label="Required" htmlFor="f-req">
          <Select id="f-req" value={v.required} onChange={(e) => f.set('required', e.target.value as FieldDef['required'])}>
            <option value="never">Optional</option><option value="always">Always required</option>
            {['deal', 'lead'].includes(entity) && <option value="from_stage">Required at specific stages</option>}
          </Select>
        </Field>
        {v.required === 'from_stage' && (
          <Field label="Required when entering" error={f.errors.requiredStageIds}>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {stageOptions.map((s) => (
                <Checkbox key={s.id} checked={v.requiredStageIds.includes(s.id)} onChange={(c) => f.set('requiredStageIds', c ? [...v.requiredStageIds, s.id] : v.requiredStageIds.filter((x) => x !== s.id))}
                  label={<span>{s.name}{pipelines.length > 1 && <span className="text-xs text-muted"> · {s.pipelineName}</span>}</span>} />
              ))}
            </div>
          </Field>
        )}
        <Field label="Help text" htmlFor="f-help"><Input id="f-help" value={v.helpText} onChange={(e) => f.set('helpText', e.target.value)} placeholder="Shown under the field" /></Field>
        {field && <Checkbox checked={v.isActive} onChange={(c) => f.set('isActive', c)} label="Active (uncheck to archive — values are kept)" />}
      </div>
    </Drawer>
  );
}
