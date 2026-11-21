import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { Button, EmptyState, ErrorState, Field, Input, Select, Skeleton } from '../../components/ui/primitives.tsx';
import { Dialog } from '../../components/ui/overlays.tsx';

interface Template { name: string; language: string; category: string; header: string | null; body: string; footer: string | null; params: number }

/** The template text with the values filled in so far (blanks still empty show as {{n}}). */
function preview(t: Template, values: string[]): string {
  const body = t.body.replace(/\{\{(\d+)\}\}/g, (all, n) => values[Number(n) - 1]?.trim() || all);
  return [t.header, body, t.footer].filter(Boolean).join('\n\n');
}

/**
 * WhatsApp only delivers approved templates once 24 hours have passed since the customer's last message. Pick one of
 * the business's approved templates, fill in its blanks, check the preview and send.
 */
export function TemplateDialog({ conversationId, customerName, open, onOpenChange, onSent }: {
  conversationId: number; customerName: string; open: boolean; onOpenChange: (v: boolean) => void; onSent: () => void;
}) {
  const list = useQuery({
    queryKey: ['templates', conversationId], enabled: open, retry: false,
    queryFn: () => api.get<{ data: Template[] }>(`/inbox/conversations/${conversationId}/templates`),
  });
  const templates = useMemo(() => list.data?.data ?? [], [list.data]);
  const [key, setKey] = useState('');
  const [values, setValues] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const t = templates.find((x) => `${x.name}|${x.language}` === key) ?? null;
  useEffect(() => { if (open) { setKey(''); setValues([]); } }, [open]);
  useEffect(() => {
    // The first blank is usually the name: start with the customer's first name.
    if (t) setValues(Array.from({ length: t.params }, (_, i) => (i === 0 && /^\s*(hi|hello|dear|សួស្តី)\b/i.test(t.body) ? customerName.split(' ')[0] : '')));
  }, [t, customerName]);
  const ready = !!t && values.every((v) => v.trim());
  const send = async () => {
    if (!t) return;
    setSending(true);
    try {
      await api.post(`/inbox/conversations/${conversationId}/templates`, { name: t.name, language: t.language, params: values.map((v) => v.trim()) });
      onSent(); onOpenChange(false); toast.success('Template sent');
    } catch (e) { toast.error(errorMessage(e)); } finally { setSending(false); }
  };
  const noWaba = list.error instanceof ApiError && list.error.status === 409;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Send a WhatsApp template"
      description="After 24 hours without a message from the customer, WhatsApp only delivers templates that Meta has approved for your business."
      footer={<><Button onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" disabled={!ready || sending} onClick={send}>{sending ? 'Sending…' : 'Send template'}</Button></>}>
      {list.isLoading ? <div className="space-y-2"><Skeleton className="h-9" /><Skeleton className="h-24" /></div>
        : noWaba ? <EmptyState icon={<FileText className="size-5" />} title="Templates aren’t set up" description={errorMessage(list.error)} />
        : list.isError ? <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />
        : templates.length === 0 ? <EmptyState icon={<FileText className="size-5" />} title="No approved templates" description="Create one in WhatsApp Manager → Message templates. Once Meta approves it, it shows up here." />
        : (
          <div className="space-y-3">
            <Field label="Template" htmlFor="tpl-pick">
              <Select id="tpl-pick" value={key} onChange={(e) => setKey(e.target.value)}>
                <option value="">Choose…</option>
                {templates.map((x) => <option key={`${x.name}|${x.language}`} value={`${x.name}|${x.language}`}>{x.name.replace(/_/g, ' ')} · {x.language}{x.category ? ` · ${x.category.toLowerCase()}` : ''}</option>)}
              </Select>
            </Field>
            {t && values.map((v, i) => (
              <Field key={i} label={`Blank {{${i + 1}}}`} htmlFor={`tpl-v${i}`} required>
                <Input id={`tpl-v${i}`} maxLength={1024} value={v} onChange={(e) => setValues((vs) => vs.map((x, j) => (j === i ? e.target.value : x)))} />
              </Field>
            ))}
            {t && (
              <div>
                <p className="mb-1 text-sm font-medium">Preview</p>
                <p className="whitespace-pre-wrap rounded-md bg-[var(--surface-2)] px-3 py-2 text-sm" aria-label="Template preview">{preview(t, values)}</p>
              </div>
            )}
          </div>
        )}
    </Dialog>
  );
}
