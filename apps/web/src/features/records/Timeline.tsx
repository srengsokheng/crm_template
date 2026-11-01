import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRightLeft, Bot, CalendarClock, CheckCircle2, Circle, Mail, MessageSquare, Phone, Pin, PinOff, Trash2, Users, Flag, CheckSquare, History } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { dateTime, dueLabel, fromLocalInput, money, relative, toLocalInput } from '../../lib/format.ts';
import { useMe, useMeta } from '../../lib/hooks.ts';
import type { Activity, RecordType } from '../../lib/types.ts';
import { Avatar, Button, Card, IconButton, Input, Segmented, Select, Skeleton, Textarea } from '../../components/ui/primitives.tsx';
import { UserSelect } from './form.tsx';

export const ACTIVITY_ICON = { task: CheckSquare, call: Phone, meeting: Users, email: Mail, deadline: Flag } as const;
const KINDS = ['task', 'call', 'meeting', 'email', 'deadline'] as const;

interface TimelineItem { type: 'note' | 'activity' | 'event'; at: string; data: Record<string, any> }
interface TimelineData { upcoming: Activity[]; items: TimelineItem[] }

const tomorrow9 = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.toISOString(); };

export function Timeline({ type, id }: { type: RecordType; id: number }) {
  const qc = useQueryClient();
  const key = ['timeline', type, id];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<TimelineData>(`/timeline/${type}/${id}`) });
  const [filter, setFilter] = useState<'all' | 'note' | 'activity' | 'event'>('all');
  const refresh = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['activity-counts'] }); qc.invalidateQueries({ queryKey: [type + 's'] }); };
  const items = (data?.items ?? []).filter((i) => filter === 'all' || i.type === filter);
  return (
    <div className="space-y-4">
      <Composer type={type} id={id} onDone={refresh} />
      <Card title={<span className="flex items-center gap-1.5"><CalendarClock className="size-4 text-brand-600" />Up next</span>} padded={false}>
        {isLoading ? <div className="p-4"><Skeleton className="h-10" /></div>
          : data?.upcoming.length ? <ul className="divide-y divide-[var(--border)]">{data.upcoming.map((a) => <UpcomingRow key={a.id} a={a} onChange={refresh} />)}</ul>
          : <p className="px-4 py-5 text-sm text-muted">No open activities. Plan the next step so nothing slips.</p>}
      </Card>
      <Card title="History" padded={false} actions={
        <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'note', label: 'Notes' }, { value: 'activity', label: 'Activities' }, { value: 'event', label: 'Changes' }]} />
      }>
        {isLoading ? <div className="space-y-3 p-4"><Skeleton className="h-12" /><Skeleton className="h-12" /></div> : (
          <ol className="relative space-y-0 px-4 py-2">
            {items.map((it) => <FeedItem key={`${it.type}-${it.data.id}`} it={it} recordType={type} recordId={id} onChange={refresh} />)}
            {!items.length && <li className="py-6 text-center text-sm text-muted">Nothing here yet.</li>}
          </ol>
        )}
      </Card>
    </div>
  );
}

