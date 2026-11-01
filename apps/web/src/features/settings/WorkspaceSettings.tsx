import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.ts';
import { useAction, useMe } from '../../lib/hooks.ts';
import { Button, Card, Checkbox, Field, Input, Select } from '../../components/ui/primitives.tsx';
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
    </AdminOnly>
  );
}
