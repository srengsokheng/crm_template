import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, X } from 'lucide-react';
import { moneyCompare } from '@crm/shared';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { money } from '../../lib/format.ts';
import { useMe } from '../../lib/hooks.ts';
import { Button, Card, Field, IconButton, Input, Textarea } from '../../components/ui/primitives.tsx';
import { ConfirmDialog, Dialog } from '../../components/ui/overlays.tsx';
import { dateOnly, docTitle, kindLabel, type DocFull } from './common.tsx';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Payments received on an invoice: list, add, remove. */
export function PaymentsCard({ doc, onChange, onRecord }: { doc: DocFull; onChange: () => Promise<void>; onRecord: () => void }) {
  const [removing, setRemoving] = useState<number | null>(null);
  const canAdd = doc.canEdit && doc.status === 'sent';
  const remove = async (pid: number) => {
    try { await api.del(`/documents/${doc.id}/payments/${pid}`); await onChange(); toast.success('Payment removed'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setRemoving(null); }
  };
  return (
    <Card padded={false} title={`Payments (${doc.payments.length})`}
      actions={canAdd && <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={onRecord}>Record payment</Button>}>
      {doc.payments.length ? (
        <ul className="divide-y divide-[var(--border)]">
          {doc.payments.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium tabular">{money(p.amount, doc.currency)}</div>
                <div className="truncate text-xs text-muted">{dateOnly(p.paidOn)}{p.method ? ` · ${p.method}` : ''}{p.note ? ` · ${p.note}` : ''}{p.createdByName ? ` · ${p.createdByName}` : ''}</div>
              </div>
              {doc.canEdit && doc.status !== 'void' && <IconButton size="sm" label={`Remove payment of ${money(p.amount, doc.currency)}`} onClick={() => setRemoving(p.id)}><Trash2 className="size-3.5" /></IconButton>}
            </li>
          ))}
        </ul>
      ) : <p className="px-4 py-3 text-sm text-muted">No payments yet.</p>}
      <div className="flex justify-between border-t border-[var(--border)] px-4 py-2.5 text-sm">
        <span className="text-muted">Balance due</span>
        <span className="font-semibold tabular">{money(doc.balance, doc.currency)}</span>
      </div>
      <ConfirmDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)} danger title="Remove this payment?"
        description="Use this when a payment was recorded by mistake. The balance goes back up." confirmLabel="Remove payment" onConfirm={() => removing !== null && remove(removing)} />
    </Card>
  );
}

