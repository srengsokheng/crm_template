import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn.ts';
import { Checkbox, ErrorState, Skeleton } from './primitives.tsx';

export interface Column<T> {
  key: string; header: ReactNode; cell: (row: T) => ReactNode; sortKey?: string; className?: string; align?: 'right'; hideOnMobile?: boolean;
}

export function DataTable<T extends { id: number }>({ columns, rows, loading, error, onRetry, sort, onSort, onRowClick, selected, onSelect, empty, footer }: {
  columns: Column<T>[]; rows: T[]; loading?: boolean; error?: string | null; onRetry?: () => void;
  sort?: string; onSort?: (s: string) => void; onRowClick?: (r: T) => void;
  selected?: Set<number>; onSelect?: (s: Set<number>) => void; empty?: ReactNode; footer?: ReactNode;
}) {
  const sortKey = sort?.replace(/^-/, '');
  const desc = sort?.startsWith('-');
  const allSelected = !!selected && rows.length > 0 && rows.every((r) => selected.has(r.id));
  return (
    <div className="surface overflow-hidden rounded-[var(--radius-card)] border border-base">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-base bg-[var(--surface-2)]/60 text-left text-xs font-medium text-muted">
            <tr>
              {onSelect && (
                <th className="w-10 px-3 py-2.5">
                  <Checkbox checked={allSelected} onChange={(v) => onSelect(v ? new Set(rows.map((r) => r.id)) : new Set())} label={<span className="sr-only">Select all</span>} />
                </th>
              )}
              {columns.map((c) => (
                <th key={c.key} className={cn('px-3 py-2.5 font-medium whitespace-nowrap', c.align === 'right' && 'text-right', c.hideOnMobile && 'max-md:hidden', c.className)}>
                  {c.sortKey && onSort ? (
                    <button type="button" className="inline-flex items-center gap-1 hover:text-[var(--text)]" onClick={() => onSort(sortKey === c.sortKey && !desc ? `-${c.sortKey}` : c.sortKey!)}>
                      {c.header}
                      {sortKey === c.sortKey && (desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                    </button>
                  ) : c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {loading && rows.length === 0 && Array.from({ length: 6 }).map((_, i) => (
              <tr key={i}>{onSelect && <td className="px-3 py-3" />}{columns.map((c) => <td key={c.key} className={cn('px-3 py-3', c.hideOnMobile && 'max-md:hidden')}><Skeleton className="h-4 w-3/4" /></td>)}</tr>
            ))}
            {!loading && error && <tr><td colSpan={columns.length + 1}><ErrorState message={error} onRetry={onRetry} /></td></tr>}
            {!loading && !error && rows.length === 0 && <tr><td colSpan={columns.length + 1}>{empty}</td></tr>}
            {rows.map((r) => (
              <tr key={r.id} onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={cn('transition-colors', onRowClick && 'cursor-pointer hover:bg-[var(--surface-2)]/70', selected?.has(r.id) && 'bg-brand-50/60 dark:bg-brand-600/10')}>
                {onSelect && (
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={!!selected?.has(r.id)} onChange={(v) => { const s = new Set(selected); if (v) s.add(r.id); else s.delete(r.id); onSelect(s); }} label={<span className="sr-only">Select row</span>} />
                  </td>
                )}
                {columns.map((c) => <td key={c.key} className={cn('px-3 py-2.5 align-middle', c.align === 'right' && 'text-right tabular', c.hideOnMobile && 'max-md:hidden', c.className)}>{c.cell(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage, onPageSize, summary }: {
  page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize?: (n: number) => void; summary?: ReactNode;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-base px-3 py-2.5 text-[13px] text-muted">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span><span className="font-medium text-[var(--text)]">{total.toLocaleString()}</span> total · {from}–{to}</span>
        {summary}
      </div>
      <div className="flex items-center gap-2">
        {onPageSize && (
          <select aria-label="Rows per page" className="h-8 rounded-md border border-base surface px-2" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
            {[25, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
          </select>
        )}
        <button type="button" className="inline-flex size-8 items-center justify-center rounded-md border border-base disabled:opacity-40" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="size-4" /></button>
        <span className="tabular">{page} / {pages}</span>
        <button type="button" className="inline-flex size-8 items-center justify-center rounded-md border border-base disabled:opacity-40" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="size-4" /></button>
      </div>
    </div>
  );
}
