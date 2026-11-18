import { Badge } from '../../components/ui/primitives.tsx';
import type { LineItem } from '../../lib/types.ts';

export type DocKind = 'quote' | 'invoice';
export interface DocSummary { id: number; kind: DocKind; number: string | null; status: string; currency: string; total: string; issueDate: string | null; dueDate: string | null; createdAt: string; sourceQuoteId: number | null; paidAmount?: string; overdue?: boolean }
export interface DocFull extends DocSummary {
  dealId: number; dealTitle: string; canEdit: boolean; billToName: string; billToDetails: string; notes: string;
  listTotal: string; discount: string; tax: string; items: (LineItem & { id: number })[];
  paidAmount: string; balance: string; customerUrl: string | null; viewedAt: string | null; respondedByName: string | null; customerNote: string | null; lastEmailedAt: string | null; suggestedRecipients: string[];
  payments: { id: number; amount: string; paidOn: string; method: string; note: string; createdByName: string | null }[];
}

const TONES: Record<string, 'slate' | 'blue' | 'green' | 'red' | 'amber'> = { draft: 'slate', sent: 'blue', accepted: 'green', paid: 'green', declined: 'red', void: 'red' };
export const kindLabel = (k: DocKind) => (k === 'quote' ? 'Quote' : 'Invoice');
export const docTitle = (d: Pick<DocSummary, 'kind' | 'number'>) => (d.number ? `${kindLabel(d.kind)} ${d.number}` : kindLabel(d.kind));
/** "2026-11-16" → shown in the local calendar (no timezone shift). */
export const dateOnly = (v: string | null) => (v ? new Date(`${v.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

/** Status badge; sent invoices also show "Overdue" / "Partially paid". */
export function DocStatus({ status, paidAmount, overdue }: { status: string; paidAmount?: string | null; overdue?: boolean }) {
  if (status === 'sent' && overdue) return <Badge tone="red">Overdue</Badge>;
  if (status === 'sent' && paidAmount && Number(paidAmount) > 0) return <Badge tone="amber">Partially paid</Badge>;
  return <Badge tone={TONES[status] ?? 'slate'}>{status.charAt(0).toUpperCase() + status.slice(1)}</Badge>;
}
