import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { CalendarDays, ChevronLeft, ChevronRight, Handshake } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, qsOf } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { money } from '../../lib/format.ts';
import { useCan, useLocalStorage } from '../../lib/hooks.ts';
import { Button, EmptyState, ErrorState, IconButton, PageHeader, Segmented, Skeleton } from '../../components/ui/primitives.tsx';
import { STAGE_SOLID } from '../../components/ui/stageColors.ts';
import { ACTIVITY_ICON } from '../records/Timeline.tsx';

interface CalActivity {
  id: number; kind: keyof typeof ACTIVITY_ICON; subject: string; dueAt: string; status: 'open' | 'done'; assigneeId: number; assigneeName: string | null;
  links: { entityType: 'deal' | 'lead' | 'contact' | 'company'; entityId: number; title: string }[];
}
interface CalDeal { id: number; title: string; amount: string; currency: string; expectedCloseDate: string; ownerId: number; version: number; stageName: string; stageColor: string }
interface CalData { activities: CalActivity[]; activitiesTotal: number; deals: CalDeal[]; dealsTotal: number; cap: number }

// ── Local-calendar date helpers (weeks start on Monday) ──
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseYmd = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfWeek = (d: Date) => addDays(d, -((d.getDay() + 6) % 7));
const PLURAL = { deal: 'deals', lead: 'leads', contact: 'contacts', company: 'companies' } as const;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The days shown: a 6-week grid around the month, or the week. */
function daysOf(view: 'month' | 'week', anchor: Date): Date[] {
  const first = view === 'month' ? startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1)) : startOfWeek(anchor);
  return Array.from({ length: view === 'month' ? 42 : 7 }, (_, i) => addDays(first, i));
}

type Item = { key: string; day: string; kind: 'activity'; a: CalActivity } | { key: string; day: string; kind: 'deal'; d: CalDeal };

/**
 * Calendar of the user's activities (by due time) and open deals (by expected close date), month or week. Drag an item
 * to another day to move it (activities keep their time of day); the toast offers Undo. Phones get the same range as
 * an agenda list. Each item links to its record, where the date can also be changed without dragging.
 */
