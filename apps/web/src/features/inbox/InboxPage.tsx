import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeft, Camera, Clock, FileText, Globe, Inbox, Link2, MessageCircle, Paperclip, Phone, Video, RotateCcw, Search, Send, UserPlus, Users, X } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { fileSize } from '../records/Attachments.tsx';
import { cn } from '../../lib/cn.ts';
import { dateTime, relative } from '../../lib/format.ts';
import { useCan, useDebounced, useMe, useMediaQuery, useMeta } from '../../lib/hooks.ts';
import { Avatar, Badge, Button, EmptyState, ErrorState, IconButton, Input, Segmented, Select, Spinner, Textarea } from '../../components/ui/primitives.tsx';
import { Dialog } from '../../components/ui/overlays.tsx';
import { usePollInterval, useTyping } from './live.ts';
import { TemplateDialog } from './TemplateDialog.tsx';
import { startCall } from '../calls/CallPages.tsx';
import { FeedList, useFeed } from '../../components/ui/FeedList.tsx';
import { SavedRepliesMenu } from './SavedReplies.tsx';
import { EntityPicker, type PickerItem } from '../../components/ui/EntityPicker.tsx';

import type { ChannelKind } from '@crm/shared';
import { CHANNEL_LABELS, isMetaKind } from '@crm/shared';
interface ConversationItem {
  id: number; channelKind: ChannelKind; channelName: string; kind: 'direct' | 'group'; title: string; status: 'open' | 'closed';
  unread: number; lastMessageAt: string; lastMessagePreview: string; lastDirection: 'in' | 'out';
  assigneeId: number | null; assigneeName: string | null; contactId: number | null; contactName: string | null; leadId: number | null; leadTitle: string | null;
}
interface MessageFile { id: number; fileName: string; contentType: string; sizeBytes: number | null; status: 'pending' | 'stored' | 'too_large' | 'blocked' | 'failed' }
interface Message { id: number; direction: 'in' | 'out'; senderName: string; authorName: string | null; body: string; status: 'received' | 'pending' | 'sent' | 'failed'; error: string | null; createdAt: string; files: MessageFile[]; isTemplate?: boolean }
const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
interface ConversationDetail extends ConversationItem {
  channelStatus: string; botUsername: string | null; profile: { name?: string; username?: string; email?: string; phone?: string };
  canEdit: boolean; canReply: boolean; messages: Message[]; hasOlder: boolean;
}

const CHANNEL_ICONS: Record<ChannelKind, typeof Globe> = { webchat: Globe, telegram_bot: Send, messenger: MessageCircle, instagram: Camera, whatsapp: Phone, telegram_user: Send };
/** The channel's icon; labelled for screen readers unless `decorative` (next to text that already names it). */
export function ChannelIcon({ kind, className, decorative }: { kind: ChannelKind; className?: string; decorative?: boolean }) {
  const Icon = CHANNEL_ICONS[kind] ?? Globe;
  return decorative ? <Icon className={cn('size-3.5', className)} aria-hidden="true" /> : <Icon className={cn('size-3.5', className)} role="img" aria-label={CHANNEL_LABELS[kind] ?? 'Chat'} />;
}

/** Meta delivers replies only within 24 hours of the customer's last message. */
const DAY_MS = 24 * 60 * 60 * 1000;
function ReplyWindowNotice({ kind, messages, conversationId, canReply, customerName, onSent }: { kind: ChannelKind; messages: Message[]; conversationId: number; canReply: boolean; customerName: string; onSent: () => void }) {
  const [templates, setTemplates] = useState(false);
  if (!isMetaKind(kind)) return null;
  const lastIn = [...messages].reverse().find((m) => m.direction === 'in');
  if (!lastIn || Date.now() - new Date(lastIn.createdAt).getTime() < DAY_MS) return null;
  return (
    <div className="flex flex-wrap items-start gap-2 border-t border-base bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-100" role="status">
      <Clock className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        Their last message was more than 24 hours ago. {CHANNEL_LABELS[kind]} only delivers replies within 24 hours of it, so a reply now will probably fail.
        {kind === 'whatsapp' ? ' You can still send an approved template.' : ' Ask them to write again, or contact them another way.'}
      </span>
      {kind === 'whatsapp' && canReply && <Button size="sm" className="shrink-0" onClick={() => setTemplates(true)}>Send a template</Button>}
      {kind === 'whatsapp' && <TemplateDialog conversationId={conversationId} customerName={customerName} open={templates} onOpenChange={setTemplates} onSent={onSent} />}
    </div>
  );
}

