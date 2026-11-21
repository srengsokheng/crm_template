import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../../lib/api.ts';
import { relative } from '../../lib/format.ts';
import { Button, Card, ErrorState, Skeleton } from '../../components/ui/primitives.tsx';
import { QrSvg } from '../documents/Khqr.tsx';

interface State { available: boolean; botUsername: string | null; linked: { tgName: string; linkedAt: string } | null }

/** Your account → Telegram notifications: get CRM notifications in Telegram, through the workspace's bot. */
export function TelegramAlertsCard() {
  const qc = useQueryClient();
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // While a link is open, check every few seconds whether it was used in Telegram.
  const q = useQuery({ queryKey: ['account-telegram'], queryFn: () => api.get<State>('/account/telegram'), refetchInterval: link ? 3000 : false });
  const s = q.data;
  useEffect(() => { if (s?.linked) setLink(null); }, [s?.linked]);
  const connect = async () => {
    setBusy(true);
    try { setLink(await api.post('/account/telegram/link')); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const disconnect = async () => {
    setBusy(true);
    try { await api.del('/account/telegram'); await qc.invalidateQueries({ queryKey: ['account-telegram'] }); toast.success('Telegram notifications turned off'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Card title={<span className="flex items-center gap-1.5"><Send className="size-4 text-muted" />Telegram notifications</span>}>
      {q.isLoading ? <Skeleton className="h-16" /> : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : !s!.available ? (
        <p className="text-sm text-muted">Get your CRM notifications — new chats, quotes accepted, reminders — in Telegram. An admin first needs to connect a Telegram bot in Settings → Channels.</p>
      ) : s!.linked ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p>Notifications go to <span className="font-medium">{s!.linked.tgName || 'your Telegram'}</span> through @{s!.botUsername} <span className="text-muted">(connected {relative(s!.linked.linkedAt)})</span>.</p>
          <Button disabled={busy} onClick={disconnect}>Turn off</Button>
        </div>
      ) : link ? (
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <QrSvg text={link.url} label="QR code to open the CRM bot in Telegram" className="size-32 shrink-0 rounded-md border border-base" />
          <div className="min-w-0 space-y-2">
            <p>Open <span className="font-medium">@{s!.botUsername}</span> in Telegram and tap <span className="font-medium">Start</span>. On a computer, scan the code with your phone.</p>
            <a className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3 font-medium text-white hover:bg-brand-700" href={link.url} target="_blank" rel="noopener noreferrer"><Send className="size-4" />Open Telegram</a>
            <p className="text-xs text-muted" role="status">Waiting for you to tap Start… The link works once, for 15 minutes.</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-muted">Get your CRM notifications — new chats assigned to you, quotes accepted, reminders — in Telegram, from @{s!.botUsername}.</p>
          <Button variant="primary" disabled={busy} onClick={connect}>Connect Telegram</Button>
        </div>
      )}
    </Card>
  );
}
