import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Plus, Trash2, UserPlus } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { useMe, useMeta } from '../../lib/hooks.ts';
import { Avatar, Badge, Button, Card, Checkbox, Field, IconButton, Input, Select } from '../../components/ui/primitives.tsx';
import { Dialog } from '../../components/ui/overlays.tsx';
import { AdminOnly } from './SettingsLayout.tsx';

interface Role { id: number; name: string; isAdmin: boolean }

export function UsersSettings() {
  const { data: meta } = useMeta();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ data: Role[] }>('/roles') });
  const [inviting, setInviting] = useState(false);
  const [team, setTeam] = useState<{ id?: number; name: string; memberIds: number[] } | null>(null);
  const call = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); qc.invalidateQueries({ queryKey: ['meta'] }); qc.invalidateQueries({ queryKey: ['roles'] }); if (ok) toast.success(ok); return true; } catch (e) { toast.error(errorMessage(e)); return false; } };
  return (
    <AdminOnly>
      <div className="space-y-4">
        <Card title={`Users (${meta?.users.length ?? 0})`} padded={false} actions={<Button size="sm" variant="primary" icon={<UserPlus className="size-3.5" />} onClick={() => setInviting(true)}>Invite</Button>}>
          <ul className="divide-y divide-[var(--border)]">
            {(meta?.users ?? []).map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <Avatar name={u.name} />
                <div className="min-w-0 flex-1"><div className="truncate font-medium">{u.name} {u.id === me?.user.id && <span className="text-xs text-muted">(you)</span>}</div><div className="truncate text-xs text-muted">{u.email}</div></div>
                {u.status === 'invited' && <Badge tone="amber">Invited</Badge>}
                {u.status === 'disabled' && <Badge tone="red">Disabled</Badge>}
                <Select aria-label={`Role for ${u.name}`} className="h-8 w-36" value={u.roleId} disabled={u.id === me?.user.id} onChange={(e) => call(() => api.patch(`/users/${u.id}`, { roleId: Number(e.target.value) }), 'Role updated')}>
                  {(roles.data?.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </Select>
                {u.id !== me?.user.id && u.status !== 'invited' && (
                  <Button size="sm" variant="ghost" onClick={() => call(() => api.patch(`/users/${u.id}`, { status: u.status === 'disabled' ? 'active' : 'disabled' }), u.status === 'disabled' ? 'User enabled' : 'User disabled')}>{u.status === 'disabled' ? 'Enable' : 'Disable'}</Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Teams" padded={false} actions={<Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setTeam({ name: '', memberIds: [] })}>New team</Button>}>
          {(meta?.teams ?? []).length ? (
            <ul className="divide-y divide-[var(--border)]">
              {(meta?.teams ?? []).map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                  <button type="button" className="text-left" onClick={() => setTeam({ id: t.id, name: t.name, memberIds: t.memberIds })}>
                    <div className="font-medium">{t.name}</div><div className="text-xs text-muted">{t.memberIds.map((id) => meta?.users.find((u) => u.id === id)?.name).filter(Boolean).join(', ') || 'No members'}</div>
                  </button>
                  <IconButton label={`Delete ${t.name}`} onClick={() => call(() => api.del(`/teams/${t.id}`), 'Team deleted')}><Trash2 className="size-4" /></IconButton>
                </li>
              ))}
            </ul>
          ) : <p className="px-4 py-4 text-sm text-muted">Teams let people with “team” access see each other’s records.</p>}
        </Card>
      </div>
      <InviteDialog open={inviting} onClose={() => setInviting(false)} roles={roles.data?.data ?? []} />
      {team && (
        <Dialog open onOpenChange={(v) => !v && setTeam(null)} title={team.id ? 'Edit team' : 'New team'}
          footer={<><Button onClick={() => setTeam(null)}>Cancel</Button><Button variant="primary" disabled={!team.name.trim()} onClick={() => call(() => team.id ? api.patch(`/teams/${team.id}`, team) : api.post('/teams', team), 'Team saved').then((ok) => ok && setTeam(null))}>Save</Button></>}>
          <div className="space-y-3">
            <Field label="Name" htmlFor="t-name"><Input id="t-name" value={team.name} onChange={(e) => setTeam({ ...team, name: e.target.value })} /></Field>
            <Field label="Members"><div className="grid gap-1.5 sm:grid-cols-2">{(meta?.users ?? []).map((u) => (
              <Checkbox key={u.id} checked={team.memberIds.includes(u.id)} label={u.name} onChange={(c) => setTeam({ ...team, memberIds: c ? [...team.memberIds, u.id] : team.memberIds.filter((x) => x !== u.id) })} />
            ))}</div></Field>
          </div>
        </Dialog>
      )}
    </AdminOnly>
  );
}

function InviteDialog({ open, onClose, roles }: { open: boolean; onClose: () => void; roles: Role[] }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ email: '', name: '', roleId: 0 });
  const [link, setLink] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const roleId = form.roleId || roles.find((r) => r.name === 'Sales rep')?.id || roles[0]?.id;
  const submit = async () => {
    setBusy(true); setErrors({});
    try { const r = await api.post<{ inviteUrl: string }>('/users/invite', { ...form, roleId }); setLink(r.inviteUrl); qc.invalidateQueries({ queryKey: ['meta'] }); }
    catch (e) { setErrors((e as { fields?: Record<string, string> }).fields ?? { email: errorMessage(e) }); } finally { setBusy(false); }
  };
  const close = () => { setLink(null); setForm({ email: '', name: '', roleId: 0 }); onClose(); };
  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()} title="Invite a teammate"
      description={link ? 'Share this link with them. It works once.' : 'They’ll get a link to set their password.'}
      footer={link ? <Button variant="primary" onClick={close}>Done</Button> : <><Button onClick={close}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Create invite</Button></>}>
      {link ? (
        <div className="flex gap-2"><Input readOnly value={link} aria-label="Invite link" onFocus={(e) => e.target.select()} />
          <Button icon={<Copy className="size-4" />} onClick={async () => { try { await navigator.clipboard.writeText(link); toast.success('Link copied'); } catch { toast.error('Copy failed — select the link and copy it manually'); } }}>Copy</Button></div>
      ) : (
        <div className="space-y-3">
          <Field label="Name" htmlFor="i-name" error={errors.name}><Input id="i-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email" htmlFor="i-email" error={errors.email}><Input id="i-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Role" htmlFor="i-role"><Select id="i-role" value={roleId} onChange={(e) => setForm({ ...form, roleId: Number(e.target.value) })}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
        </div>
      )}
    </Dialog>
  );
}
