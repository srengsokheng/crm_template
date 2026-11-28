import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Copy, ExternalLink, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { BOOKING_DURATIONS } from '@crm/shared';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { dateTime, fromLocalInput, toLocalInput } from '../../lib/format.ts';
import { useMe, useMeta } from '../../lib/hooks.ts';
import { WhatsAppTemplateField } from '../settings/WhatsAppTemplateField.tsx';
import { WA_BOOKING_FIELDS, type WaTemplateSetting } from '@crm/shared';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, Field, IconButton, Input, Select, Skeleton, Textarea } from '../../components/ui/primitives.tsx';
import { ConfirmDialog, Dialog } from '../../components/ui/overlays.tsx';

export interface BookingPageRow {
  whatsapp: WaTemplateSetting | null;
  id: number; slug: string; title: string; description: string; hostId: number; hostIds: (number | string)[]; hostWeights?: number[]; hostName: string; durationMinutes: number; days: number[];
  startTime: string; endTime: string; minNoticeHours: number; daysAhead: number; video: boolean; location: string; active: boolean; upcoming: number; url: string;
}
interface Booking { id: number; name: string; email: string; phone: string; note: string; startsAt: string; endsAt: string; status: 'booked' | 'canceled'; canceledBy: string | null; hostName: string | null }

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']] as const;
const daysText = (d: number[]) => (d.join() === '1,2,3,4,5' ? 'Mon–Fri' : d.join() === '1,2,3,4,5,6,7' ? 'Every day' : d.map((x) => DAYS[x - 1][1]).join(', '));
const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

async function copy(url: string) {
  try { await navigator.clipboard.writeText(url); toast.success('Link copied'); } catch { toast.error('Copy failed — select the link and copy it'); }
}

