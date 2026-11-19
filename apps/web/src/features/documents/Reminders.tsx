import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../../lib/api.ts';
import { dateTime, money } from '../../lib/format.ts';
import { useMe } from '../../lib/hooks.ts';
import { Button, Card, Checkbox, ErrorState, Skeleton } from '../../components/ui/primitives.tsx';
import { dateOnly } from './common.tsx';

interface Status {
  enabled: boolean; off: boolean; owed: boolean; emailTo: string[]; chats: number; telegram: boolean;
  next: { step: string; date: string; label: string } | null;
  sent: { id: number; step: string; sentTo: string[]; chats: number; balance: string; sentAt: string; sentByName: string | null }[];
}

export const stepLabel = (step: string) => {
  if (step.startsWith('manual:')) return 'Sent by hand';
  if (step === 'due') return 'On the due date';
  const [k, n] = step.split(':');
  return k === 'before' ? `${n} day${n === '1' ? '' : 's'} before the due date` : `${n} day${n === '1' ? '' : 's'} overdue`;
};

/** "Payment reminders" card on a sent invoice: what's next, who gets it, what went out; send one now; turn off for it. */
export function RemindersCard({ docId, canEdit, currency }: { docId: number; canEdit: boolean; currency: string }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const q = useQuery({ queryKey: ['reminders', docId], queryFn: () => api.get<Status>(`/documents/${docId}/reminders`) });
  const [busy, setBusy] = useState<'' | 'send' | 'off'>('');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['reminders', docId] }); qc.invalidateQueries({ queryKey: ['timeline'] }); };
  if (q.isLoading) return <Card title="Payment reminders"><Skeleton className="h-16" /></Card>;
  if (q.isError) return <Card title="Payment reminders"><ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /></Card>;
  const s = q.data!;
  if (!s.owed && !s.sent.length) return null;
  const nobody = !s.emailTo.length && !s.chats;
  const sendNow = async () => {
    setBusy('send');
    try { await api.post(`/documents/${docId}/remind`); toast.success('Reminder sent'); refresh(); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(''); }
  };
  const setOff = async (off: boolean) => {
    setBusy('off');
    qc.setQueryData<Status>(['reminders', docId], (v) => (v ? { ...v, off } : v)); // the box follows the click at once
    try { await api.post(`/documents/${docId}/reminders`, { off }); refresh(); }
    catch (e) { qc.setQueryData<Status>(['reminders', docId], (v) => (v ? { ...v, off: !off } : v)); toast.error(errorMessage(e)); }
    finally { setBusy(''); }
  };
  return (
    <Card title={<span className="inline-flex items-center gap-1.5"><BellRing className="size-4" aria-hidden="true" />Payment reminders</span>}
      actions={s.owed && canEdit && <Button size="sm" disabled={!!busy || nobody} onClick={sendNow}>{busy === 'send' ? 'Sending…' : 'Send reminder now'}</Button>}>
      <div className="space-y-3 text-sm">
        {s.owed && (
          <div className="space-y-1">
            {!s.enabled ? (
              <p className="text-muted">Automatic reminders are off for the workspace.{' '}
                {me?.role.isAdmin && <Link className="text-brand-600 underline underline-offset-2 dark:text-brand-200" to="/settings/documents">Turn them on</Link>}</p>
            ) : s.off ? <p className="text-muted">No automatic reminders for this invoice.</p>
              : nobody ? <p className="text-amber-700 dark:text-amber-300">Nobody to remind yet: email the invoice to the customer, or link their Telegram chat to a contact on the deal.</p>
              : s.next ? <p>Next: <span className="font-medium">{dateOnly(s.next.date)}</span> <span className="text-muted">({s.next.label})</span></p>
              : <p className="text-muted">No more automatic reminders are planned.</p>}
            {!nobody && <p className="break-words text-xs text-muted">To {[...s.emailTo, ...(s.chats && s.telegram ? [`${s.chats} Telegram chat${s.chats === 1 ? '' : 's'}`] : [])].join(', ')}</p>}
            {s.enabled && canEdit && <Checkbox checked={s.off} disabled={!!busy} onChange={(v) => void setOff(v)} label="Don’t remind for this invoice" />}
          </div>
        )}
        {s.sent.length > 0 && (
          <div className={s.owed ? 'border-t border-base pt-3' : ''}>
            <h3 className="mb-1.5 text-xs font-semibold text-muted">Sent</h3>
            <ul className="space-y-1.5" aria-label="Reminders sent">
              {s.sent.map((r) => (
                <li key={r.id}>
                  <p>{stepLabel(r.step)}{r.sentByName ? ` by ${r.sentByName}` : ''} <span className="text-muted">· {dateTime(r.sentAt)}</span></p>
                  <p className="break-words text-xs text-muted">{money(r.balance, currency)} due · {[...r.sentTo, ...(r.chats ? [`${r.chats} Telegram chat${r.chats === 1 ? '' : 's'}`] : [])].join(', ')}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
