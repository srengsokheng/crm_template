import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Copy, Plus } from 'lucide-react';
import { CHANNEL_LABELS, isMetaKind, META_ACCOUNT_LABELS, type ChannelKind, type MetaKind } from '@crm/shared';
import { ChannelIcon } from '../inbox/InboxPage.tsx';
import { api, errorMessage } from '../../lib/api.ts';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, Field, Input, Skeleton, Textarea } from '../../components/ui/primitives.tsx';
import { UserSelect } from '../records/form.tsx';
import { ConfirmDialog, Dialog } from '../../components/ui/overlays.tsx';
import { AdminOnly } from './SettingsLayout.tsx';

interface Channel {
  id: number; kind: ChannelKind; name: string; status: 'active' | 'disabled' | 'error' | 'pending'; lastError: string | null; publicKey: string;
  conversationCount: number;
  config: {
    greeting?: string; color?: string; allowedOrigins?: string[]; username?: string; botName?: string; mode?: 'webhook' | 'polling';
    accountId?: string; accountName?: string; webhookUrl?: string; verifyToken?: string; httpsReady?: boolean; businessAccountId?: string | null;
    displayName?: string; phone?: string; includeGroups?: boolean; ownerId?: number | null; loginStep?: 'code' | 'password' | null;
  };
}

export function ChannelsSettings() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['channels'], queryFn: () => api.get<{ data: Channel[] }>('/channels') });
  const [adding, setAdding] = useState<null | ChannelKind>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['channels'] }); qc.invalidateQueries({ queryKey: ['inbox'] }); };
  const channels = list.data?.data ?? [];
  return (
    <AdminOnly>
      <div className="space-y-4">
        <Card title="Channels">
          <p className="text-sm text-muted">Messages people send through these channels arrive in the Inbox, where your team replies. Add one:</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(['webchat', 'telegram_bot', 'telegram_user', 'messenger', 'instagram', 'whatsapp'] as const).map((k) => (
              <Button key={k} size="sm" icon={<ChannelIcon kind={k} decorative />} onClick={() => setAdding(k)}>{CHANNEL_LABELS[k]}</Button>
            ))}
          </div>
        </Card>
        {list.isLoading ? <Skeleton className="h-40" /> : list.isError ? <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} /> : channels.length === 0 ? (
          <Card><EmptyState icon={<Plus className="size-5" />} title="No channels yet" description="Add a chat to your website, or connect Telegram, Facebook Messenger, Instagram or WhatsApp, to start receiving messages." /></Card>
        ) : channels.map((c) => <ChannelCard key={c.id} c={c} onChange={refresh} />)}
      </div>
      <AddWebchat open={adding === 'webchat'} onOpenChange={(v) => setAdding(v ? 'webchat' : null)} onAdded={refresh} />
      <AddTelegram open={adding === 'telegram_bot'} onOpenChange={(v) => setAdding(v ? 'telegram_bot' : null)} onAdded={refresh} />
      <AddTelegramUser open={adding === 'telegram_user'} onOpenChange={(v) => setAdding(v ? 'telegram_user' : null)} onAdded={refresh} />
      {adding && isMetaKind(adding) && <AddMeta kind={adding} open onOpenChange={(v) => { if (!v) setAdding(null); }} onAdded={refresh} />}
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
  const status = c.status === 'active' ? <Badge tone="green">Active</Badge> : c.status === 'error' ? <Badge tone="red">Needs attention</Badge>
    : c.status === 'pending' ? <Badge tone="amber">Signing in</Badge> : <Badge>Disabled</Badge>;
  return (
    <Card title={<span className="flex min-w-0 items-center gap-2"><ChannelIcon kind={c.kind} className="size-4 shrink-0" decorative /><span className="truncate">{c.name}</span>{status}</span>}
      actions={<div className="flex gap-2">
        {c.status === 'pending' ? null : c.status === 'active'
          ? <Button size="sm" disabled={busy} onClick={() => patch({ status: 'disabled' }, 'Channel disabled')}>Disable</Button>
          : <Button size="sm" disabled={busy} onClick={() => patch({ status: 'active' }, 'Channel enabled')}>{c.status === 'error' ? 'Reconnect' : 'Enable'}</Button>}
        <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>Delete</Button>
      </div>}>
      {c.lastError && <p className="mb-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300" role="alert">{c.lastError}</p>}
      <p className="mb-3 text-xs text-muted">{CHANNEL_LABELS[c.kind]} · {c.conversationCount} conversation{c.conversationCount === 1 ? '' : 's'}</p>
      {c.kind === 'webchat' ? <WebchatDetails c={c} save={(b) => patch(b, 'Chat settings saved')} busy={busy} />
        : isMetaKind(c.kind) ? <MetaDetails c={c} kind={c.kind} onChange={onChange} />
        : c.kind === 'telegram_user' ? <TelegramUserDetails c={c} onChange={onChange} save={(b, ok) => patch(b, ok)} busy={busy} /> : <TelegramDetails c={c} />}
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

/** Where each id and credential is found in Meta's dashboards. */
const META_STEPS: Record<MetaKind, string[]> = {
  messenger: [
    'In developers.facebook.com, create an app (type Business) and add the Messenger product.',
    'Under Messenger → Settings, generate a Page access token for your Page (permissions pages_messaging and pages_manage_metadata). For a token that doesn’t expire, use a system user in Business Settings.',
    'Copy the Page ID from your Page’s About → Page transparency, or from the token screen.',
  ],
  instagram: [
    'Your Instagram account must be a professional account linked to a Facebook Page.',
    'In your Meta app, add the Instagram product (Instagram messaging via Facebook Login) and generate a Page access token with instagram_basic and instagram_manage_messages.',
    'Copy the Instagram account ID shown next to the token (not the @username).',
  ],
  whatsapp: [
    'In developers.facebook.com, create an app (type Business) and add the WhatsApp product.',
    'Under WhatsApp → API setup, copy the Phone number ID of the number customers write to.',
    'Create a permanent access token: Business Settings → System users → Generate token, with whatsapp_business_messaging.',
  ],
};

function MetaCredentialFields({ token, setToken, secret, setSecret, idPrefix }: { token: string; setToken: (v: string) => void; secret: string; setSecret: (v: string) => void; idPrefix: string }) {
  return (
    <>
      <Field label="Access token" htmlFor={`${idPrefix}-token`} required hint="Stored encrypted and never shown again.">
        <Input id={`${idPrefix}-token`} type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
      </Field>
      <Field label="App secret" htmlFor={`${idPrefix}-secret`} required hint="App settings → Basic. Used to check that messages really come from Meta.">
        <Input id={`${idPrefix}-secret`} type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} />
      </Field>
    </>
  );
}

