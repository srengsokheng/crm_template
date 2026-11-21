import { CheckCircle2, Download, Share, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { promptInstall, useInstall } from '../../lib/install.ts';
import { Button, Card } from '../../components/ui/primitives.tsx';

/** Your account → App: install the CRM on the phone's home screen (or the computer), or how to on iPhone. */
export function InstallAppCard() {
  const s = useInstall();
  const install = async () => { if (await promptInstall()) toast.success('Installed — open the CRM from your home screen'); };
  return (
    <Card title={<span className="flex items-center gap-1.5"><Smartphone className="size-4 text-muted" />App on your phone</span>}>
      {s.installed ? (
        <p className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4 text-emerald-600" />You’re using the installed app.</p>
      ) : s.canPrompt ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-muted">Add the CRM to your home screen: it opens full-screen like an app and starts faster.</p>
          <Button variant="primary" icon={<Download className="size-4" />} onClick={install}>Install the app</Button>
        </div>
      ) : s.ios ? (
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>Open the CRM in Safari.</li>
          <li>Tap <Share className="inline size-4 align-text-bottom" aria-label="Share" /> Share, then <span className="font-medium text-[var(--text)]">Add to Home Screen</span>.</li>
          <li>Open the CRM from its new icon.</li>
        </ol>
      ) : (
        <p className="text-sm text-muted">On Android, open the CRM in Chrome and choose <span className="font-medium text-[var(--text)]">⋮ → Add to Home screen</span>. On a computer, use the install icon at the right of Chrome’s or Edge’s address bar. On iPhone, use Safari’s Share → Add to Home Screen.</p>
      )}
    </Card>
  );
}
