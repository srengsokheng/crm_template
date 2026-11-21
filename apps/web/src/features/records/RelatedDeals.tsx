import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, errorMessage, qsOf } from '../../lib/api.ts';
import { money } from '../../lib/format.ts';
import { useMe } from '../../lib/hooks.ts';
import type { ListResponse } from '../../lib/types.ts';
import { Badge, Button, Card } from '../../components/ui/primitives.tsx';
import { StageBadge } from '../../components/ui/StageBadge.tsx';

export interface RelatedDeal { id: number; title: string; amount: string; currency: string; status: string; stageName: string; stageColor: string }

/** Same page size as the API's inline list (RELATED_DEALS_INLINE): page 2 of the deals list continues where it stops. */
const PAGE = 10;

/**
 * Deals of a contact or company: the first 10 come with the record; "Load more" pages through the deals list (same
 * permissions), and the title shows how many there are in all.
 */
export function RelatedDeals({ deals, total, filter, onAdd }: {
  deals: RelatedDeal[]; total: number; filter: { contactId: number } | { companyId: number }; onAdd?: () => void;
}) {
  const { data: me } = useMe();
  const key = JSON.stringify(filter);
  // Pages loaded beyond the first, for this record only (reset when the page shows another record).
  const [loaded, setLoaded] = useState<{ key: string; rows: RelatedDeal[]; pages: number }>({ key, rows: [], pages: 1 });
  const extra = loaded.key === key ? loaded.rows : [];
  const pages = loaded.key === key ? loaded.pages : 1;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = [...deals, ...extra.filter((d) => !deals.some((x) => x.id === d.id))];
  // The open pipeline over all of them, in the workspace's base currency (not just the ones shown).
  const open = useQuery({
    queryKey: ['related-deals-open', filter, total], enabled: total > 0,
    queryFn: () => api.get<ListResponse<RelatedDeal>>(`/deals${qsOf({ ...filter, status: 'open', pageSize: 1 })}`),
  });
  const loadMore = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = pages + 1;
      const r = await api.get<ListResponse<RelatedDeal>>(`/deals${qsOf({ ...filter, sort: '-createdAt', page: next, pageSize: PAGE })}`);
      setLoaded({ key, rows: [...extra, ...r.data], pages: next });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  const openTotal = open.data?.total ?? 0;
  return (
    <Card title={`Deals (${total})`} padded={false} actions={onAdd && <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={onAdd}>Add</Button>}>
      {shown.length ? (
        <ul className="divide-y divide-[var(--border)]">
          {shown.map((d) => (
            <li key={d.id}>
              <Link to={`/deals/${d.id}`} className="flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-[var(--surface-2)]/60">
                <div className="min-w-0"><div className="truncate text-sm font-medium">{d.title}</div><div className="mt-0.5"><StageBadge name={d.stageName} color={d.stageColor} /></div></div>
                <div className="text-right text-sm tabular">{money(d.amount, d.currency)}{d.status !== 'open' && <div><Badge tone={d.status === 'won' ? 'green' : 'red'}>{d.status}</Badge></div>}</div>
              </Link>
            </li>
          ))}
          {total > shown.length && (
            <li className="px-4 py-2">
              <Button size="sm" variant="ghost" className="w-full" loading={loading} onClick={loadMore}>
                Load more <span className="text-muted">· {total - shown.length} more</span>
              </Button>
              {error && <p role="alert" className="mt-1 text-center text-xs text-rose-600">{error}</p>}
            </li>
          )}
          {openTotal > 0 && open.data?.aggregates && (
            <li className="flex justify-between px-4 py-2 text-xs text-muted">
              <span>Open pipeline ({openTotal})</span><span className="tabular">{money(open.data.aggregates.amountSum, me?.workspace.baseCurrency ?? 'USD')}</span>
            </li>
          )}
        </ul>
      ) : <p className="px-4 py-4 text-sm text-muted">No deals yet.</p>}
    </Card>
  );
}