function Composer({ type, id, onDone }: { type: RecordType; id: number; onDone: () => void }) {
  const { data: me } = useMe();
  const [tab, setTab] = useState<'note' | 'activity' | 'call'>('note');
  const [note, setNote] = useState('');
  const [act, setAct] = useState({ kind: 'task' as Activity['kind'], subject: '', dueAt: tomorrow9(), assigneeId: me?.user.id ?? null as number | null, reminder: '15' });
  const [call, setCall] = useState({ subject: 'Call', outcome: '', direction: 'outbound', description: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const link = [{ entityType: type, entityId: id }];
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setSaving(true); setErr(null);
    try { await fn(); toast.success(ok); onDone(); return true; } catch (e) { setErr(errorMessage(e)); return false; } finally { setSaving(false); }
  };
  return (
    <Card padded={false}>
      <div className="flex items-center gap-1 border-b border-base px-3 pt-2">
        {([['note', 'Note', MessageSquare], ['activity', 'Activity', CalendarClock], ['call', 'Log call', Phone]] as const).map(([k, l, Icon]) => (
          <button key={k} type="button" onClick={() => { setTab(k); setErr(null); }}
            className={cn('-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium', tab === k ? 'border-brand-600 text-brand-700 dark:text-brand-200' : 'border-transparent text-muted hover:text-[var(--text)]')}>
            <Icon className="size-4" />{l}
          </button>
        ))}
      </div>
      <div className="space-y-3 p-3">
        {tab === 'note' && (
          <>
            <Textarea aria-label="Note" placeholder="Write a note…" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
            <div className="flex justify-end"><Button variant="primary" size="sm" loading={saving} disabled={!note.trim()}
              onClick={async () => { if (await run(() => api.post('/notes', { entityType: type, entityId: id, body: note }), 'Note added')) setNote(''); }}>Add note</Button></div>
          </>
        )}
        {tab === 'activity' && (
          <>
            <div className="flex flex-wrap gap-1.5">
              {KINDS.map((k) => {
                const Icon = ACTIVITY_ICON[k];
                return (
                  <button key={k} type="button" onClick={() => setAct((s) => ({ ...s, kind: k }))} aria-pressed={act.kind === k}
                    className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium capitalize', act.kind === k ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-100' : 'border-base text-muted')}>
                    <Icon className="size-3.5" />{k}
                  </button>
                );
              })}
            </div>
            <Input aria-label="Subject" placeholder={act.kind === 'call' ? 'Call to confirm requirements' : 'What needs to happen?'} value={act.subject} onChange={(e) => setAct((s) => ({ ...s, subject: e.target.value }))} />
            <div className="grid gap-2 sm:grid-cols-3">
              <Input aria-label="Due" type="datetime-local" value={toLocalInput(act.dueAt)} onChange={(e) => setAct((s) => ({ ...s, dueAt: fromLocalInput(e.target.value) ?? '' }))} />
              <UserSelect value={act.assigneeId} onChange={(v) => setAct((s) => ({ ...s, assigneeId: v }))} />
              <Select aria-label="Reminder" value={act.reminder} onChange={(e) => setAct((s) => ({ ...s, reminder: e.target.value }))}>
                <option value="">No reminder</option><option value="0">At due time</option><option value="15">15 min before</option><option value="60">1 hour before</option><option value="1440">1 day before</option>
              </Select>
            </div>
            <div className="flex justify-end"><Button variant="primary" size="sm" loading={saving} disabled={!act.subject.trim()}
              onClick={async () => {
                const ok = await run(() => api.post('/activities', {
                  kind: act.kind, subject: act.subject, dueAt: act.dueAt || null, assigneeId: act.assigneeId,
                  reminderMinutesBefore: act.reminder === '' || !act.dueAt ? null : Number(act.reminder), links: link,
                }), 'Activity scheduled');
                if (ok) setAct((s) => ({ ...s, subject: '', dueAt: tomorrow9() }));
              }}>Schedule</Button></div>
          </>
        )}
        {tab === 'call' && (
          <>
            <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
              <Input aria-label="Subject" value={call.subject} onChange={(e) => setCall((s) => ({ ...s, subject: e.target.value }))} />
              <Select aria-label="Direction" value={call.direction} onChange={(e) => setCall((s) => ({ ...s, direction: e.target.value }))}>
                <option value="outbound">Outgoing</option><option value="inbound">Incoming</option>
              </Select>
            </div>
            <Select aria-label="Outcome" value={call.outcome} onChange={(e) => setCall((s) => ({ ...s, outcome: e.target.value }))}>
              <option value="">Outcome…</option>
              {['Connected', 'Left voicemail', 'No answer', 'Wrong number', 'Busy'].map((o) => <option key={o}>{o}</option>)}
            </Select>
            <Textarea aria-label="Call notes" placeholder="What was discussed?" value={call.description} onChange={(e) => setCall((s) => ({ ...s, description: e.target.value }))} rows={2} />
            <div className="flex justify-end"><Button variant="primary" size="sm" loading={saving} disabled={!call.subject.trim()}
              onClick={async () => {
                const ok = await run(() => api.post('/activities', {
                  kind: 'call', subject: call.subject, outcome: call.outcome || null, direction: call.direction, description: call.description || null,
                  status: 'done', dueAt: new Date().toISOString(), links: link,
                }), 'Call logged');
                if (ok) setCall({ subject: 'Call', outcome: '', direction: 'outbound', description: '' });
              }}>Log call</Button></div>
          </>
        )}
        {err && <p className="text-sm text-rose-600" role="alert">{err}</p>}
      </div>
    </Card>
  );
}

