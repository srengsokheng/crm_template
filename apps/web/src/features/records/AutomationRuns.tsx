import { Bot } from 'lucide-react';
import { dateTime, relative } from '../../lib/format.ts';
import { cn } from '../../lib/cn.ts';
import { Badge, Card } from '../../components/ui/primitives.tsx';
import { FeedList, useFeed } from '../../components/ui/FeedList.tsx';

interface Run { id: number; status: 'scheduled' | 'success' | 'skipped' | 'failed'; scheduledFor: string; finishedAt: string | null; message: string | null; action: string | null; trigger: string | null; stageName: string | null }

const ACTIONS: Record<string, string> = { create_activity: 'Create an activity', notify: 'Send a notification', add_note: 'Add a note', update_field: 'Update a field', assign_owner: 'Assign an owner', move_stage: 'Move to another stage', webhook: 'Call a webhook' };
const STATUS: Record<Run['status'], { label: string; tone: 'green' | 'amber' | 'red' | 'slate' }> = {
  success: { label: 'Done', tone: 'green' }, scheduled: { label: 'Scheduled', tone: 'amber' }, skipped: { label: 'Skipped', tone: 'slate' }, failed: { label: 'Failed', tone: 'red' },
};

/** "Automation" card on deal and lead pages: what rules did on this record (or will do), with failures explained. */
export function AutomationRuns({ type, id }: { type: 'deal' | 'lead'; id: number }) {
  const feed = useFeed<Run>(['automation-runs', type, id], `/automation-runs/${type}/${id}`);
  // Nothing ran on this record: no empty card.
  if (feed.isSuccess && feed.items.length === 0) return null;
  return (
    <Card title={<span className="flex items-center gap-1.5"><Bot className="size-4 text-muted" />Automation</span>} padded={false}>
      <FeedList feed={feed} skeletonRows={1} empty={{ title: 'Nothing has run yet' }} label="Automation runs">
        {(items) => items.map((r) => (
          <li key={r.id} className="flex items-start gap-3 px-4 py-2.5">
            <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{r.action ? ACTIONS[r.action] ?? r.action : 'Deleted rule'}
                {r.trigger === 'stage_entered' && r.stageName && <span className="font-normal text-muted"> · on entering {r.stageName}</span>}
                {r.trigger === 'created' && <span className="font-normal text-muted"> · when created</span>}
              </div>
              {r.message && <div className={cn('text-xs', r.status === 'failed' ? 'text-rose-600' : 'text-muted')}>{r.message}</div>}
            </div>
            <span className="shrink-0 text-[11px] text-muted" title={dateTime(r.finishedAt ?? r.scheduledFor)}>
              {r.status === 'scheduled' ? `due ${relative(r.scheduledFor)}` : relative(r.finishedAt ?? r.scheduledFor)}
            </span>
          </li>
        ))}
      </FeedList>
    </Card>
  );
}