/** Settings → Booking pages: everyone sees the links (to share them); admins set pages up. */
export function BookingSettings() {
  const { data: me } = useMe();
  const q = useQuery({ queryKey: ['booking-pages'], queryFn: () => api.get<{ data: BookingPageRow[]; canEdit: boolean }>('/booking-pages') });
  const [editing, setEditing] = useState<BookingPageRow | 'new' | null>(null);
  const [showing, setShowing] = useState<BookingPageRow | null>(null);
  const canEdit = !!q.data?.canEdit;
  const add = canEdit && <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>New booking page</Button>;
  return (
    <Card title="Booking pages" actions={add} padded={false}>
      <p className="border-b border-base px-4 py-3 text-sm text-muted">Send customers a link where they pick a free time with you. Each booking becomes a meeting in Activities (with a video-call link if you like), linked to the contact, and the customer gets a confirmation email with a calendar file.</p>
      {q.isLoading ? <div className="space-y-2 p-4"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
        : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        : !q.data!.data.length ? <EmptyState icon={<CalendarClock className="size-5" />} title="No booking pages yet" description={canEdit ? 'Create one for showroom visits, demos or consultations.' : 'Ask an admin to create one.'} action={add || undefined} />
        : (
          <ul className="divide-y divide-[var(--border)]" aria-label="Booking pages">
            {q.data!.data.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1 basis-60">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{p.title}{!p.active && <Badge>Off</Badge>}</p>
                  <p className="text-xs text-muted">{p.durationMinutes} min · {p.hostName} · {daysText(p.days)} {p.startTime}–{p.endTime}{p.video ? ' · video call' : ''}</p>
                  <p className="truncate text-xs"><a className="text-brand-600 underline underline-offset-2 dark:text-brand-200" href={p.url} target="_blank" rel="noreferrer">{p.url.replace(/^https?:\/\//, '')}</a></p>
                </div>
                <div className="flex items-center gap-1">
                  {(canEdit || p.hostIds.map(Number).includes(me?.user.id ?? -1)) ? <Button size="sm" variant="ghost" onClick={() => setShowing(p)}>{p.upcoming} upcoming</Button> : <span className="px-2 text-xs text-muted">{p.upcoming} upcoming</span>}
                  <IconButton label={`Copy link of ${p.title}`} onClick={() => void copy(p.url)}><Copy className="size-4" /></IconButton>
                  <IconButton label={`Open ${p.title}`} onClick={() => window.open(p.url, '_blank', 'noopener')}><ExternalLink className="size-4" /></IconButton>
                  {canEdit && <IconButton label={`Edit ${p.title}`} onClick={() => setEditing(p)}><Pencil className="size-4" /></IconButton>}
                </div>
              </li>
            ))}
          </ul>
        )}
      {editing && <PageDialog page={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {showing && <BookingsDialog page={showing} onClose={() => setShowing(null)} />}
    </Card>
  );
}

const SHARES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** "Everyone gets about the same number of bookings." or "Out of every 3 bookings: Rita 2, Otto 1." */
function shareHint(people: [string, number][]) {
  if (people.every(([, w]) => w === people[0][1])) return 'Everyone gets about the same number of bookings.';
  const total = people.reduce((sum, [, w]) => sum + w, 0);
  return `Out of every ${total} bookings, about: ${people.map(([n, w]) => `${n} ${w}`).join(', ')}.`;
}

function PageDialog({ page, onClose }: { page: BookingPageRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [f, setF] = useState(() => page ? {
    title: page.title, slug: page.slug, description: page.description, hostIds: page.hostIds.map(Number),
    weights: Object.fromEntries(page.hostIds.map((id, i) => [Number(id), page.hostWeights?.[i] ?? 1])) as Record<number, number>, durationMinutes: page.durationMinutes, days: page.days,
    start: page.startTime, end: page.endTime, minNoticeHours: page.minNoticeHours, daysAhead: page.daysAhead, video: page.video, location: page.location, active: page.active,
    whatsapp: page.whatsapp,
  } : { title: '', slug: '', description: '', hostIds: me ? [me.user.id] : [], weights: {} as Record<number, number>, durationMinutes: 30, days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', minNoticeHours: 4, daysAhead: 30, video: true, location: '', active: true, whatsapp: null as WaTemplateSetting | null });
  const meta = useMeta();
  const users = (meta.data?.users ?? []).filter((u) => u.status === 'active' || f.hostIds.includes(u.id));
  const [slugTouched, setSlugTouched] = useState(!!page);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => { if (!slugTouched) setF((v) => ({ ...v, slug: slugify(v.title) })); }, [f.title, slugTouched]);
  const save = async () => {
    setBusy(true); setErrors({});
    try {
      const { weights, ...rest } = f;
      const body = { ...rest, hostWeights: f.hostIds.map((id) => weights[id] ?? 1) };
      if (page) await api.put(`/booking-pages/${page.id}`, body); else await api.post('/booking-pages', body);
      await qc.invalidateQueries({ queryKey: ['booking-pages'] });
      toast.success(page ? 'Booking page saved' : 'Booking page created — copy the link and share it');
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.fields) setErrors(Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k.split('.')[0], v])));
      toast.error(errorMessage(e));
    } finally { setBusy(false); }
  };
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="lg" title={page ? 'Edit booking page' : 'New booking page'}
      footer={<>
        {page && <Button variant="ghost" className="mr-auto" onClick={() => setDeleting(true)}>Delete</Button>}
        <Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>{page ? 'Save' : 'Create'}</Button>
      </>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title" htmlFor="bp-title" required error={errors.title} hint="Customers see it, e.g. Showroom visit"><Input id="bp-title" maxLength={120} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Link" htmlFor="bp-slug" required error={errors.slug} hint={`${origin}/book/${f.slug || '…'}`}>
            <Input id="bp-slug" maxLength={40} value={f.slug} onChange={(e) => { setSlugTouched(true); setF({ ...f, slug: e.target.value.toLowerCase() }); }} /></Field>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1.5 text-[13px] font-medium">With</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {users.map((u) => (
                <Checkbox key={u.id} label={u.name} checked={f.hostIds.includes(u.id)}
                  onChange={(v) => setF({ ...f, hostIds: v ? [...f.hostIds, u.id] : f.hostIds.filter((x) => x !== u.id) })} />
              ))}
            </div>
            <p className={errors.hostIds ? 'mt-1 text-xs text-rose-600' : 'mt-1 text-xs text-muted'} role={errors.hostIds ? 'alert' : undefined}>
              {errors.hostIds ?? (f.hostIds.length > 1
                ? 'Shared: a time is offered when any of them is free, and each booking goes to one of them, taking turns by their share.'
                : 'Bookings become their meetings.')}
            </p>
            {f.hostIds.length > 1 && (
              <div className="mt-3 rounded-lg border border-base p-3">
                <p className="mb-2 text-[13px] font-medium" id="bp-shares">Share of bookings</p>
                <ul className="grid gap-2 sm:grid-cols-2" aria-labelledby="bp-shares">
                  {f.hostIds.map((id) => {
                    const name = users.find((u) => u.id === id)?.name ?? `#${id}`;
                    return (
                      <li key={id} className="flex items-center justify-between gap-3">
                        <label htmlFor={`bp-w-${id}`} className="truncate text-sm">{name}</label>
                        <Select id={`bp-w-${id}`} aria-label={`${name}’s share`} className="w-24 shrink-0" value={f.weights[id] ?? 1}
                          onChange={(e) => setF({ ...f, weights: { ...f.weights, [id]: Number(e.target.value) } })}>
                          {SHARES.map((n) => <option key={n} value={n}>{n}×</option>)}
                        </Select>
                      </li>
                    );
                  })}
                </ul>
                <p className={errors.hostWeights ? 'mt-2 text-xs text-rose-600' : 'mt-2 text-xs text-muted'} role={errors.hostWeights ? 'alert' : undefined}>
                  {errors.hostWeights ?? shareHint(f.hostIds.map((id) => [users.find((u) => u.id === id)?.name ?? `#${id}`, f.weights[id] ?? 1]))}
                </p>
              </div>
            )}
          </fieldset>
          <Field label="Length" htmlFor="bp-len" error={errors.durationMinutes}>
            <Select id="bp-len" value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: Number(e.target.value) })}>
              {BOOKING_DURATIONS.map((n) => <option key={n} value={n}>{n < 60 ? `${n} minutes` : `${n / 60} hour${n === 60 ? '' : 's'}`}</option>)}
            </Select></Field>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">Days</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {DAYS.map(([n, label]) => <Checkbox key={n} label={label} checked={f.days.includes(n)} onChange={(v) => setF({ ...f, days: v ? [...f.days, n].sort() : f.days.filter((x) => x !== n) })} />)}
          </div>
          {errors.days && <p className="mt-1 text-xs text-rose-600" role="alert">{errors.days}</p>}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="From" htmlFor="bp-start" error={errors.start}><Input id="bp-start" type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
          <Field label="Until" htmlFor="bp-end" error={errors.end}><Input id="bp-end" type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></Field>
          <Field label="Notice (hours)" htmlFor="bp-notice" error={errors.minNoticeHours}><Input id="bp-notice" type="number" min={0} max={168} value={f.minNoticeHours} onChange={(e) => setF({ ...f, minNoticeHours: Number(e.target.value) })} /></Field>
          <Field label="Days ahead" htmlFor="bp-ahead" error={errors.daysAhead}><Input id="bp-ahead" type="number" min={1} max={90} value={f.daysAhead} onChange={(e) => setF({ ...f, daysAhead: Number(e.target.value) })} /></Field>
        </div>
        <p className="text-xs text-muted">Times use the workspace time zone. Open meetings and calls of the person block their times.</p>
        <Checkbox checked={f.video} onChange={(v) => setF({ ...f, video: v })} label="Video call (each booking gets its own call link)" />
        {!f.video && <Field label="Where" htmlFor="bp-loc" hint="Address or phone, shown to the customer" error={errors.location}><Input id="bp-loc" maxLength={200} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>}
        <Field label="Description (optional)" htmlFor="bp-desc" error={errors.description}><Textarea id="bp-desc" rows={3} maxLength={2000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="What the meeting is about, what to bring…" /></Field>
        <WhatsAppTemplateField id="bp-wa" fields={WA_BOOKING_FIELDS} value={f.whatsapp} onChange={(v) => setF({ ...f, whatsapp: v })} error={errors.whatsapp}
          samples={{ name: 'Dara Sok', title: f.title || 'Showroom visit', when: 'Fri 20 Nov 2026, 10:30', link: 'https://…/booking/…', company: 'Acme Robotics' }} />
        <Checkbox checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Taking bookings" />
      </div>
      {page && (
        <ConfirmDialog open={deleting} onOpenChange={setDeleting} danger confirmLabel="Delete" title={`Delete “${page.title}”?`}
          description="The link stops working. Bookings already made stay in Activities."
          onConfirm={async () => { setDeleting(false); try { await api.del(`/booking-pages/${page.id}`); await qc.invalidateQueries({ queryKey: ['booking-pages'] }); toast.success('Booking page deleted'); onClose(); } catch (e) { toast.error(errorMessage(e)); } }} />
      )}
    </Dialog>
  );
}

