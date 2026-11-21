import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { RotateCcw, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { relative } from '../../lib/format.ts';
import { Badge, Button, Card } from '../../components/ui/primitives.tsx';
import { FeedList, useFeed } from '../../components/ui/FeedList.tsx';

const LABEL: Record<string, string> = { leads: 'Lead', deals: 'Deal', contacts: 'Contact', companies: 'Company', products: 'Product' };
interface Deleted { id: number; entity: string; title: string; deletedAt: string; deletedByName: string | null }

export function RecycleBin() {
  const qc = useQueryClient();
  const feed = useFeed<Deleted>(['recycle-bin'], '/recycle-bin');
  const retention = (feed.data?.pages[0] as { retentionDays?: number } | undefined)?.retentionDays ?? 30;
  const restore = async (entity: string, id: number) => {
    try { await api.post(`/${entity}/${id}/restore`); qc.invalidateQueries(); toast.success(`${LABEL[entity]} restored`); } catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <Card title="Recycle bin" padded={false}>
      <p className="border-b border-base px-4 py-2.5 text-[13px] text-muted">Deleted records stay here for {retention} days. Restoring keeps all links and history.</p>
      <FeedList feed={feed} label="Deleted records" empty={{ icon: <Trash2 className="size-5" />, title: 'The recycle bin is empty', description: 'Records you delete appear here, so you can restore them.' }}>
        {(items) => items.map((r) => (
          <li key={`${r.entity}-${r.id}`} className="flex items-center gap-3 px-4 py-2.5">
            <Badge>{LABEL[r.entity]}</Badge>
            <div className="min-w-0 flex-1"><div className="truncate font-medium">{r.title || 'Untitled'}</div><div className="text-xs text-muted">Deleted {relative(r.deletedAt)}{r.deletedByName ? ` by ${r.deletedByName}` : ''}</div></div>
            <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => restore(r.entity, r.id)}>Restore</Button>
          </li>
        ))}
      </FeedList>
    </Card>
  );
}