export function InboxPage() {
  const { id } = useParams();
  const activeId = id ? Number(id) : null;
  return (
    // Fills the space between the top bar and (on phones) the bottom navigation: undo <main>'s padding.
    <div className="-mx-4 -mb-24 -mt-5 flex h-[calc(100dvh-7rem-env(safe-area-inset-bottom))] min-h-0 md:-mx-6 md:-mb-10 md:h-[calc(100dvh-3.5rem)]">
      <aside className={cn('flex w-full min-w-0 flex-col border-r border-base md:w-[300px] lg:w-[340px] md:shrink-0', activeId && 'max-md:hidden')} aria-label="Conversations">
        <ConversationList activeId={activeId} />
      </aside>
      <section className={cn('flex min-w-0 flex-1 flex-col', !activeId && 'max-md:hidden')} aria-label="Conversation">
        {activeId ? <Thread key={activeId} id={activeId} /> : (
          <div className="grid flex-1 place-items-center"><EmptyState icon={<MessageCircle className="size-5" />} title="Pick a conversation" description="Messages from all your connected channels arrive here." /></div>
        )}
      </section>
    </div>
  );
}

function ConversationList({ activeId }: { activeId: number | null }) {
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const [assignee, setAssignee] = useState<'all' | 'me' | 'unassigned'>('all');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 300);
  const listPoll = usePollInterval(5000);
  const { data: me } = useMe();
  const list = useFeed<ConversationItem>(['inbox', 'list'], '/inbox/conversations', { status, assignee, q: term || undefined }, { refetchInterval: listPoll });
  const channels = useQuery({ queryKey: ['channels'], enabled: !!me?.role.isAdmin, queryFn: () => api.get<{ data: unknown[] }>('/channels') });
  const noChannels = !!me?.role.isAdmin && !!channels.data && channels.data.data.length === 0;
  return (
    <>
      <div className="space-y-2 border-b border-base p-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold">Inbox</h1>
          <Segmented size="sm" value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }]} />
        </div>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <Input aria-label="Search conversations" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-8 text-sm" />
          </div>
          <Select aria-label="Assigned to" value={assignee} onChange={(e) => setAssignee(e.target.value as typeof assignee)} className="h-8 w-[8.5rem] text-sm">
            <option value="all">Everyone</option><option value="me">Mine</option><option value="unassigned">Unassigned</option>
          </Select>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <FeedList feed={list} skeletonRows={4} label="Conversations list"
          empty={noChannels
            ? { icon: <Inbox className="size-5" />, title: 'No channels connected', description: 'Connect your website chat or a Telegram bot, and customer messages will appear here.', action: <Link to="/settings/channels"><Button size="sm" variant="primary">Connect a channel</Button></Link> }
            : { icon: <Inbox className="size-5" />, title: term ? 'No matching conversations' : status === 'open' ? 'No open conversations' : 'No closed conversations', description: term ? 'Try another name or word.' : status === 'open' ? 'New messages from customers will show up here.' : undefined }}>
          {(items) => items.map((c) => (
              <li key={c.id}>
                <Link to={`/inbox/${c.id}`} aria-current={c.id === activeId ? 'page' : undefined}
                  className={cn('flex gap-3 px-3 py-3 hover:bg-[var(--surface-2)]', c.id === activeId && 'bg-brand-50 dark:bg-brand-600/15')}>
                  <span className="relative shrink-0">
                    {c.kind === 'group' ? <span className="grid size-9 place-items-center rounded-full bg-[var(--surface-2)] text-muted"><Users className="size-4" /></span> : <Avatar name={c.title} />}
                    <span className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full border border-base surface text-muted"><ChannelIcon kind={c.channelKind} className="size-2.5" /></span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={cn('truncate text-sm', c.unread ? 'font-semibold' : 'font-medium')}>{c.title}</span>
                      <span className="shrink-0 text-[11px] text-muted">{relative(c.lastMessageAt)}</span>
                    </span>
                    <span className="flex items-center justify-between gap-2">
                      <span className={cn('truncate text-xs', c.unread ? 'text-[var(--text)]' : 'text-muted')}>{c.lastDirection === 'out' && 'You: '}{c.lastMessagePreview}</span>
                      {c.unread > 0 && <span className="shrink-0 rounded-full bg-brand-600 px-1.5 text-[11px] font-semibold text-white" aria-label={`${c.unread} unread`}>{c.unread}</span>}
                    </span>
                    {(c.assigneeName || c.contactName) && (
                      <span className="mt-0.5 block truncate text-[11px] text-muted">{[c.assigneeName && `→ ${c.assigneeName}`, c.contactName].filter(Boolean).join(' · ')}</span>
                    )}
                  </span>
                </Link>
              </li>
          ))}
        </FeedList>
      </div>
    </>
  );
}

