import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Globe, Plus, Send } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Skeleton, Textarea } from '../../components/ui/primitives.tsx';
import { ConfirmDialog, Dialog } from '../../components/ui/overlays.tsx';
import { AdminOnly } from './SettingsLayout.tsx';

interface Channel {
  id: number; kind: 'webchat' | 'telegram_bot'; name: string; status: 'active' | 'disabled' | 'error'; lastError: string | null; publicKey: string;
  conversationCount: number;
  config: { greeting?: string; color?: string; allowedOrigins?: string[]; username?: string; botName?: string; mode?: 'webhook' | 'polling' };
}

export function ChannelsSettings() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['channels'], queryFn: () => api.get<{ data: Channel[] }>('/channels') });
  const [adding, setAdding] = useState<null | 'webchat' | 'telegram_bot'>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['channels'] }); qc.invalidateQueries({ queryKey: ['inbox'] }); };
  const channels = list.data?.data ?? [];
  return (
    <AdminOnly>
      <div className="space-y-4">
        <Card title="Channels" actions={<div className="flex gap-2">
          <Button size="sm" icon={<Globe className="size-3.5" />} onClick={() => setAdding('webchat')}>Website chat</Button>
          <Button size="sm" icon={<Send className="size-3.5" />} onClick={() => setAdding('telegram_bot')}>Telegram bot</Button>
        </div>}>
          <p className="text-sm text-muted">Messages people send through these channels arrive in the Inbox, where your team replies. Telegram personal accounts, Facebook, Instagram and WhatsApp Business are not available yet.</p>
        </Card>
        {list.isLoading ? <Skeleton className="h-40" /> : list.isError ? <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} /> : channels.length === 0 ? (
          <Card><EmptyState icon={<Plus className="size-5" />} title="No channels yet" description="Add a chat to your website, or connect a Telegram bot, to start receiving messages." /></Card>
        ) : channels.map((c) => <ChannelCard key={c.id} c={c} onChange={refresh} />)}
      </div>
      <AddWebchat open={adding === 'webchat'} onOpenChange={(v) => setAdding(v ? 'webchat' : null)} onAdded={refresh} />
      <AddTelegram open={adding === 'telegram_bot'} onOpenChange={(v) => setAdding(v ? 'telegram_bot' : null)} onAdded={refresh} />
    </AdminOnly>
  );
}

function ChannelCard({ c, onChange }: { c: Channel; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const patch = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try { await api.patch(`/channels/${c.id}`, body); onChange(); toast.success(ok); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const status = c.status === 'active' ? <Badge tone="green">Active</Badge> : c.status === 'error' ? <Badge tone="red">Needs attention</Badge> : <Badge>Disabled</Badge>;
  return (
    <Card title={<span className="flex min-w-0 items-center gap-2">{c.kind === 'webchat' ? <Globe className="size-4 shrink-0" /> : <Send className="size-4 shrink-0" />}<span className="truncate">{c.name}</span>{status}</span>}
      actions={<div className="flex gap-2">
        {c.status === 'active'
          ? <Button size="sm" disabled={busy} onClick={() => patch({ status: 'disabled' }, 'Channel disabled')}>Disable</Button>
          : <Button size="sm" disabled={busy} onClick={() => patch({ status: 'active' }, 'Channel enabled')}>{c.status === 'error' ? 'Reconnect' : 'Enable'}</Button>}
        <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>Delete</Button>
      </div>}>
      {c.lastError && <p className="mb-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300" role="alert">{c.lastError}</p>}
      <p className="mb-3 text-xs text-muted">{c.kind === 'webchat' ? 'Website chat' : 'Telegram bot'} · {c.conversationCount} conversation{c.conversationCount === 1 ? '' : 's'}</p>
      {c.kind === 'webchat' ? <WebchatDetails c={c} save={(b) => patch(b, 'Chat settings saved')} busy={busy} /> : <TelegramDetails c={c} />}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} danger confirmLabel="Delete channel" title={`Delete “${c.name}”?`}
        description={`This also deletes its ${c.conversationCount} conversation${c.conversationCount === 1 ? '' : 's'} and all their messages. It can’t be undone. To stop new messages but keep the history, disable the channel instead.`}
        onConfirm={async () => { try { await api.del(`/channels/${c.id}`); setConfirm(false); onChange(); toast.success('Channel deleted'); } catch (e) { toast.error(errorMessage(e)); } }} />
    </Card>
  );
}

function WebchatDetails({ c, save, busy }: { c: Channel; save: (b: Record<string, unknown>) => void; busy: boolean }) {
  const snippet = `<script src="${window.location.origin}/widget.js" data-key="${c.publicKey}" async></script>`;
  const [greeting, setGreeting] = useState(c.config.greeting ?? '');
  const [color, setColor] = useState(c.config.color ?? '#4f46e5');
  const [origins, setOrigins] = useState((c.config.allowedOrigins ?? []).join('\n'));
  useEffect(() => { setGreeting(c.config.greeting ?? ''); setColor(c.config.color ?? '#4f46e5'); setOrigins((c.config.allowedOrigins ?? []).join('\n')); }, [c.config.greeting, c.config.color, c.config.allowedOrigins]);
  const copy = async () => { try { await navigator.clipboard.writeText(snippet); toast.success('Copied'); } catch { toast.error('Copy failed — select the code and copy it'); } };
  return (
    <div className="space-y-4">
      <Field label="Add this to your website, just before </body>">
        <div className="flex items-start gap-2">
          <code className="block min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md bg-[var(--surface-2)] px-3 py-2 text-xs">{snippet}</code>
          <Button size="sm" icon={<Copy className="size-3.5" />} onClick={copy}>Copy</Button>
        </div>
      </Field>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem]">
        <Field label="Greeting" htmlFor={`g${c.id}`}><Input id={`g${c.id}`} maxLength={300} value={greeting} onChange={(e) => setGreeting(e.target.value)} /></Field>
        <Field label="Colour" htmlFor={`c${c.id}`}><div className="flex items-center gap-2"><input type="color" aria-label="Pick colour" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-10 cursor-pointer rounded border border-base bg-transparent" /><Input id={`c${c.id}`} value={color} onChange={(e) => setColor(e.target.value)} /></div></Field>
      </div>
      <Field label="Allowed websites" htmlFor={`o${c.id}`} hint="One per line, like https://www.example.com. Leave empty to allow any website.">
        <Textarea id={`o${c.id}`} rows={2} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://www.example.com" />
      </Field>
      <div className="flex justify-end">
        <Button variant="primary" disabled={busy} onClick={() => save({ greeting, color, allowedOrigins: origins.split(/\s+/).map((s) => s.trim().replace(/\/$/, '')).filter(Boolean) })}>Save</Button>
      </div>
    </div>
  );
}

