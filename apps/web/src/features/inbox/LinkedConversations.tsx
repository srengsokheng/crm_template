import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '../../lib/api.ts';
import { relative } from '../../lib/format.ts';
import { useCan } from '../../lib/hooks.ts';
import { Card, ErrorState, Skeleton } from '../../components/ui/primitives.tsx';
import { ChannelIcon } from './InboxPage.tsx';

interface Item { id: number; channelKind: 'webchat' | 'telegram_bot'; title: string; status: string; lastMessageAt: string; lastMessagePreview: string; unread: number }

/** "Conversations" card on contact and lead pages: Inbox conversations linked to the record (open and closed). */
export function LinkedConversations({ contactId, leadId }: { contactId?: number; leadId?: number }) {
  const can = useCan();
  const param = contactId ? `contactId=${contactId}` : `leadId=${leadId}`;
  const enabled = can('conversation', 'view');
  const open = useQuery({ queryKey: ['inbox', 'linked', param, 'open'], enabled, queryFn: () => api.get<{ data: Item[] }>(`/inbox/conversations?${param}&status=open`) });
  const closed = useQuery({ queryKey: ['inbox', 'linked', param, 'closed'], enabled, queryFn: () => api.get<{ data: Item[] }>(`/inbox/conversations?${param}&status=closed`) });
  if (!enabled) return null;
  const items = [...(open.data?.data ?? []), ...(closed.data?.data ?? [])];
  if (!open.isLoading && !closed.isLoading && !open.isError && !closed.isError && items.length === 0) return null; // nothing linked: no empty card
  return (
    <Card title={`Conversations${items.length ? ` (${items.length})` : ''}`} padded={false}>
      {open.isLoading || closed.isLoading ? <div className="p-4"><Skeleton className="h-10" /></div>
        : open.isError || closed.isError ? <ErrorState message={errorMessage(open.error ?? closed.error)} onRetry={() => { open.refetch(); closed.refetch(); }} />
        : (
          <ul className="divide-y divide-[var(--border)]">
            {items.map((c) => (
              <li key={c.id}>
                <Link to={`/inbox/${c.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--surface-2)]">
                  <ChannelIcon kind={c.channelKind} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{c.title}{c.status === 'closed' && <span className="ml-1.5 text-xs font-normal text-muted">closed</span>}</span>
                    <span className="block truncate text-xs text-muted">{c.lastMessagePreview}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted">{relative(c.lastMessageAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
    </Card>
  );
}
