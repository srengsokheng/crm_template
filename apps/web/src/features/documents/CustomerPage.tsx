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

interface PublicDoc {
  kind: 'quote' | 'invoice'; number: string; status: string; currency: string; issueDate: string | null; dueDate: string | null;
  billToName: string; billToDetails: string; notes: string; listTotal: string; discount: string; tax: string; total: string; paidAmount: string; balance: string;
  items: { name: string; quantity: string; unit: string; unitPrice: string; discountType: string | null; discountValue: string | null; taxRate: string | null; lineTotal: string }[];
  seller: { name: string; details: string }; expired: boolean; canRespond: boolean;
  response: { at: string; by: string | null; note: string | null } | null;
  khqr: { payload: string; amount: string; currency: string; expiresAt: string; merchantName: string; accountId: string } | null;
}

async function call<T>(token: string, path = '', body?: unknown): Promise<T> {
  const r = await fetch(`/api/v1/public/documents/${encodeURIComponent(token)}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error?.message ?? (r.status === 404 ? 'This link isn’t valid any more. Ask for a new one.' : 'Something went wrong. Please try again.'));
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
      toast.success(kind === 'accept' ? 'Thank you — the quote is accepted' : 'Thanks for letting us know');
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  if (q.isLoading) return <main className="mx-auto max-w-3xl px-4 py-8"><Skeleton className="h-96" /></main>;
  if (q.isError) return <main className="mx-auto max-w-3xl px-4 py-16"><EmptyState title="Can’t open this document" description={(q.error as Error).message} /></main>;
  const d = q.data!;
  const isQuote = d.kind === 'quote';
  const m = (v: string) => money(v, d.currency);
  const paid = Number(d.paidAmount) > 0;
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-6 sm:py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-lg font-semibold">{d.seller.name}</p>
          {d.seller.details && <p className="whitespace-pre-line text-sm text-muted">{d.seller.details}</p>}
        </div>
        <div className="text-right">
          <h1 className="text-2xl font-semibold tracking-tight text-brand-600 dark:text-brand-200">{isQuote ? 'Quote' : 'Invoice'} {d.number}</h1>
          <p className="text-sm text-muted">{d.issueDate ? `Issued ${dateOnly(d.issueDate)}` : ''}{d.dueDate ? ` · ${isQuote ? 'Valid until' : 'Due'} ${dateOnly(d.dueDate)}` : ''}</p>
        </div>
      </header>

      {/* What the customer can do now. */}
      {isQuote && d.status === 'accepted' && (
        <p className="flex items-start gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200" role="status">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />Accepted{d.response?.by ? ` by ${d.response.by}` : ''}{d.response?.at ? ` on ${dateOnly(d.response.at)}` : ''}. Thank you — we’ll be in touch.</p>
      )}
      {isQuote && d.status === 'declined' && <p className="rounded-md bg-[var(--surface-2)] px-3 py-2 text-sm text-muted" role="status">This quote was declined. Contact {d.seller.name} if you’d like a new one.</p>}
      {isQuote && d.status === 'sent' && d.expired && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-100" role="status">This quote has expired. Contact {d.seller.name} for a new one.</p>}
      {!isQuote && d.status === 'paid' && <p className="flex items-start gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200" role="status"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />Paid in full. Thank you!</p>}
      {!isQuote && d.status === 'void' && <p className="rounded-md bg-[var(--surface-2)] px-3 py-2 text-sm text-muted" role="status">This invoice was cancelled.</p>}

      <Card>
        <div className="space-y-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted">{isQuote ? 'Prepared for' : 'Bill to'}</p>
            <p className="font-medium">{d.billToName || '—'}</p>
            {d.billToDetails && <p className="whitespace-pre-line text-sm text-muted">{d.billToDetails}</p>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-base text-left text-xs text-muted"><tr><th className="py-2 pr-3 font-medium">Item</th><th className="py-2 pr-3 text-right font-medium">Qty</th><th className="py-2 pr-3 text-right font-medium max-sm:hidden">Price</th><th className="py-2 text-right font-medium">Amount</th></tr></thead>
              <tbody className="divide-y divide-[var(--border)]">
                {d.items.map((i, n) => (
                  <tr key={n}>
                    <td className="py-2 pr-3">{i.name}<span className="block text-xs text-muted sm:hidden">{m(i.unitPrice)} each</span></td>
                    <td className="whitespace-nowrap py-2 pr-3 text-right tabular">{Number(i.quantity)} {i.unit}</td>
                    <td className="whitespace-nowrap py-2 pr-3 text-right tabular max-sm:hidden">{m(i.unitPrice)}</td>
                    <td className="whitespace-nowrap py-2 text-right font-medium tabular">{m(i.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="ml-auto w-full max-w-xs space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd className="tabular">{m(d.listTotal)}</dd></div>
            {Number(d.discount) > 0 && <div className="flex justify-between"><dt className="text-muted">Discount</dt><dd className="tabular">−{m(d.discount)}</dd></div>}
            <div className="flex justify-between"><dt className="text-muted">Tax</dt><dd className="tabular">{m(d.tax)}</dd></div>
            <div className="flex justify-between border-t border-base pt-1 text-base font-semibold"><dt>Total</dt><dd className="tabular">{m(d.total)}</dd></div>
            {!isQuote && paid && <>
              <div className="flex justify-between"><dt className="text-muted">Paid</dt><dd className="tabular">−{m(d.paidAmount)}</dd></div>
              <div className="flex justify-between font-semibold"><dt>Balance due</dt><dd className="tabular">{m(d.balance)}</dd></div>
            </>}
          </dl>
          {d.notes && <div><p className="text-xs font-medium uppercase tracking-wide text-muted">Notes</p><p className="whitespace-pre-line text-sm">{d.notes}</p></div>}
        </div>
      </Card>

      {d.khqr && (
        <Card title="Pay with KHQR">
          <div className="flex flex-wrap items-center gap-4">
            <QrSvg text={d.khqr.payload} label={`KHQR to pay ${money(d.khqr.amount, d.khqr.currency)} to ${d.khqr.merchantName}`} className="size-48 shrink-0 rounded-md border border-base" />
            <div className="space-y-1 text-sm">
              <p className="text-lg font-semibold tabular">{money(d.khqr.amount, d.khqr.currency)}</p>
              <p>To <span className="font-medium">{d.khqr.merchantName}</span></p>
              <p className="text-muted">Open your bank app (ABA, ACLEDA, Wing, …), choose Scan, and scan this code. On a phone, take a screenshot and use “scan from photo”.</p>
            </div>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <a href={`/api/v1/public/documents/${encodeURIComponent(token)}/pdf`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-sm font-medium hover:bg-[var(--surface-2)]"><Download className="size-4" />Download PDF</a>
        {d.canRespond && <>
          <Button icon={<XCircle className="size-4" />} onClick={() => { setNote(''); setDialog('decline'); }}>Decline</Button>
          <Button variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => { setNote(''); setDialog('accept'); }}>Accept quote</Button>
        </>}
      </div>

      <Dialog open={dialog === 'accept'} onOpenChange={(o) => !o && setDialog(null)} title={`Accept quote ${d.number}`}
        description={`You accept the quote for ${m(d.total)}. ${d.seller.name} will be told right away.`}
        footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" disabled={name.trim().length < 2 || busy} onClick={() => answer('accept')}>{busy ? 'Sending…' : 'Accept'}</Button></>}>
        <div className="space-y-3">
          <Field label="Your full name" htmlFor="acc-name" required hint="Typed as your confirmation"><Input id="acc-name" autoComplete="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Note (optional)" htmlFor="acc-note"><Textarea id="acc-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. delivery date, PO number" /></Field>
        </div>
      </Dialog>
      <Dialog open={dialog === 'decline'} onOpenChange={(o) => !o && setDialog(null)} title={`Decline quote ${d.number}`}
        description="Telling us why helps us make a better offer."
        footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="danger" disabled={busy} onClick={() => answer('decline')}>{busy ? 'Sending…' : 'Decline'}</Button></>}>
        <Field label="Reason (optional)" htmlFor="dec-reason"><Textarea id="dec-reason" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Dialog>
      <p className="pt-4 text-center text-xs text-muted">Questions? Reply to the email this link came with.</p>
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
