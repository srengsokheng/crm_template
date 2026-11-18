import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Megaphone, MessageCircle, Send } from 'lucide-react';
import { toast } from 'sonner';
import { ct, personalize, type CustomerLanguage } from '@crm/shared';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { dateTime, fromLocalInput, number, relative } from '../../lib/format.ts';
import { useDebounced, useDict, useMe } from '../../lib/hooks.ts';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, PageHeader, Segmented, Select, Skeleton, Spinner, Textarea } from '../../components/ui/primitives.tsx';
import { ConfirmDialog, Dialog } from '../../components/ui/overlays.tsx';
import { FeedList, useFeed } from '../../components/ui/FeedList.tsx';

type Kind = 'telegram_bot' | 'whatsapp' | 'email';
type Status = 'draft' | 'scheduled' | 'sending' | 'sent' | 'canceled';
interface TemplateRef { name: string; language: string; params: string[] }
interface Broadcast {
  id: number; name: string; channelKind: Kind; channelId: number | null; channelName: string | null; subject: string; body: string;
  template: TemplateRef | null; contactTypeId: number | null; status: Status; sendAt: string | null; sentAt: string | null; createdAt: string;
  createdByName: string | null; recipients: number; stats?: { total: number; sending: number; delivered: number; failed: number; skipped: number };
}
interface Channel { id: number; kind: string; name: string; status: string }
interface Template { name: string; language: string; category: string; header: string | null; body: string; footer: string | null; params: number }
interface Recipient { id: number; name: string; address: string; status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped'; error: string | null; conversationId: number | null; contactId: number | null }

const KIND_LABEL: Record<Kind, string> = { telegram_bot: 'Telegram', whatsapp: 'WhatsApp', email: 'Email' };
const STATUS: Record<Status, { label: string; tone: 'slate' | 'brand' | 'green' | 'amber' | 'red' }> = {
  draft: { label: 'Draft', tone: 'slate' }, scheduled: { label: 'Scheduled', tone: 'brand' }, sending: { label: 'Sending', tone: 'amber' },
  sent: { label: 'Sent', tone: 'green' }, canceled: { label: 'Stopped', tone: 'red' },
};
const KindIcon = ({ kind }: { kind: Kind }) => (kind === 'email' ? <Mail className="size-4" aria-hidden="true" /> : <MessageCircle className="size-4" aria-hidden="true" />);
const linkCls = 'text-brand-600 underline underline-offset-2 dark:text-brand-200';

function AdminsOnly() {
  return <EmptyState icon={<Megaphone className="size-5" />} title="Only admins can send broadcasts" description="Ask an admin of your workspace if you need to message many customers at once." />;
}

/** /broadcasts: the list, newest first. */
export function BroadcastsPage() {
  const { data: me } = useMe();
  const nav = useNavigate();
  const isAdmin = !!me?.role.isAdmin;
  const feed = useFeed<Broadcast>(['broadcasts'], '/broadcasts', {}, { enabled: isAdmin, refetchInterval: 10_000 });
  if (me && !isAdmin) return <AdminsOnly />;
  const create = <Button variant="primary" icon={<Megaphone className="size-4" />} onClick={() => nav('/broadcasts/new')}>New broadcast</Button>;
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Broadcasts" subtitle="One message to many customers: through your Telegram bot, WhatsApp, or email." actions={create} />
      <Card padded={false}>
        <FeedList feed={feed} label="Broadcasts" empty={{ icon: <Megaphone className="size-5" />, title: 'No broadcasts yet',
          description: 'Tell customers about new stock, an offer or a holiday closing. People who reply STOP or unsubscribe are never included.', action: create }}>
          {(items) => items.map((b) => (
            <li key={b.id}>
              <Link to={`/broadcasts/${b.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--surface-2)]">
                <span className="rounded-full bg-[var(--surface-2)] p-2 text-muted"><KindIcon kind={b.channelKind} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{b.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {b.channelKind === 'email' ? 'Email' : `${KIND_LABEL[b.channelKind]} · ${b.channelName ?? 'removed channel'}`}
                    {' · '}{b.status === 'scheduled' ? `for ${dateTime(b.sendAt)}` : b.sentAt ? relative(b.sentAt) : b.status === 'draft' ? `edited ${relative(b.createdAt)}` : relative(b.sendAt)}
                    {b.recipients ? ` · ${number(b.recipients)} ${b.recipients === 1 ? 'person' : 'people'}` : ''}
                  </span>
                </span>
                <Badge tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Badge>
              </Link>
            </li>
          ))}
        </FeedList>
      </Card>
    </div>
  );
}

/** /broadcasts/new and /broadcasts/:id — drafts open in the editor, the rest show progress. */
export function BroadcastRoute() {
  const { data: me } = useMe();
  const id = useParams().id;
  const isNew = id === undefined;
  const q = useQuery({ queryKey: ['broadcast', Number(id)], enabled: !isNew && !!me?.role.isAdmin, queryFn: () => api.get<Broadcast>(`/broadcasts/${id}`),
    refetchInterval: (query) => (query.state.data?.status === 'sending' || query.state.data?.status === 'scheduled' ? 3000 : false) });
  const [editing, setEditing] = useState(false);
  if (me && !me.role.isAdmin) return <AdminsOnly />;
  if (isNew) return <BroadcastEditor />;
  if (q.isLoading) return <div className="mx-auto max-w-3xl space-y-3"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-64" /></div>;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />;
  const b = q.data!;
  if (b.status === 'draft' || editing) return <BroadcastEditor initial={b} onDone={() => setEditing(false)} />;
  return <BroadcastDetail b={b} onEdit={() => setEditing(true)} />;
}

const blank = { name: '', channel: 'email', subject: '', body: '', contactTypeId: '', template: '', params: [] as string[] };

function BroadcastEditor({ initial, onDone }: { initial?: Broadcast; onDone?: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const types = useDict('contact_type');
  const channels = useQuery({ queryKey: ['channels'], queryFn: () => api.get<{ data: Channel[] }>('/channels') });
  const usable = (channels.data?.data ?? []).filter((c) => c.kind === 'telegram_bot' || c.kind === 'whatsapp');
  const [f, setF] = useState(() => initial ? {
    name: initial.name, channel: initial.channelKind === 'email' ? 'email' : String(initial.channelId), subject: initial.subject, body: initial.body,
    contactTypeId: initial.contactTypeId ? String(initial.contactTypeId) : '', template: initial.template ? `${initial.template.name}|${initial.template.language}` : '',
    params: initial.template?.params ?? [],
  } : blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'' | 'save' | 'send'>('');
  const [sendOpen, setSendOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const ch = usable.find((c) => String(c.id) === f.channel);
  const kind: Kind = f.channel === 'email' ? 'email' : (ch?.kind as Kind | undefined) ?? 'telegram_bot';

  const templates = useQuery({ queryKey: ['broadcast-templates', ch?.id], enabled: kind === 'whatsapp' && !!ch, retry: false,
    queryFn: () => api.get<{ data: Template[] }>(`/broadcasts/templates?channelId=${ch!.id}`) });
  const tpl = templates.data?.data.find((t) => `${t.name}|${t.language}` === f.template);
  useEffect(() => { if (tpl && f.params.length !== tpl.params) setF((v) => ({ ...v, params: Array.from({ length: tpl.params }, (_, i) => v.params[i] ?? '') })); }, [tpl, f.params.length]);

  const audKey = useDebounced(`${kind}|${ch?.id ?? ''}|${f.contactTypeId}`, 200);
  const audience = useQuery({ queryKey: ['broadcast-audience', audKey], enabled: kind === 'email' || !!ch, staleTime: 0, refetchOnMount: 'always',
    queryFn: () => { const [k, c, t] = audKey.split('|'); return api.get<{ count: number; optedOut: number }>(`/broadcasts/audience?channelKind=${k}&channelId=${c}&contactTypeId=${t}`); } });

  const payload = () => ({
    name: f.name, channelKind: kind, channelId: kind === 'email' ? null : Number(f.channel), subject: kind === 'email' ? f.subject : '',
    body: kind === 'whatsapp' ? '' : f.body, contactTypeId: kind === 'email' && f.contactTypeId ? Number(f.contactTypeId) : null,
    template: kind === 'whatsapp' && tpl ? { name: tpl.name, language: tpl.language, params: f.params } : null,
  });
  const save = async (): Promise<Broadcast | null> => {
    setErrors({});
    try {
      const saved = initial ? await api.put<Broadcast>(`/broadcasts/${initial.id}`, payload()) : await api.post<Broadcast>('/broadcasts', payload());
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
      qc.setQueryData(['broadcast', saved.id], saved);
      return saved;
    } catch (e) {
      if (e instanceof ApiError && e.fields) setErrors(Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k.split('.')[0], v])));
      toast.error(errorMessage(e));
      return null;
    }
  };
  const saveDraft = async () => {
    setBusy('save');
    const saved = await save();
    setBusy('');
    if (!saved) return;
    toast.success('Draft saved');
    onDone?.();
    if (!initial) nav(`/broadcasts/${saved.id}`, { replace: true });
  };
  const send = async (sendAt: string | null) => {
    setBusy('send');
    try {
      const saved = await save();
      if (!saved) return;
      const out = await api.post<Broadcast>(`/broadcasts/${saved.id}/send`, { sendAt });
      qc.setQueryData(['broadcast', out.id], out);
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
      toast.success(sendAt ? `Scheduled for ${dateTime(sendAt)}` : 'Sending started');
      setSendOpen(false);
      onDone?.();
      nav(`/broadcasts/${out.id}`, { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.fields) setErrors(Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k.split('.')[0], v])));
      toast.error(errorMessage(e));
    } finally { setBusy(''); }
  };

  const sampleName = 'Dara Sok';
  const preview = kind === 'whatsapp'
    ? (tpl ? [tpl.header, tpl.body.replace(/\{\{(\d+)\}\}/g, (m, n) => personalize(f.params[Number(n) - 1] || m, sampleName)), tpl.footer].filter(Boolean).join('\n\n') : '')
    : personalize(f.body, sampleName);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={initial ? initial.name || 'Broadcast' : 'New broadcast'} subtitle={<Link className={linkCls} to="/broadcasts">All broadcasts</Link>}
        actions={<>
          {initial && <Button variant="ghost" onClick={() => setDeleting(true)}>Delete</Button>}
          <Button disabled={!!busy} onClick={saveDraft}>{busy === 'save' ? 'Saving…' : 'Save draft'}</Button>
          <Button variant="primary" icon={<Send className="size-4" />} disabled={!!busy || !audience.data?.count} onClick={() => setSendOpen(true)}>Send…</Button>
        </>} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <div className="space-y-4">
            <Field label="Name (only your team sees it)" htmlFor="bc-name" required error={errors.name}>
              <Input id="bc-name" maxLength={120} value={f.name} placeholder="e.g. November offer" onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
            <Field label="Send through" htmlFor="bc-channel" error={errors.channelId}
              hint={kind === 'telegram_bot' ? 'Everyone who chatted with this bot privately.' : kind === 'whatsapp' ? 'Everyone who messaged this WhatsApp number. Meta only allows approved templates here.' : 'Contacts with an email address. Each email has an unsubscribe link.'}>
              <Select id="bc-channel" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value, template: '', params: [] })}>
                <option value="email">Email</option>
                {usable.map((c) => <option key={c.id} value={c.id} disabled={c.status !== 'active'}>{KIND_LABEL[c.kind as Kind]} · {c.name}{c.status !== 'active' ? ' (disabled)' : ''}</option>)}
              </Select>
            </Field>
            {channels.isSuccess && usable.length === 0 && (
              <p className="text-xs text-muted">To broadcast on Telegram or WhatsApp, connect them in <Link className={linkCls} to="/settings/channels">Settings → Channels</Link>. Messenger and Instagram can’t be used: Meta doesn’t allow marketing messages there.</p>
            )}
            {kind === 'email' && (
              <>
                <Field label="Contacts" htmlFor="bc-type" error={errors.contactTypeId}>
                  <Select id="bc-type" value={f.contactTypeId} onChange={(e) => setF({ ...f, contactTypeId: e.target.value })}>
                    <option value="">All contacts with an email address</option>
                    {types.map((t) => <option key={t.id} value={t.id}>Only {t.label}</option>)}
                  </Select>
                </Field>
                <Field label="Subject" htmlFor="bc-subject" required error={errors.subject}>
                  <Input id="bc-subject" maxLength={200} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
                </Field>
              </>
            )}
            {kind !== 'whatsapp' ? (
              <Field label="Message" htmlFor="bc-body" required error={errors.body} hint="{{first_name}} and {{name}} are replaced with each person’s name.">
                <Textarea id="bc-body" rows={8} maxLength={4000} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
              </Field>
            ) : templates.isLoading ? <Skeleton className="h-10" />
              : templates.isError ? <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-100" role="alert">{errorMessage(templates.error)} <Link className={linkCls} to="/settings/channels">Open channel settings</Link></p>
              : (
                <>
                  <Field label="Approved template" htmlFor="bc-tpl" required error={errors.template}
                    hint={templates.data?.data.length ? 'Templates are written and approved in WhatsApp Manager.' : 'No approved templates yet. Create one in WhatsApp Manager; approval usually takes minutes.'}>
                    <Select id="bc-tpl" value={f.template} onChange={(e) => setF({ ...f, template: e.target.value, params: [] })}>
                      <option value="">Pick a template…</option>
                      {templates.data?.data.map((t) => <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>{t.name} ({t.language}){t.category ? ` · ${t.category.toLowerCase()}` : ''}</option>)}
                    </Select>
                  </Field>
                  {tpl && tpl.params > 0 && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {f.params.map((p, i) => (
                        <Field key={i} label={`Blank {{${i + 1}}}`} htmlFor={`bc-p${i}`} required hint={i === 0 ? 'Use {{first_name}} for each person’s name' : undefined}>
                          <Input id={`bc-p${i}`} maxLength={1000} value={p} onChange={(e) => setF({ ...f, params: f.params.map((x, j) => (j === i ? e.target.value : x)) })} />
                        </Field>
                      ))}
                    </div>
                  )}
                </>
              )}
          </div>
        </Card>
        <div className="space-y-4">
          <Card title="Who gets it">
            {audience.isLoading ? <Skeleton className="h-10" /> : audience.isError ? <p className="text-sm text-rose-600" role="alert">{errorMessage(audience.error)}</p> : audience.data ? (
              <div aria-live="polite">
                <p className="text-2xl font-semibold tabular-nums">{number(audience.data.count)} <span className="text-sm font-normal text-muted">{audience.data.count === 1 ? 'person' : 'people'}</span></p>
                <p className="mt-1 text-xs text-muted">{audience.data.optedOut ? `${number(audience.data.optedOut)} opted out and won’t get it.` : 'Nobody opted out.'} {kind === 'email' ? 'Unsubscribe link in every email.' : 'Replying STOP opts out.'}</p>
                {audience.data.count === 0 && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{kind === 'email' ? 'No contact has an email address yet.' : 'Nobody has messaged this channel yet.'}</p>}
              </div>
            ) : <p className="text-sm text-muted">Pick a channel.</p>}
          </Card>
          <Card title="Preview">
            {preview ? (
              <div className="space-y-2">
                {kind === 'email' && <p className="text-sm font-semibold">{personalize(f.subject, sampleName) || 'No subject'}</p>}
                <p className="whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-2)] px-3 py-2 text-sm">{preview}</p>
                <p className="text-xs text-muted">As {sampleName} would see it.</p>
              </div>
            ) : <p className="text-sm text-muted">{kind === 'whatsapp' ? 'Pick a template to see it.' : 'Write the message to see it.'}</p>}
          </Card>
        </div>
      </div>
      <SendDialog open={sendOpen} onOpenChange={setSendOpen} people={audience.data?.count ?? 0} busy={busy === 'send'} onSend={send} />
      {initial && (
        <ConfirmDialog open={deleting} onOpenChange={setDeleting} title="Delete this draft?" description="It was never sent, so nobody is affected." danger confirmLabel="Delete"
          onConfirm={async () => {
            setDeleting(false);
            try { await api.del(`/broadcasts/${initial.id}`); qc.invalidateQueries({ queryKey: ['broadcasts'] }); toast.success('Draft deleted'); nav('/broadcasts'); } catch (e) { toast.error(errorMessage(e)); }
          }} />
      )}
    </div>
  );
}

function SendDialog({ open, onOpenChange, people, busy, onSend }: { open: boolean; onOpenChange: (v: boolean) => void; people: number; busy: boolean; onSend: (sendAt: string | null) => void }) {
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const soon = new Date(Date.now() + 5 * 60_000);
  const min = new Date(soon.getTime() - soon.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const later = when === 'later';
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Send to ${number(people)} ${people === 1 ? 'person' : 'people'}?`}
      description="Once it’s sent it can’t be taken back. You can stop it while it’s still going out."
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" disabled={busy || (later && !at)} onClick={() => onSend(later ? fromLocalInput(at) : null)}>{busy ? 'Working…' : later ? 'Schedule' : 'Send now'}</Button></>}>
      <div className="space-y-3">
        <Segmented value={when} onChange={setWhen} options={[{ value: 'now', label: 'Now' }, { value: 'later', label: 'Later' }]} />
        {later && <Field label="Send at" htmlFor="bc-at" hint="Your local time"><Input id="bc-at" type="datetime-local" min={min} value={at} onChange={(e) => setAt(e.target.value)} /></Field>}
      </div>
    </Dialog>
  );
}

function BroadcastDetail({ b, onEdit }: { b: Broadcast; onEdit: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [stopping, setStopping] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const s = b.stats ?? { total: 0, sending: 0, delivered: 0, failed: 0, skipped: 0 };
  const pct = (n: number) => (s.total ? Math.round((n / s.total) * 100) : 0);
  const refresh = (out?: Broadcast) => { if (out) qc.setQueryData(['broadcast', b.id], out); qc.invalidateQueries({ queryKey: ['broadcasts'] }); qc.invalidateQueries({ queryKey: ['broadcast-recipients', b.id] }); };
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title={b.name} subtitle={<span className="flex flex-wrap items-center gap-2"><Link className={linkCls} to="/broadcasts">All broadcasts</Link><Badge tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Badge></span>}
        actions={<>
          {b.status === 'canceled' && <Button variant="ghost" onClick={() => setDeleting(true)}>Delete</Button>}
          {b.status === 'scheduled' && <Button onClick={onEdit}>Edit</Button>}
          {(b.status === 'scheduled' || b.status === 'sending') && <Button variant="danger" onClick={() => setStopping(true)}>Stop</Button>}
        </>} />
      <p className="flex items-start gap-2 text-sm text-muted">
        <span className="mt-0.5 shrink-0"><KindIcon kind={b.channelKind} /></span><span className="min-w-0">{b.channelKind === 'email' ? 'Email' : `${KIND_LABEL[b.channelKind]} · ${b.channelName ?? 'removed channel'}`}
          {' · '}{b.status === 'scheduled' ? `Goes out ${dateTime(b.sendAt)}` : b.sentAt ? `Finished ${dateTime(b.sentAt)}` : b.sendAt ? `Started ${dateTime(b.sendAt)}` : ''}
          {b.createdByName ? ` · by ${b.createdByName}` : ''}</span>
      </p>
      {b.status !== 'scheduled' && (
        <Card>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[['People', s.total, ''], ['Delivered', s.delivered, 'text-emerald-700 dark:text-emerald-300'], ['Failed', s.failed, s.failed ? 'text-rose-700 dark:text-rose-300' : ''], ['Still sending', s.sending, '']].map(([label, n, cls]) => (
              <div key={label as string}><p className="text-xs text-muted">{label}</p><p className={cn('text-xl font-semibold tabular-nums', cls as string)}>{number(n as number)}</p></div>
            ))}
          </div>
          {s.total > 0 && (
            <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-[var(--surface-2)]" role="img" aria-label={`${pct(s.delivered)}% delivered, ${pct(s.failed)}% failed`}>
              <div className="bg-emerald-500" style={{ width: `${pct(s.delivered)}%` }} />
              <div className="bg-rose-500" style={{ width: `${pct(s.failed)}%` }} />
            </div>
          )}
          {s.skipped > 0 && <p className="mt-2 text-xs text-muted">{number(s.skipped)} not sent (stopped, opted out or deleted meanwhile).</p>}
          {b.channelKind === 'email' && <p className="mt-2 text-xs text-muted">Email “delivered” means handed to your mail server; bounces show up in your mailbox.</p>}
        </Card>
      )}
      <Card title="Message">
        {b.channelKind === 'email' && <p className="mb-2 text-sm font-semibold">{b.subject}</p>}
        {b.template ? <p className="text-sm">Template <span className="font-medium">{b.template.name}</span> ({b.template.language}){b.template.params.length ? ` · ${b.template.params.join(' · ')}` : ''}</p>
          : <p className="whitespace-pre-wrap break-words text-sm">{b.body}</p>}
      </Card>
      {b.status !== 'scheduled' && <Recipients b={b} />}
      <ConfirmDialog open={stopping} onOpenChange={setStopping} danger confirmLabel="Stop"
        title={b.status === 'scheduled' ? 'Stop this scheduled broadcast?' : 'Stop sending?'}
        description={b.status === 'scheduled' ? 'Nobody will get it.' : 'People who already got it keep it; the rest won’t get it.'}
        onConfirm={async () => { setStopping(false); try { refresh(await api.post<Broadcast>(`/broadcasts/${b.id}/cancel`)); toast.success('Stopped'); } catch (e) { toast.error(errorMessage(e)); } }} />
      <ConfirmDialog open={deleting} onOpenChange={setDeleting} danger confirmLabel="Delete" title="Delete this broadcast?" description="Its record and list of people are removed. Messages already delivered stay in the conversations."
        onConfirm={async () => { setDeleting(false); try { await api.del(`/broadcasts/${b.id}`); refresh(); nav('/broadcasts'); } catch (e) { toast.error(errorMessage(e)); } }} />
    </div>
  );
}

const R_STATUS: Record<Recipient['status'], { label: string; tone: 'slate' | 'green' | 'amber' | 'red' }> = {
  pending: { label: 'Waiting', tone: 'slate' }, sending: { label: 'Sending', tone: 'amber' }, sent: { label: 'Delivered', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' }, skipped: { label: 'Not sent', tone: 'slate' },
};

function Recipients({ b }: { b: Broadcast }) {
  const [filter, setFilter] = useState<'all' | 'failed'>('all');
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['broadcast-recipients', b.id, filter, page], refetchInterval: b.status === 'sending' ? 3000 : false,
    queryFn: () => api.get<{ data: Recipient[]; total: number; page: number; pageSize: number }>(`/broadcasts/${b.id}/recipients?page=${page}${filter === 'failed' ? '&status=failed' : ''}`) });
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.pageSize)) : 1;
  return (
    <Card padded={false} title="People" actions={<Segmented size="sm" value={filter} onChange={(v) => { setFilter(v); setPage(1); }} options={[{ value: 'all', label: 'All' }, { value: 'failed', label: 'Failed' }]} />}>
      {q.isLoading ? <div className="space-y-2 p-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
        : q.isError ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        : !q.data!.data.length ? <EmptyState title={filter === 'failed' ? 'Nothing failed' : 'Nobody yet'} description={filter === 'failed' ? undefined : 'People appear here once sending starts.'} />
        : (
          <>
            <ul className="divide-y divide-[var(--border)]" aria-label="People">
              {q.data!.data.map((r) => (
                <li key={r.id} className="flex items-start gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {r.conversationId ? <Link className="hover:underline" to={`/inbox/${r.conversationId}`}>{r.name || 'Unknown'}</Link>
                        : r.contactId ? <Link className="hover:underline" to={`/contacts/${r.contactId}`}>{r.name || r.address}</Link> : (r.name || r.address)}
                    </p>
                    {r.address && <p className="truncate text-xs text-muted">{r.address}</p>}
                    {r.error && r.status !== 'sent' && <p className="text-xs text-rose-700 dark:text-rose-300">{r.error}</p>}
                  </div>
                  <Badge tone={R_STATUS[r.status].tone}>{R_STATUS[r.status].label}</Badge>
                </li>
              ))}
            </ul>
            {pages > 1 && (
              <div className="flex items-center justify-between border-t border-base px-4 py-2 text-xs text-muted">
                <span>{(page - 1) * 50 + 1}–{Math.min(page * 50, q.data!.total)} of {number(q.data!.total)}</span>
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                  <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
                </span>
              </div>
            )}
          </>
        )}
    </Card>
  );
}