export function UpcomingRow({ a, onChange, showLinks }: { a: Activity; onChange: () => void; showLinks?: boolean }) {
  const due = dueLabel(a.dueAt);
  const Icon = ACTIVITY_ICON[a.kind] ?? CheckSquare;
  const [busy, setBusy] = useState(false);
  const complete = async () => {
    setBusy(true);
    try {
      await api.patch(`/activities/${a.id}`, { status: 'done' });
      onChange();
      toast.success('Marked as done', { action: { label: 'Undo', onClick: async () => { await api.patch(`/activities/${a.id}`, { status: 'open' }); onChange(); } } });
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    try { await api.del(`/activities/${a.id}`); onChange(); toast.success('Activity deleted'); } catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <button type="button" disabled={busy} onClick={complete} aria-label={`Complete ${a.subject}`} className="mt-0.5 text-muted hover:text-emerald-600"><Circle className="size-[18px]" /></button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium"><Icon className="size-3.5 shrink-0 text-muted" /><span className="truncate">{a.subject}</span></div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
          <span className={cn(due.tone === 'overdue' ? 'font-medium text-rose-600' : due.tone === 'today' ? 'font-medium text-amber-600' : 'text-muted')}>{due.tone === 'overdue' ? `Overdue · ${due.text}` : due.text}</span>
          {a.assigneeName && <span className="text-muted">· {a.assigneeName}</span>}
          {showLinks && a.links.map((l) => <span key={`${l.entityType}${l.entityId}`} className="text-muted">· {l.title}</span>)}
        </div>
      </div>
      <IconButton size="sm" label="Delete activity" onClick={remove}><Trash2 className="size-3.5" /></IconButton>
    </li>
  );
}

const FIELD_LABELS: Record<string, string> = {
  first_name: 'First name', last_name: 'Last name', job_title: 'Job title', owner_id: 'Owner', amount: 'Amount', title: 'Title', name: 'Name',
  expected_close_date: 'Expected close', probability: 'Probability', company_id: 'Company', company_name: 'Company name', source_id: 'Source',
  type_id: 'Type', industry_id: 'Industry', size_id: 'Size', description: 'Description', visibility: 'Visibility', custom: 'Custom fields',
  methods: 'Contact details', contacts: 'Contacts', amount_mode: 'Amount mode', lineItems: 'Products', primary_company_id: 'Company',
  deal_type_id: 'Deal type', address: 'Address', annual_revenue: 'Annual revenue', birthday: 'Birthday', currency: 'Currency', source_details: 'Source details',
};

function describeEvent(d: Record<string, any>, userName: (id: number) => string): { icon: typeof History; text: string; tone?: string } {
  const ch = d.changes ?? {};
  const stage = Array.isArray(ch.stage) ? ch.stage : null;
  switch (d.action) {
    case 'created': return { icon: Flag, text: `${d.entityType[0].toUpperCase()}${d.entityType.slice(1)} created${ch.fromLead ? ' from a lead' : ''}${stage?.[1] ? ` in ${stage[1]}` : ''}` };
    case 'stage_changed': return { icon: ArrowRightLeft, text: `Stage: ${stage?.[0]} → ${stage?.[1]}` };
    case 'won': return { icon: CheckCircle2, text: `Deal won${stage?.[1] ? ` (${stage[1]})` : ''}`, tone: 'text-emerald-600' };
    case 'lost': return { icon: Flag, text: `Deal lost${ch.lostReason?.[1] ? ` — ${ch.lostReason[1]}` : ''}`, tone: 'text-rose-600' };
    case 'converted': return { icon: CheckCircle2, text: 'Lead converted', tone: 'text-emerald-600' };
    case 'disqualified': return { icon: Flag, text: 'Lead disqualified', tone: 'text-rose-600' };
    case 'reopened': return { icon: ArrowRightLeft, text: `Reopened in ${stage?.[1]}` };
    case 'deleted': return { icon: Trash2, text: 'Moved to recycle bin' };
    case 'restored': return { icon: History, text: 'Restored from recycle bin' };
    case 'owner_changed': return { icon: Users, text: `Owner changed to ${userName(Number(ch.owner?.[1]))}` };
    case 'updated': {
      const parts = Object.entries(ch).map(([k, v]) => {
        const label = FIELD_LABELS[k] ?? k;
        const [, to] = (v as [unknown, unknown]) ?? [];
        if (k === 'owner_id') return `${label} → ${userName(Number(to))}`;
        if (k === 'amount') return `${label} → ${money(String(to))}`;
        if (typeof to === 'string' && to.length < 40 && !['custom', 'methods'].includes(k)) return `${label} → ${to}`;
        return label;
      });
      return { icon: History, text: `Updated ${parts.join(', ')}` };
    }
    default: return { icon: History, text: d.action.replace(/_/g, ' ') };
  }
}

function FeedItem({ it, recordType, recordId, onChange }: { it: TimelineItem; recordType: string; recordId: number; onChange: () => void }) {
  const { data: meta } = useMeta();
  const userName = (id: number) => meta?.users.find((u) => u.id === id)?.name ?? 'Unknown';
  const d = it.data;
  const foreign = d.entityType && (d.entityType !== recordType || Number(d.entityId) !== recordId);
  const via = foreign ? <span className="text-muted"> · on related {d.entityType}</span> : null;
  if (it.type === 'note') {
    const toggle = async () => { try { await api.patch(`/notes/${d.id}`, { isPinned: !d.isPinned }); onChange(); } catch (e) { toast.error(errorMessage(e)); } };
    const del = async () => { try { await api.del(`/notes/${d.id}`); onChange(); toast.success('Note deleted'); } catch (e) { toast.error(errorMessage(e)); } };
    return (
      <li className="group flex gap-3 border-b border-base py-3 last:border-0">
        {d.authorType === 'automation' ? <span className="flex size-8 items-center justify-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-200"><Bot className="size-4" /></span> : <Avatar name={d.authorName} />}
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted"><span className="font-medium text-[var(--text)]">{d.authorType === 'automation' ? 'Automation' : d.authorName}</span> · {relative(d.createdAt)}{via}{d.isPinned && <span className="ml-1 text-amber-600">· pinned</span>}</div>
          <p className={cn('mt-1 whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm', d.isPinned ? 'bg-amber-50 dark:bg-amber-500/10' : 'bg-[var(--surface-2)]')}>{d.body}</p>
        </div>
        <div className="flex flex-col opacity-60 group-hover:opacity-100 max-md:opacity-100">
          <IconButton size="sm" label={d.isPinned ? 'Unpin' : 'Pin'} onClick={toggle}>{d.isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}</IconButton>
          <IconButton size="sm" label="Delete note" onClick={del}><Trash2 className="size-3.5" /></IconButton>
        </div>
      </li>
    );
  }
  if (it.type === 'activity') {
    const Icon = ACTIVITY_ICON[d.kind as keyof typeof ACTIVITY_ICON] ?? CheckSquare;
    return (
      <li className="flex gap-3 border-b border-base py-3 last:border-0">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200"><Icon className="size-4" /></span>
        <div className="min-w-0 flex-1 text-sm">
          <div><span className="font-medium">{d.subject}</span> <span className="text-xs text-muted">· {d.status === 'done' ? 'completed' : d.status} {relative(d.completedAt ?? d.updatedAt)}{via}</span></div>
          {(d.outcome || d.description) && <p className="mt-0.5 whitespace-pre-wrap text-[13px] text-muted">{[d.outcome, d.description].filter(Boolean).join(' — ')}</p>}
          <div className="text-xs text-muted">{d.assigneeName}{d.dueAt ? ` · due ${dateTime(d.dueAt)}` : ''}</div>
        </div>
      </li>
    );
  }
  const ev = describeEvent(d, userName);
  const Icon = ev.icon;
  return (
    <li className="flex gap-3 border-b border-base py-2.5 last:border-0">
      <span className="flex size-8 shrink-0 items-center justify-center"><Icon className={cn('size-4 text-muted', ev.tone)} /></span>
      <div className="min-w-0 flex-1 pt-1.5 text-[13px]">
        <span className={cn(ev.tone)}>{ev.text}</span>
        <span className="text-xs text-muted"> · {d.actorType === 'automation' ? 'Automation' : d.actorName ?? 'System'} · {relative(d.createdAt)}</span>{via}
      </div>
    </li>
  );
}
