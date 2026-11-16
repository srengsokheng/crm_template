import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { CURRENCIES } from '@crm/shared';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { date } from '../../lib/format.ts';
import { Badge, Button, Card, EmptyState, ErrorState, Field, IconButton, Input, Select, Skeleton } from '../../components/ui/primitives.tsx';
import { AdminOnly } from './SettingsLayout.tsx';

interface Rate { id: number; currency: string; rate: string; validFrom: string; current: boolean; createdByName: string | null }

const today = () => new Date().toISOString().slice(0, 10);
const trimRate = (r: string) => r.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

export function CurrenciesSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['exchange-rates'], queryFn: () => api.get<{ baseCurrency: string; data: Rate[]; missing: string[] }>('/exchange-rates') });
  const base = q.data?.baseCurrency ?? 'USD';
  const [form, setForm] = useState({ currency: '', rate: '', validFrom: today() });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['exchange-rates'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); qc.invalidateQueries({ queryKey: ['report'] }); };
  const add = async () => {
    setBusy(true); setErrors({});
    try { await api.post('/exchange-rates', form); toast.success(`Rate for ${form.currency.toUpperCase()} saved`); setForm({ currency: '', rate: '', validFrom: today() }); refresh(); }
    catch (e) { setErrors(e instanceof ApiError ? e.fields ?? { rate: e.message } : { rate: errorMessage(e) }); }
    finally { setBusy(false); }
  };
  const remove = async (r: Rate) => {
    try { await api.del(`/exchange-rates/${r.id}`); toast.success('Rate deleted'); refresh(); } catch (e) { toast.error(errorMessage(e)); }
  };
  const options = CURRENCIES.filter((c) => c !== base);
  return (
    <AdminOnly>
      <div className="space-y-4">
        <Card title="Exchange rates">
          <p className="mb-4 text-sm text-muted">
            Deals and leads keep their own currency. Totals on the dashboard, boards, lists and reports are shown in <span className="font-medium text-[var(--text)]">{base}</span>,
            using the newest rate valid on the day (today for open deals, the close date for won and lost deals). Change the base currency under Workspace.
          </p>
          {q.data && q.data.missing.length > 0 && (
            <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
              Needed: {q.data.missing.map((c) => <button key={c} type="button" className="mr-2 font-medium underline" onClick={() => setForm({ ...form, currency: c })}>{c}</button>)}
              — records in these currencies are left out of totals until a rate exists.
            </p>
          )}
          <form className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)_10rem_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <Field label="Currency" htmlFor="rate-cur" error={errors.currency}>
              <Select id="rate-cur" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} invalid={!!errors.currency}>
                <option value="">Choose…</option>
                {[...new Set([...(q.data?.missing ?? []), ...options])].map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label={`1 ${form.currency || 'unit'} = ? ${base}`} htmlFor="rate-val" error={errors.rate}>
              <Input id="rate-val" inputMode="decimal" placeholder="e.g. 1.0850" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} invalid={!!errors.rate} />
            </Field>
            <Field label="Valid from" htmlFor="rate-from" error={errors.validFrom}>
              <Input id="rate-from" type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
            </Field>
            <Button type="submit" variant="primary" icon={<Plus className="size-4" />} loading={busy} disabled={!form.currency || !form.rate}>Add rate</Button>
          </form>
        </Card>
        <Card title="Rates" padded={false}>
          {q.isLoading ? <div className="space-y-2 p-4">{[0, 1].map((i) => <Skeleton key={i} className="h-9" />)}</div>
            : q.error ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
            : !q.data?.data.length ? <EmptyState title="No exchange rates yet" description={`Everything in ${base} adds up already. Add a rate when you sell in another currency.`} />
            : (
              <ul className="divide-y divide-[var(--border)]">
                {q.data.data.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                    <span className="w-12 font-semibold">{r.currency}</span>
                    <span className="tabular min-w-0 flex-1">1 {r.currency} = {trimRate(r.rate)} {base}</span>
                    <span className="text-xs text-muted">from {date(r.validFrom)}{r.createdByName ? ` · ${r.createdByName}` : ''}</span>
                    {r.current ? <Badge tone="green">In use</Badge> : new Date(r.validFrom) > new Date() ? <Badge tone="blue">Upcoming</Badge> : <Badge>Older</Badge>}
                    <IconButton size="sm" label={`Delete ${r.currency} rate from ${r.validFrom}`} onClick={() => remove(r)}><Trash2 className="size-3.5" /></IconButton>
                  </li>
                ))}
              </ul>
            )}
        </Card>
      </div>
    </AdminOnly>
  );
}
