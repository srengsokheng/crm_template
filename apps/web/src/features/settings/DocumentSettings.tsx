import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { Button, Card, Checkbox, ErrorState, Field, Input, Select, Skeleton, Textarea } from '../../components/ui/primitives.tsx';
import { AdminOnly } from './SettingsLayout.tsx';

interface K { enabled: boolean; accountId: string; merchantName: string; city: string; accountType: 'individual' | 'merchant'; merchantId: string; acquiringBank: string; validDays: number }
interface S { companyDetails: string; footer: string; quotePrefix: string; invoicePrefix: string; quoteValidDays: number; paymentTermsDays: number; khqr: K; customerLanguage: 'en' | 'km' | 'both' }

/** What appears on quote and invoice PDFs, and how they are numbered. */
export function DocumentSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['document-settings'], queryFn: () => api.get<S>('/settings/documents') });
  const [f, setF] = useState<S | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);
  const set = (patch: Partial<S>) => setF((v) => (v ? { ...v, ...patch } : v));
  const setK = (patch: Partial<K>) => setF((v) => (v ? { ...v, khqr: { ...v.khqr, ...patch } } : v));
  const kErr = (k: string) => errors[`khqr.${k}`] ?? (k === 'accountId' ? errors.khqr : undefined);
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
              <Field label="Language for customers" htmlFor="ds-lang" hint="Quote and invoice PDFs, the customer’s page, the email button, the website chat and video calls. The team’s screens stay in English.">
                <Select id="ds-lang" value={f.customerLanguage} onChange={(e) => set({ customerLanguage: e.target.value as S['customerLanguage'] })}>
                  <option value="en">English</option>
                  <option value="km">ខ្មែរ (Khmer)</option>
                  <option value="both">ខ្មែរ + English (bilingual PDFs)</option>
                </Select>
              </Field>
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
              <fieldset className="space-y-3 rounded-md border border-base p-3">
                <legend className="px-1 text-sm font-medium">KHQR payments (Bakong)</legend>
                <Checkbox checked={f.khqr.enabled} onChange={(v) => setK({ enabled: v })} label="Show a KHQR on sent invoices in riel or dollars, for the balance due" />
                <p className="text-xs text-muted">Customers scan it with any Bakong member bank app (ABA, ACLEDA, Wing, …) and the money goes straight to your account. Record the payment here when it arrives.</p>
                {f.khqr.enabled && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Bakong account ID" htmlFor="kq-id" required hint="In your bank app, e.g. name@aclb or name@abaa" error={kErr('accountId')}><Input id="kq-id" autoComplete="off" spellCheck={false} value={f.khqr.accountId} onChange={(e) => setK({ accountId: e.target.value })} /></Field>
                    <Field label="Name the payer sees" htmlFor="kq-name" required hint="Up to 25 English letters" error={kErr('merchantName')}><Input id="kq-name" maxLength={25} value={f.khqr.merchantName} onChange={(e) => setK({ merchantName: e.target.value })} /></Field>
                    <Field label="City" htmlFor="kq-city" error={kErr('city')}><Input id="kq-city" maxLength={15} value={f.khqr.city} onChange={(e) => setK({ city: e.target.value })} /></Field>
                    <Field label="Account type" htmlFor="kq-type"><Select id="kq-type" value={f.khqr.accountType} onChange={(e) => setK({ accountType: e.target.value as K['accountType'] })}><option value="individual">Personal account</option><option value="merchant">Merchant account</option></Select></Field>
                    {f.khqr.accountType === 'merchant' && <>
                      <Field label="Merchant ID" htmlFor="kq-mid" hint="From your bank" error={kErr('merchantId')}><Input id="kq-mid" value={f.khqr.merchantId} onChange={(e) => setK({ merchantId: e.target.value })} /></Field>
                      <Field label="Bank" htmlFor="kq-bank" hint="e.g. ABA Bank" error={kErr('acquiringBank')}><Input id="kq-bank" value={f.khqr.acquiringBank} onChange={(e) => setK({ acquiringBank: e.target.value })} /></Field>
                    </>}
                    <Field label="A QR stays valid for (days)" htmlFor="kq-days" hint="Banks refuse expired ones; each view or PDF makes a fresh one" error={kErr('validDays')}><Input id="kq-days" type="number" min={1} max={90} value={f.khqr.validDays} onChange={(e) => setK({ validDays: Number(e.target.value) })} /></Field>
                  </div>
                )}
              </fieldset>
              <div className="flex justify-end"><Button variant="primary" loading={saving} onClick={save}>Save</Button></div>
            </div>
          )}
      </Card>
    </AdminOnly>
  );
}
