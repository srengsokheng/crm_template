import { useState } from 'react';
import { DICTIONARY_KINDS, DICTIONARY_LABELS, type DictionaryKind } from '@crm/shared';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { useMeta } from '../../lib/hooks.ts';
import { Button, Card, Checkbox, IconButton, Input } from '../../components/ui/primitives.tsx';
import { ConfirmDialog } from '../../components/ui/overlays.tsx';
import { AdminOnly } from './SettingsLayout.tsx';

export function DictionariesSettings() {
  const { data: meta } = useMeta();
  const qc = useQueryClient();
  const [kind, setKind] = useState<DictionaryKind | 'product_category'>('lead_source');
  const [label, setLabel] = useState('');
  const items = (meta?.dictionaries ?? []).filter((d) => d.kind === kind);
  const call = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); qc.invalidateQueries({ queryKey: ['meta'] }); if (ok) toast.success(ok); } catch (e) { toast.error(errorMessage(e)); } };
  return (
    <AdminOnly>
      <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
        <nav className="flex gap-1 overflow-x-auto md:flex-col" aria-label="Lists">
          {[...DICTIONARY_KINDS, 'product_category' as const].map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)} aria-current={k === kind ? 'true' : undefined} className={cn('whitespace-nowrap rounded-md px-3 py-2 text-left text-[13px] font-medium', k === kind ? 'bg-[var(--surface-2)] text-[var(--text)]' : 'text-muted hover:text-[var(--text)]')}>{k === 'product_category' ? 'Product categories' : DICTIONARY_LABELS[k]}</button>
          ))}
        </nav>
        {kind === 'product_category' ? <ProductCategories /> : (
        <Card title={DICTIONARY_LABELS[kind]} padded={false}>
          <ul className="divide-y divide-[var(--border)]">
            {items.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-4 py-2">
                <Input aria-label="Label" defaultValue={d.label} className="h-8" onBlur={(e) => e.target.value.trim() && e.target.value !== d.label && call(() => api.patch(`/dictionaries/${d.id}`, { label: e.target.value }), 'Saved')} />
                <Checkbox checked={d.isActive} onChange={(v) => call(() => api.patch(`/dictionaries/${d.id}`, { isActive: v }))} label="Active" />
              </li>
            ))}
          </ul>
          <form className="flex gap-2 border-t border-base px-4 py-3" onSubmit={(e) => { e.preventDefault(); if (label.trim()) call(() => api.post('/dictionaries', { kind, label }), 'Option added').then(() => setLabel('')); }}>
            <Input aria-label="New option" placeholder="New option" value={label} onChange={(e) => setLabel(e.target.value)} className="h-8" />
            <Button size="sm" type="submit" icon={<Plus className="size-3.5" />} disabled={!label.trim()}>Add</Button>
          </form>
        </Card>
        )}
      </div>
    </AdminOnly>
  );
}

/** Product categories: add, rename (on leaving the field), delete (products keep existing, without a category). */
function ProductCategories() {
  const { data: meta } = useMeta();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<{ id: number; name: string } | null>(null);
  const cats = meta?.productCategories ?? [];
  const call = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); qc.invalidateQueries({ queryKey: ['meta'] }); qc.invalidateQueries({ queryKey: ['products'] }); if (ok) toast.success(ok); return true; }
    catch (e) { toast.error(errorMessage(e)); return false; }
  };
  return (
    <Card title="Product categories" padded={false}>
      {cats.length === 0
        ? <p className="px-4 py-5 text-sm text-muted">No categories yet. Add some to group your products and filter the product list.</p>
        : (
          <ul className="divide-y divide-[var(--border)]">
            {cats.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-2">
                <Input aria-label={`Category name: ${c.name}`} defaultValue={c.name} maxLength={100} className="h-8"
                  onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && call(() => api.patch(`/product-categories/${c.id}`, { name: e.target.value }), 'Saved')} />
                <IconButton label={`Delete ${c.name}`} onClick={() => setDeleting(c)}><Trash2 className="size-4" /></IconButton>
              </li>
            ))}
          </ul>
        )}
      <form className="flex gap-2 border-t border-base px-4 py-3" onSubmit={async (e) => { e.preventDefault(); if (name.trim() && await call(() => api.post('/product-categories', { name }), 'Category added')) setName(''); }}>
        <Input aria-label="New category" placeholder="New category" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} className="h-8" />
        <Button size="sm" type="submit" icon={<Plus className="size-3.5" />} disabled={!name.trim()}>Add</Button>
      </form>
      <ConfirmDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger confirmLabel="Delete category" title={`Delete “${deleting?.name ?? ''}”?`}
        description="Products in this category are kept; they just won’t have a category any more."
        onConfirm={async () => { if (await call(() => api.del(`/product-categories/${deleting!.id}`), 'Category deleted')) setDeleting(null); }} />
    </Card>
  );
}