export function PaymentDialog({ doc, open, onOpenChange, onSaved }: { doc: DocFull; open: boolean; onOpenChange: (v: boolean) => void; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ amount: doc.balance, paidOn: today(), method: '', note: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const tooMuch = !!f.amount && moneyCompare(f.amount, doc.balance) > 0;
  const save = async () => {
    setBusy(true); setErrors({});
    try {
      const r = await api.post<DocFull>(`/documents/${doc.id}/payments`, f);
      await onSaved();
      toast.success(r.status === 'paid' ? `Invoice ${doc.number} is paid in full` : `Payment recorded — ${money(r.balance, doc.currency)} still due`);
      onOpenChange(false);
    } catch (e) { if (e instanceof ApiError && e.fields) setErrors(e.fields); toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Record a payment on ${docTitle(doc)}`} description={`Balance due: ${money(doc.balance, doc.currency)}`}
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={tooMuch || !f.amount} onClick={save}>Record payment</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`Amount (${doc.currency})`} htmlFor="pay-amount" error={errors.amount ?? (tooMuch ? 'More than the balance due' : undefined)}>
          <Input id="pay-amount" inputMode="decimal" autoFocus value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        <Field label="Paid on" htmlFor="pay-date" error={errors.paidOn}><Input id="pay-date" type="date" value={f.paidOn} onChange={(e) => setF({ ...f, paidOn: e.target.value })} /></Field>
        <Field label="Method" htmlFor="pay-method" hint="Pick one or type your own"><Input id="pay-method" list="pay-methods" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} />
          <datalist id="pay-methods">{['KHQR', 'ABA', 'ACLEDA', 'Wing', 'Bank transfer', 'Cash', 'Card', 'Cheque'].map((m) => <option key={m} value={m} />)}</datalist></Field>
        <Field label="Note" htmlFor="pay-note"><Input id="pay-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Reference number…" /></Field>
      </div>
    </Dialog>
  );
}

/** Send the quote/invoice as a PDF attachment. A draft is issued (numbered) when it is sent. */
export function EmailDialog({ doc, open, onOpenChange, onSent }: { doc: DocFull; open: boolean; onOpenChange: (v: boolean) => void; onSent: () => Promise<void> }) {
  const { data: me } = useMe();
  const label = kindLabel(doc.kind).toLowerCase();
  const [to, setTo] = useState<string[]>(doc.suggestedRecipients.slice(0, 1));
  const [draftAddr, setDraftAddr] = useState('');
  const [subject, setSubject] = useState(`${kindLabel(doc.kind)}${doc.number ? ` ${doc.number}` : ''} from ${me?.workspace.name ?? 'us'}`);
  const [message, setMessage] = useState(`Hello${doc.billToName ? ` ${doc.billToName}` : ''},\n\nPlease find our ${label} attached.${doc.kind === 'invoice' && doc.dueDate ? ` Payment is due by ${dateOnly(doc.dueDate)}.` : ''}\n\nKind regards,\n${me?.user.name ?? ''}`);
  const [busy, setBusy] = useState(false);
  const add = (v: string) => {
    const e = v.trim().replace(/[,;]$/, '');
    if (e && !to.includes(e) && to.length < 5) setTo([...to, e]);
    setDraftAddr('');
  };
  const send = async () => {
    const all = draftAddr.trim() ? [...to, draftAddr.trim()] : to;
    setBusy(true);
    try {
      const r = await api.post<DocFull>(`/documents/${doc.id}/email`, { to: all, subject, message });
      await onSent();
      toast.success(`${kindLabel(doc.kind)} ${r.number} emailed to ${all.join(', ')}`);
      onOpenChange(false);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const suggestions = doc.suggestedRecipients.filter((s) => !to.includes(s));
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" title={`Email ${docTitle(doc).toLowerCase().startsWith('draft') ? label : docTitle(doc)}`}
      description={doc.status === 'draft' ? `Sending gives the ${label} its number and marks it as sent.` : `The PDF is attached. Replies go to ${me?.user.email ?? 'you'}.`}
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!to.length && !draftAddr.trim()} onClick={send}>Send email</Button></>}>
      <div className="space-y-3">
        <Field label="To" htmlFor="mail-to" hint="Up to 5 addresses. Press Enter after each.">
          <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-[var(--radius-control)] border border-base px-2 py-1">
            {to.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] py-0.5 pl-2.5 pr-1 text-xs">
                {t}<button type="button" aria-label={`Remove ${t}`} className="rounded-full p-0.5 hover:bg-[var(--border)]" onClick={() => setTo(to.filter((x) => x !== t))}><X className="size-3" /></button>
              </span>
            ))}
            <input id="mail-to" type="email" className="min-w-[10rem] flex-1 bg-transparent py-1 text-sm outline-none" value={draftAddr} placeholder={to.length ? '' : 'name@company.com'}
              onChange={(e) => setDraftAddr(e.target.value)} onBlur={() => draftAddr && add(draftAddr)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',' || e.key === ';') { e.preventDefault(); add(draftAddr); } else if (e.key === 'Backspace' && !draftAddr) setTo(to.slice(0, -1)); }} />
          </div>
        </Field>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">From this deal:
            {suggestions.map((s) => <button key={s} type="button" className="rounded-full border border-base px-2 py-0.5 hover:bg-[var(--surface-2)]" onClick={() => add(s)}>+ {s}</button>)}
          </div>
        )}
        <Field label="Subject" htmlFor="mail-subject"><Input id="mail-subject" value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
        <Field label="Message" htmlFor="mail-message"><Textarea id="mail-message" rows={7} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>
        <p className="text-xs text-muted">Attachment: {doc.number ?? `Draft ${label}`}.pdf</p>
      </div>
    </Dialog>
  );
}
