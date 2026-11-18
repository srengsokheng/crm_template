import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Banknote, Download, ExternalLink, FileText, Mail, Trash2, MoreHorizontal } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { money } from '../../lib/format.ts';
import { Button, Card, Field, Input, Textarea, IconButton } from '../../components/ui/primitives.tsx';
import { ConfirmDialog, Menu } from '../../components/ui/overlays.tsx';
import { RecordError, RecordShell, RecordSkeleton } from '../records/record.tsx';
import { itemsPayload, LineItemsEditor } from '../products/LineItemsEditor.tsx';
import { dateOnly, DocStatus, docTitle, kindLabel, type DocFull } from './common.tsx';
import { EmailDialog, PaymentDialog, PaymentsCard } from './DocumentExtras.tsx';
import { KhqrCard } from './Khqr.tsx';
import { CustomerLinkCard } from './CustomerPage.tsx';

/** The next steps offered for each status (the server enforces the same rules). */
const ACTIONS: Record<string, Record<string, { status: string; label: string; primary?: boolean; danger?: boolean }[]>> = {
  quote: { draft: [{ status: 'sent', label: 'Mark as sent', primary: true }], sent: [{ status: 'accepted', label: 'Accepted', primary: true }, { status: 'declined', label: 'Declined' }], declined: [{ status: 'sent', label: 'Send again' }] },
  invoice: { draft: [{ status: 'sent', label: 'Mark as sent' }], sent: [{ status: 'paid', label: 'Mark as paid' }, { status: 'void', label: 'Void', danger: true }] },
};

