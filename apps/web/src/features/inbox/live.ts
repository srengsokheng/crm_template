import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Real-time Inbox updates over server-sent events (GET /api/v1/inbox/events). One connection per tab, opened by the
 * app shell; each "conversation changed" event refreshes the inbox list, that conversation and the unread badge.
 * While connected, the Inbox only polls as a safety net; if the stream drops, it falls back to frequent polling
 * (and EventSource reconnects by itself).
 */
let connected = false;
const listeners = new Set<() => void>();
const setConnected = (v: boolean) => { if (connected !== v) { connected = v; listeners.forEach((l) => l()); } };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** True while the event stream is open. */
export const useInboxLive = () => useSyncExternalStore(subscribe, () => connected, () => false);

/** Polling interval for inbox queries: slow while live, fast otherwise. */
export const usePollInterval = (fallbackMs: number) => (useInboxLive() ? 60_000 : fallbackMs);

export function useInboxEvents(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/v1/inbox/events');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('conversation', (e) => {
      let id: number | undefined;
      try { id = JSON.parse((e as MessageEvent<string>).data).conversationId; } catch { /* ignore malformed */ }
      qc.invalidateQueries({ queryKey: ['inbox'] });
      qc.invalidateQueries({ queryKey: ['inbox-summary'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
      if (id) qc.invalidateQueries({ queryKey: ['conversation', id] });
    });
    return () => { es.close(); setConnected(false); };
  }, [enabled, qc]);
}
