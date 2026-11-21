import { useState } from 'react';
import { LOCKABLE_FIELDS, type FieldEntity, type FieldRules } from '@crm/shared';
import { useMeta } from '../../lib/hooks.ts';
import { Segmented, Select } from '../../components/ui/primitives.tsx';

const ENTITY_TABS: { value: FieldEntity; label: string }[] = [
  { value: 'deal', label: 'Deals' }, { value: 'lead', label: 'Leads' }, { value: 'contact', label: 'Contacts' }, { value: 'company', label: 'Companies' },
];
type Access = 'edit' | 'readonly' | 'hidden';

/** Per-field access for one role: standard fields can be locked; custom fields can also be hidden. */
export function FieldAccessEditor({ value, onChange }: { value: FieldRules; onChange: (v: FieldRules) => void }) {
  const [entity, setEntity] = useState<FieldEntity>('deal');
  const { data: meta } = useMeta();
  const custom = (meta?.fields ?? []).filter((f) => f.entityType === entity && f.isActive);
  const rules = value[entity] ?? {};
  const set = (field: string, access: Access) => {
    const next = { ...rules };
    if (access === 'edit') delete next[field]; else next[field] = access;
    onChange({ ...value, [entity]: next });
  };
  const changed = (e: FieldEntity) => Object.keys(value[e] ?? {}).length;
  const row = (key: string, label: string, canHide: boolean) => (
    <li key={key} className="flex items-center justify-between gap-3 py-1.5">
      <span className="min-w-0 truncate text-sm">{label}</span>
      <Select aria-label={`${label} access`} className="h-8 w-36 shrink-0 pl-2 text-xs" value={rules[key] ?? 'edit'} onChange={(e) => set(key, e.target.value as Access)}>
        <option value="edit">Can edit</option>
        <option value="readonly">Read-only</option>
        {canHide && <option value="hidden">Hidden</option>}
      </Select>
    </li>
  );
  return (
    <div className="space-y-3">
      <Segmented value={entity} onChange={setEntity} options={ENTITY_TABS.map((t) => ({ ...t, label: changed(t.value) ? `${t.label} (${changed(t.value)})` : t.label }))} />
      <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
        <div>
          <div className="text-xs font-medium text-muted">Standard fields</div>
          <ul className="divide-y divide-[var(--border)]">{LOCKABLE_FIELDS[entity].map((f) => row(f.key, f.label, false))}</ul>
        </div>
        <div>
          <div className="text-xs font-medium text-muted">Custom fields</div>
          {custom.length
            ? <ul className="divide-y divide-[var(--border)]">{custom.map((f) => row(`custom.${f.key}`, f.label, true))}</ul>
            : <p className="py-1.5 text-sm text-muted">No custom fields for {ENTITY_TABS.find((t) => t.value === entity)!.label.toLowerCase()}.</p>}
        </div>
      </div>
      <p className="text-xs text-muted">
        <strong>Read-only</strong>: people with this role see the value but can’t change it (also not by import or merge).{' '}
        <strong>Hidden</strong> (custom fields only): the field and its values are left out everywhere — record pages, history, exports.
        Standard fields can’t be hidden because totals, boards and reports are built from them.
      </p>
    </div>
  );
}