/** /unsubscribe/:token — the customer's page from a broadcast email (asks first: mail scanners open links). */
export function UnsubscribePage() {
  const token = useParams().token ?? '';
  const [state, setState] = useState<'idle' | 'busy' | 'out' | 'in' | 'error'>('idle');
  const info = useQuery({ queryKey: ['unsubscribe', token], retry: false, queryFn: async () => {
    const r = await fetch(`/api/v1/public/unsubscribe/${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(r.status === 404 ? 'bad' : 'error');
    return (await r.json()) as { company: string; email: string; unsubscribed: boolean; lang: CustomerLanguage };
  } });
  const lang = info.data?.lang ?? 'en';
  const t = (k: Parameters<typeof ct>[1], vars?: Record<string, string>) => ct(lang, k, vars);
  const post = async (subscribe: boolean) => {
    setState('busy');
    try {
      const r = await fetch(`/api/v1/public/unsubscribe/${encodeURIComponent(token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscribe }) });
      if (!r.ok) throw new Error();
      setState(subscribe ? 'in' : 'out');
    } catch { setState('error'); }
  };
  const out = state === 'out' || (state === 'idle' && info.data?.unsubscribed);
  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--bg)] px-4 py-10" lang={lang === 'en' ? 'en' : 'km'}>
      <div className="surface w-full max-w-md rounded-[var(--radius-card)] border border-base p-6 shadow-xs">
        {info.isLoading ? <div className="flex justify-center py-6"><Spinner /></div>
          : info.isError ? <p className="text-sm" role="alert">{(info.error as Error).message === 'bad' ? `${ct('km', 'unsubBadLink')} ${ct('en', 'unsubBadLink')}` : `${ct('km', 'somethingWrong')} ${ct('en', 'somethingWrong')}`}</p>
          : (
            <div className="space-y-4">
              <h1 className="text-lg font-semibold">{t('unsubTitle', { company: info.data!.company })}</h1>
              {out ? <p className="text-sm" role="status">{t('unsubDone')}</p>
                : state === 'in' ? <p className="text-sm" role="status">{t('unsubResubscribed')}</p>
                : <p className="text-sm text-muted">{t('unsubHelp', { company: info.data!.company, email: info.data!.email })}</p>}
              {state === 'error' && <p className="text-sm text-rose-600" role="alert">{t('somethingWrong')}</p>}
              {out ? <Button onClick={() => void post(true)}>{t('unsubUndo')}</Button>
                : <Button variant="primary" disabled={state === 'busy'} onClick={() => void post(false)}>{state === 'busy' ? t('sending') : t('unsubButton')}</Button>}
            </div>
          )}
      </div>
    </main>
  );
}
