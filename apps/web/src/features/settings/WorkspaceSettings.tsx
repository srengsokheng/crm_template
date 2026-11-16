import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RotateCcw, Send } from 'lucide-react';
import { api } from '../../lib/api.ts';
import { useAction, useMe } from '../../lib/hooks.ts';
import { Badge, Button, Card, Checkbox, ErrorState, Field, Input, Select, Skeleton } from '../../components/ui/primitives.tsx';
import { errorMessage } from '../../lib/api.ts';
import { relative } from '../../lib/format.ts';
import { useForm } from '../records/form.tsx';
import { AdminOnly } from './SettingsLayout.tsx';

export function WorkspaceSettings() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const f = useForm({
    name: me?.workspace.name ?? '', baseCurrency: me?.workspace.baseCurrency ?? 'USD', useLeads: me?.workspace.useLeads ?? true,
    timezone: me?.workspace.timezone ?? 'UTC', workingHours: me?.workspace.workingHours ?? { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
  });
  const wh = f.values.workingHours;
  const zones = useMemo(() => { try { return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { return ['UTC']; } }, []);
  const save = useAction(() => api.patch('/workspace', f.values), { success: 'Workspace saved', onSuccess: () => qc.invalidateQueries(), onError: (e) => { f.fromError(e); return false; } });
  return (
    <AdminOnly>
      <Card title="Workspace">
        <form className="max-w-md space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
          <Field label="Workspace name" htmlFor="ws-name" error={f.errors.name}><Input id="ws-name" value={f.values.name} onChange={(e) => f.set('name', e.target.value)} /></Field>
          <Field label="Default currency" htmlFor="ws-cur" hint="Used for new records and in reports"><Select id="ws-cur" value={f.values.baseCurrency} onChange={(e) => f.set('baseCurrency', e.target.value)}>
            {['USD', 'EUR', 'GBP', 'KHR', 'THB', 'SGD', 'JPY', 'CNY', 'AUD', 'CAD'].map((c) => <option key={c}>{c}</option>)}</Select></Field>
          <div className="space-y-1">
            <Checkbox checked={f.values.useLeads} onChange={(v) => f.set('useLeads', v)} label={<span className="font-medium">Use leads</span>} />
            <p className="pl-6 text-xs text-muted">Qualify new inquiries as leads before creating deals. Turn off to work with deals and contacts only.</p>
          </div>
          <Field label="Time zone" htmlFor="ws-tz" hint="Used for reminders and working hours" error={f.errors.timezone}>
            <Select id="ws-tz" value={f.values.timezone} onChange={(e) => f.set('timezone', e.target.value)}>
              {(zones.includes(f.values.timezone) ? zones : [f.values.timezone, ...zones]).map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
            </Select>
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-[13px] font-medium">Working hours</legend>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Working days">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => {
                const on = wh.days.includes(i + 1);
                return (
                  <button key={d} type="button" aria-pressed={on} onClick={() => f.set('workingHours', { ...wh, days: on ? wh.days.filter((x) => x !== i + 1) : [...wh.days, i + 1].sort() })}
                    className={`h-8 w-11 rounded-md border text-[13px] font-medium ${on ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-100' : 'border-base text-muted'}`}>{d}</button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <Input type="time" aria-label="Day starts" className="w-32" value={wh.start} onChange={(e) => f.set('workingHours', { ...wh, start: e.target.value })} />
              <span className="text-muted">to</span>
              <Input type="time" aria-label="Day ends" className="w-32" value={wh.end} onChange={(e) => f.set('workingHours', { ...wh, end: e.target.value })} />
            </div>
            {(f.errors['workingHours.end'] || f.errors.workingHours) && <p className="text-xs text-rose-600" role="alert">{f.errors['workingHours.end'] ?? f.errors.workingHours}</p>}
            <p className="text-xs text-muted">Automation delays marked “working hours only” skip evenings and days off.</p>
          </fieldset>
          <Button type="submit" variant="primary" loading={save.isPending}>Save changes</Button>
        </form>
      </Card>
      <EmailDelivery />
    </AdminOnly>
  );
}

interface MailStatus {
  transport: 'console' | 'smtp' | 'memory'; delivers: boolean; from: string; host: string | null;
  senderName: string | null; fromHeader: string; failedCount: number;
}
interface FailedMail { id: number; to: string; subject: string; error: string | null; attempts: number; createdAt: string }

function EmailDelivery() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings-email'], queryFn: () => api.get<MailStatus>('/settings/email') });
  const [name, setName] = useState<string | null>(null);
  const current = name ?? q.data?.senderName ?? '';
  const test = useAction(() => api.post<MailStatus & { to: string }>('/settings/email/test'), {
    success: (r) => (r.delivers ? `Test email sent to ${r.to}` : `Test message written to the server log (not sent to ${r.to})`),
  });
  const saveName = useAction(() => api.put<MailStatus>('/settings/email', { senderName: current }), {
    success: 'Sender name saved', onSuccess: () => { setName(null); qc.invalidateQueries({ queryKey: ['settings-email'] }); },
  });
  const dirty = name !== null && name.trim() !== (q.data?.senderName ?? '');
  const preview = current.trim() ? `"${current.trim().replace(/["<>\\]/g, ' ').slice(0, 60)}" <${(/<([^>]+)>/.exec(q.data?.from ?? '')?.[1] ?? q.data?.from ?? '').trim()}>` : q.data?.from;
  return (
    <Card className="mt-4" title="Email delivery" actions={q.data && <Badge tone={q.data.delivers ? 'green' : 'amber'}>{q.data.delivers ? 'Sending' : 'Not sending'}</Badge>}>
      {q.isLoading ? <Skeleton className="h-16" /> : q.error || !q.data ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : (
        <div className="max-w-xl space-y-4 text-sm">
          {q.data.delivers
            ? <p>Invitations, activity reminders and the daily summary are sent through <span className="font-medium">{q.data.host}</span>.</p>
            : <p>No mail server is configured, so invitations and reminders are only written to the server log. Invitation links are shown on screen for you to share.</p>}
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (dirty) saveName.mutate(undefined); }}>
            <Field label="Sender name" htmlFor="ws-sender" hint={<>Emails from this workspace appear as <span className="font-medium text-[var(--text)]">{preview}</span>. The address itself is set by the server administrator.</>}>
              <div className="flex gap-2">
                <Input id="ws-sender" maxLength={60} value={current} placeholder="e.g. Acme Robotics Sales" onChange={(e) => setName(e.target.value)} />
                <Button type="submit" disabled={!dirty} loading={saveName.isPending}>Save</Button>
              </div>
            </Field>
          </form>
          <p className="text-xs text-muted">Server settings: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and EMAIL_FROM environment variables. Passwords are never shown here.</p>
          <Button icon={<Send className="size-4" />} loading={test.isPending} onClick={() => test.mutate(undefined)}>Send a test email to me</Button>
          {q.data.failedCount > 0 && <FailedMails />}
        </div>
      )}
    </Card>
  );
}

/** Emails of this workspace that could not be delivered after all retries (kept 14 days). */
function FailedMails() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings-email-failures'], queryFn: () => api.get<{ data: FailedMail[] }>('/settings/email/failures') });
  const retry = useAction((id: number) => api.post(`/settings/email/failures/${id}/retry`, {}), {
    success: 'Queued again', onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings-email-failures'] }); qc.invalidateQueries({ queryKey: ['settings-email'] }); },
  });
  const rows = q.data?.data ?? [];
  return (
    <section className="rounded-[var(--radius-card)] border border-rose-200 dark:border-rose-500/30">
      <h3 className="flex items-center gap-2 border-b border-rose-200 px-3 py-2 text-[13px] font-semibold text-rose-700 dark:border-rose-500/30 dark:text-rose-300">
        <AlertTriangle className="size-4" />Emails that couldn’t be delivered ({rows.length})
      </h3>
      {q.isLoading ? <div className="p-3"><Skeleton className="h-10" /></div>
        : q.error ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        : !rows.length ? <p className="px-3 py-3 text-muted">None any more.</p>
        : (
          <ul className="divide-y divide-[var(--border)]">
            {rows.map((m) => (
              <li key={m.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{m.subject}</div>
                  <div className="truncate text-xs text-muted">To {m.to} · {relative(m.createdAt)} · {m.attempts} attempts</div>
                  {m.error && <div className="mt-0.5 break-words text-xs text-rose-600 dark:text-rose-300">{m.error}</div>}
                </div>
                <Button size="sm" icon={<RotateCcw className="size-3.5" />} loading={retry.isPending && retry.variables === m.id} onClick={() => retry.mutate(m.id)}>Retry</Button>
              </li>
            ))}
          </ul>
        )}
      <p className="border-t border-[var(--border)] px-3 py-2 text-xs text-muted">Usually a wrong address or a mail server problem. Fix the cause, then retry. Entries disappear after 14 days.</p>
    </section>
  );
}
