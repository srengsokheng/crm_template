import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { api } from '../../lib/api.ts';
import { useAction, useMe } from '../../lib/hooks.ts';
import { Badge, Button, Card, Checkbox, ErrorState, Field, Input, Select, Skeleton } from '../../components/ui/primitives.tsx';
import { errorMessage } from '../../lib/api.ts';
import { useForm } from '../records/form.tsx';
import { AdminOnly } from './SettingsLayout.tsx';

export function WorkspaceSettings() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const f = useForm({ name: me?.workspace.name ?? '', baseCurrency: me?.workspace.baseCurrency ?? 'USD', useLeads: me?.workspace.useLeads ?? true });
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
          <Button type="submit" variant="primary" loading={save.isPending}>Save changes</Button>
        </form>
      </Card>
      <EmailDelivery />
    </AdminOnly>
  );
}

interface MailStatus { transport: 'console' | 'smtp' | 'memory'; delivers: boolean; from: string; host: string | null }

function EmailDelivery() {
  const q = useQuery({ queryKey: ['settings-email'], queryFn: () => api.get<MailStatus>('/settings/email') });
  const test = useAction(() => api.post<MailStatus & { to: string }>('/settings/email/test'), {
    success: (r) => (r.delivers ? `Test email sent to ${r.to}` : `Test message written to the server log (not sent to ${r.to})`),
  });
  return (
    <Card className="mt-4" title="Email delivery" actions={q.data && <Badge tone={q.data.delivers ? 'green' : 'amber'}>{q.data.delivers ? 'Sending' : 'Not sending'}</Badge>}>
      {q.isLoading ? <Skeleton className="h-16" /> : q.error || !q.data ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /> : (
        <div className="max-w-xl space-y-3 text-sm">
          {q.data.delivers
            ? <p>Invitations and activity reminders are sent through <span className="font-medium">{q.data.host}</span> from <span className="font-medium">{q.data.from}</span>.</p>
            : <p>No mail server is configured, so invitations and reminders are only written to the server log. Invitation links are shown on screen for you to share.</p>}
          <p className="text-xs text-muted">Set by the server administrator with the SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and EMAIL_FROM environment variables. Passwords are never shown here.</p>
          <Button icon={<Send className="size-4" />} loading={test.isPending} onClick={() => test.mutate(undefined)}>Send a test email to me</Button>
        </div>
      )}
    </Card>
  );
}
