import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Columns3, Download, Search, Trash2, UserRound, X } from 'lucide-react';
import { api, errorMessage, qsOf } from '../../lib/api.ts';
import { useDebounced } from '../../lib/hooks.ts';
import { Button, Checkbox, Input, Select } from '../../components/ui/primitives.tsx';
import { ConfirmDialog, Dialog, Popover } from '../../components/ui/overlays.tsx';
import type { Column } from '../../components/ui/DataTable.tsx';
import { UserSelect } from './form.tsx';

/** List state kept in the URL so views are shareable and survive reloads. */
export function useListParams(defaults: { sort: string; pageSize?: number }) {
  const [sp, setSp] = useSearchParams();
  const get = (k: string) => sp.get(k) ?? '';
  const set = (patch: Record<string, string | number | null | undefined>, resetPage = true) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === '') next.delete(k); else next.set(k, String(v));
    }
    if (resetPage && !('page' in patch)) next.delete('page');
    setSp(next, { replace: true });
  };
  const page = Number(get('page')) || 1;
  const pageSize = Number(get('pageSize')) || defaults.pageSize || 25;
  const sort = get('sort') || defaults.sort;
  const params: Record<string, string> = {};
  // `view` and `cols` are for the page only (not sent to the API; `cols` is still saved with saved views).
  sp.forEach((v, k) => { if (!['view', 'cols'].includes(k)) params[k] = v; });
  return { sp, get, set, page, pageSize, sort, params: { ...params, page: String(page), pageSize: String(pageSize), sort } };
}

export function SearchBox({ value, onChange, placeholder = 'Search…' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [local, setLocal] = useState(value);
  const deb = useDebounced(local, 300);
  useEffect(() => { if (deb !== value) onChange(deb); }, [deb]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setLocal(value); }, [value]);
  return (
    <div className="relative w-full sm:w-72">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
      <Input aria-label="Search" value={local} onChange={(e) => setLocal(e.target.value)} placeholder={placeholder} className="pl-8 pr-8" />
      {local && <button type="button" aria-label="Clear search" onClick={() => { setLocal(''); onChange(''); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted"><X className="size-3.5" /></button>}
    </div>
  );
}

export function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="w-auto min-w-36">
      <option value="">{label}: all</option>
      {options.map((o) => <option key={o.value} value={o.value}>{label}: {o.label}</option>)}
    </Select>
  );
}

/** Download the list as CSV with the current filters, search and sort. */
export function ExportLink({ path, params }: { path: string; params: Record<string, string> }) {
  const { page: _p, pageSize: _s, ...rest } = params;
  void _p; void _s;
  return (
    <a href={`/api/v1${path}${qsOf({ ...rest, format: 'csv' })}`} download title="Download these records as a CSV file (up to 50,000 rows; the audit log notes when the limit is reached)"
      className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-base surface px-3 text-[13px] font-medium hover:bg-[var(--surface-2)]">
      <Download className="size-4" />Export
    </a>
  );
}

export function Toolbar({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-1 flex-wrap items-center gap-2 max-sm:basis-full">{children}</div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}

/** Bulk actions shown when rows are selected. */
export function BulkBar({ entityPath, selected, clear, canDelete, canEdit }: { entityPath: string; selected: Set<number>; clear: () => void; canDelete: boolean; canEdit: boolean }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [assign, setAssign] = useState(false);
  const [owner, setOwner] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  if (!selected.size) return null;
  const runAll = async (fn: (id: number) => Promise<unknown>, ok: string) => {
    setBusy(true);
    const results = await Promise.allSettled([...selected].map(fn));
    const failed = results.filter((r) => r.status === 'rejected');
    setBusy(false);
    qc.invalidateQueries();
    if (failed.length) toast.error(`${failed.length} of ${results.length} failed: ${errorMessage((failed[0] as PromiseRejectedResult).reason)}`);
    else toast.success(ok);
    clear(); setConfirm(false); setAssign(false);
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm dark:border-brand-600/40 dark:bg-brand-600/10">
      <span className="font-medium">{selected.size} selected</span>
      {canEdit && <Button size="sm" icon={<UserRound className="size-3.5" />} onClick={() => setAssign(true)}>Change owner</Button>}
      {canDelete && <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirm(true)}>Delete</Button>}
      <Button size="sm" variant="ghost" onClick={clear}>Clear</Button>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} danger loading={busy} title={`Delete ${selected.size} records?`}
        description="They go to the recycle bin and can be restored for 30 days." confirmLabel="Delete"
        onConfirm={() => runAll((id) => api.del(`/${entityPath}/${id}`), `${selected.size} moved to the recycle bin`)} />
      <Dialog open={assign} onOpenChange={setAssign} title="Change owner" size="sm"
        footer={<><Button onClick={() => setAssign(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!owner} onClick={() => runAll((id) => api.patch(`/${entityPath}/${id}`, { ownerId: owner }), 'Owner updated')}>Apply</Button></>}>
        <UserSelect value={owner} onChange={setOwner} allowEmpty emptyLabel="Choose a person" />
      </Dialog>
    </div>
  );
}

/**
 * Which columns a list shows, kept in the URL as `cols=key,key` (so saved views and links keep it). The first `fixed`
 * columns (the record name) always show. Returns the columns to render and the "Columns" button for the toolbar.
 */
export function columnChoice<T>(lp: ReturnType<typeof useListParams>, columns: Column<T>[], fixed = 1) {
  const raw = lp.get('cols');
  const chosen = raw ? new Set(raw.split(',')) : null;
  const visible = chosen ? columns.filter((c, i) => i < fixed || chosen.has(c.key)) : columns;
  const setKeys = (keys: string[]) => {
    const optional = columns.slice(fixed).map((c) => c.key);
    const all = optional.every((k) => keys.includes(k));
    lp.set({ cols: all ? null : optional.filter((k) => keys.includes(k)).join(',') || '-' }, false);
  };
  const picker = <ColumnPicker columns={columns} fixed={fixed} visible={visible.map((c) => c.key)} onChange={setKeys} />;
  return { visible, picker };
}

function ColumnPicker<T>({ columns, fixed, visible, onChange }: { columns: Column<T>[]; fixed: number; visible: string[]; onChange: (keys: string[]) => void }) {
  const hidden = columns.length - visible.length;
  return (
    <Popover align="end" className="w-60"
      trigger={<Button icon={<Columns3 className="size-4" />} aria-label={`Columns${hidden ? ` (${hidden} hidden)` : ''}`}>Columns{hidden ? <span className="text-muted">· {hidden} hidden</span> : null}</Button>}>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-[13px] font-medium">Show columns</legend>
        {columns.map((c, i) => (
          <div key={c.key}><Checkbox label={c.label ?? (typeof c.header === 'string' ? c.header : c.key)} checked={visible.includes(c.key)} disabled={i < fixed}
            onChange={(v) => onChange(v ? [...visible, c.key] : visible.filter((k) => k !== c.key))} /></div>
        ))}
      </fieldset>
      {hidden > 0 && <Button size="sm" variant="ghost" className="mt-2 w-full" onClick={() => onChange(columns.map((c) => c.key))}>Show all</Button>}
    </Popover>
  );
}