function AddMeta({ kind, open, onOpenChange, onAdded }: { kind: MetaKind; open: boolean; onOpenChange: (v: boolean) => void; onAdded: () => void }) {
  const [accountId, setAccountId] = useState('');
  const [waba, setWaba] = useState('');
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.post('/channels', { kind, accountId: accountId.trim(), accessToken: token.trim(), appSecret: secret.trim(), ...(kind === 'whatsapp' && waba.trim() ? { businessAccountId: waba.trim() } : {}) });
      onAdded(); onOpenChange(false); toast.success(`${CHANNEL_LABELS[kind]} connected — finish the webhook setup on the channel`);
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Connect ${CHANNEL_LABELS[kind]}`}
      description="Uses Meta’s official API for business accounts. Personal accounts can’t be connected."
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" disabled={!accountId.trim() || !token.trim() || !secret.trim() || saving} onClick={save}>{saving ? 'Checking…' : 'Connect'}</Button></>}>
      <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-muted">{META_STEPS[kind].map((s) => <li key={s}>{s}</li>)}</ol>
      <div className="space-y-3">
        <Field label={META_ACCOUNT_LABELS[kind]} htmlFor="meta-account" required>
          <Input id="meta-account" inputMode="numeric" autoComplete="off" value={accountId} onChange={(e) => setAccountId(e.target.value)} />
        </Field>
        <MetaCredentialFields token={token} setToken={setToken} secret={secret} setSecret={setSecret} idPrefix="meta" />
        {kind === 'whatsapp' && (
          <Field label="WhatsApp Business Account ID (optional)" htmlFor="meta-waba" hint="Under WhatsApp → API setup. Needed to send approved templates after 24 hours.">
            <Input id="meta-waba" inputMode="numeric" autoComplete="off" value={waba} onChange={(e) => setWaba(e.target.value)} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function CopyField({ label, value, id }: { label: string; value: string; id: string }) {
  const copy = async () => { try { await navigator.clipboard.writeText(value); toast.success('Copied'); } catch { toast.error('Copy failed — select the text and copy it'); } };
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex items-center gap-2">
        <Input id={id} readOnly value={value} className="min-w-0 flex-1 font-mono text-xs" onFocus={(e) => e.target.select()} />
        <Button size="sm" icon={<Copy className="size-3.5" />} onClick={copy}>Copy</Button>
      </div>
    </Field>
  );
}

function MetaDetails({ c, kind, onChange }: { c: Channel; kind: MetaKind; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!editing) { setToken(''); setSecret(''); } }, [editing]);
  const save = async () => {
    setSaving(true);
    try { await api.patch(`/channels/${c.id}`, { accessToken: token.trim(), appSecret: secret.trim() }); setEditing(false); onChange(); toast.success('Credentials updated'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <div className="space-y-4 text-sm">
      <p>{META_ACCOUNT_LABELS[kind]}: <span className="font-medium">{c.config.accountId}</span>{c.config.accountName && c.config.accountName !== c.name ? <> · {c.config.accountName}</> : null}</p>
      {!c.config.httpsReady && (
        <p className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-500/10 dark:text-amber-100" role="status">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>Meta only sends messages to an https address. This server’s APP_URL isn’t https, so nothing will arrive until it runs on its public https address.</span>
        </p>
      )}
      <div>
        <p className="mb-2 font-medium">Finish in your Meta app → Webhooks{kind === 'whatsapp' ? ' (under WhatsApp → Configuration)' : ''}:</p>
        <div className="space-y-3">
          <CopyField label="Callback URL" id={`cb${c.id}`} value={c.config.webhookUrl ?? ''} />
          <CopyField label="Verify token" id={`vt${c.id}`} value={c.config.verifyToken ?? ''} />
        </div>
        <p className="mt-2 text-muted">Then subscribe to the <span className="font-mono">messages</span> field. If several channels use the same Meta app, one callback URL is enough: messages are sorted by account.</p>
      </div>
      {kind === 'whatsapp' && <WabaField c={c} onChange={onChange} />}
      {editing ? (
        <div className="space-y-3 rounded-md border border-base p-3">
          <MetaCredentialFields token={token} setToken={setToken} secret={secret} setSecret={setSecret} idPrefix={`m${c.id}`} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setEditing(false)}>Cancel</Button>
            <Button variant="primary" disabled={!token.trim() || !secret.trim() || saving} onClick={save}>{saving ? 'Checking…' : 'Save credentials'}</Button>
          </div>
        </div>
      ) : <Button size="sm" onClick={() => setEditing(true)}>Update access token</Button>}
    </div>
  );
}

function AddTelegramUser({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (v: boolean) => void; onAdded: () => void }) {
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [phone, setPhone] = useState('');
  const [groups, setGroups] = useState(false);
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) { setApiId(''); setApiHash(''); setPhone(''); setGroups(false); setOwnerId(null); } }, [open]);
  const save = async () => {
    setSaving(true);
    try {
      await api.post('/channels', { kind: 'telegram_user', apiId: apiId.trim(), apiHash: apiHash.trim(), phone: phone.trim(), includeGroups: groups, ...(ownerId ? { ownerId } : {}) });
      onAdded(); onOpenChange(false); toast.success('Telegram sent a code to the account — enter it on the channel');
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Connect a Telegram account"
      description="Messages people send to this account arrive in the Inbox, and replies are sent as the account. The account’s owner must agree: they’ll get a login code."
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" disabled={!apiId.trim() || !apiHash.trim() || !phone.trim() || saving} onClick={save}>{saving ? 'Sending code…' : 'Send login code'}</Button></>}>
      <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-muted">
        <li>Sign in at <a className="text-brand-600 hover:underline dark:text-brand-200" href="https://my.telegram.org" target="_blank" rel="noreferrer">my.telegram.org</a> with the account’s phone number and open “API development tools”.</li>
        <li>Create an app (any name) and copy its api_id and api_hash.</li>
      </ol>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <Field label="api_id" htmlFor="tgu-id" required><Input id="tgu-id" inputMode="numeric" autoComplete="off" value={apiId} onChange={(e) => setApiId(e.target.value)} /></Field>
          <Field label="api_hash" htmlFor="tgu-hash" required><Input id="tgu-hash" type="password" autoComplete="off" spellCheck={false} value={apiHash} onChange={(e) => setApiHash(e.target.value)} /></Field>
        </div>
        <Field label="Phone number" htmlFor="tgu-phone" required hint="With the country code, like +855 12 345 678.">
          <Input id="tgu-phone" type="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Whose account is it?" htmlFor="tgu-owner" hint="New conversations are assigned to them, so only people who may see their conversations see these.">
          <UserSelect id="tgu-owner" value={ownerId} onChange={setOwnerId} allowEmpty emptyLabel="Me" />
        </Field>
        <Checkbox checked={groups} onChange={setGroups} label="Also take in group chats (off: private chats only)" />
      </div>
    </Dialog>
  );
}

function TelegramUserDetails({ c, onChange, save, busy }: { c: Channel; onChange: () => void; save: (b: Record<string, unknown>, ok: string) => void; busy: boolean }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [sending, setSending] = useState(false);
  const step = c.status === 'pending' ? c.config.loginStep : null;
  useEffect(() => { setCode(''); setPassword(''); }, [step]);
  const login = async (body: Record<string, unknown>, ok?: string) => {
    setSending(true);
    try {
      const r = await api.post<Channel>(`/channels/${c.id}/login`, body);
      onChange();
      if (ok) toast.success(ok); else if (r.status === 'active') toast.success('Telegram account connected');
    } catch (e) { toast.error(errorMessage(e)); } finally { setSending(false); }
  };
  if (step === 'code' || step === 'password') {
    return (
      <form className="max-w-sm space-y-3 text-sm" onSubmit={(e) => { e.preventDefault(); void login(step === 'code' ? { code: code.trim() } : { password }); }}>
        {step === 'code' ? (
          <Field label="Login code" htmlFor={`tc${c.id}`} hint={`Telegram sent it to ${c.config.phone ?? 'the account'} (in the Telegram app, from “Telegram”).`}>
            <Input id={`tc${c.id}`} inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        ) : (
          <Field label="Two-step verification password" htmlFor={`tp${c.id}`} hint="This account has a cloud password. It’s used once to sign in and never stored.">
            <Input id={`tp${c.id}`} type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={sending || (step === 'code' ? !code.trim() : !password)}>{sending ? 'Signing in…' : 'Sign in'}</Button>
          {step === 'code' && <Button disabled={sending} onClick={() => login({ resend: true }, 'A new code was sent')}>Send a new code</Button>}
        </div>
      </form>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      <p>{c.config.username ? <>Signed in as <span className="font-medium">@{c.config.username}</span></> : <>Signed in as <span className="font-medium">{c.config.displayName ?? c.name}</span></>}{c.config.phone ? <span className="text-muted"> · {c.config.phone}</span> : null}</p>
      <Field label="Assign new conversations to" htmlFor={`to${c.id}`}>
        <div className="max-w-xs"><UserSelect id={`to${c.id}`} value={c.config.ownerId ?? null} onChange={(v) => { if (v) save({ ownerId: v }, 'Saved'); }} /></div>
      </Field>
      <Checkbox checked={!!c.config.includeGroups} disabled={busy} onChange={(v) => save({ includeGroups: v }, v ? 'Group chats will be taken in' : 'Only private chats from now on')} label="Also take in group chats" />
      <p className="text-muted">Only messages people send to the account are taken in; what the owner writes from their phone stays in Telegram. To stop, disable the channel, or end the “CRM Inbox” session in Telegram → Settings → Devices.</p>
    </div>
  );
}

/** WhatsApp: the business account whose approved templates the Inbox can send. */
function WabaField({ c, onChange }: { c: Channel; onChange: () => void }) {
  const [value, setValue] = useState(c.config.businessAccountId ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setValue(c.config.businessAccountId ?? ''); }, [c.config.businessAccountId]);
  const changed = value.trim() !== (c.config.businessAccountId ?? '');
  const save = async () => {
    setSaving(true);
    try { await api.patch(`/channels/${c.id}`, { businessAccountId: value.trim() }); onChange(); toast.success(value.trim() ? 'Templates can be sent now' : 'Templates turned off'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <Field label="WhatsApp Business Account ID" htmlFor={`waba${c.id}`} hint="For sending approved templates after 24 hours. Under WhatsApp → API setup.">
      <div className="flex max-w-md items-center gap-2">
        <Input id={`waba${c.id}`} inputMode="numeric" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} className="min-w-0 flex-1" />
        <Button size="sm" disabled={!changed || saving} onClick={save}>{saving ? 'Checking…' : 'Save'}</Button>
      </div>
    </Field>
  );
}
