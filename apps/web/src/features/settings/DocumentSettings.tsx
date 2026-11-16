import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { Button, Card, ErrorState, Field, Input, Skeleton, Textarea } from '../../components/ui/primitives.tsx';
import { AdminOnly } from './SettingsLayout.tsx';

interface S { companyDetails: string; footer: string; quotePrefix: string; invoicePrefix: string; quoteValidDays: number; paymentTermsDays: number }

/** What appears on quote and invoice PDFs, and how they are numbered. */
export function DocumentSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['document-settings'], queryFn: () => api.get<S>('/settings/documents') });
  const [f, setF] = useState<S | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);
  const set = (patch: Partial<S>) => setF((v) => (v ? { ...v, ...patch } : v));
  const save = async () => {
    if (!f) return;
    setSaving(true); setErrors({});
    try { await api.put('/settings/documents', f); await qc.invalidateQueries({ queryKey: ['document-settings'] }); toast.success('Settings saved'); }
    catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <AdminOnly>
      <Card title="Quotes & invoices">
        {q.isLoading || (!f && !q.error) ? <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
          : q.error ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
          : f && (
            <div className="space-y-4">
              <p className="text-sm text-muted">The workspace name is printed at the top of every quote and invoice. Numbers are given when a document is first marked as sent, so deleted drafts never leave gaps.</p>
              <Field label="Your company details" htmlFor="ds-details" hint="Address, tax ID, phone, email — printed under your name" error={errors.companyDetails}>
                <Textarea id="ds-details" rows={4} value={f.companyDetails} onChange={(e) => set({ companyDetails: e.target.value })} placeholder={'12 Main Street\nPhnom Penh, Cambodia\nVAT: K001-123456789'} />
              </Field>
              <Field label="Footer" htmlFor="ds-footer" hint="Printed at the bottom of every page, e.g. bank details or a thank-you line" error={errors.footer}>
                <Textarea id="ds-footer" rows={2} value={f.footer} onChange={(e) => set({ footer: e.target.value })} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Quote number prefix" htmlFor="ds-qp" hint={`Next looks like ${f.quotePrefix}0001`} error={errors.quotePrefix}><Input id="ds-qp" value={f.quotePrefix} onChange={(e) => set({ quotePrefix: e.target.value })} /></Field>
                <Field label="Invoice number prefix" htmlFor="ds-ip" hint={`Next looks like ${f.invoicePrefix}0001`} error={errors.invoicePrefix}><Input id="ds-ip" value={f.invoicePrefix} onChange={(e) => set({ invoicePrefix: e.target.value })} /></Field>
                <Field label="Quotes are valid for (days)" htmlFor="ds-qv" error={errors.quoteValidDays}><Input id="ds-qv" type="number" min={1} max={365} value={f.quoteValidDays} onChange={(e) => set({ quoteValidDays: Number(e.target.value) })} /></Field>
                <Field label="Invoices are due after (days)" htmlFor="ds-pt" error={errors.paymentTermsDays}><Input id="ds-pt" type="number" min={0} max={365} value={f.paymentTermsDays} onChange={(e) => set({ paymentTermsDays: Number(e.target.value) })} /></Field>
              </div>
              <div className="flex justify-end"><Button variant="primary" loading={saving} onClick={save}>Save</Button></div>
            </div>
          )}
      </Card>
    </AdminOnly>
  );
}
