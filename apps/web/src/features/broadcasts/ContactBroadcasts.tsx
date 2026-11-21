import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '../../lib/api.ts';
import { date } from '../../lib/format.ts';
import { useMe } from '../../lib/hooks.ts';
import { Badge, Button, Card, ErrorState, Skeleton } from '../../components/ui/primitives.tsx';
import { ConfirmDialog } from '../../components/ui/overlays.tsx';

interface Marketing {
  canEdit: boolean;
  email: { addresses: string[]; optedOutAt: string | null };
  chats: { id: number; channelKind: 'telegram_bot' | 'whatsapp'; channelName: string; title: string; optedOutAt: string | null; canEdit: boolean }[];
  received: { broadcastId: number; name: string; channelKind: string; sentAt: string | null; status: 'sent' | 'sending' | 'failed' | 'skipped' }[];
}
type Change = { kind: 'email' } | { kind: 'chat'; conversationId: number; label: string };

const CHANNEL: Record<string, string> = { telegram_bot: 'Telegram', whatsapp: 'WhatsApp', email: 'Email' };
const RECEIVED: Record<Marketing['received'][number]['status'], { label: string; tone: 'green' | 'amber' | 'red' | 'slate' }> = {
  sent: { label: 'Delivered', tone: 'green' }, sending: { label: 'Sending', tone: 'amber' }, failed: { label: 'Failed', tone: 'red' }, skipped: { label: 'Not sent', tone: 'slate' },
};

/** "Broadcasts" card on the contact page: do they get broadcasts, where they opted out, what they received. */
export function ContactBroadcasts({ contactId }: { contactId: number }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const q = useQuery({ queryKey: ['contact-marketing', contactId], queryFn: () => api.get<Marketing>(`/contacts/${contactId}/marketing`) });
  const [confirm, setConfirm] = useState<{ change: Change; optedOut: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <Card title="Broadcasts"><Skeleton className="h-16" /></Card>;
  if (q.isError) return <Card title="Broadcasts"><ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /></Card>;
  const m = q.data!;
  // Nothing to say: no email, no chat that broadcasts reach, nothing received.
  if (!m.email.addresses.length && !m.chats.length && !m.received.length && !m.email.optedOutAt) return null;

  const apply = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.change.kind === 'email') await api.post(`/contacts/${contactId}/email-opt-out`, { optedOut: confirm.optedOut });
      else await api.post(`/contacts/${contactId}/chat-opt-out`, { conversationId: confirm.change.conversationId, optedOut: confirm.optedOut });
      await qc.invalidateQueries({ queryKey: ['contact-marketing', contactId] });
      qc.invalidateQueries({ queryKey: ['timeline', 'contact', contactId] });
      toast.success(confirm.optedOut ? 'Opted out of broadcasts' : 'Gets broadcasts again');
      setConfirm(null);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const row = (key: string, label: string, detail: string, optedOutAt: string | null, change: Change, canEdit: boolean) => (
    <li key={key} className="flex items-start gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">{label}
          {optedOutAt ? <Badge tone="red">Opted out</Badge> : <Badge tone="green">Gets broadcasts</Badge>}</p>
        <p className="break-words text-xs text-muted">{detail}{optedOutAt ? ` · since ${date(optedOutAt)}` : ''}</p>
      </div>
      {canEdit && <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setConfirm({ change, optedOut: !optedOutAt })}>{optedOutAt ? 'Opt back in' : 'Opt out'}</Button>}
    </li>
  );
  const optingIn = confirm && !confirm.optedOut;
  const what = confirm?.change.kind === 'email' ? 'broadcast emails' : `broadcasts on ${confirm?.change.kind === 'chat' ? confirm.change.label : ''}`;
  return (
    <Card title="Broadcasts" padded={false}>
      <ul className="divide-y divide-[var(--border)]" aria-label="Broadcast opt-outs">
        {(m.email.addresses.length > 0 || m.email.optedOutAt) && row('email', 'Email', m.email.addresses.join(', ') || 'No email address yet', m.email.optedOutAt, { kind: 'email' }, m.canEdit)}
        {m.chats.map((c) => row(`chat-${c.id}`, `${CHANNEL[c.channelKind]} · ${c.channelName}`, c.title, c.optedOutAt,
          { kind: 'chat', conversationId: c.id, label: `${CHANNEL[c.channelKind]} (${c.channelName})` }, c.canEdit))}
      </ul>
      {m.received.length > 0 && (
        <div className="border-t border-base px-4 py-3">
          <h3 className="mb-1.5 text-xs font-semibold text-muted">Received</h3>
          <ul className="space-y-1.5" aria-label="Broadcasts received">
            {m.received.map((r, i) => (
              <li key={`${r.broadcastId}-${i}`} className="flex items-start gap-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{me?.role.isAdmin ? <Link className="hover:underline" to={`/broadcasts/${r.broadcastId}`}>{r.name}</Link> : r.name}</span>
                  <span className="block text-xs text-muted">{CHANNEL[r.channelKind] ?? r.channelKind}{r.sentAt ? ` · ${date(r.sentAt)}` : ''}</span>
                </span>
                <Badge tone={RECEIVED[r.status].tone}>{RECEIVED[r.status].label}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ConfirmDialog open={!!confirm} onOpenChange={(v) => { if (!v) setConfirm(null); }} loading={busy} onConfirm={() => void apply()}
        title={optingIn ? `Send ${what} again?` : `Stop ${what}?`} confirmLabel={optingIn ? 'Opt back in' : 'Opt out'} danger={!optingIn}
        description={optingIn
          ? 'Only do this if the customer asked for it. It’s recorded on the timeline.'
          : confirm?.change.kind === 'email' ? 'They won’t get broadcast emails at any of their addresses (also on other contacts with the same address). Invoices and normal emails still go out.' : 'They won’t get broadcasts in this chat. Normal replies still work.'} />
    </Card>
  );
}
