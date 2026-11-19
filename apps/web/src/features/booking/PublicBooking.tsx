import { useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, Clock, MapPin, Video } from 'lucide-react';
import { ct, customerDate, customerWeekday, dateIn, timeIn, type CustomerLanguage, type TextKey } from '@crm/shared';
import { cn } from '../../lib/cn.ts';
import { Button, EmptyState, Field, Input, Skeleton, Spinner, Textarea } from '../../components/ui/primitives.tsx';
import { Dialog } from '../../components/ui/overlays.tsx';

interface PageInfo {
  title: string; description: string; durationMinutes: number; host: string; company: string; video: boolean; location: string;
  tz: string; lang: CustomerLanguage; daysAhead: number; days: { date: string; slots: string[] }[];
}

const both = (k: TextKey) => `${ct('km', k)} · ${ct('en', k)}`;
/** Short month of a date: "Nov" / "វិច្ឆិកា". */
const monthOf = (lang: CustomerLanguage, d: string) => { const parts = customerDate(lang, d).split(' '); return lang === 'en' ? parts[0] : parts[1]; };
const when = (lang: CustomerLanguage, iso: string, tz: string) => { const d = dateIn(iso, tz); return `${customerWeekday(lang, d)} ${customerDate(lang, d)}, ${timeIn(iso, tz)}`; };

type SlotDay = { date: string; slots: string[] };

