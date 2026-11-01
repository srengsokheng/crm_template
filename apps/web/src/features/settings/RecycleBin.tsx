import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { RotateCcw, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { relative } from '../../lib/format.ts';
import { Badge, Button, Card, EmptyState, Skeleton } from '../../components/ui/primitives.tsx';

const LABEL: Record<string, string> = { leads: 'Lead', deals: 'Deal', contacts: 'Contact', companies: 'Company', products: 'Product' };

export function RecycleBin() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['recycle-bin'], queryFn: () => api.get<{ retentionDays: number; data: { entity: string; id: number; title: string; deletedAt: string; deletedByName: string | null }[] }>('/recycle-bin') });
  const restore = async (entity: string, id: number) => {
    try { await api.post(`/${entity}/${id}/restore`); qc.invalidateQueries(); toast.success(`${LABEL[entity]} restored`); } catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <Card title="Recycle bin" padded={false}>
      <p className="border-b border-base px-4 py-2.5 text-[13px] text-muted">Deleted records stay here for {q.data?.retentionDays ?? 30} days. Restoring keeps all links and history.</p>
      {q.isLoading ? <div className="p-4"><Skeleton className="h-24" /></div> : !q.data?.data.length ? <EmptyState icon={<Trash2 className="size-5" />} title="The recycle bin is empty" /> : (
        <ul className="divide-y divide-[var(--border)]">
          {q.data.data.map((r) => (
            <li key={`${r.entity}-${r.id}`} className="flex items-center gap-3 px-4 py-2.5">
              <Badge>{LABEL[r.entity]}</Badge>
              <div className="min-w-0 flex-1"><div className="truncate font-medium">{r.title || 'Untitled'}</div><div className="text-xs text-muted">Deleted {relative(r.deletedAt)}{r.deletedByName ? ` by ${r.deletedByName}` : ''}</div></div>
              <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => restore(r.entity, r.id)}>Restore</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
