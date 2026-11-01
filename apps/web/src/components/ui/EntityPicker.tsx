import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, X } from 'lucide-react';
import { api, qsOf } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { useDebounced } from '../../lib/hooks.ts';
import { personName } from '../../lib/format.ts';
import { Popover } from './overlays.tsx';
import { Spinner } from './primitives.tsx';

export type PickerEntity = 'contacts' | 'companies' | 'products' | 'deals';
export interface PickerItem { id: number; label: string; sub?: string; raw?: Record<string, unknown> }

function toItem(entity: PickerEntity, r: Record<string, any>): PickerItem {
  if (entity === 'contacts') return { id: r.id, label: personName(r.firstName, r.lastName), sub: [r.jobTitle, r.companyName, r.email].filter(Boolean).join(' · '), raw: r };
  if (entity === 'companies') return { id: r.id, label: r.name, sub: [r.email, r.website].filter(Boolean).join(' · '), raw: r };
  if (entity === 'products') return { id: r.id, label: r.name, sub: [r.sku, r.unitPrice && `${r.currency} ${r.unitPrice}`].filter(Boolean).join(' · '), raw: r };
  return { id: r.id, label: r.title, sub: r.stageName, raw: r };
}

export function useEntitySearch(entity: PickerEntity, q: string, enabled: boolean) {
  const dq = useDebounced(q, 200);
  return useQuery({
    queryKey: ['picker', entity, dq],
    queryFn: () => api.get<{ data: Record<string, any>[] }>(`/${entity}${qsOf({ q: dq, pageSize: 8, ...(entity === 'products' ? { active: 'true' } : {}) })}`),
    enabled,
    select: (r) => r.data.map((x) => toItem(entity, x)),
  });
}

/** Single-select async picker. `value` is the selected item (for its label). */
export function EntityPicker({ entity, value, onChange, placeholder = 'Search…', onCreate, invalid, id, disabled }: {
  entity: PickerEntity; value: PickerItem | null; onChange: (v: PickerItem | null) => void; placeholder?: string;
  onCreate?: (text: string) => void; invalid?: boolean; id?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const { data, isFetching } = useEntitySearch(entity, q, open);
  return (
    <Popover open={open} onOpenChange={setOpen} className="w-[min(22rem,calc(100vw-2rem))] p-0"
      trigger={
        <button id={id} type="button" disabled={disabled}
          className={cn('flex h-9 w-full items-center justify-between gap-2 rounded-[var(--radius-control)] border border-base surface px-3 text-left text-sm disabled:opacity-60', invalid && 'border-rose-500')}>
          <span className={cn('truncate', !value && 'text-muted')}>{value?.label ?? placeholder}</span>
          {value ? (
            <span role="button" tabIndex={0} aria-label="Clear" className="text-muted hover:text-[var(--text)]"
              onClick={(e) => { e.stopPropagation(); onChange(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onChange(null); } }}>
              <X className="size-3.5" />
            </span>
          ) : <Search className="size-3.5 text-muted" />}
        </button>
      }>
      <PickerList q={q} setQ={setQ} items={data ?? []} loading={isFetching} placeholder={placeholder}
        onPick={(it) => { onChange(it); setOpen(false); setQ(''); }}
        onCreate={onCreate ? (t) => { onCreate(t); setOpen(false); setQ(''); } : undefined} />
    </Popover>
  );
}

/** Multi-select async picker rendered as chips. */
export function MultiEntityPicker({ entity, value, onChange, placeholder = 'Add…' }: {
  entity: PickerEntity; value: PickerItem[]; onChange: (v: PickerItem[]) => void; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const { data, isFetching } = useEntitySearch(entity, q, open);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((v) => (
        <span key={v.id} className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] py-0.5 pl-2.5 pr-1 text-xs font-medium">
          {v.label}
          <button type="button" aria-label={`Remove ${v.label}`} className="rounded-full p-0.5 text-muted hover:text-[var(--text)]" onClick={() => onChange(value.filter((x) => x.id !== v.id))}><X className="size-3" /></button>
        </span>
      ))}
      <Popover open={open} onOpenChange={setOpen} className="w-[min(22rem,calc(100vw-2rem))] p-0"
        trigger={<button type="button" className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-base px-2.5 text-xs text-muted hover:text-[var(--text)]"><Plus className="size-3" />{placeholder}</button>}>
        <PickerList q={q} setQ={setQ} items={(data ?? []).filter((d) => !value.some((v) => v.id === d.id))} loading={isFetching} placeholder="Search…"
          onPick={(it) => { onChange([...value, it]); setOpen(false); setQ(''); }} />
      </Popover>
    </div>
  );
}

function PickerList({ q, setQ, items, loading, onPick, onCreate, placeholder }: {
  q: string; setQ: (v: string) => void; items: PickerItem[]; loading: boolean; onPick: (i: PickerItem) => void; onCreate?: (t: string) => void; placeholder: string;
}) {
  const [active, setActive] = useState(0);
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-base px-3">
        <Search className="size-4 text-muted" />
        <input autoFocus value={q} placeholder={placeholder} aria-label="Search"
          className="h-10 w-full bg-transparent text-sm outline-none"
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            if (e.key === 'Enter') { e.preventDefault(); if (items[active]) onPick(items[active]); else if (onCreate && q.trim()) onCreate(q.trim()); }
          }} />
        {loading && <Spinner className="size-4" />}
      </div>
      <ul className="max-h-64 overflow-y-auto p-1" role="listbox">
        {items.map((it, i) => (
          <li key={it.id} role="option" aria-selected={i === active}>
            <button type="button" onMouseEnter={() => setActive(i)} onClick={() => onPick(it)}
              className={cn('w-full rounded-md px-2.5 py-1.5 text-left', i === active && 'bg-[var(--surface-2)]')}>
              <div className="truncate text-sm font-medium">{it.label}</div>
              {it.sub && <div className="truncate text-xs text-muted">{it.sub}</div>}
            </button>
          </li>
        ))}
        {!loading && items.length === 0 && !onCreate && <li className="px-2.5 py-3 text-center text-sm text-muted">No matches</li>}
        {onCreate && q.trim() && (
          <li>
            <button type="button" onClick={() => onCreate(q.trim())} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-brand-700 hover:bg-[var(--surface-2)] dark:text-brand-200">
              <Plus className="size-4" />Create “{q.trim()}”
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
