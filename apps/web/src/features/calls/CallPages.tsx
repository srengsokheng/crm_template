import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '../../lib/api.ts';
import { useMe } from '../../lib/hooks.ts';
import { Button, EmptyState, ErrorState, Field, Input, Skeleton } from '../../components/ui/primitives.tsx';
import { CallRoom } from './CallRoom.tsx';
import type { Transport } from './useCallRoom.ts';

interface CallInfo { id: number; title: string; status: 'open' | 'ended'; activityId: number | null; conversationId: number | null; guestUrl: string | null; minutes: number | null; createdBy?: number }

/** A team member's view of a call (/calls/:id). */
export function CallPage() {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const { data: me } = useMe();
  const call = useQuery({ queryKey: ['call', id], queryFn: () => api.get<CallInfo & { createdBy?: number }>(`/calls/${id}`) });
  const transport = useMemo<Transport>(() => ({
    join: () => api.post(`/calls/${id}/join`),
    eventsUrl: (peer, secret) => `/api/v1/calls/${id}/events?peer=${encodeURIComponent(peer)}&secret=${encodeURIComponent(secret)}`,
    signal: (b) => api.post(`/calls/${id}/signal`, b),
    leave: (b) => api.post(`/calls/${id}/leave`, b),
  }), [id]);
  if (call.isLoading) return <Skeleton className="h-96" />;
  if (call.isError) return <ErrorState message={errorMessage(call.error)} onRetry={() => call.refetch()} />;
  const c = call.data!;
  if (c.status === 'ended') {
    return <EmptyState title="This call has ended" description={c.minutes ? `It lasted ${c.minutes} minute${c.minutes === 1 ? '' : 's'}.` : 'Nobody joined it.'}
      action={c.activityId ? <Link className="text-brand-600 hover:underline dark:text-brand-200" to="/activities">Go to activities</Link> : undefined} />;
  }
  return (
    <CallRoom transport={transport} title={c.title} myName={me?.user.name ?? 'You'} guestUrl={c.guestUrl}
      canEnd={!!me && (me.role.isAdmin || c.createdBy === me.user.id)}
      onEnd={async () => {
        try { await api.post(`/calls/${id}/end`); qc.invalidateQueries({ queryKey: ['call', id] }); toast.success('Call ended for everyone'); } catch (e) { toast.error(errorMessage(e)); }
      }} />
  );
}

/** The customer's page (/join/:token): no account needed, just a name. */
export function GuestCallPage() {
  const token = useParams().token ?? '';
  const [name, setName] = useState('');
  const info = useQuery({ queryKey: ['guest-call', token], retry: false, queryFn: async () => {
    const r = await fetch(`/api/v1/public/calls/${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(r.status === 404 ? 'This call link isn’t valid. Ask for a new one.' : 'The call couldn’t be loaded. Try again.');
    return (await r.json()) as { title: string; status: 'open' | 'ended'; host: string };
  } });
  const transport = useMemo<Transport>(() => {
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`/api/v1/public/calls/${encodeURIComponent(token)}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = r.status === 204 ? null : await r.json().catch(() => null);
      if (!r.ok) throw Object.assign(new Error(data?.error?.message ?? 'Something went wrong'), { code: data?.error?.code });
      return data;
    };
    return {
      join: () => post('/join', { name: name.trim() }),
      eventsUrl: (peer, secret) => `/api/v1/public/calls/${encodeURIComponent(token)}/events?peer=${encodeURIComponent(peer)}&secret=${encodeURIComponent(secret)}`,
      signal: (b) => post('/signal', b),
      leave: (b) => post('/leave', b),
    };
  }, [token, name]);
  return (
    <main className="mx-auto min-h-screen max-w-5xl px-4 py-6">
      {info.isLoading ? <Skeleton className="h-96" />
        : info.isError ? <EmptyState title="Can’t open this call" description={(info.error as Error).message} />
        : info.data!.status === 'ended' ? <EmptyState title="This call has ended" description={`Thanks for talking with ${info.data!.host}.`} />
        : (
          <>
            <p className="mb-2 text-sm text-muted">Video call with {info.data!.host}</p>
            <CallRoom transport={transport} title={info.data!.title} myName={name.trim() || 'You'}
              extra={<Field label="Your name" htmlFor="guest-name" required><Input id="guest-name" autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>}
              joinLabel={name.trim() ? 'Join call' : 'Enter your name to join'} />
          </>
        )}
    </main>
  );
}

/** "Video call" buttons: starts a call (optionally on a meeting or a conversation) and returns it. */
export async function startCall(body: { activityId?: number; conversationId?: number; title?: string }) {
  return api.post<CallInfo & { guestUrl: string }>('/calls', body);
}

export function StartCallButton({ label = 'Video call', body, onStarted }: { label?: string; body: { activityId?: number; conversationId?: number }; onStarted: (c: CallInfo & { guestUrl: string }) => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button size="sm" disabled={busy} onClick={async () => {
      setBusy(true);
      try { await onStarted(await startCall(body)); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
    }}>{busy ? 'Starting…' : label}</Button>
  );
}
