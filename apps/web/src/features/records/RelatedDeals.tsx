import { Link } from 'react-router';
import { Plus } from 'lucide-react';
import { money } from '../../lib/format.ts';
import { Badge, Button, Card } from '../../components/ui/primitives.tsx';
import { StageBadge } from '../../components/ui/StageBadge.tsx';

export interface RelatedDeal { id: number; title: string; amount: string; currency: string; status: string; stageName: string; stageColor: string }
export function RelatedDeals({ deals, onAdd }: { deals: RelatedDeal[]; onAdd?: () => void }) {
  const open = deals.filter((d) => d.status === 'open');
  const total = open.reduce((a, d) => a + Number(d.amount), 0);
  return (
    <Card title={`Deals (${deals.length})`} padded={false} actions={onAdd && <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={onAdd}>Add</Button>}>
      {deals.length ? (
        <ul className="divide-y divide-[var(--border)]">
          {deals.map((d) => (
            <li key={d.id}>
              <Link to={`/deals/${d.id}`} className="flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-[var(--surface-2)]/60">
                <div className="min-w-0"><div className="truncate text-sm font-medium">{d.title}</div><div className="mt-0.5"><StageBadge name={d.stageName} color={d.stageColor} /></div></div>
                <div className="text-right text-sm tabular">{money(d.amount, d.currency)}{d.status !== 'open' && <div><Badge tone={d.status === 'won' ? 'green' : 'red'}>{d.status}</Badge></div>}</div>
              </Link>
            </li>
          ))}
          {open.length > 0 && <li className="flex justify-between px-4 py-2 text-xs text-muted"><span>Open pipeline</span><span className="tabular">{money(total, deals[0].currency)}</span></li>}
        </ul>
      ) : <p className="px-4 py-4 text-sm text-muted">No deals yet.</p>}
    </Card>
  );
}
