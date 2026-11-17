import { Link } from 'react-router';
import { relative } from '../../lib/format.ts';
import { useCan } from '../../lib/hooks.ts';
import { Card } from '../../components/ui/primitives.tsx';
import { FeedList, useFeed } from '../../components/ui/FeedList.tsx';
import { ChannelIcon } from './InboxPage.tsx';

interface Item { id: number; channelKind: 'webchat' | 'telegram_bot'; title: string; status: string; lastMessageAt: string; lastMessagePreview: string; unread: number }

/** "Conversations" card on contact and lead pages: Inbox conversations linked to the record (open and closed). */
export function LinkedConversations({ contactId, leadId }: { contactId?: number; leadId?: number }) {
  const can = useCan();
  const enabled = can('conversation', 'view');
  const feed = useFeed<Item>(['inbox', 'linked'], '/inbox/conversations',
    { status: 'all', ...(contactId ? { contactId } : { leadId }) }, { enabled, limit: 10 });
  // Nothing linked: no empty card on the record page.
  if (!enabled || (feed.isSuccess && feed.items.length === 0)) return null;
  return (
    <Card title="Conversations" padded={false}>
      <FeedList feed={feed} skeletonRows={1} empty={{ title: 'No conversations' }} label="Linked conversations">
        {(items) => items.map((c) => (
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
      </FeedList>
    </Card>
  );
}
