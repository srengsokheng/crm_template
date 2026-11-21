import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Repeat } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { money } from '../../lib/format.ts';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Select, Skeleton, Textarea } from '../../components/ui/primitives.tsx';
import { Dialog } from '../../components/ui/overlays.tsx';
import { dateOnly } from './common.tsx';

export interface Schedule {
  id: number; dealId: number; dealTitle: string; sourceId: number | null; everyMonths: number; startOn: string; nextRun: string; endsAfter: number | null;
  runs: number; mode: 'draft' | 'send'; emailTo: string[]; status: 'active' | 'paused' | 'ended'; lastError: string | null; lastDocumentId: number | null;
  lastNumber: string | null; currency: string; amount: string | null; createdByName: string | null; canEdit?: boolean;
}
const EVERY: Record<number, string> = { 1: 'Every month', 2: 'Every 2 months', 3: 'Every 3 months', 6: 'Every 6 months', 12: 'Every year' };
export const everyLabel = (n: number) => EVERY[n] ?? `Every ${n} months`;
const today = () => new Date().toISOString().slice(0, 10);

/** "Repeat…": set up a schedule from this invoice. */
export function RepeatDialog({ docId, open, onOpenChange, suggestedTo, onSaved }: { docId: number; open: boolean; onOpenChange: (v: boolean) => void; suggestedTo: string[]; onSaved: () => void }) {
  const [f, setF] = useState({ everyMonths: '1', startOn: today(), ends: 'never' as 'never' | 'after', endsAfter: '12', mode: 'draft' as 'draft' | 'send', emailTo: '', message: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setErrors({}); setF((v) => ({ ...v, startOn: today(), emailTo: v.emailTo || suggestedTo.join(', ') })); } }, [open, suggestedTo]);
  const save = async () => {
    setBusy(true); setErrors({});
    try {
      await api.post('/recurring-invoices', {
        sourceId: docId, everyMonths: Number(f.everyMonths), startOn: f.startOn, endsAfter: f.ends === 'after' ? Number(f.endsAfter) : null, mode: f.mode,
        emailTo: f.mode === 'send' ? f.emailTo.split(/[\s,;]+/).filter(Boolean) : [], message: f.message,
      });
      onSaved(); onOpenChange(false); toast.success('Repeating invoice set up');
    } catch (e) {
      if (e instanceof ApiError && e.fields) setErrors(Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k.split('.')[0], v])));
      toast.error(errorMessage(e));
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Repeat this invoice"
      description="On each date, a new invoice is made with the same items and customer."
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Set up'}</Button></>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="How often" htmlFor="rp-every"><Select id="rp-every" value={f.everyMonths} onChange={(e) => setF({ ...f, everyMonths: e.target.value })}>
            {[1, 2, 3, 6, 12].map((n) => <option key={n} value={n}>{everyLabel(n)}</option>)}</Select></Field>
          <Field label="First invoice on" htmlFor="rp-start" error={errors.startOn}><Input id="rp-start" type="date" min={today()} value={f.startOn} onChange={(e) => setF({ ...f, startOn: e.target.value })} /></Field>
          <Field label="Ends" htmlFor="rp-ends"><Select id="rp-ends" value={f.ends} onChange={(e) => setF({ ...f, ends: e.target.value as 'never' | 'after' })}><option value="never">Never (until stopped)</option><option value="after">After a number of invoices</option></Select></Field>
          {f.ends === 'after' && <Field label="Number of invoices" htmlFor="rp-n" error={errors.endsAfter}><Input id="rp-n" type="number" min={1} max={120} value={f.endsAfter} onChange={(e) => setF({ ...f, endsAfter: e.target.value })} /></Field>}
        </div>
        <Field label="Each new invoice" htmlFor="rp-mode"><Select id="rp-mode" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as 'draft' | 'send' })}>
          <option value="draft">Is saved as a draft for me to check and send</option><option value="send">Is sent by email right away</option></Select></Field>
        {f.mode === 'send' && <>
          <Field label="Send to" htmlFor="rp-to" required hint="Separate several addresses with commas" error={errors.emailTo}><Input id="rp-to" type="email" multiple value={f.emailTo} onChange={(e) => setF({ ...f, emailTo: e.target.value })} /></Field>
          <Field label="Message (optional)" htmlFor="rp-msg" hint="Leave empty for a short standard message with the due date"><Textarea id="rp-msg" rows={3} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
        </>}
      </div>
    </Dialog>
  );
}