export function CalendarPage() {
  const can = useCan();
  const qc = useQueryClient();
  const [view, setView] = useLocalStorage<'month' | 'week'>('cal-view', 'month');
  const [who, setWho] = useLocalStorage<'me' | 'all'>('cal-who', 'me');
  const [show, setShow] = useLocalStorage<'both' | 'activities' | 'deals'>('cal-show', 'both');
  const [anchorStr, setAnchor] = useState(() => ymd(new Date()));
  const anchor = parseYmd(anchorStr);
  const days = daysOf(view, anchor);
  const first = days[0], last = days[days.length - 1];
  const params = {
    from: first.toISOString(), to: addDays(last, 1).toISOString(), fromDate: ymd(first), toDate: ymd(last),
    assigneeId: who === 'all' ? 'all' : 'me', show: show === 'both' ? 'activities,deals' : show,
  };
  const key = ['calendar', params];
  const q = useQuery({ queryKey: key, placeholderData: keepPreviousData, queryFn: () => api.get<CalData>(`/calendar${qsOf(params)}`) });
  const items: Item[] = [
    ...(q.data?.activities ?? []).map((a) => ({ key: `a${a.id}`, day: ymd(new Date(a.dueAt)), kind: 'activity' as const, a })),
    ...(q.data?.deals ?? []).map((d) => ({ key: `d${d.id}`, day: d.expectedCloseDate, kind: 'deal' as const, d })),
  ];
  const byDay = new Map<string, Item[]>();
  for (const it of items) byDay.set(it.day, [...(byDay.get(it.day) ?? []), it]);
  const today = ymd(new Date());
  const step = (n: number) => setAnchor(ymd(view === 'month' ? new Date(anchor.getFullYear(), anchor.getMonth() + n, 1) : addDays(anchor, 7 * n)));
  const title = view === 'month'
    ? anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : `${first.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${last.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const truncated = q.data && (q.data.activitiesTotal > q.data.activities.length || q.data.dealsTotal > q.data.deals.length);

  const canMove = (it: Item) => it.kind === 'activity' ? it.a.status === 'open' && can('activity', 'edit', it.a.assigneeId) : can('deal', 'edit', it.d.ownerId);
  /** Moves an item to another day and offers Undo. */
  const moveTo = async (it: Item, day: string) => {
    if (it.day === day) return;
    const refresh = () => { qc.invalidateQueries({ queryKey: ['calendar'] }); qc.invalidateQueries({ queryKey: ['activity-counts'] }); };
    try {
      if (it.kind === 'activity') {
        const before = new Date(it.a.dueAt);
        const target = parseYmd(day);
        target.setHours(before.getHours(), before.getMinutes(), 0, 0);
        await api.patch(`/activities/${it.a.id}`, { dueAt: target.toISOString() });
        refresh();
        toast.success(`Moved “${it.a.subject}” to ${target.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`, {
          action: { label: 'Undo', onClick: async () => { await api.patch(`/activities/${it.a.id}`, { dueAt: before.toISOString() }); refresh(); } },
        });
      } else {
        await api.patch(`/deals/${it.d.id}`, { expectedCloseDate: day, version: it.d.version });
        refresh();
        qc.invalidateQueries({ queryKey: ['deal', it.d.id] });
        toast.success(`“${it.d.title}” now expected to close ${parseYmd(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, {
          action: { label: 'Undo', onClick: async () => { await api.patch(`/deals/${it.d.id}`, { expectedCloseDate: it.day }); refresh(); } },
        });
      }
    } catch (e) {
      toast.error(errorMessage(e));
      refresh();
    }
  };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    const it = items.find((x) => x.key === e.active.id);
    const day = e.over ? String(e.over.id).replace(/^day-/, '') : null;
    if (it && day) void moveTo(it, day);
  };

  return (
    <div>
      <PageHeader title="Calendar" subtitle="Activities by due date and open deals by expected close" actions={<>
        <Segmented value={show} onChange={setShow} options={[{ value: 'both', label: 'All' }, { value: 'activities', label: 'Activities' }, { value: 'deals', label: 'Deals' }]} />
        <Segmented value={who} onChange={setWho} options={[{ value: 'me', label: 'Mine' }, { value: 'all', label: 'Everyone' }]} />
      </>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <IconButton label={view === 'month' ? 'Previous month' : 'Previous week'} onClick={() => step(-1)}><ChevronLeft className="size-4" /></IconButton>
        <IconButton label={view === 'month' ? 'Next month' : 'Next week'} onClick={() => step(1)}><ChevronRight className="size-4" /></IconButton>
        <Button size="sm" onClick={() => setAnchor(today)}>Today</Button>
        <h2 className="ml-1 text-base font-semibold" aria-live="polite">{title}</h2>
        <div className="ml-auto"><Segmented size="sm" value={view} onChange={setView} options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }]} /></div>
      </div>
      {truncated && (
        <p role="status" className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">
          Showing the first {q.data!.cap} of {Math.max(q.data!.activitiesTotal, q.data!.dealsTotal)} items in this range. Switch to the week view or to “Mine” to see them all.
        </p>
      )}
      {q.error ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        : !q.data ? <Skeleton className="h-[32rem]" />
        : (
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            {/* Tablet and desktop: the grid */}
            <section className="hidden overflow-hidden rounded-[var(--radius-card)] border border-base sm:block" aria-label={`Calendar, ${title}`}>
              <div className="grid grid-cols-7 border-b border-base bg-[var(--surface-2)] text-xs font-medium text-muted" aria-hidden>
                {WEEKDAYS.map((w) => <div key={w} className="px-2 py-1.5">{w}</div>)}
              </div>
              <div className="grid grid-cols-7">
                {days.map((d) => {
                  const day = ymd(d);
                  const list = byDay.get(day) ?? [];
                  const limit = view === 'month' ? 3 : 50;
                  return (
                    <DayCell key={day} day={day} outside={view === 'month' && d.getMonth() !== anchor.getMonth()} today={day === today} tall={view === 'week'}
                      label={d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} num={d.getDate()}>
                      {list.slice(0, limit).map((it) => <Chip key={it.key} item={it} draggable={canMove(it)} />)}
                      {list.length > limit && (
                        <button type="button" className="w-full rounded px-1 text-left text-xs font-medium text-brand-600 hover:underline"
                          onClick={() => { setAnchor(day); setView('week'); }}>+{list.length - limit} more</button>
                      )}
                    </DayCell>
                  );
                })}
              </div>
            </section>
            {/* Phones: an agenda of the same range */}
            <div className="sm:hidden">
              {items.length === 0 ? <EmptyState icon={<CalendarDays className="size-5" />} title="Nothing scheduled" description="No activities or expected closes in this period." /> : (
                <ol className="space-y-3">
                  {days.map(ymd).filter((day) => byDay.has(day)).map((day) => (
                    <li key={day}>
                      <h3 className={cn('mb-1 text-xs font-semibold uppercase tracking-wide text-muted', day === today && 'text-brand-600')}>
                        {parseYmd(day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}{day === today ? ' · Today' : ''}
                      </h3>
                      <div className="space-y-1">{byDay.get(day)!.map((it) => <div key={it.key} className="[&>a]:py-2 [&>a]:text-sm"><ChipBody item={it} /></div>)}</div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            {items.length === 0 && <p className="mt-3 hidden text-center text-sm text-muted sm:block">Nothing scheduled in this period.</p>}
          </DndContext>
        )}
    </div>
  );
}

function DayCell({ day, label, num, outside, today, tall, children }: { day: string; label: string; num: number; outside: boolean; today: boolean; tall: boolean; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `day-${day}` });
  return (
    <div ref={setNodeRef} data-day={day}
      className={cn('min-w-0 border-b border-r border-base p-1 [&:nth-child(7n)]:border-r-0', tall ? 'min-h-[24rem]' : 'min-h-28',
        outside && 'bg-[var(--surface-2)]/40', isOver && 'bg-brand-50 dark:bg-brand-600/15')}>
      <h3 className={cn('mb-1 flex size-6 items-center justify-center rounded-full text-xs tabular', outside ? 'text-muted' : 'font-medium',
        today && 'bg-brand-600 text-white')}><span aria-hidden>{num}</span><span className="sr-only">{label}{today ? ', today' : ''}</span></h3>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

/** One activity or deal, as a link to its record (no drag: used by the phone agenda too). */
function ChipBody({ item }: { item: Item }) {
  return item.kind === 'activity' ? (() => {
    const a = item.a;
    const Icon = ACTIVITY_ICON[a.kind] ?? CalendarDays;
    const link = a.links[0];
    const time = new Date(a.dueAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP])M$/, (_, x: string) => x.toLowerCase());
    return (
      <Link draggable={false} to={link ? `/${PLURAL[link.entityType]}/${link.entityId}` : '/activities'} title={`${a.subject}${link ? ` — ${link.title}` : ''}${a.assigneeName ? ` · ${a.assigneeName}` : ''}`}
        className={cn('flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-xs hover:bg-[var(--surface-2)]', a.status === 'done' && 'text-muted line-through')}>
        <Icon className="size-3 shrink-0 text-muted max-lg:hidden" aria-hidden /><span className="shrink-0 tabular text-muted">{time}</span><span className="truncate">{a.subject}</span>
      </Link>
    );
  })() : (() => {
    const d = item.d;
    return (
      <Link draggable={false} to={`/deals/${d.id}`} title={`${d.title} — expected to close · ${d.stageName}`}
        className="flex min-w-0 items-center gap-1 rounded border border-base surface px-1 py-0.5 text-xs hover:bg-[var(--surface-2)]">
        <span className={cn('size-2 shrink-0 rounded-full', STAGE_SOLID[d.stageColor] ?? 'bg-slate-400')} aria-hidden />
        <Handshake className="size-3 shrink-0 text-muted max-lg:hidden" aria-hidden /><span className="sr-only">Deal closing:</span>
        <span className="truncate">{d.title}</span>
        {Number(d.amount) > 0 && <span className="ml-auto shrink-0 tabular text-muted max-lg:hidden">{money(d.amount, d.currency, { compact: true })}</span>}
      </Link>
    );
  })();
}

/**
 * A draggable item in the grid. Pointer and touch only: dnd-kit's keyboard attributes would wrap the link in a second
 * control. Keyboard users change the date on the record itself. Only the grid registers drag ids (the agenda's copies
 * would otherwise shadow them with hidden 0×0 nodes).
 */
function Chip({ item, draggable }: { item: Item; draggable: boolean }) {
  const { listeners, setNodeRef, isDragging } = useDraggable({ id: item.key, disabled: !draggable });
  return (
    <div ref={setNodeRef} {...(draggable ? listeners : {})} data-item={item.key}
      className={cn(draggable && 'cursor-grab touch-manipulation', isDragging && 'opacity-40')}>
      <ChipBody item={item} />
    </div>
  );
}
