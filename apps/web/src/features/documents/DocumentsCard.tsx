import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText, Plus } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { money } from '../../lib/format.ts';
import { Button, Card, ErrorState, Skeleton } from '../../components/ui/primitives.tsx';
import { dateOnly, DocStatus, docTitle, type DocKind, type DocSummary } from './common.tsx';

/** Quotes and invoices of a deal, on the deal page. */
export function DocumentsCard({ dealId, canEdit }: { dealId: number; canEdit: boolean }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['documents', dealId], queryFn: () => api.get<{ data: DocSummary[] }>(`/deals/${dealId}/documents`) });
  const [creating, setCreating] = useState<DocKind | null>(null);
  const create = async (kind: DocKind) => {
    setCreating(kind);
    try {
      const doc = await api.post<{ id: number }>(`/deals/${dealId}/documents`, { kind });
      navigate(`/documents/${doc.id}`);
    } catch (e) { toast.error(errorMessage(e)); setCreating(null); }
  };
  const docs = q.data?.data ?? [];
  return (
    <Card padded={false} title={`Quotes & invoices (${docs.length})`}
      actions={canEdit && <div className="flex gap-1">
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} loading={creating === 'quote'} disabled={!!creating} onClick={() => create('quote')}>Quote</Button>
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} loading={creating === 'invoice'} disabled={!!creating} onClick={() => create('invoice')}>Invoice</Button>
      </div>}>
      {q.isLoading ? <div className="space-y-2 p-4"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
        : q.error ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        : !docs.length ? <p className="px-4 py-4 text-sm text-muted">{canEdit ? 'No quotes or invoices yet. A new one starts with the deal’s products.' : 'No quotes or invoices.'}</p>
        : (
          <ul className="divide-y divide-[var(--border)]">
            {docs.map((d) => (
              <li key={d.id}>
                <Link to={`/documents/${d.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-[var(--surface-2)]">
                  <FileText className="size-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{docTitle(d)}</div>
                    <div className="truncate text-xs text-muted">{d.issueDate ? `Issued ${dateOnly(d.issueDate)}` : 'Not sent yet'}{d.dueDate ? ` · ${d.kind === 'quote' ? 'valid until' : 'due'} ${dateOnly(d.dueDate)}` : ''}</div>
                  </div>
                  <span className="font-medium tabular">{money(d.total, d.currency)}</span>
                  <DocStatus status={d.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
    </Card>
  );
}