function Thread({ id }: { id: number }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const can = useCan();
  const meta = useMeta();
  const threadPoll = usePollInterval(4000);
  const conv = useQuery({ queryKey: ['conversation', id], refetchInterval: threadPoll, queryFn: () => api.get<ConversationDetail>(`/inbox/conversations/${id}`) });
  const d = conv.data;
  // Earlier messages loaded with "Load older messages" (the thread query only returns the latest ones).
  const [older, setOlder] = useState<Message[]>([]);
  const [olderMore, setOlderMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const hasOlder = olderMore ?? !!d?.hasOlder;
  const loadOlder = async () => {
    const first = older[0] ?? d?.messages[0];
    if (!first) return;
    setLoadingOlder(true);
    try {
      const r = await api.get<{ messages: Message[]; hasOlder: boolean }>(`/inbox/conversations/${id}/messages?beforeId=${first.id}`);
      setOlder((o) => [...r.messages, ...o]);
      setOlderMore(r.hasOlder);
    } catch (e) { toast.error(errorMessage(e)); } finally { setLoadingOlder(false); }
  };
  const bottom = useRef<HTMLDivElement>(null);
  const lastId = d?.messages.at(-1)?.id;
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [lastId]);
  // Opening the conversation (or a new message arriving while it's open) marks it read.
  useEffect(() => {
    if (d && d.unread > 0) {
      api.post(`/inbox/conversations/${id}/read`, {}).then(() => { qc.invalidateQueries({ queryKey: ['inbox'] }); qc.invalidateQueries({ queryKey: ['inbox-summary'] }); qc.invalidateQueries({ queryKey: ['notifications'] }); }, () => {});
    }
  }, [d?.unread, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [linkOpen, setLinkOpen] = useState(false);

  const refresh = () => { qc.invalidateQueries({ queryKey: ['conversation', id] }); qc.invalidateQueries({ queryKey: ['inbox'] }); };
  const update = async (body: Record<string, unknown>, ok: string) => {
    try { await api.patch(`/inbox/conversations/${id}`, body); refresh(); toast.success(ok); } catch (e) { toast.error(errorMessage(e)); }
  };

  if (conv.isLoading) return <div className="grid flex-1 place-items-center"><Spinner /></div>;
  if (conv.isError || !d) return <div className="flex-1"><ErrorState message={errorMessage(conv.error)} onRetry={() => conv.refetch()} /></div>;
  const users = (meta.data?.users ?? []).filter((u) => u.status === 'active');
  return (
    <>
      <header className="flex flex-wrap items-center gap-2 border-b border-base px-3 py-2.5 md:px-4">
        <IconButton label="Back to conversations" className="md:hidden" onClick={() => nav('/inbox')}><ArrowLeft className="size-4" /></IconButton>
        <div className="min-w-[10rem] flex-1">
          <h2 className="truncate text-[15px] font-semibold">{d.title}</h2>
          <p className="flex items-center gap-1.5 truncate text-xs text-muted">
            <ChannelIcon kind={d.channelKind} />{d.channelName}
            {d.kind === 'group' && <Badge>Group</Badge>}
            {d.profile.username && <span>@{d.profile.username}</span>}
            {d.profile.email && <span className="truncate">{d.profile.email}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {d.canEdit ? (
            <Select aria-label="Assignee" className="h-8 w-40 text-sm" value={d.assigneeId ?? ''}
              onChange={(e) => update({ assigneeId: e.target.value ? Number(e.target.value) : null }, e.target.value ? 'Assigned' : 'Unassigned')}>
              <option value="">Unassigned</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          ) : d.assigneeName && <span className="text-xs text-muted">Assigned to {d.assigneeName}</span>}
          {d.canEdit && (d.status === 'open'
            ? <Button size="sm" onClick={() => update({ status: 'closed' }, 'Conversation closed')}>Close</Button>
            : <Button size="sm" onClick={() => update({ status: 'open' }, 'Conversation reopened')}>Reopen</Button>)}
        </div>
      </header>
      <div className="flex flex-wrap items-center gap-2 border-b border-base px-3 py-2 text-xs md:px-4">
        {d.contactId ? (
          <span className="flex items-center gap-1">Contact: {d.contactName ? <Link className="font-medium text-brand-600 hover:underline dark:text-brand-200" to={`/contacts/${d.contactId}`}>{d.contactName}</Link> : <span className="text-muted">a contact you can’t see</span>}
            {d.canEdit && <IconButton size="sm" label="Unlink contact" onClick={() => update({ contactId: null }, 'Contact unlinked')}><X className="size-3" /></IconButton>}</span>
        ) : <span className="text-muted">No contact linked</span>}
        {d.leadId && (
          <span className="flex items-center gap-1">· Lead: {d.leadTitle ? <Link className="font-medium text-brand-600 hover:underline dark:text-brand-200" to={`/leads/${d.leadId}`}>{d.leadTitle}</Link> : <span className="text-muted">a lead you can’t see</span>}
            {d.canEdit && <IconButton size="sm" label="Unlink lead" onClick={() => update({ leadId: null }, 'Lead unlinked')}><X className="size-3" /></IconButton>}</span>
        )}
        {d.canEdit && <Button size="sm" variant="ghost" icon={<Link2 className="size-3.5" />} onClick={() => setLinkOpen(true)}>Link…</Button>}
        {d.canReply && d.kind === 'direct' && (
          <Button size="sm" variant="ghost" icon={<Video className="size-3.5" />} onClick={async () => {
            // Start a call and send the customer its link in this conversation, then open the call.
            try {
              const c = await startCall({ conversationId: id });
              await api.post(`/inbox/conversations/${id}/messages`, { body: `Join our video call: ${c.guestUrl}` });
              nav(`/calls/${c.id}`);
            } catch (e) { toast.error(errorMessage(e)); }
          }}>Video call</Button>
        )}
        {d.canEdit && !d.contactId && d.kind === 'direct' && can('contact', 'create') && (
          <Button size="sm" variant="ghost" icon={<UserPlus className="size-3.5" />} onClick={async () => {
            try { const r = await api.post<{ id: number }>(`/inbox/conversations/${id}/contact`, {}); refresh(); toast.success('Contact created', { action: { label: 'Open', onClick: () => nav(`/contacts/${r.id}`) } }); }
            catch (e) { toast.error(errorMessage(e)); }
          }}>Create contact</Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6" aria-live="polite">
        {hasOlder && (
          <div className="mb-3 flex justify-center">
            <Button size="sm" variant="ghost" disabled={loadingOlder} onClick={loadOlder}>{loadingOlder ? 'Loading…' : 'Load older messages'}</Button>
          </div>
        )}
        {d.messages.length === 0 ? <EmptyState title="No messages yet" /> : (
          <ol className="space-y-3">
            {[...older.filter((o) => !d.messages.some((m) => m.id === o.id)), ...d.messages].map((m) => <Bubble key={m.id} m={m} group={d.kind === 'group'} conversationId={id} canRetry={d.canReply} onRetried={refresh} />)}
          </ol>
        )}
        <div ref={bottom} />
      </div>
      <TypingLine conversationId={id} />
      <ReplyWindowNotice kind={d.channelKind} messages={d.messages} conversationId={id} canReply={d.canReply} customerName={d.profile.name || d.title} onSent={refresh} />
      <Composer conversationId={id} canReply={d.canReply} reason={!d.canEdit ? 'You can read this conversation but your role can’t reply.' : d.channelStatus !== 'active' ? 'This channel is disabled or disconnected, so replies can’t be sent.' : ''} onSent={refresh} customerName={d.profile.name || d.title} />
      <LinkDialog open={linkOpen} onOpenChange={setLinkOpen} conversationId={id} onLinked={refresh} />
    </>
  );
}

function Bubble({ m, group, conversationId, canRetry, onRetried }: { m: Message; group: boolean; conversationId: number; canRetry: boolean; onRetried: () => void }) {
  const out = m.direction === 'out';
  const who = out ? m.authorName : group ? m.senderName : '';
  // "[Photo] caption" describes the file for the list preview; with the file shown, only the caption is needed.
  const text = m.files.length ? m.body.replace(/^\[[^\]]*\]\s?/, '') : m.body;
  return (
    <li className={cn('flex flex-col', out ? 'items-end' : 'items-start')}>
      {who && <span className="mb-0.5 px-1 text-[11px] text-muted">{who}</span>}
      {m.files.map((f) => <FileView key={f.id} f={f} out={out} />)}
      {text && <div className={cn('max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm md:max-w-[70%]',
        out ? 'rounded-br-md bg-brand-600 text-white' : 'rounded-bl-md bg-[var(--surface-2)]', m.files.length > 0 && 'mt-1', m.status === 'failed' && 'opacity-70')}>{text}</div>}
      <span className="mt-0.5 flex items-center gap-1 px-1 text-[11px] text-muted" title={dateTime(m.createdAt)}>
        {m.isTemplate && <Badge>Template</Badge>}
        {m.status === 'pending' && <><Clock className="size-3" />Sending…</>}
        {m.status === 'failed' && <span className="flex items-center gap-1 text-rose-600"><AlertCircle className="size-3" />{m.error ?? 'Not sent'}</span>}
        {m.status !== 'pending' && m.status !== 'failed' && relative(m.createdAt)}
        {m.status === 'failed' && canRetry && (
          <button type="button" className="ml-1 inline-flex items-center gap-0.5 font-medium text-brand-600 hover:underline dark:text-brand-200" onClick={async () => {
            try { await api.post(`/inbox/conversations/${conversationId}/messages/${m.id}/retry`, {}); onRetried(); } catch (e) { toast.error(errorMessage(e)); }
          }}><RotateCcw className="size-3" />Retry</button>
        )}
      </span>
    </li>
  );
}

function FileView({ f, out }: { f: MessageFile; out: boolean }) {
  const url = `/api/v1/inbox/files/${f.id}`;
  if (f.status === 'stored' && PREVIEW_TYPES.has(f.contentType)) {
    return <a href={`${url}?inline=1`} target="_blank" rel="noreferrer" className="mb-0.5 block"><img src={`${url}?inline=1`} alt={f.fileName} loading="lazy" className="max-h-60 max-w-[min(15rem,70vw)] rounded-xl border border-base object-cover" /></a>;
  }
  const note = f.status === 'pending' ? 'Downloading…' : f.status === 'too_large' ? `Too large to download${f.sizeBytes ? ` (${fileSize(f.sizeBytes)})` : ''} — open it in the app it was sent from`
    : f.status === 'blocked' ? 'Blocked by the virus scanner' : f.status === 'failed' ? 'Couldn’t be downloaded' : f.sizeBytes !== null ? fileSize(f.sizeBytes) : '';
  const body = <><FileText className="size-4 shrink-0" /><span className="min-w-0"><span className="block truncate font-medium">{f.fileName}</span><span className="block text-xs opacity-80">{note}</span></span></>;
  const cls = cn('mb-0.5 flex max-w-[min(18rem,80vw)] items-center gap-2 rounded-xl border px-3 py-2 text-sm', out ? 'border-brand-600/40' : 'border-base');
  return f.status === 'stored' ? <a href={url} className={cn(cls, 'hover:bg-[var(--surface-2)]')} download>{body}</a> : <div className={cn(cls, 'text-muted')}>{body}</div>;
}

async function uploadReply(conversationId: number, file: File, caption: string) {
  const res = await fetch(`/api/v1/inbox/conversations/${conversationId}/files?fileName=${encodeURIComponent(file.name)}&caption=${encodeURIComponent(caption)}`, {
    method: 'POST', credentials: 'same-origin', body: file,
    headers: { 'x-requested-with': 'crm', 'content-type': 'application/octet-stream', 'x-file-type': file.type || 'application/octet-stream' },
  });
  if (!res.ok) {
    let msg = `Sending the file failed (${res.status})`;
    try { msg = (await res.json()).error?.message ?? msg; } catch { /* not JSON */ }
    if (res.status === 413) msg = 'This file is too large';
    throw new ApiError(res.status, 'UPLOAD_FAILED', msg);
  }
}

/** "Grace is typing…" under the messages (customer, or a colleague replying at the same time). */
function TypingLine({ conversationId }: { conversationId: number }) {
  const t = useTyping(conversationId);
  return (
    <p className="h-5 shrink-0 truncate px-4 text-xs text-muted md:px-6" aria-live="polite">
      {t ? (t.side === 'team' ? `${t.name || 'A colleague'} is also writing a reply…` : `${t.name || 'The customer'} is typing…`) : ''}
    </p>
  );
}

function Composer({ conversationId, canReply, reason, onSent, customerName }: { conversationId: number; canReply: boolean; reason: string; onSent: () => void; customerName: string }) {
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const wide = useMediaQuery('(min-width: 768px)');
  const lastTyping = useRef(0);
  if (!canReply) return <p className="border-t border-base px-4 py-3 text-sm text-muted">{reason}</p>;
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = body.trim();
    if ((!text && !file) || sending) return;
    setSending(true);
    try {
      if (file) await uploadReply(conversationId, file, text);
      else await api.post(`/inbox/conversations/${conversationId}/messages`, { body: text });
      setBody(''); setFile(null); onSent();
    }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setSending(false); }
  };
  /** Tells the customer and colleagues "typing…" (at most every 4 seconds; failures don't matter). */
  const typed = (text: string) => {
    const now = Date.now();
    if (!text.trim() || now - lastTyping.current < 4000) return;
    lastTyping.current = now;
    api.post(`/inbox/conversations/${conversationId}/typing`).catch(() => {});
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  return (
    <form onSubmit={send} className="flex flex-wrap items-end gap-2 border-t border-base p-3">
      {file && (
        <div className="flex w-full items-center gap-2 rounded-md bg-[var(--surface-2)] px-3 py-1.5 text-sm">
          <FileText className="size-4 shrink-0 text-muted" /><span className="min-w-0 flex-1 truncate">{file.name}</span><span className="text-xs text-muted">{fileSize(file.size)}</span>
          <IconButton size="sm" label="Remove file" onClick={() => setFile(null)}><X className="size-3.5" /></IconButton>
        </div>
      )}
      <input ref={picker} type="file" className="hidden" aria-label="File to send" onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
      <IconButton label="Attach a file" onClick={() => picker.current?.click()}><Paperclip className="size-4" /></IconButton>
      <SavedRepliesMenu name={customerName} onInsert={(t) => setBody((b) => (b.trim() ? `${b.trimEnd()}\n${t}` : t))} />
      <Textarea aria-label="Reply" rows={2} maxLength={4000} placeholder={file ? 'Add a caption (optional)' : wide ? 'Write a reply… (Enter to send, Shift+Enter for a new line)' : 'Write a reply…'} value={body}
        onChange={(e) => { setBody(e.target.value); typed(e.target.value); }} onKeyDown={onKey} className="min-h-[2.75rem] min-w-0 flex-1 resize-none" />
      <Button type="submit" variant="primary" disabled={(!body.trim() && !file) || sending} icon={sending ? <Spinner className="size-4 text-white" /> : <Send className="size-4" />}>Send</Button>
    </form>
  );
}

function LinkDialog({ open, onOpenChange, conversationId, onLinked }: { open: boolean; onOpenChange: (v: boolean) => void; conversationId: number; onLinked: () => void }) {
  const { data: me } = useMe();
  const [contact, setContact] = useState<PickerItem | null>(null);
  const [lead, setLead] = useState<PickerItem | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) { setContact(null); setLead(null); } }, [open]);
  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/inbox/conversations/${conversationId}`, { ...(contact ? { contactId: contact.id } : {}), ...(lead ? { leadId: lead.id } : {}) });
      onLinked(); onOpenChange(false); toast.success('Linked');
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Link conversation" description="Linked conversations show on the contact’s or lead’s page."
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" disabled={(!contact && !lead) || saving} onClick={save}>Link</Button></>}>
      <div className="space-y-3">
        <label className="block text-sm font-medium">Contact<div className="mt-1"><EntityPicker entity="contacts" value={contact} onChange={setContact} placeholder="Search contacts…" /></div></label>
        {me?.workspace.useLeads && <label className="block text-sm font-medium">Lead<div className="mt-1"><EntityPicker entity="leads" value={lead} onChange={setLead} placeholder="Search leads…" /></div></label>}
      </div>
    </Dialog>
  );
}
