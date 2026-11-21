import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bookmark, ChevronDown, Pencil, RefreshCw, Trash2, Users } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { Button, Checkbox, Field, Input } from '../../components/ui/primitives.tsx';
import { ConfirmDialog, Dialog, Menu } from '../../components/ui/overlays.tsx';

type Entity = 'lead' | 'deal' | 'contact' | 'company';
interface View { id: number; name: string; query: Record<string, string>; shared: boolean }

/** Current list filters from the URL (without the page number). */
function currentQuery(sp: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  sp.forEach((v, k) => { if (k !== 'page' && v !== '') out[k] = v; });
  return out;
}
const same = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

/** Saved views for a list: one click applies a stored set of filters. */
export function SavedViews({ entity, defaults = {} }: { entity: Entity; defaults?: Record<string, string> }) {
  const [sp, setSp] = useSearchParams();
  const qc = useQueryClient();
  const views = useQuery({ queryKey: ['views', entity], queryFn: () => api.get<{ data: View[]; canShare: boolean }>(`/views?entityType=${entity}`) });
  const [dialog, setDialog] = useState<{ mode: 'create' | 'rename'; view?: View } | null>(null);
  const [deleting, setDeleting] = useState<View | null>(null);
  const cur = currentQuery(sp);
  // Default values (e.g. the board layout) count as "no filter".
  const meaningful = Object.fromEntries(Object.entries(cur).filter(([k, v]) => defaults[k] !== v));
  const list = views.data?.data ?? [];
  const active = list.find((v) => same(v.query, cur));
  const apply = (q: Record<string, string>) => setSp(new URLSearchParams(q), { replace: false });
  const refresh = () => qc.invalidateQueries({ queryKey: ['views', entity] });
  const call = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); refresh(); toast.success(ok); return true; } catch (e) { toast.error(errorMessage(e)); return false; } };
  const canEdit = (v: View) => !v.shared || !!views.data?.canShare;

  if (views.isError) return null; // the list itself still works; views are an extra
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Saved views">
      <button type="button" onClick={() => apply({})} aria-pressed={!Object.keys(meaningful).length && !active}
        className={cn('h-8 rounded-full border px-3 text-[13px] font-medium', !Object.keys(meaningful).length && !active ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-100' : 'border-base text-muted hover:text-[var(--text)]')}>
        All
      </button>
      {list.map((v) => {
        const on = active?.id === v.id;
        return (
          <div key={v.id} className={cn('inline-flex h-8 items-center rounded-full border text-[13px] font-medium', on ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-100' : 'border-base text-muted hover:text-[var(--text)]')}>
            <button type="button" className="inline-flex h-full items-center gap-1.5 pl-3 pr-2" aria-pressed={on} onClick={() => apply(v.query)}>
              {v.shared && <Users className="size-3.5" aria-label="Shared with everyone" />}{v.name}
            </button>
            {on && canEdit(v) && (
              <Menu trigger={<button type="button" aria-label={`Options for ${v.name}`} className="-ml-1 inline-flex h-full items-center pr-2"><ChevronDown className="size-3.5" /></button>}
                items={[
                  { label: 'Rename', icon: <Pencil className="size-4" />, onSelect: () => setDialog({ mode: 'rename', view: v }) },
                  { label: 'Delete view', icon: <Trash2 className="size-4" />, danger: true, onSelect: () => setDeleting(v) },
                ]} />
            )}
          </div>
        );
      })}
      {Object.keys(meaningful).length > 0 && !active && (
        <>
          <Button size="sm" variant="ghost" icon={<Bookmark className="size-3.5" />} onClick={() => setDialog({ mode: 'create' })}>Save view</Button>
          {list.filter(canEdit).length > 0 && (
            <Menu trigger={<Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />}>Update a view</Button>}
              items={list.filter(canEdit).map((v) => ({ label: v.name,
                onSelect: () => call(() => api.patch(`/views/${v.id}`, { query: cur }), `“${v.name}” updated`) }))} />
          )}
        </>
      )}
      {dialog && (
        <ViewDialog entity={entity} mode={dialog.mode} view={dialog.view} canShare={!!views.data?.canShare} query={cur}
          onClose={() => setDialog(null)} onSaved={(v) => { refresh(); setDialog(null); if (dialog.mode === 'create') apply(v.query); }} />
      )}
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} danger title={`Delete “${deleting?.name}”?`}
        description={deleting?.shared ? 'It disappears for everyone in the workspace. The records are not affected.' : 'The records are not affected.'}
        confirmLabel="Delete view" onConfirm={async () => { if (deleting && await call(() => api.del(`/views/${deleting.id}`), 'View deleted')) { setDeleting(null); apply({}); } }} />
    </div>
  );
}

function ViewDialog({ entity, mode, view, canShare, query, onClose, onSaved }: {
  entity: Entity; mode: 'create' | 'rename'; view?: View; canShare: boolean; query: Record<string, string>;
  onClose: () => void; onSaved: (v: View) => void;
}) {
  const [name, setName] = useState(view?.name ?? '');
  const [shared, setShared] = useState(view?.shared ?? false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError(undefined);
    try {
      const v = mode === 'create'
        ? await api.post<View>('/views', { entityType: entity, name, query, shared })
        : await api.patch<View>(`/views/${view!.id}`, { name, ...(canShare ? { shared } : {}) });
      toast.success(mode === 'create' ? 'View saved' : 'View renamed');
      onSaved(v);
    } catch (e) { setError(e instanceof ApiError ? (e.fields?.name ?? e.message) : errorMessage(e)); setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="sm" title={mode === 'create' ? 'Save this view' : 'Rename view'}
      description={mode === 'create' ? 'Saves the current search, filters and sorting so you can come back with one click.' : undefined}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>{mode === 'create' ? 'Save view' : 'Save'}</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void save(); }}>
        <Field label="Name" htmlFor="view-name" error={error}><Input id="view-name" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. My open deals" invalid={!!error} /></Field>
        {canShare && <Checkbox checked={shared} onChange={setShared} label="Share with everyone in the workspace" />}
      </form>
    </Dialog>
  );
}