function TelegramDetails({ c }: { c: Channel }) {
  return (
    <div className="space-y-2 text-sm">
      {c.config.username && <p>People can message <a className="font-medium text-brand-600 hover:underline dark:text-brand-200" href={`https://t.me/${c.config.username}`} target="_blank" rel="noreferrer">@{c.config.username}</a>, or add it to a group.</p>}
      <p className="text-muted">{c.config.mode === 'webhook' ? 'Telegram sends new messages to this CRM as they arrive.' : 'The CRM checks Telegram for new messages every few seconds (the server has no https address for Telegram to call).'}</p>
      <p className="text-muted">In groups, a bot only sees commands and replies to it. To receive every message in a group, open @BotFather, send /setprivacy, pick this bot and choose Disable, then add it to the group again.</p>
    </div>
  );
}

function AddWebchat({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (v: boolean) => void; onAdded: () => void }) {
  const [name, setName] = useState('Website chat');
  const [greeting, setGreeting] = useState('Hi! How can we help?');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try { await api.post('/channels', { kind: 'webchat', name, greeting }); onAdded(); onOpenChange(false); toast.success('Website chat added — copy the code onto your site'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add website chat" description="A chat button for your website. You’ll get a line of code to paste into your site."
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim() || saving} onClick={save}>Add</Button></>}>
      <div className="space-y-3">
        <Field label="Name shown to visitors" htmlFor="wc-name" required><Input id="wc-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Greeting" htmlFor="wc-greeting"><Input id="wc-greeting" maxLength={300} value={greeting} onChange={(e) => setGreeting(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

function AddTelegram({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (v: boolean) => void; onAdded: () => void }) {
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) setToken(''); }, [open]);
  const save = async () => {
    setSaving(true);
    try { await api.post('/channels', { kind: 'telegram_bot', token: token.trim() }); onAdded(); onOpenChange(false); toast.success('Telegram bot connected'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Connect a Telegram bot"
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" disabled={!token.trim() || saving} onClick={save}>{saving ? 'Connecting…' : 'Connect'}</Button></>}>
      <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-muted">
        <li>In Telegram, open <a className="text-brand-600 hover:underline dark:text-brand-200" href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> and send /newbot (or pick an existing bot).</li>
        <li>Copy the token it gives you and paste it below.</li>
      </ol>
      <Field label="Bot token" htmlFor="tg-token" hint="Stored encrypted. Anyone with the token can control the bot, so don’t share it elsewhere.">
        <Input id="tg-token" autoComplete="off" spellCheck={false} placeholder="123456789:AA…" value={token} onChange={(e) => setToken(e.target.value)} />
      </Field>
    </Dialog>
  );
}
