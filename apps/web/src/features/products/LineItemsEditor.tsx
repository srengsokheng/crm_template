import { useEffect, useState } from 'react';
import { calcLine, calcTotals } from '@crm/shared';
import { Package, Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { money } from '../../lib/format.ts';
import type { LineItem } from '../../lib/types.ts';
import { Button, Card, IconButton, Input, Select } from '../../components/ui/primitives.tsx';
import { EntityPicker } from '../../components/ui/EntityPicker.tsx';

const blank = (): LineItem => ({ productId: null, name: '', unitPrice: '0', quantity: 1, unit: 'pcs', discountType: null, discountValue: null, taxRate: null, taxIncluded: false });

/** Editable product rows with live totals; the server recomputes and stores the authoritative values. */
export function LineItemsEditor({ items, currency, canEdit, onSave, amountMode }: {
  items: LineItem[]; currency: string; canEdit: boolean; onSave: (items: LineItem[]) => Promise<void>; amountMode?: string;
}) {
  const [rows, setRows] = useState<LineItem[]>(items);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!editing) setRows(items); }, [items, editing]);
  const norm = (r: LineItem) => ({ unitPrice: r.unitPrice || 0, quantity: r.quantity || 0, discountType: r.discountType, discountValue: r.discountValue, taxRate: r.taxRate, taxIncluded: r.taxIncluded });
  const totals = calcTotals(rows.map(norm));
  const update = (i: number, patch: Partial<LineItem>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = async () => {
    setSaving(true); setError(null);
    try {
      await onSave(rows.filter((r) => r.name.trim()).map((r) => ({ ...r, discountValue: r.discountType ? Number(r.discountValue || 0) : null })));
      setEditing(false);
    } catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <Card title={`Products (${items.length})`} padded={false}
      actions={canEdit && !editing && <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => { setEditing(true); if (!rows.length) setRows([blank()]); }}>{items.length ? 'Edit' : 'Add'}</Button>}>
      {!editing ? (
        items.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted"><tr><th className="px-4 py-2 font-medium">Item</th><th className="px-2 py-2 text-right font-medium">Qty</th><th className="px-2 py-2 text-right font-medium">Price</th><th className="px-4 py-2 text-right font-medium">Total</th></tr></thead>
              <tbody className="divide-y divide-[var(--border)]">
                {items.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2"><div className="font-medium">{r.name}</div>
                      <div className="text-xs text-muted">{[r.discountType && Number(r.discountValue) > 0 ? `−${r.discountType === 'percent' ? `${Number(r.discountValue)}%` : money(String(r.discountValue), currency)}` : null, r.taxRate ? `tax ${Number(r.taxRate)}%${r.taxIncluded ? ' incl.' : ''}` : null].filter(Boolean).join(' · ')}</div></td>
                    <td className="px-2 py-2 text-right tabular">{Number(r.quantity)} {r.unit}</td>
                    <td className="px-2 py-2 text-right tabular">{money(r.unitPrice, currency)}</td>
                    <td className="px-4 py-2 text-right font-medium tabular">{money(r.lineTotal, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Totals totals={calcTotals(items.map(norm))} currency={currency} />
            {amountMode === 'manual' && <p className="px-4 pb-3 text-xs text-amber-700 dark:text-amber-300">The deal amount is set manually and doesn’t follow these totals.</p>}
          </div>
        ) : <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted"><Package className="size-4" />No products added.</div>
      ) : (
        <div className="space-y-3 p-4">
          {rows.map((r, i) => {
            const line = calcLine(norm(r));
            return (
              <div key={i} className="space-y-2 rounded-lg border border-base p-3">
                <div className="flex gap-2">
                  <div className="flex-1">
                    <EntityPicker entity="products" value={r.name ? { id: r.productId ?? -1, label: r.name } : null}
                      placeholder="Search products or type a name"
                      onChange={(p) => update(i, p ? { productId: p.id, name: p.label, unitPrice: String(p.raw?.unitPrice ?? r.unitPrice), unit: String(p.raw?.unit ?? 'pcs'), taxRate: (p.raw?.taxRate as string) ?? null, taxIncluded: Boolean(p.raw?.taxIncluded) } : { productId: null, name: '' })}
                      onCreate={(text) => update(i, { productId: null, name: text })} />
                  </div>
                  <IconButton label="Remove row" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <label className="text-xs text-muted">Qty<Input type="number" min="0" step="any" value={r.quantity} onChange={(e) => update(i, { quantity: e.target.value })} /></label>
                  <label className="text-xs text-muted">Unit price<Input inputMode="decimal" value={r.unitPrice} onChange={(e) => update(i, { unitPrice: e.target.value })} /></label>
                  <label className="text-xs text-muted">Discount
                    <div className="flex"><Input inputMode="decimal" className="rounded-r-none" value={r.discountValue ?? ''} onChange={(e) => update(i, { discountValue: e.target.value, discountType: r.discountType ?? 'percent' })} />
                      <Select aria-label="Discount type" className="w-14 rounded-l-none border-l-0 px-1" value={r.discountType ?? 'percent'} onChange={(e) => update(i, { discountType: e.target.value as 'percent' | 'amount' })}><option value="percent">%</option><option value="amount">$</option></Select></div>
                  </label>
                  <label className="text-xs text-muted">Tax %<Input inputMode="decimal" value={r.taxRate ?? ''} onChange={(e) => update(i, { taxRate: e.target.value || null })} /></label>
                  <div className="text-xs text-muted">Line total<div className="flex h-9 items-center justify-end text-sm font-semibold text-[var(--text)] tabular">{money(line.lineTotal, currency)}</div></div>
                </div>
              </div>
            );
          })}
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setRows((rs) => [...rs, blank()])}>Add row</Button>
          <Totals totals={totals} currency={currency} />
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button onClick={() => { setEditing(false); setRows(items); setError(null); }}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={save}>Save products</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function Totals({ totals, currency }: { totals: ReturnType<typeof calcTotals>; currency: string }) {
  return (
    <dl className="ml-auto max-w-xs space-y-1 px-4 py-3 text-sm">
      <div className="flex justify-between text-muted"><dt>Subtotal</dt><dd className="tabular">{money(totals.listTotal, currency)}</dd></div>
      {Number(totals.discount) > 0 && <div className="flex justify-between text-muted"><dt>Discount</dt><dd className="tabular">−{money(totals.discount, currency)}</dd></div>}
      {Number(totals.tax) > 0 && <div className="flex justify-between text-muted"><dt>Tax</dt><dd className="tabular">{money(totals.tax, currency)}</dd></div>}
      <div className="flex justify-between border-t border-base pt-1 font-semibold"><dt>Total</dt><dd className="tabular">{money(totals.total, currency)}</dd></div>
    </dl>
  );
}

export async function saveLineItems(path: string, items: LineItem[]) {
  await api.put(path, { items: items.map((r) => ({ productId: r.productId && r.productId > 0 ? r.productId : null, name: r.name, unitPrice: String(r.unitPrice || 0), quantity: Number(r.quantity), unit: r.unit || 'pcs', discountType: r.discountType, discountValue: r.discountValue === null ? null : Number(r.discountValue), taxRate: r.taxRate === null || r.taxRate === '' ? null : Number(r.taxRate), taxIncluded: !!r.taxIncluded })) });
}
