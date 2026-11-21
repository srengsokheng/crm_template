import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { useMe } from '../../lib/hooks.ts';
import { Button, Card, Field, Input, Skeleton } from '../../components/ui/primitives.tsx';
import { TelegramAlertsCard } from './TelegramAlertsCard.tsx';
import { InstallAppCard } from './InstallAppCard.tsx';

/** Settings → Your account (everyone): display name and password. */
export function AccountSettings() {
  const { data: me, isLoading } = useMe();
  if (isLoading || !me) return <Card title="Your account"><Skeleton className="h-24" /></Card>;
  return (
    <div className="space-y-4">
      <ProfileCard name={me.user.name} />
      <EmailCard email={me.user.email} />
      <PasswordCard />
      <TelegramAlertsCard />
      <InstallAppCard />
    </div>
  );
}

function ProfileCard({ name: initial }: { name: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  useEffect(() => setName(initial), [initial]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true); setError(undefined);
    try {
      await api.patch('/auth/profile', { name });
      await qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['meta'] });
      toast.success('Name saved');
    } catch (err) { setError(err instanceof ApiError ? err.fields?.name ?? err.message : errorMessage(err)); } finally { setSaving(false); }
  };
  return (
    <Card title="Profile">
      <form onSubmit={save} className="max-w-md space-y-3">
        <Field label="Name" htmlFor="acc-name" required error={error} hint="Shown to your team, on activities and on replies to customers.">
          <Input id="acc-name" maxLength={100} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} invalid={!!error} />
        </Field>
        <Button type="submit" variant="primary" disabled={saving || !name.trim() || name.trim() === initial}>{saving ? 'Saving…' : 'Save name'}</Button>
      </form>
    </Card>
  );
}

function EmailCard({ email }: { email: string }) {
  const [next, setNext] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true); setErrors({});
    try {
      const r = await api.post<{ sentTo: string }>('/auth/email', { newEmail: next.trim(), currentPassword: password });
      setSentTo(r.sentTo); setNext(''); setPassword('');
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields as Record<string, string>);
      else toast.error(errorMessage(err));
    } finally { setSaving(false); }
  };
  return (
    <Card title="Sign-in email">
      <form onSubmit={save} className="max-w-md space-y-3">
        <p className="text-sm text-muted">Currently <span className="font-medium text-[var(--text)]">{email}</span>. We’ll send a confirmation link to the new address; your email changes when you open it.</p>
        {sentTo && <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200" role="status">Check {sentTo} for a confirmation link (valid for 1 hour). Until you open it, you keep signing in with {email}.</p>}
        {/* Password managers fill a saved login into "email + password" forms; give them the current
            address here so they don't put it into "New email". */}
        <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
        <Field label="New email" htmlFor="acc-new-email" required error={errors.newEmail}>
          <Input id="acc-new-email" type="email" name="new-email" autoComplete="off" maxLength={200} value={next} onChange={(e) => setNext(e.target.value)} invalid={!!errors.newEmail} />
        </Field>
        <Field label="Current password" htmlFor="acc-email-password" required error={errors.currentPassword} hint="To make sure it’s you.">
          <Input id="acc-email-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} invalid={!!errors.currentPassword} />
        </Field>
        <Button type="submit" variant="primary" disabled={saving || !next.trim() || !password}>{saving ? 'Sending…' : 'Send confirmation link'}</Button>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== next;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setSaving(true); setErrors({});
    try {
      const r = await api.post<{ signedOutSessions: number }>('/auth/password', { currentPassword: current, newPassword: next });
      setCurrent(''); setNext(''); setConfirm('');
      toast.success(r.signedOutSessions ? `Password changed. You were signed out on ${r.signedOutSessions} other device${r.signedOutSessions === 1 ? '' : 's'}.` : 'Password changed');
    } catch (err) {
      if (err instanceof ApiError && err.fields) setErrors(err.fields as Record<string, string>);
      toast.error(errorMessage(err));
    } finally { setSaving(false); }
  };
  return (
    <Card title="Password">
      <form onSubmit={save} className="max-w-md space-y-3">
        {/* Lets password managers attach the change to the right account. */}
        <input type="text" name="username" autoComplete="username" value="" readOnly hidden />
        <Field label="Current password" htmlFor="acc-current" required error={errors.currentPassword}>
          <Input id="acc-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} invalid={!!errors.currentPassword} />
        </Field>
        <Field label="New password" htmlFor="acc-new" required error={errors.newPassword} hint="At least 8 characters.">
          <Input id="acc-new" type="password" autoComplete="new-password" minLength={8} maxLength={200} value={next} onChange={(e) => setNext(e.target.value)} invalid={!!errors.newPassword} />
        </Field>
        <Field label="Repeat new password" htmlFor="acc-confirm" required error={mismatch ? 'The passwords don’t match' : undefined}>
          <Input id="acc-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} invalid={mismatch} />
        </Field>
        <p className="text-xs text-muted">Changing your password signs you out on your other devices.</p>
        <Button type="submit" variant="primary" disabled={saving || !current || next.length < 8 || confirm !== next}>{saving ? 'Changing…' : 'Change password'}</Button>
      </form>
    </Card>
  );
}
