import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquareHeart, Star } from 'lucide-react';
import { toast } from 'sonner';
import { ct, type CustomerLanguage, type TextKey } from '@crm/shared';
import { api, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { dateTime, relative } from '../../lib/format.ts';
import { useMe } from '../../lib/hooks.ts';
import { Button, Card, Checkbox, EmptyState, ErrorState, Field, Select, Skeleton, Spinner, Textarea } from '../../components/ui/primitives.tsx';
import { AdminOnly } from '../settings/SettingsLayout.tsx';

/** Five stars, filled up to `value` (read-only display). */
export function Stars({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn('inline-flex', className)} role="img" aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => <Star key={n} aria-hidden="true" className={cn('size-4', n <= Math.round(value) ? 'fill-amber-400 text-amber-400' : 'text-slate-300 dark:text-slate-600')} />)}
    </span>
  );
}

// ───────────────────────── Settings ─────────────────────────

export function FeedbackSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['feedback-settings'], queryFn: () => api.get<{ enabled: boolean; delayDays: number }>('/settings/feedback') });
  const [f, setF] = useState<{ enabled: boolean; delayDays: number } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);
  const save = async () => {
    if (!f) return;
    setSaving(true);
    try { await api.put('/settings/feedback', f); await qc.invalidateQueries({ queryKey: ['feedback-settings'] }); toast.success('Settings saved'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <AdminOnly>
      <Card title="Customer feedback">
        {q.isLoading || (!f && !q.error) ? <Skeleton className="h-24" /> : q.error ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : f && (
          <div className="space-y-4">
            <p className="text-sm text-muted">After a deal is won, the customer gets a short email in the language for customers asking them to rate you from 1 to 5, with an optional comment. The rating counts for the deal’s owner, who is told when it arrives. Contacts who unsubscribed from emails are never asked.</p>
            <Checkbox checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Ask customers for feedback automatically after a deal is won" />
            {f.enabled && (
              <Field label="When" htmlFor="fb-delay" hint="Deals won before you turn this on aren’t asked. You can always ask by hand on a won deal.">
                <Select id="fb-delay" value={f.delayDays} onChange={(e) => setF({ ...f, delayDays: Number(e.target.value) })}>
                  <option value={0}>The day the deal is won</option>
                  {[1, 2, 3, 5, 7, 14, 30].map((n) => <option key={n} value={n}>{n} day{n === 1 ? '' : 's'} after it’s won</option>)}
                </Select>
              </Field>
            )}
            <div className="flex justify-end"><Button variant="primary" loading={saving} onClick={save}>Save</Button></div>
          </div>
        )}
      </Card>
    </AdminOnly>
  );
}

// ───────────────────────── Home card ─────────────────────────

interface Summary {
  days: number; overall: { asked: number; answered: number; average: string | null } | null;
  people: { userId: number | null; name: string; asked: number; answered: number; average: string | null; low: number }[];
  comments: { dealId: number; dealTitle: string; rating: number; comment: string; respondedAt: string; ownerName: string | null }[];
}

export function FeedbackCard() {
  const { data: me } = useMe();
  const q = useQuery({ queryKey: ['feedback-summary'], queryFn: () => api.get<Summary>('/feedback/summary?days=90') });
  const title = <span className="flex items-center gap-1.5"><MessageSquareHeart className="size-4 text-brand-600" />Customer rating</span>;
  if (q.isLoading) return <Card title={title}><Skeleton className="h-20" /></Card>;
  if (q.isError) return <Card title={title}><ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /></Card>;
  const s = q.data!;
  if (!s.overall) {
    return (
      <Card title={title}>
        <p className="text-sm text-muted">No feedback in the last {s.days} days. {me?.role.isAdmin
          ? <>Ask customers automatically after a won deal: <Link className="text-brand-600 underline underline-offset-2 dark:text-brand-200" to="/settings/feedback">set it up</Link>.</>
          : 'Ask on a won deal’s page.'}</p>
      </Card>
    );
  }
  return (
    <Card title={title} actions={<span className="text-xs text-muted">Last {s.days} days</span>}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
          <span className="text-2xl font-semibold tabular-nums">{s.overall.average ?? '—'}</span>
          {s.overall.average && <Stars value={Number(s.overall.average)} className="mb-1.5" />}
          <span className="mb-1 text-xs text-muted">{s.overall.answered} of {s.overall.asked} answered</span>
        </div>
        {s.people.length > 1 && (
          <table className="w-full text-sm">
            <caption className="sr-only">Average rating per salesperson</caption>
            <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Person</th><th className="pb-1 text-right font-medium">Rating</th><th className="pb-1 text-right font-medium">Answers</th></tr></thead>
            <tbody>{s.people.map((p) => (
              <tr key={p.userId ?? 'x'} className="border-t border-base">
                <td className="py-1.5 pr-2">{p.name}{p.low > 0 && <span className="ml-1.5 text-xs text-rose-600 dark:text-rose-300">{p.low} low</span>}</td>
                <td className="py-1.5 text-right tabular-nums">{p.average ?? '—'}</td>
                <td className="py-1.5 text-right tabular-nums text-muted">{p.answered}/{p.asked}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {s.comments.length > 0 && (
          <ul className="space-y-2 border-t border-base pt-3" aria-label="Latest comments">
            {s.comments.filter((x) => x.comment).slice(0, 3).map((x) => (
              <li key={x.dealId} className="text-sm">
                <p className="flex items-center gap-2"><Stars value={x.rating} /><Link className="truncate text-xs text-muted hover:underline" to={`/deals/${x.dealId}`}>{x.dealTitle}</Link></p>
                <p className="mt-0.5 line-clamp-2">“{x.comment}”</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

// ───────────────────────── Deal card ─────────────────────────

interface DealFeedback {
  request: { email: string; sentAt: string; rating: number | null; comment: string; respondedAt: string | null; sentByName: string | null; ownerName: string | null } | null;
  won: boolean; autoEnabled: boolean; delayDays: number; canAsk: boolean;
}

export function DealFeedbackCard({ dealId, canEdit }: { dealId: number; canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['deal-feedback', dealId], queryFn: () => api.get<DealFeedback>(`/deals/${dealId}/feedback`) });
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <Card title="Customer feedback"><Skeleton className="h-10" /></Card>;
  if (q.isError) return <Card title="Customer feedback"><ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /></Card>;
  const f = q.data!;
  if (!f.won && !f.request) return null;
  const r = f.request;
  const askNow = async () => {
    setBusy(true);
    try { await api.post(`/deals/${dealId}/feedback`); toast.success('Feedback request sent'); await qc.invalidateQueries({ queryKey: ['deal-feedback', dealId] }); qc.invalidateQueries({ queryKey: ['timeline', 'deal', dealId] }); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Card title={<span className="flex items-center gap-1.5"><MessageSquareHeart className="size-4" aria-hidden="true" />Customer feedback</span>}
      actions={!r && canEdit && f.canAsk && <Button size="sm" disabled={busy} onClick={askNow}>{busy ? 'Sending…' : 'Ask now'}</Button>}>
      {!r ? (
        <p className="text-sm text-muted">{f.canAsk
          ? f.autoEnabled ? `Not asked yet — it goes out ${f.delayDays ? `${f.delayDays} day${f.delayDays === 1 ? '' : 's'} after the win` : 'today'} (if the deal was won after feedback was turned on).` : 'Not asked yet.'
          : 'Nobody to ask: add a contact with an email address to the deal.'}</p>
      ) : r.rating ? (
        <div className="space-y-1 text-sm">
          <p className="flex flex-wrap items-center gap-2"><Stars value={r.rating} /><span className="font-medium">{r.rating}/5</span><span className="text-xs text-muted">· {relative(r.respondedAt)}</span></p>
          {r.comment && <p className="whitespace-pre-line">“{r.comment}”</p>}
          <p className="text-xs text-muted">From {r.email}{r.ownerName ? ` · counts for ${r.ownerName}` : ''}</p>
        </div>
      ) : (
        <p className="text-sm text-muted">Asked {r.email} {dateTime(r.sentAt)}{r.sentByName ? ` (by ${r.sentByName})` : ''} — no answer yet.</p>
      )}
    </Card>
  );
}

// ───────────────────────── Customer page ─────────────────────────

interface Pub { company: string; owner: string; lang: CustomerLanguage; rating: number | null; comment: string; expired: boolean }
const both = (k: TextKey) => `${ct('km', k)} · ${ct('en', k)}`;

/** /r/:token — the customer rates 1–5 with an optional comment (and can change it later). */
export function RatePage() {
  const token = useParams().token ?? '';
  const q = useQuery({ queryKey: ['rate', token], retry: false, queryFn: async () => {
    const r = await fetch(`/api/v1/public/feedback/${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(r.status === 404 ? 'bad' : 'error');
    return (await r.json()) as Pub;
  } });
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [state, setState] = useState<'form' | 'busy' | 'done'>('form');
  const [problem, setProblem] = useState('');
  useEffect(() => { if (q.data) { setRating(q.data.rating); setComment(q.data.comment); if (q.data.rating) setState('done'); } }, [q.data]);
  const shell = (lang: CustomerLanguage | undefined, children: React.ReactNode) => (
    <main className="grid min-h-dvh place-items-center bg-[var(--bg)] px-4 py-10" lang={!lang || lang === 'en' ? 'en' : 'km'}>
      <div className="surface w-full max-w-md rounded-[var(--radius-card)] border border-base p-6 shadow-xs">{children}</div>
    </main>
  );
  if (q.isLoading) return shell(undefined, <div className="flex justify-center py-6"><Spinner /></div>);
  if (q.isError) return shell(undefined, <EmptyState title={(q.error as Error).message === 'bad' ? both('fbBadLink') : both('somethingWrong')} />);
  const p = q.data!;
  const t = (k: TextKey, vars?: Record<string, string | number>) => ct(p.lang, k, vars);
  if (p.expired && !p.rating) return shell(p.lang, <p className="text-sm" role="status">{t('fbExpired')}</p>);
  const send = async () => {
    if (!rating) return;
    setState('busy'); setProblem('');
    try {
      const r = await fetch(`/api/v1/public/feedback/${encodeURIComponent(token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rating, comment }) });
      if (r.status === 410) { setProblem(t('fbExpired')); setState('form'); return; }
      if (!r.ok) throw new Error();
      setState('done');
    } catch { setProblem(t('somethingWrong')); setState('form'); }
  };
  if (state === 'done') {
    return shell(p.lang, (
      <div className="space-y-3 text-center" role="status">
        <Stars value={rating ?? 0} className="justify-center [&_svg]:size-7" />
        <h1 className="text-lg font-semibold">{t('fbThanks')}</h1>
        {rating && rating <= 2 && <p className="text-sm text-muted">{t('fbThanksLow', { owner: p.owner })}</p>}
        {!p.expired && <Button size="sm" variant="ghost" onClick={() => setState('form')}>{t('fbChange')}</Button>}
      </div>
    ));
  }
  return shell(p.lang, (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <h1 className="text-lg font-semibold">{t('fbTitle', { company: p.company })}</h1>
      <fieldset>
        <legend className="sr-only">{t('fbTitle', { company: p.company })}</legend>
        <div className="flex justify-between gap-1" role="radiogroup">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${t('fbStars', { n })} — ${t(`fb${n}` as TextKey)}`} onClick={() => setRating(n)}
              className={cn('flex flex-1 flex-col items-center gap-1 rounded-lg border px-1 py-2 text-xs transition-colors', rating === n ? 'border-amber-400 bg-amber-50 dark:bg-amber-500/10' : 'border-base hover:bg-[var(--surface-2)]')}>
              <Star aria-hidden="true" className={cn('size-7', rating && n <= rating ? 'fill-amber-400 text-amber-400' : 'text-slate-300 dark:text-slate-600')} />
              <span className="text-center leading-tight">{t(`fb${n}` as TextKey)}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <Field label={t('fbComment')} htmlFor="fb-comment"><Textarea id="fb-comment" rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      {problem && <p className="text-sm text-rose-600" role="alert">{problem}</p>}
      <Button type="submit" variant="primary" className="w-full justify-center" disabled={!rating || state === 'busy'}>{state === 'busy' ? t('sending') : t('fbSend')}</Button>
    </form>
  ));
}