export function DocumentPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const key = ['document', id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<DocFull>(`/documents/${id}`) });
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'void' | null>(null);
  const [dialog, setDialog] = useState<'email' | 'payment' | null>(null);
  const [form, setForm] = useState({ billToName: '', billToDetails: '', notes: '', dueDate: '' });
  const d = q.data;
  useEffect(() => { if (d) setForm({ billToName: d.billToName, billToDetails: d.billToDetails, notes: d.notes, dueDate: d.dueDate ?? '' }); }, [d]);

  if (q.isLoading) return <RecordSkeleton />;
  if (q.error || !d) return <RecordError error={q.error} back="/deals" />;
  const draft = d.status === 'draft';
  const editable = draft && d.canEdit;
  const dirty = form.billToName !== d.billToName || form.billToDetails !== d.billToDetails || form.notes !== d.notes || form.dueDate !== (d.dueDate ?? '');
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: key });
    await qc.invalidateQueries({ queryKey: ['documents', d.dealId] });
    await qc.invalidateQueries({ queryKey: ['timeline', 'deal', d.dealId] }); // the deal's history lists document events
    await qc.invalidateQueries({ queryKey: ['documents-list'] });
  };
  const overdue = d.kind === 'invoice' && d.status === 'sent' && !!d.dueDate && d.dueDate < new Date().toISOString().slice(0, 10);

  const save = async () => {
    setBusy('save');
    try { await api.patch(`/documents/${id}`, { ...form, dueDate: form.dueDate || null }); await refresh(); toast.success('Saved'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const setStatus = async (status: string) => {
    setBusy(status);
    try {
      if (dirty) await api.patch(`/documents/${id}`, { ...form, dueDate: form.dueDate || null });
      const r = await api.post<DocFull>(`/documents/${id}/status`, { status });
      await refresh();
      toast.success(status === 'sent' ? `${kindLabel(d.kind)} ${r.number} is ready to send` : `Marked as ${status}`);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); setConfirm(null); }
  };
  const remove = async () => {
    try { await api.del(`/documents/${id}`); await qc.invalidateQueries({ queryKey: ['documents', d.dealId] }); await qc.invalidateQueries({ queryKey: ['timeline', 'deal', d.dealId] }); toast.success('Draft deleted'); navigate(`/deals/${d.dealId}`); }
    catch (e) { toast.error(errorMessage(e)); setConfirm(null); }
  };
  const toInvoice = async () => {
    setBusy('invoice');
    // The same page component shows the new invoice, so local state must be reset after navigating.
    try { const inv = await api.post<{ id: number }>(`/deals/${d.dealId}/documents`, { kind: 'invoice', fromQuoteId: d.id }); await refresh(); navigate(`/documents/${inv.id}`); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); setConfirm(null); }
  };
  const pdf = `/api/v1/documents/${id}/pdf`;

  return (
    <RecordShell back={{ to: `/deals/${d.dealId}`, label: d.dealTitle }}
      title={<span className="flex flex-wrap items-center gap-2">{docTitle(d)} <DocStatus status={d.status} paidAmount={d.paidAmount} overdue={overdue} /></span>}
      subtitle={<span className="text-muted">{money(d.total, d.currency)}{d.kind === 'invoice' && Number(d.paidAmount) > 0 && d.status === 'sent' ? ` · ${money(d.balance, d.currency)} due` : ''} · {d.issueDate ? `issued ${dateOnly(d.issueDate)}` : 'not sent yet'}{d.lastEmailedAt ? ` · emailed ${dateOnly(d.lastEmailedAt)}` : ''}</span>}
      actions={<div className="flex flex-wrap gap-2">
        {d.canEdit && d.status !== 'void' && <Button variant="primary" icon={<Mail className="size-4" />} onClick={() => setDialog('email')}>{draft ? 'Send by email' : 'Email'}</Button>}
        {d.canEdit && d.kind === 'invoice' && d.status === 'sent' && <Button variant="primary" icon={<Banknote className="size-4" />} onClick={() => setDialog('payment')}>Record payment</Button>}
        {d.canEdit && (ACTIONS[d.kind][d.status] ?? []).map((a) => (
          <Button key={a.status} variant={a.primary ? 'primary' : a.danger ? 'danger' : 'secondary'} loading={busy === a.status} disabled={!!busy}
            onClick={() => (a.status === 'void' ? setConfirm('void') : setStatus(a.status))}>{a.label}</Button>
        ))}
        {d.canEdit && d.kind === 'quote' && d.status === 'accepted' && <Button variant="primary" loading={busy === 'invoice'} onClick={toInvoice}>Create invoice</Button>}
        {/* PDF, Preview and Delete draft: buttons from tablet width, one "More actions" menu on phones. */}
        <a href={pdf} download className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-sm font-medium hover:bg-[var(--surface-2)] max-sm:hidden"><Download className="size-4" />PDF</a>
        <a href={`${pdf}?inline=1`} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-sm font-medium hover:bg-[var(--surface-2)] max-sm:hidden"><ExternalLink className="size-4" />Preview</a>
        {editable && <span className="max-sm:hidden"><Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setConfirm('delete')}>Delete draft</Button></span>}
        <span className="sm:hidden">
          <Menu trigger={<IconButton label="More actions"><MoreHorizontal className="size-4" /></IconButton>} items={[
            { label: 'Download PDF', icon: <Download className="size-4" />, onSelect: () => { const a = document.createElement('a'); a.href = pdf; a.download = ''; a.click(); } },
            { label: 'Preview', icon: <ExternalLink className="size-4" />, onSelect: () => { window.open(`${pdf}?inline=1`, '_blank', 'noopener'); } },
            { label: 'Delete draft', icon: <Trash2 className="size-4" />, danger: true, onSelect: () => setConfirm('delete'), hidden: !editable },
          ]} />
        </span>
      </div>}
      left={<>
        {!draft && <p className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-muted"><FileText className="mt-0.5 size-4 shrink-0" />
          {d.kind === 'invoice' ? 'Sent invoices can’t be changed. Void it and create a new one if something is wrong.' : 'Sent quotes can’t be changed. Create a new quote from the deal for a revised offer.'}</p>}
        <Card title={d.kind === 'quote' ? 'Prepared for' : 'Bill to'}>
          {editable ? (
            <div className="space-y-3">
              <Field label="Name" htmlFor="doc-name"><Input id="doc-name" value={form.billToName} onChange={(e) => setForm({ ...form, billToName: e.target.value })} /></Field>
              <Field label="Address and details" htmlFor="doc-details"><Textarea id="doc-details" rows={4} value={form.billToDetails} onChange={(e) => setForm({ ...form, billToDetails: e.target.value })} /></Field>
              <Field label={d.kind === 'quote' ? 'Valid until' : 'Due date'} htmlFor="doc-due" hint="Leave empty to use the default from settings when it’s sent">
                <Input id="doc-due" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></Field>
              <Field label="Notes on the document" htmlFor="doc-notes"><Textarea id="doc-notes" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Payment details, delivery terms…" /></Field>
              <div className="flex justify-end"><Button variant="primary" size="sm" disabled={!dirty} loading={busy === 'save'} onClick={save}>Save</Button></div>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <div><div className="font-medium">{d.billToName || '—'}</div>{d.billToDetails && <div className="whitespace-pre-line text-muted">{d.billToDetails}</div>}</div>
              <div className="text-muted">{d.kind === 'quote' ? 'Valid until' : 'Due'} {dateOnly(d.dueDate)}</div>
              {d.notes && <div><div className="text-xs font-medium text-muted">Notes</div><div className="whitespace-pre-line">{d.notes}</div></div>}
            </div>
          )}
        </Card>
      </>}
      right={<>
        {d.customerUrl && <CustomerLinkCard url={d.customerUrl} viewedAt={d.viewedAt} kind={d.kind} status={d.status} respondedByName={d.respondedByName} customerNote={d.customerNote} />}
        {d.kind === 'invoice' && d.status === 'sent' && <KhqrCard docId={d.id} balance={d.balance} />}
        {d.kind === 'invoice' && d.status !== 'draft' && <PaymentsCard doc={d} onChange={refresh} onRecord={() => setDialog('payment')} />}
        <LineItemsEditor title="Items" items={d.items} currency={d.currency} canEdit={editable}
          onSave={async (items) => { await api.patch(`/documents/${id}`, { items: itemsPayload(items) }); await refresh(); toast.success('Items saved'); }} />
        {d.sourceQuoteId && <p className="text-sm text-muted">Created from <Link className="text-brand-600 hover:underline dark:text-brand-200" to={`/documents/${d.sourceQuoteId}`}>the accepted quote</Link>.</p>}
        <ConfirmDialog open={confirm === 'delete'} onOpenChange={(o) => !o && setConfirm(null)} danger title={`Delete this draft ${d.kind}?`}
          description="It hasn’t been sent and has no number yet. This can’t be undone." confirmLabel="Delete draft" onConfirm={remove} />
        <ConfirmDialog open={confirm === 'void'} onOpenChange={(o) => !o && setConfirm(null)} danger title={`Void invoice ${d.number}?`}
          description="The invoice stays on record with its number but no longer counts as owed. This can’t be undone." confirmLabel="Void invoice" onConfirm={() => setStatus('void')} />
        {dialog === 'email' && <EmailDialog doc={d} open onOpenChange={(o) => !o && setDialog(null)} onSent={refresh} />}
        {dialog === 'payment' && <PaymentDialog doc={d} open onOpenChange={(o) => !o && setDialog(null)} onSaved={refresh} />}
      </>} />
  );
}

