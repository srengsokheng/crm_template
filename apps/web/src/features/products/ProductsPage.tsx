import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Package, Plus } from 'lucide-react';
import { api, errorMessage, qsOf } from '../../lib/api.ts';
import { money } from '../../lib/format.ts';
import { useAction, useCan, useMe, useMeta } from '../../lib/hooks.ts';
import type { ListResponse } from '../../lib/types.ts';
import { Badge, Button, Checkbox, EmptyState, Field, Input, PageHeader, Select, Textarea } from '../../components/ui/primitives.tsx';
import { Drawer } from '../../components/ui/overlays.tsx';
import { DataTable, Pagination, type Column } from '../../components/ui/DataTable.tsx';
import { BulkBar, FilterSelect, SearchBox, Toolbar, useListParams } from '../records/list.tsx';
import { clean, useForm } from '../records/form.tsx';

interface Product { id: number; name: string; sku: string | null; categoryId: number | null; categoryName: string | null; unitPrice: string; currency: string; unit: string; taxRate: string | null; taxIncluded: boolean; isActive: boolean; description?: string | null }

export function ProductsPage() {
  const can = useCan();
  const { data: meta } = useMeta();
  const lp = useListParams({ sort: 'name' });
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const q = useQuery({ queryKey: ['products', lp.params], queryFn: () => api.get<ListResponse<Product>>(`/products${qsOf(lp.params)}`), placeholderData: keepPreviousData });
  const cols: Column<Product>[] = [
    { key: 'name', header: 'Product', sortKey: 'name', cell: (r) => <div><div className="font-medium">{r.name}</div>{r.sku && <div className="text-xs text-muted">SKU {r.sku}</div>}</div> },
    { key: 'category', header: 'Category', sortKey: 'category', cell: (r) => r.categoryName ?? <span className="text-muted">—</span> },
    { key: 'price', header: 'Price', sortKey: 'unitPrice', align: 'right', cell: (r) => <span>{money(r.unitPrice, r.currency)} <span className="text-xs text-muted">/ {r.unit}</span></span> },
    { key: 'tax', header: 'Tax', align: 'right', hideOnMobile: true, cell: (r) => r.taxRate ? `${Number(r.taxRate)}%${r.taxIncluded ? ' incl.' : ''}` : <span className="text-muted">—</span> },
    { key: 'status', header: 'Status', cell: (r) => r.isActive ? <Badge tone="green">Active</Badge> : <Badge>Archived</Badge> },
  ];
  return (
    <div>
      <PageHeader title="Products" subtitle="Your catalog of products and services" actions={can('product', 'create') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>New product</Button>} />
      <Toolbar>
        <SearchBox value={lp.get('q')} onChange={(v) => lp.set({ q: v })} placeholder="Search name or SKU" />
        <FilterSelect label="Category" value={lp.get('categoryId')} onChange={(v) => lp.set({ categoryId: v })} options={(meta?.productCategories ?? []).map((c) => ({ value: String(c.id), label: c.name }))} />
        <FilterSelect label="Status" value={lp.get('active')} onChange={(v) => lp.set({ active: v })} options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Archived' }]} />
      </Toolbar>
      <BulkBar entityPath="products" selected={selected} clear={() => setSelected(new Set())} canDelete={can('product', 'delete')} canEdit={false} />
      <DataTable columns={cols} rows={q.data?.data ?? []} loading={q.isLoading} error={q.error ? errorMessage(q.error) : null} onRetry={() => q.refetch()}
        sort={lp.sort} onSort={(s) => lp.set({ sort: s })} onRowClick={can('product', 'edit') ? (r) => setEditing(r) : undefined} selected={can('product', 'delete') ? selected : undefined} onSelect={can('product', 'delete') ? setSelected : undefined}
        empty={<EmptyState icon={<Package className="size-5" />} title="No products yet" description="Add products to quote prices and track what you sell." action={can('product', 'create') ? <Button variant="primary" onClick={() => setEditing('new')}>Add a product</Button> : undefined} />}
        footer={<Pagination page={lp.page} pageSize={lp.pageSize} total={q.data?.total ?? 0} onPage={(p) => lp.set({ page: p }, false)} onPageSize={(n) => lp.set({ pageSize: n })} />} />
      {editing && <ProductForm product={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ProductForm({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const { data: me } = useMe();
  const { data: meta } = useMeta();
  const full = useQuery({ queryKey: ['product', product?.id], enabled: !!product, queryFn: () => api.get<Product & { usage: { deals: number; wonRevenue: string } }>(`/products/${product!.id}`) });
  const f = useForm({
    name: product?.name ?? '', sku: product?.sku ?? '', categoryId: product?.categoryId ?? null as number | null, unitPrice: product?.unitPrice ?? '',
    currency: product?.currency ?? me?.workspace.baseCurrency ?? 'USD', unit: product?.unit ?? 'pcs', taxRate: product?.taxRate ?? '',
    taxIncluded: product?.taxIncluded ?? false, isActive: product?.isActive ?? true, description: product?.description ?? '',
  });
  const v = f.values;
  const save = useAction(() => {
    const body = clean({ ...v, unitPrice: v.unitPrice || '0', taxRate: v.taxRate === '' ? null : Number(v.taxRate) });
    return product ? api.patch(`/products/${product.id}`, body) : api.post('/products', body);
  }, { success: product ? 'Product saved' : 'Product created', invalidate: [['products'], ['picker']], onSuccess: onClose, onError: (e) => { f.fromError(e); return false; } });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={product ? 'Edit product' : 'New product'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>{product ? 'Save' : 'Create product'}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <Field label="Name" required htmlFor="p-name" error={f.errors.name}><Input id="p-name" autoFocus value={v.name} invalid={!!f.errors.name} onChange={(e) => f.set('name', e.target.value)} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="SKU / code" htmlFor="p-sku" error={f.errors.sku}><Input id="p-sku" value={v.sku} onChange={(e) => f.set('sku', e.target.value)} /></Field>
          <Field label="Category" htmlFor="p-cat"><Select id="p-cat" value={v.categoryId ?? ''} onChange={(e) => f.set('categoryId', e.target.value ? Number(e.target.value) : null)}>
            <option value="">None</option>{(meta?.productCategories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <Field label="Unit price" htmlFor="p-price" error={f.errors.unitPrice}><Input id="p-price" inputMode="decimal" placeholder="0.00" value={v.unitPrice} invalid={!!f.errors.unitPrice} onChange={(e) => f.set('unitPrice', e.target.value)} /></Field>
          <Field label="Currency" htmlFor="p-cur"><Select id="p-cur" value={v.currency} onChange={(e) => f.set('currency', e.target.value)}>{['USD', 'EUR', 'GBP', 'KHR', 'THB', 'SGD', 'JPY', 'CNY', 'AUD', 'CAD'].map((c) => <option key={c}>{c}</option>)}</Select></Field>
          <Field label="Unit" htmlFor="p-unit"><Input id="p-unit" value={v.unit} onChange={(e) => f.set('unit', e.target.value)} /></Field>
          <Field label="Tax rate %" htmlFor="p-tax" error={f.errors.taxRate}><Input id="p-tax" inputMode="decimal" value={v.taxRate} onChange={(e) => f.set('taxRate', e.target.value)} /></Field>
        </div>
        <Checkbox checked={v.taxIncluded} onChange={(x) => f.set('taxIncluded', x)} label="Price includes tax" />
        <Field label="Description" htmlFor="p-desc"><Textarea id="p-desc" value={v.description ?? ''} onChange={(e) => f.set('description', e.target.value)} /></Field>
        {product && <Checkbox checked={v.isActive} onChange={(x) => f.set('isActive', x)} label="Active (available for new deals)" />}
        {full.data && <p className="text-xs text-muted">Used in {full.data.usage.deals} deal(s) · {money(full.data.usage.wonRevenue, v.currency)} won revenue</p>}
        <button type="submit" className="hidden" />
      </form>
    </Drawer>
  );
}
