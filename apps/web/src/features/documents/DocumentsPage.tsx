import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { api, errorMessage, qsOf } from '../../lib/api.ts';
import { money } from '../../lib/format.ts';
import { Card, EmptyState, PageHeader, Segmented } from '../../components/ui/primitives.tsx';
import { DataTable, Pagination, type Column } from '../../components/ui/DataTable.tsx';
import { SearchBox, Toolbar, useListParams } from '../records/list.tsx';
import { dateOnly, DocStatus, docTitle, type DocKind } from './common.tsx';

interface Row {
  id: number; kind: DocKind; number: string | null; status: string; currency: string; total: string; paidAmount: string; balance: string;
  issueDate: string | null; dueDate: string | null; billToName: string; dealId: number; dealTitle: string; overdue: boolean; lastEmailedAt: string | null;
}
interface ListRes { data: Row[]; page: number; pageSize: number; total: number; baseCurrency: string; totals: { outstanding: string; overdue: string; overdueCount: number; missingRates: string[] } }

/** Filter tabs → query parameters. */
const VIEWS: Record<string, { label: string; params: Record<string, string> }> = {
  all: { label: 'All', params: {} },
  unpaid: { label: 'Unpaid', params: { kind: 'invoice', status: 'unpaid' } },
  overdue: { label: 'Overdue', params: { kind: 'invoice', status: 'overdue' } },
  paid: { label: 'Paid', params: { kind: 'invoice', status: 'paid' } },
  quotes: { label: 'Quotes', params: { kind: 'quote' } },
  drafts: { label: 'Drafts', params: { status: 'draft' } },
};

/** Every quote and invoice the user can see (through their deals), with money still owed. */
export function DocumentsPage() {
  const nav = useNavigate();
  const lp = useListParams({ sort: '-createdAt' });
  const view = VIEWS[lp.get('view')] ? lp.get('view') : 'all';
  const params = { ...lp.params, view: undefined, ...VIEWS[view].params };
  const q = useQuery({ queryKey: ['documents-list', params], queryFn: () => api.get<ListRes>(`/documents${qsOf(params)}`), placeholderData: keepPreviousData });
  const t = q.data?.totals;
  const base = q.data?.baseCurrency ?? 'USD';
  const cols: Column<Row>[] = [
    { key: 'number', header: 'Document', sortKey: 'number', cell: (r) => (
      <div>
        <div className="font-medium">{docTitle(r)}</div>
        <div className="truncate text-xs text-muted">{r.dealTitle}</div>
        {/* Phones: the amount and status columns are hidden, so show them here. */}
        <div className="mt-1 flex flex-wrap items-center gap-2 md:hidden">
          <span className="text-[13px] font-medium tabular">{r.kind === 'invoice' && r.status === 'sent' ? `${money(r.balance, r.currency)} due` : money(r.total, r.currency)}</span>
          <DocStatus status={r.status} paidAmount={r.paidAmount} overdue={r.overdue} />
        </div>
      </div>
    ) },
    { key: 'billTo', header: 'Customer', sortKey: 'billTo', hideOnMobile: true, cell: (r) => r.billToName || <span className="text-muted">—</span> },
    { key: 'due', header: 'Due / valid until', sortKey: 'dueDate', hideOnMobile: true, cell: (r) => <span className={r.overdue ? 'font-medium text-rose-600 dark:text-rose-300' : ''}>{dateOnly(r.dueDate)}</span> },
    { key: 'total', header: 'Total', sortKey: 'total', align: 'right', hideOnMobile: true, cell: (r) => <span className="tabular">{money(r.total, r.currency)}</span> },
    { key: 'balance', header: 'Balance', sortKey: 'balance', align: 'right', hideOnMobile: true,
      cell: (r) => (r.kind === 'invoice' && r.status === 'sent' ? <span className="font-medium tabular">{money(r.balance, r.currency)}</span> : <span className="text-muted">—</span>) },
    { key: 'status', header: 'Status', hideOnMobile: true, cell: (r) => <DocStatus status={r.status} paidAmount={r.paidAmount} overdue={r.overdue} /> },
  ];
  return (
    <div>
      <PageHeader title="Quotes & invoices" subtitle="Everything you've quoted and billed, across all deals. New ones are created from a deal." />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Kpi label="Outstanding" value={t ? money(t.outstanding, base) : '…'} hint="Unpaid balance of sent invoices" />
        <Kpi label="Overdue" value={t ? money(t.overdue, base) : '…'} hint={t ? `${t.overdueCount} ${t.overdueCount === 1 ? 'invoice' : 'invoices'} past the due date` : ''} tone={t && t.overdueCount > 0 ? 'red' : undefined} />
        <Kpi label="Shown" value={q.data ? String(q.data.total) : '…'} hint={VIEWS[view].label === 'All' ? 'Quotes and invoices' : VIEWS[view].label} />
      </div>
      {t && t.missingRates.length > 0 && (
        <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          Amounts in {t.missingRates.join(', ')} aren’t in these totals yet — add an exchange rate in Settings → Currencies.
        </p>
      )}
      <Toolbar right={<Segmented size="sm" value={view} onChange={(v) => lp.set({ view: v === 'all' ? '' : v, page: '' })} options={Object.entries(VIEWS).map(([value, v]) => ({ value, label: v.label }))} />}>
        <SearchBox value={lp.get('q')} onChange={(v) => lp.set({ q: v })} placeholder="Search number, customer or deal" />
      </Toolbar>
      <DataTable columns={cols} rows={q.data?.data ?? []} loading={q.isLoading} error={q.error ? errorMessage(q.error) : null} onRetry={() => q.refetch()}
        sort={lp.sort} onSort={(s) => lp.set({ sort: s })} onRowClick={(r) => nav(`/documents/${r.id}`)}
        empty={<EmptyState icon={<FileText className="size-5" />} title={view === 'all' ? 'No quotes or invoices yet' : `Nothing ${VIEWS[view].label.toLowerCase()}`}
          description={view === 'all' ? 'Open a deal and use “Quote” or “Invoice” in its Quotes & invoices card.' : undefined} />} />
      {q.data && q.data.total > q.data.pageSize && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={(p) => lp.set({ page: String(p) })} />}
    </div>
  );
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: 'red' }) {
  return (
    <Card>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular ${tone === 'red' ? 'text-rose-600 dark:text-rose-300' : ''}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </Card>
  );
}
