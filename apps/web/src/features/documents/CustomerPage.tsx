import { useState } from 'react';
import { useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { money } from '../../lib/format.ts';
import { Button, Card, EmptyState, Field, Input, Skeleton, Textarea } from '../../components/ui/primitives.tsx';
import { Dialog } from '../../components/ui/overlays.tsx';
import { dateOnly } from './common.tsx';
import { QrSvg } from './Khqr.tsx';
import { ct, ctLabel, customerDate, type CustomerLanguage, type TextKey } from '@crm/shared';

interface PublicDoc {
  kind: 'quote' | 'invoice'; number: string; status: string; currency: string; issueDate: string | null; dueDate: string | null;
  billToName: string; billToDetails: string; notes: string; listTotal: string; discount: string; tax: string; total: string; paidAmount: string; balance: string;
  items: { name: string; quantity: string; unit: string; unitPrice: string; discountType: string | null; discountValue: string | null; taxRate: string | null; lineTotal: string }[];
  seller: { name: string; details: string }; expired: boolean; canRespond: boolean;
  response: { at: string; by: string | null; note: string | null } | null;
  khqr: { payload: string; amount: string; currency: string; expiresAt: string; merchantName: string; accountId: string } | null;
  lang: CustomerLanguage;
}

async function call<T>(token: string, path = '', body?: unknown): Promise<T> {
  const r = await fetch(`/api/v1/public/documents/${encodeURIComponent(token)}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  // Before the document (and its language) is known, errors are in both languages.
  const both = (k: TextKey) => `${ct('km', k)} ${ct('en', k)}`;
  if (!r.ok) throw new Error(r.status === 404 ? both('linkInvalid') : (data?.error?.message ?? both('somethingWrong')));
  return data as T;
}

/** The page a customer opens from the email: the quote or invoice, accept/decline, PDF, KHQR. No sign-in. */
export function CustomerDocumentPage() {
  const token = useParams().token ?? '';
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['public-doc', token], retry: false, queryFn: () => call<PublicDoc>(token) });
  const [dialog, setDialog] = useState<null | 'accept' | 'decline'>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const answer = async (kind: 'accept' | 'decline') => {
    setBusy(true);
    try {
      await call(token, `/${kind}`, kind === 'accept' ? { name: name.trim(), note: note.trim() || undefined } : { reason: note.trim() || undefined });
      setDialog(null);
      await qc.invalidateQueries({ queryKey: ['public-doc', token] });
      toast.success(ct(q.data?.lang ?? 'en', kind === 'accept' ? 'thanksAccepted' : 'thanksDeclined'));
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  if (q.isLoading) return <main className="mx-auto max-w-3xl px-4 py-8"><Skeleton className="h-96" /></main>;
  if (q.isError) return <main className="mx-auto max-w-3xl px-4 py-16"><EmptyState title={`${ct('km', 'cantOpen')} · ${ct('en', 'cantOpen')}`} description={(q.error as Error).message} /></main>;
  const d = q.data!;
  // The workspace's customer language: sentences in Khmer for "km"/"both", short labels bilingual for "both".
  const t = (k: TextKey, vars?: Record<string, string | number>) => ct(d.lang, k, vars);
  const L = (k: TextKey) => ctLabel(d.lang, k);
  const day = (v: string | null) => customerDate(d.lang, v);
  const isQuote = d.kind === 'quote';
  const m = (v: string) => money(v, d.currency);
  const paid = Number(d.paidAmount) > 0;
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-6 sm:py-10" lang={d.lang === 'en' ? 'en' : 'km'}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-lg font-semibold">{d.seller.name}</p>
          {d.seller.details && <p className="whitespace-pre-line text-sm text-muted">{d.seller.details}</p>}
        </div>
        <div className="text-right">
          <h1 className="text-2xl font-semibold tracking-tight text-brand-600 dark:text-brand-200">{L(d.kind)} {d.number}</h1>
          <p className="text-sm text-muted">{d.issueDate ? t('issued', { date: day(d.issueDate) }) : ''}{d.dueDate ? ` · ${t(isQuote ? 'validUntil' : 'dueDate')} ${day(d.dueDate)}` : ''}</p>
        </div>
      </header>

      {/* What the customer can do now. */}
      {isQuote && d.status === 'accepted' && (
        <p className="flex items-start gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200" role="status">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />{d.response?.by && d.response.at ? t('acceptedBy', { name: d.response.by, date: day(d.response.at) }) : t('acceptedPlain')}</p>
      )}
      {isQuote && d.status === 'declined' && <p className="rounded-md bg-[var(--surface-2)] px-3 py-2 text-sm text-muted" role="status">{t('declinedNote', { seller: d.seller.name })}</p>}
      {isQuote && d.status === 'sent' && d.expired && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-100" role="status">{t('expiredNote', { seller: d.seller.name })}</p>}
      {!isQuote && d.status === 'paid' && <p className="flex items-start gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200" role="status"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{t('paidNote')}</p>}
      {!isQuote && d.status === 'void' && <p className="rounded-md bg-[var(--surface-2)] px-3 py-2 text-sm text-muted" role="status">{t('voidNote')}</p>}

      <Card>
        <div className="space-y-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted">{L(isQuote ? 'preparedFor' : 'billTo')}</p>
            <p className="font-medium">{d.billToName || '—'}</p>
            {d.billToDetails && <p className="whitespace-pre-line text-sm text-muted">{d.billToDetails}</p>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-base text-left text-xs text-muted"><tr><th className="py-2 pr-3 font-medium">{L('item')}</th><th className="py-2 pr-3 text-right font-medium">{L('qty')}</th><th className="py-2 pr-3 text-right font-medium max-sm:hidden">{L('unitPrice')}</th><th className="py-2 text-right font-medium">{L('amount')}</th></tr></thead>
              <tbody className="divide-y divide-[var(--border)]">
                {d.items.map((i, n) => (
                  <tr key={n}>
                    <td className="py-2 pr-3">{i.name}<span className="block text-xs text-muted sm:hidden">{t('each', { price: m(i.unitPrice) })}</span></td>
                    <td className="whitespace-nowrap py-2 pr-3 text-right tabular">{Number(i.quantity)} {i.unit}</td>
                    <td className="whitespace-nowrap py-2 pr-3 text-right tabular max-sm:hidden">{m(i.unitPrice)}</td>
                    <td className="whitespace-nowrap py-2 text-right font-medium tabular">{m(i.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="ml-auto w-full max-w-xs space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-muted">{L('subtotal')}</dt><dd className="tabular">{m(d.listTotal)}</dd></div>
            {Number(d.discount) > 0 && <div className="flex justify-between"><dt className="text-muted">{L('discount')}</dt><dd className="tabular">−{m(d.discount)}</dd></div>}
            <div className="flex justify-between"><dt className="text-muted">{L('tax')}</dt><dd className="tabular">{m(d.tax)}</dd></div>
            <div className="flex justify-between border-t border-base pt-1 text-base font-semibold"><dt>{L('total')}</dt><dd className="tabular">{m(d.total)}</dd></div>
            {!isQuote && paid && <>
              <div className="flex justify-between"><dt className="text-muted">{L('paidAmount')}</dt><dd className="tabular">−{m(d.paidAmount)}</dd></div>
              <div className="flex justify-between font-semibold"><dt>{L('balanceDue')}</dt><dd className="tabular">{m(d.balance)}</dd></div>
            </>}
          </dl>
          {d.notes && <div><p className="text-xs font-medium uppercase tracking-wide text-muted">{L('notes')}</p><p className="whitespace-pre-line text-sm">{d.notes}</p></div>}
        </div>
      </Card>

      {d.khqr && (
        <Card title={L('payWithKhqr')}>
          <div className="flex flex-wrap items-center gap-4">
            <QrSvg text={d.khqr.payload} label={`KHQR to pay ${money(d.khqr.amount, d.khqr.currency)} to ${d.khqr.merchantName}`} className="size-48 shrink-0 rounded-md border border-base" />
            <div className="space-y-1 text-sm">
              <p className="text-lg font-semibold tabular">{money(d.khqr.amount, d.khqr.currency)}</p>
              <p>{t('to')} <span className="font-medium">{d.khqr.merchantName}</span></p>
              <p className="text-muted">{t('scanHelp')}</p>
            </div>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <a href={`/api/v1/public/documents/${encodeURIComponent(token)}/pdf`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-sm font-medium hover:bg-[var(--surface-2)]"><Download className="size-4" />{t('downloadPdf')}</a>
        {d.canRespond && <>
          <Button icon={<XCircle className="size-4" />} onClick={() => { setNote(''); setDialog('decline'); }}>{t('decline')}</Button>
          <Button variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => { setNote(''); setDialog('accept'); }}>{t('acceptQuote')}</Button>
        </>}
      </div>

      <Dialog open={dialog === 'accept'} onOpenChange={(o) => !o && setDialog(null)} title={t('acceptTitle', { number: d.number })}
        description={t('acceptHelp', { total: m(d.total), seller: d.seller.name })}
        footer={<><Button onClick={() => setDialog(null)}>{t('cancel')}</Button><Button variant="primary" disabled={name.trim().length < 2 || busy} onClick={() => answer('accept')}>{busy ? t('sending') : t('accept')}</Button></>}>
        <div className="space-y-3">
          <Field label={t('fullName')} htmlFor="acc-name" required hint={t('fullNameHint')}><Input id="acc-name" autoComplete="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t('noteOptional')} htmlFor="acc-note"><Textarea id="acc-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('notePlaceholder')} /></Field>
        </div>
      </Dialog>
      <Dialog open={dialog === 'decline'} onOpenChange={(o) => !o && setDialog(null)} title={t('declineTitle', { number: d.number })}
        description={t('declineHelp')}
        footer={<><Button onClick={() => setDialog(null)}>{t('cancel')}</Button><Button variant="danger" disabled={busy} onClick={() => answer('decline')}>{busy ? t('sending') : t('decline')}</Button></>}>
        <Field label={t('reasonOptional')} htmlFor="dec-reason"><Textarea id="dec-reason" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Dialog>
      <p className="pt-4 text-center text-xs text-muted">{t('questions')}</p>
    </main>
  );
}

/** For the team: the customer's link, and whether they opened or answered it. */
export function CustomerLinkCard({ url, viewedAt, kind, status, respondedByName, customerNote }: { url: string; viewedAt: string | null; kind: 'quote' | 'invoice'; status: string; respondedByName: string | null; customerNote: string | null }) {
  const copy = async () => { try { await navigator.clipboard.writeText(url); toast.success('Link copied'); } catch { toast.error('Copy failed — select the link and copy it'); } };
  return (
    <Card title="Customer link">
      <div className="space-y-2 text-sm">
        <p className="text-muted">The customer can open this {kind}{kind === 'quote' ? ', accept or decline it' : ' and pay it by KHQR'} — no sign-in. It’s in the email you send from here.</p>
        <div className="flex items-center gap-2">
          <Input aria-label="Customer link" readOnly value={url} className="min-w-0 flex-1 font-mono text-xs" onFocus={(e) => e.target.select()} />
          <Button size="sm" onClick={copy}>Copy</Button>
        </div>
        <p>{viewedAt ? <>Opened by the customer {dateOnly(viewedAt)}.</> : <span className="text-muted">Not opened yet.</span>}
          {kind === 'quote' && status === 'accepted' && respondedByName && <> Accepted online by <span className="font-medium">{respondedByName}</span>.</>}
          {kind === 'quote' && status === 'declined' && customerNote && <> Declined: “{customerNote}”.</>}
          {kind === 'quote' && status === 'accepted' && customerNote && <> Note: “{customerNote}”.</>}</p>
      </div>
    </Card>
  );
}