function StatusBadge({ s }: { s: Schedule }) {
  return s.status === 'active' ? <Badge tone="green">Active</Badge> : s.status === 'paused' ? <Badge tone="amber">Paused</Badge> : <Badge>Ended</Badge>;
}

function useScheduleActions(onChange: () => void) {
  const [busy, setBusy] = useState<number | null>(null);
  const set = async (s: Schedule, status: Schedule['status']) => {
    setBusy(s.id);
    try { await api.patch(`/recurring-invoices/${s.id}`, { status }); onChange(); toast.success(status === 'active' ? 'Resumed' : status === 'paused' ? 'Paused' : 'Stopped'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  return { busy, set };
}

function ScheduleLine({ s, canEdit, actions, showDeal }: { s: Schedule; canEdit: boolean; actions: ReturnType<typeof useScheduleActions>; showDeal?: boolean }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 px-4 py-3 text-sm">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2 font-medium">{everyLabel(s.everyMonths)}{s.amount ? <span className="tabular">· {money(s.amount, s.currency)}</span> : null}<StatusBadge s={s} /></div>
        {showDeal && <Link className="block truncate text-brand-600 hover:underline dark:text-brand-200" to={`/deals/${s.dealId}`}>{s.dealTitle}</Link>}
        <div className="text-xs text-muted">
          {s.status === 'active' ? `Next on ${dateOnly(s.nextRun)}` : s.status === 'paused' ? 'Paused' : 'Finished'}
          {' · '}{s.mode === 'send' ? `sent to ${s.emailTo.join(', ')}` : 'saved as a draft'}
          {' · '}{s.runs} made{s.endsAfter ? ` of ${s.endsAfter}` : ''}
          {s.lastDocumentId && s.lastNumber ? <> · last <Link className="text-brand-600 hover:underline dark:text-brand-200" to={`/documents/${s.lastDocumentId}`}>{s.lastNumber}</Link></> : null}
        </div>
        {s.lastError && <p className="text-xs text-rose-600" role="alert">{s.lastError}</p>}
      </div>
      {canEdit && s.status !== 'ended' && (
        <div className="flex shrink-0 gap-1">
          {s.status === 'active'
            ? <Button size="sm" disabled={actions.busy === s.id} onClick={() => actions.set(s, 'paused')}>Pause</Button>
            : <Button size="sm" disabled={actions.busy === s.id} onClick={() => actions.set(s, 'active')}>Resume</Button>}
          <Button size="sm" variant="ghost" disabled={actions.busy === s.id} onClick={() => actions.set(s, 'ended')}>Stop</Button>
        </div>
      )}
    </li>
  );
}

/** On an invoice: the schedules made from it. Nothing when there are none. */
export function RepeatsCard({ docId, canEdit }: { docId: number; canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['recurring', 'source', docId], queryFn: () => api.get<{ data: Schedule[] }>(`/recurring-invoices?sourceId=${docId}`) });
  const actions = useScheduleActions(() => qc.invalidateQueries({ queryKey: ['recurring'] }));
  if (q.isLoading || q.isError || !q.data?.data.length) return null;
  return (
    <Card title={<span className="flex items-center gap-1.5"><Repeat className="size-4 text-muted" />Repeats</span>} padded={false}>
      <ul className="divide-y divide-[var(--border)]">{q.data.data.map((s) => <ScheduleLine key={s.id} s={s} canEdit={canEdit && s.canEdit !== false} actions={actions} />)}</ul>
    </Card>
  );
}

/** Quotes & invoices → Recurring: every schedule the user may see. */
export function RecurringList() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['recurring', 'all'], queryFn: () => api.get<{ data: Schedule[] }>('/recurring-invoices') });
  const actions = useScheduleActions(() => qc.invalidateQueries({ queryKey: ['recurring'] }));
  if (q.isLoading) return <Card><Skeleton className="h-24" /></Card>;
  if (q.isError) return <Card><ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /></Card>;
  if (!q.data!.data.length) return <Card><EmptyState icon={<Repeat className="size-5" />} title="No repeating invoices" description="Open an invoice and choose “Repeat…” to bill a customer every month, quarter or year." /></Card>;
  return <Card padded={false}><ul className="divide-y divide-[var(--border)]">{q.data!.data.map((s) => <ScheduleLine key={s.id} s={s} canEdit={!!s.canEdit} actions={actions} showDeal />)}</ul></Card>;
}