function BookingsDialog({ page, onClose }: { page: BookingPageRow; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['booking-page-bookings', page.id], queryFn: () => api.get<{ data: Booking[] }>(`/booking-pages/${page.id}/bookings`) });
  const [moving, setMoving] = useState<{ b: Booking; at: string; error: string } | null>(null);
  const [canceling, setCanceling] = useState<{ b: Booking; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['booking-page-bookings', page.id] }); qc.invalidateQueries({ queryKey: ['booking-pages'] }); };
  const move = async () => {
    if (!moving) return;
    const start = fromLocalInput(moving.at);
    if (!start) { setMoving({ ...moving, error: 'Pick a date and time' }); return; }
    setBusy(true);
    try {
      await api.post(`/bookings/${moving.b.id}/reschedule`, { start });
      toast.success(`Moved — ${moving.b.name} was emailed the new time`);
      setMoving(null); await refresh();
    } catch (e) { setMoving({ ...moving, error: errorMessage(e) }); } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!canceling) return;
    setBusy(true);
    try {
      await api.post(`/bookings/${canceling.b.id}/cancel`, { reason: canceling.reason });
      toast.success(`Canceled — ${canceling.b.name} was emailed`);
      setCanceling(null); await refresh();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  if (moving) {
    return (
      <Dialog open onOpenChange={(o) => { if (!o) setMoving(null); }} title={`Move ${moving.b.name}’s booking`}
        description={`Now ${dateTime(moving.b.startsAt)}. Any time works if ${page.hostName} is free then; ${moving.b.name} gets an email with the new time and calendar file.`}
        footer={<><Button onClick={() => setMoving(null)}>Back</Button><Button variant="primary" loading={busy} onClick={() => void move()}>Move and email</Button></>}>
        <Field label="New date and time" htmlFor="bk-move" error={moving.error}>
          <Input id="bk-move" type="datetime-local" value={moving.at} onChange={(e) => setMoving({ ...moving, at: e.target.value, error: '' })} />
        </Field>
      </Dialog>
    );
  }
  if (canceling) {
    return (
      <Dialog open onOpenChange={(o) => { if (!o) setCanceling(null); }} title={`Cancel ${canceling.b.name}’s booking?`}
        description={`${dateTime(canceling.b.startsAt)}. The meeting is canceled and ${canceling.b.name} gets an email.`}
        footer={<><Button onClick={() => setCanceling(null)}>Keep it</Button><Button variant="danger" loading={busy} onClick={() => void cancel()}>Cancel and email</Button></>}>
        <Field label="Message to the customer (optional)" htmlFor="bk-reason" hint="E.g. why, and what to do next">
          <Textarea id="bk-reason" rows={3} maxLength={500} value={canceling.reason} onChange={(e) => setCanceling({ ...canceling, reason: e.target.value })} />
        </Field>
      </Dialog>
    );
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={`Bookings · ${page.title}`} footer={<Button onClick={onClose}>Close</Button>}>
      {q.isLoading ? <Skeleton className="h-24" /> : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        : !q.data!.data.length ? <EmptyState title="No upcoming bookings" description="Share the link to get some." />
        : (
          <ul className="divide-y divide-[var(--border)]" aria-label="Bookings">
            {q.data!.data.map((b) => (
              <li key={b.id} className="flex items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{dateTime(b.startsAt)}{page.hostIds.length > 1 && b.hostName ? <span className="font-normal text-muted"> · with {b.hostName}</span> : null}</p>
                  <p className="break-words text-xs text-muted">{b.name} · {b.email}{b.phone ? ` · ${b.phone}` : ''}</p>
                  {b.note && <p className="mt-0.5 text-xs">{b.note}</p>}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {b.status === 'canceled' ? <Badge tone="red">Canceled</Badge> : <Badge tone="green">Booked</Badge>}
                  {b.status === 'booked' && new Date(b.endsAt).getTime() > Date.now() && (
                    <span className="flex gap-1">
                      <Button size="sm" variant="ghost" aria-label={`Move ${b.name}’s booking`} onClick={() => setMoving({ b, at: toLocalInput(b.startsAt), error: '' })}>Move</Button>
                      <Button size="sm" variant="ghost" aria-label={`Cancel ${b.name}’s booking`} onClick={() => setCanceling({ b, reason: '' })}>Cancel</Button>
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
    </Dialog>
  );
}
