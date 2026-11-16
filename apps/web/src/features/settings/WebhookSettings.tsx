import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Eye, EyeOff, RefreshCw, Webhook } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { Button, Card, ErrorState, Field, IconButton, Skeleton, Textarea } from '../../components/ui/primitives.tsx';
import { ConfirmDialog } from '../../components/ui/overlays.tsx';

interface Hooks { allowedHosts: string[]; secret: string }

/** Admin card: which hosts automation rules may call, and the secret that signs each request. */
export function WebhookSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['webhook-settings'], queryFn: () => api.get<Hooks>('/settings/webhooks') });
  const [hosts, setHosts] = useState('');
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  useEffect(() => { if (q.data) setHosts(q.data.allowedHosts.join('\n')); }, [q.data]);
  const dirty = q.data && hosts.split('\n').map((h) => h.trim()).filter(Boolean).join('\n') !== q.data.allowedHosts.join('\n');

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/settings/webhooks', { allowedHosts: hosts.split('\n') });
      await qc.invalidateQueries({ queryKey: ['webhook-settings'] });
      toast.success('Allow-list saved');
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  const rotate = async () => {
    try { await api.post('/settings/webhooks/rotate-secret', {}); await qc.invalidateQueries({ queryKey: ['webhook-settings'] }); setShow(true); toast.success('New signing secret created'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setRotating(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(q.data!.secret); toast.success('Secret copied'); } catch { toast.error('Couldn’t copy; select the text instead'); }
  };

  return (
    <Card title={<span className="flex items-center gap-2"><Webhook className="size-4 text-muted" />Webhooks</span>}>
      {q.isLoading ? <div className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-8" /></div>
        : q.error ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
        : (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              The “Call a webhook” action sends a signed JSON POST to another system (Zapier, Make, your own server). For safety it can
              only call <strong>https</strong> addresses on hosts listed here, never private network addresses, and it doesn’t follow redirects.
            </p>
            <Field label="Allowed hosts" htmlFor="wh-hosts" hint="One per line, e.g. hooks.zapier.com or *.example.com for all subdomains">
              <Textarea id="wh-hosts" rows={4} value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="hooks.zapier.com" />
            </Field>
            <div className="flex justify-end"><Button size="sm" variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save allow-list</Button></div>
            <Field label="Signing secret" htmlFor="wh-secret" hint="Each request carries X-CRM-Signature: sha256=HMAC-SHA256(secret, body). Verify it on the receiving side.">
              <div className="flex items-center gap-1">
                <code id="wh-secret" className="min-w-0 flex-1 truncate rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-xs">
                  {show ? q.data!.secret : '•'.repeat(24)}
                </code>
                <IconButton size="sm" label={show ? 'Hide secret' : 'Show secret'} onClick={() => setShow(!show)}>{show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}</IconButton>
                <IconButton size="sm" label="Copy secret" onClick={copy}><Copy className="size-3.5" /></IconButton>
                <IconButton size="sm" label="Create a new secret" onClick={() => setRotating(true)}><RefreshCw className="size-3.5" /></IconButton>
              </div>
            </Field>
          </div>
        )}
      <ConfirmDialog open={rotating} onOpenChange={(o) => !o && setRotating(false)} danger title="Create a new signing secret?"
        description="Receivers that check the old secret will reject requests until you update them." confirmLabel="Create new secret" onConfirm={rotate} />
    </Card>
  );
}
