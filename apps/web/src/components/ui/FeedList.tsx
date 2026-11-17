import type { ReactNode } from 'react';
import { useInfiniteQuery, type InfiniteData, type UseInfiniteQueryResult } from '@tanstack/react-query';
import { api, errorMessage, qsOf } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { Button, EmptyState, ErrorState, Skeleton } from './primitives.tsx';

/** One page of a cursor feed (see feedQuery / feedResult in the API). */
export interface FeedPage<T> { data: T[]; nextCursor: string | null }
export type Feed<T> = UseInfiniteQueryResult<InfiniteData<FeedPage<T>>, Error> & { items: T[] };

/**
 * A newest-first list read page by page with "Load more" (docs/UI-RULES.md §3). `params` are the filters; the cursor
 * is added by the hook. Polling (refetchInterval) refreshes every loaded page.
 */
export function useFeed<T>(key: readonly unknown[], path: string, params: Record<string, string | number | undefined> = {},
  opts: { enabled?: boolean; refetchInterval?: number | false; limit?: number } = {}): Feed<T> {
  const merged: Record<string, string | number | undefined> = { ...params, limit: opts.limit };
  const clean = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])) as Record<string, string>;
  const q = useInfiniteQuery({
    queryKey: [...key, clean],
    initialPageParam: '',
    queryFn: ({ pageParam }) => api.get<FeedPage<T>>(`${path}${qsOf({ ...clean, ...(pageParam ? { before: pageParam } : {}) })}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: opts.enabled,
    refetchInterval: opts.refetchInterval,
  });
  return Object.assign(q, { items: q.data?.pages.flatMap((p) => p.data) ?? [] });
}

/** Renders a feed with its loading, error, empty and "Load more" states. Children render the items (e.g. <li>s). */
export function FeedList<T>({ feed, children, empty, skeletonRows = 3, className, listClassName = 'divide-y divide-[var(--border)]', label }: {
  feed: Feed<T>; children: (items: T[]) => ReactNode; empty: ReactNode | { title: string; description?: string; icon?: ReactNode; action?: ReactNode };
  skeletonRows?: number; className?: string; listClassName?: string; label?: string;
}) {
  if (feed.isLoading) return <div className={cn('space-y-2 p-3', className)} aria-busy="true">{Array.from({ length: skeletonRows }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>;
  if (feed.isError && feed.items.length === 0) return <div className={className}><ErrorState message={errorMessage(feed.error)} onRetry={() => feed.refetch()} /></div>;
  if (feed.items.length === 0) {
    return <div className={className}>{isEmptyProps(empty) ? <EmptyState {...empty} /> : empty}</div>;
  }
  return (
    <div className={className}>
      <ul className={listClassName} aria-label={label}>{children(feed.items)}</ul>
      {feed.hasNextPage && (
        <div className="flex justify-center border-t border-base p-2">
          <Button size="sm" variant="ghost" disabled={feed.isFetchingNextPage} onClick={() => feed.fetchNextPage()}>
            {feed.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
      {feed.isFetchNextPageError && <p className="px-3 pb-2 text-center text-xs text-rose-600" role="alert">Couldn’t load more. {errorMessage(feed.error)}</p>}
    </div>
  );
}

function isEmptyProps(v: unknown): v is { title: string; description?: string; icon?: ReactNode; action?: ReactNode } {
  return !!v && typeof v === 'object' && 'title' in (v as Record<string, unknown>) && typeof (v as { title: unknown }).title === 'string';
}