/** Pick a day, then a time (shared by booking and moving a booking). */
function SlotPicker({ days, lang, tz, problem, onPick }: { days: SlotDay[]; lang: CustomerLanguage; tz: string; problem?: string; onPick: (iso: string) => void }) {
  const [day, setDay] = useState<string | null>(null);
  const t = (k: TextKey, vars?: Record<string, string | number>) => ct(lang, k, vars);
  const selectedDay = days.find((d) => d.date === day) ?? days[0];
  return (
    <div className="space-y-4 p-5 sm:p-6">
      {problem && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-100" role="alert">{problem}</p>}
      <div>
        <h2 className="mb-2 text-sm font-semibold">{t('bookPickDay')}</h2>
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="listbox" aria-label={t('bookPickDay')}>
          {days.map((d) => {
            const on = d.date === selectedDay.date;
            return (
              <button key={d.date} type="button" role="option" aria-selected={on} onClick={() => setDay(d.date)}
                className={cn('flex min-w-16 shrink-0 flex-col items-center whitespace-nowrap rounded-lg border px-3 py-2 text-center text-xs', on ? 'border-brand-600 bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-100' : 'border-base hover:bg-[var(--surface-2)]')}>
                <span className="font-medium">{customerWeekday(lang, d.date)}</span>
                <span className="text-lg font-semibold">{Number(d.date.slice(8, 10))}</span>
                <span className="text-muted">{monthOf(lang, d.date)}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <h2 className="mb-2 text-sm font-semibold">{t('bookPickTime')} · {customerWeekday(lang, selectedDay.date)} {customerDate(lang, selectedDay.date)}</h2>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" aria-label={t('bookPickTime')}>
          {selectedDay.slots.map((s) => <Button key={s} onClick={() => onPick(s)} className="justify-center tabular-nums">{timeIn(s, tz)}</Button>)}
        </div>
        <p className="mt-2 text-xs text-muted">{t('bookTz', { tz: tz.replace(/_/g, ' ') })}</p>
      </div>
    </div>
  );
}

function Shell({ lang, children }: { lang?: CustomerLanguage; children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-[var(--bg)] px-4 py-6 sm:py-10" lang={!lang || lang === 'en' ? 'en' : 'km'}>
      <div className="surface mx-auto w-full max-w-3xl rounded-[var(--radius-card)] border border-base shadow-xs">{children}</div>
    </main>
  );
}

/** /book/:slug — the customer picks a day and a time, enters their details, and is booked. */
export function PublicBookingPage() {
  const slug = useParams().slug ?? '';
  const info = useQuery({ queryKey: ['public-book', slug], retry: false, queryFn: async () => {
    const r = await fetch(`/api/v1/public/book/${encodeURIComponent(slug)}`);
    if (!r.ok) throw new Error(r.status === 404 ? both('bookBadLink') : both('somethingWrong'));
    return (await r.json()) as PageInfo;
  } });
  const [slot, setSlot] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', note: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, setState] = useState<'pick' | 'busy' | 'done'>('pick');
  const [problem, setProblem] = useState('');

  if (info.isLoading) return <Shell><div className="space-y-3 p-6"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-40" /></div></Shell>;
  if (info.isError) return <Shell><EmptyState icon={<CalendarCheck className="size-5" />} title={both('bookBadLink')} description={(info.error as Error).message === both('bookBadLink') ? undefined : (info.error as Error).message} /></Shell>;
  const p = info.data!;
  const t = (k: TextKey, vars?: Record<string, string | number>) => ct(p.lang, k, vars);
  const book = async () => {
    if (!slot) return;
    setState('busy'); setErrors({}); setProblem('');
    try {
      const r = await fetch(`/api/v1/public/book/${encodeURIComponent(slug)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start: slot, ...form }) });
      const data = await r.json().catch(() => null);
      if (r.status === 409) { setProblem(t('bookTaken')); setSlot(null); await info.refetch(); setState('pick'); return; }
      if (!r.ok) {
        if (data?.error?.fields) setErrors(Object.fromEntries(Object.entries(data.error.fields as Record<string, string>).map(([k, v]) => [k, k === 'email' ? t('bookEmail') : v])));
        setProblem(r.status === 400 ? '' : (data?.error?.message ?? t('somethingWrong')));
        setState('pick'); return;
      }
      setState('done');
    } catch { setProblem(t('somethingWrong')); setState('pick'); }
  };

  const header = (
    <div className="border-b border-base p-5 sm:p-6">
      <p className="text-sm text-muted">{p.company}</p>
      <h1 className="mt-0.5 text-xl font-semibold">{p.title}</h1>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
        <li className="inline-flex items-center gap-1.5"><Clock className="size-4" aria-hidden="true" />{t('bookMinutes', { n: p.durationMinutes })} · {t('bookWith', { host: p.host })}</li>
        {p.video ? <li className="inline-flex items-center gap-1.5"><Video className="size-4" aria-hidden="true" />{t('bookVideo')}</li>
          : p.location && <li className="inline-flex items-center gap-1.5"><MapPin className="size-4" aria-hidden="true" />{t('bookPlace', { place: p.location })}</li>}
      </ul>
      {p.description && <p className="mt-3 whitespace-pre-line text-sm">{p.description}</p>}
    </div>
  );

  if (state === 'done') {
    return (
      <Shell lang={p.lang}>
        {header}
        <div className="p-6 text-center" role="status">
          <CalendarCheck className="mx-auto size-10 text-emerald-600" aria-hidden="true" />
          <h2 className="mt-2 text-lg font-semibold">{t('bookDone')}</h2>
          <p className="mt-1 text-sm">{when(p.lang, slot!, p.tz)}</p>
          <p className="mt-1 text-sm text-muted">{t('bookDoneHelp', { email: form.email })}</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell lang={p.lang}>
      {header}
      {!p.days.length ? <EmptyState title={t('bookNoSlots', { n: p.daysAhead })} /> : !slot ? (
        <SlotPicker days={p.days} lang={p.lang} tz={p.tz} problem={problem} onPick={(iso) => { setSlot(iso); setProblem(''); }} />
      ) : (
        <form className="space-y-3 p-5 sm:p-6" onSubmit={(e) => { e.preventDefault(); void book(); }}>
          <p className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--surface-2)] px-3 py-2 text-sm">
            <span className="font-medium">{when(p.lang, slot, p.tz)}</span>
            <Button size="sm" variant="ghost" onClick={() => setSlot(null)}>{t('bookBack')}</Button>
          </p>
          {problem && <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300" role="alert">{problem}</p>}
          <h2 className="text-sm font-semibold">{t('bookYourDetails')}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('bookName')} htmlFor="bk-name" required error={errors.name}><Input id="bk-name" autoComplete="name" maxLength={120} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label={t('bookEmail')} htmlFor="bk-email" required error={errors.email}><Input id="bk-email" type="email" autoComplete="email" maxLength={200} required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label={t('bookPhone')} htmlFor="bk-phone" error={errors.phone}><Input id="bk-phone" type="tel" autoComplete="tel" maxLength={40} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          </div>
          <Field label={t('bookNote')} htmlFor="bk-note" error={errors.note}><Textarea id="bk-note" rows={3} maxLength={2000} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={state === 'busy'} icon={state === 'busy' ? <Spinner className="size-4 text-white" /> : undefined}>{t('bookConfirm', { when: timeIn(slot, p.tz) })}</Button>
          </div>
        </form>
      )}
    </Shell>
  );
}

interface Mine {
  title: string; start: string; end: string; status: 'booked' | 'canceled'; host: string; company: string; tz: string; lang: CustomerLanguage; name: string; past: boolean;
  videoUrl: string | null; canReschedule: boolean;
}

/** /booking/:token — the customer's booking from the email: details, video link, move to another time, cancel. */
export function ManageBookingPage() {
  const token = useParams().token ?? '';
  const q = useQuery({ queryKey: ['my-booking', token], retry: false, queryFn: async () => {
    const r = await fetch(`/api/v1/public/bookings/${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(r.status === 404 ? both('bookBadLink') : both('somethingWrong'));
    return (await r.json()) as Mine;
  } });
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState('');
  const [moving, setMoving] = useState<null | 'pick' | 'confirm'>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const slots = useQuery({ queryKey: ['my-booking-slots', token], enabled: moving === 'pick', retry: false, staleTime: 0, refetchOnMount: 'always', queryFn: async () => {
    const r = await fetch(`/api/v1/public/bookings/${encodeURIComponent(token)}/slots`);
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error?.message ?? both('somethingWrong'));
    return data as { days: SlotDay[]; tz: string; lang: CustomerLanguage; daysAhead: number };
  } });
  if (q.isLoading) return <Shell><div className="p-6"><Skeleton className="h-24" /></div></Shell>;
  if (q.isError) return <Shell><EmptyState title={both('bookBadLink')} /></Shell>;
  const b = q.data!;
  const t = (k: TextKey, vars?: Record<string, string | number>) => ct(b.lang, k, vars);
  const cancel = async () => {
    setBusy(true); setProblem('');
    try {
      const r = await fetch(`/api/v1/public/bookings/${encodeURIComponent(token)}/cancel`, { method: 'POST' });
      if (!r.ok) throw new Error();
      setDone(true); setAsking(false); await q.refetch();
    } catch { setProblem(t('somethingWrong')); } finally { setBusy(false); }
  };
  const move = async () => {
    if (!target) return;
    setBusy(true); setProblem('');
    try {
      const r = await fetch(`/api/v1/public/bookings/${encodeURIComponent(token)}/reschedule`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ start: target }) });
      const data = await r.json().catch(() => null);
      if (r.status === 409 && data?.error?.code === 'TAKEN') { setProblem(t('bookTaken')); setTarget(null); setMoving('pick'); await slots.refetch(); return; }
      if (!r.ok) throw new Error(data?.error?.message ?? t('somethingWrong'));
      setMoved(target); setMoving(null); setTarget(null); await q.refetch();
    } catch (e) { setProblem((e as Error).message); } finally { setBusy(false); }
  };
  if (moving) {
    return (
      <Shell lang={b.lang}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base p-5 sm:p-6">
          <div className="min-w-0">
            <p className="text-sm text-muted">{b.title}</p>
            <h1 className="text-lg font-semibold">{t('bookReschedule')}</h1>
          </div>
          <Button size="sm" variant="ghost" onClick={() => { setMoving(null); setTarget(null); setProblem(''); }}>{t('bookKeep')}</Button>
        </div>
        {moving === 'confirm' && target ? (
          <div className="space-y-3 p-5 sm:p-6">
            <p className="text-sm"><span className="line-through text-muted">{when(b.lang, b.start, b.tz)}</span></p>
            <p className="text-base font-semibold">{when(b.lang, target, b.tz)}</p>
            {problem && <p className="text-sm text-rose-600" role="alert">{problem}</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={busy} onClick={() => void move()}>{t('bookConfirm', { when: timeIn(target, b.tz) })}</Button>
              <Button onClick={() => { setMoving('pick'); setTarget(null); }}>{t('bookBack')}</Button>
            </div>
          </div>
        ) : slots.isLoading ? <div className="p-6"><Skeleton className="h-40" /></div>
          : slots.isError ? <div className="p-6"><p className="text-sm text-rose-600" role="alert">{(slots.error as Error).message}</p></div>
          : !slots.data!.days.length ? <EmptyState title={t('bookNoSlots', { n: slots.data!.daysAhead })} />
          : <SlotPicker days={slots.data!.days} lang={b.lang} tz={b.tz} problem={problem} onPick={(iso) => { setTarget(iso); setProblem(''); setMoving('confirm'); }} />}
      </Shell>
    );
  }
  return (
    <Shell lang={b.lang}>
      <div className="space-y-3 p-6">
        <p className="text-sm text-muted">{b.company}</p>
        <h1 className="text-xl font-semibold">{b.title}</h1>
        <p className={cn('text-sm', b.status === 'canceled' && 'line-through')}>{when(b.lang, b.start, b.tz)} · {t('bookWith', { host: b.host })}</p>
        {moved && b.status === 'booked' && <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200" role="status">{t('bookMoved', { when: when(b.lang, moved, b.tz) })}</p>}
        {done ? <p className="text-sm" role="status">{t('bookCancelDone', { host: b.host })}</p>
          : b.status === 'canceled' ? <p className="text-sm" role="status">{t('bookCanceled')}</p>
          : b.past ? <p className="text-sm text-muted">{t('bookPast')}</p> : null}
        {problem && <p className="text-sm text-rose-600" role="alert">{problem}</p>}
        {b.status === 'booked' && !b.past && (
          <div className="flex flex-wrap gap-2 pt-1">
            {b.videoUrl && <a href={b.videoUrl} className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-control)] bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700"><Video className="size-4" aria-hidden="true" />{t('bookEmailJoin')}</a>}
            {b.canReschedule && <Button onClick={() => { setMoving('pick'); setProblem(''); setMoved(null); }}>{t('bookReschedule')}</Button>}
            <Button onClick={() => setAsking(true)}>{t('bookCancel')}</Button>
          </div>
        )}
      </div>
      <Dialog open={asking} onOpenChange={setAsking} size="sm" title={t('bookCancelQ', { when: when(b.lang, b.start, b.tz) })}
        footer={<><Button onClick={() => setAsking(false)}>{t('bookKeep')}</Button><Button variant="danger" loading={busy} onClick={() => void cancel()}>{t('bookCancel')}</Button></>} />
    </Shell>
  );
}
