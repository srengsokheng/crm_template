import { useQuery } from '@tanstack/react-query';
import { WA_FIELD_LABELS, type WaTemplateSetting } from '@crm/shared';
import { api, errorMessage } from '../../lib/api.ts';
import { Field, Select, Skeleton } from '../../components/ui/primitives.tsx';

interface Channel { id: number; kind: string; name: string; status: string }
interface Template { name: string; language: string; category: string; header: string | null; body: string; footer: string | null; params: number }

/**
 * "Also send on WhatsApp": a WhatsApp channel, one of its approved templates, and what fills each {{n}} blank, with a
 * preview. `value` null (or no channel) = off.
 */
export function WhatsAppTemplateField({ id, value, onChange, fields, samples, error }: {
  id: string; value: WaTemplateSetting | null; onChange: (v: WaTemplateSetting | null) => void;
  fields: readonly string[]; samples: Record<string, string>; error?: string;
}) {
  const channels = useQuery({ queryKey: ['channels'], queryFn: () => api.get<{ data: Channel[] }>('/channels') });
  const wa = (channels.data?.data ?? []).filter((c) => c.kind === 'whatsapp');
  const channelId = value?.channelId ?? null;
  const templates = useQuery({ queryKey: ['broadcast-templates', channelId], enabled: !!channelId, retry: false,
    queryFn: () => api.get<{ data: Template[] }>(`/broadcasts/templates?channelId=${channelId}`) });
  const tpl = templates.data?.data.find((t) => t.name === value?.name && t.language === value?.language);
  const set = (patch: Partial<WaTemplateSetting>) => onChange({ channelId, name: '', language: '', params: [], ...value, ...patch });
  const blanks = tpl ? Array.from({ length: tpl.params }, (_, i) => value?.params[i] ?? fields[i] ?? fields[0]) : [];
  const preview = tpl ? [tpl.header, tpl.body.replace(/\{\{(\d+)\}\}/g, (_m, n) => samples[blanks[Number(n) - 1]] ?? '…'), tpl.footer].filter(Boolean).join('\n\n') : '';

  if (channels.isLoading) return <Skeleton className="h-9" />;
  if (!wa.length) return <p className="text-xs text-muted">To also send on WhatsApp, connect a WhatsApp number in Settings → Channels.</p>;
  return (
    <div className="space-y-3">
      <Field label="Also on WhatsApp" htmlFor={`${id}-ch`} hint="To the customer’s WhatsApp chat, or the phone number on their contact. WhatsApp only allows approved templates here.">
        <Select id={`${id}-ch`} value={channelId ?? ''} onChange={(e) => onChange(e.target.value ? { channelId: Number(e.target.value), name: '', language: '', params: [] } : null)}>
          <option value="">Don’t send on WhatsApp</option>
          {wa.map((c) => <option key={c.id} value={c.id} disabled={c.status !== 'active'}>{c.name}{c.status !== 'active' ? ' (disabled)' : ''}</option>)}
        </Select>
      </Field>
      {channelId && (templates.isLoading ? <Skeleton className="h-9" />
        : templates.isError ? <p className="text-xs text-rose-600" role="alert">{errorMessage(templates.error)}</p>
        : (
          <>
            <Field label="Approved template" htmlFor={`${id}-tpl`} error={error}
              hint={templates.data!.data.length ? 'Write and get templates approved in WhatsApp Manager.' : 'No approved templates yet — create one in WhatsApp Manager.'}>
              <Select id={`${id}-tpl`} value={value?.name ? `${value.name}|${value.language}` : ''}
                onChange={(e) => {
                  const [name = '', language = ''] = e.target.value.split('|');
                  const t = templates.data!.data.find((x) => x.name === name && x.language === language);
                  // Save the suggested fields too, so blanks are filled even if nobody changes them.
                  set({ name, language, params: t ? Array.from({ length: t.params }, (_, i) => fields[i] ?? fields[0]) : [] });
                }}>
                <option value="">Pick a template…</option>
                {templates.data!.data.map((t) => <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>{t.name} ({t.language})</option>)}
              </Select>
            </Field>
            {tpl && tpl.params > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {blanks.map((f, i) => (
                  <Field key={i} label={`Blank {{${i + 1}}}`} htmlFor={`${id}-p${i}`}>
                    <Select id={`${id}-p${i}`} value={f} onChange={(e) => set({ params: blanks.map((x, j) => (j === i ? e.target.value : x)) })}>
                      {fields.map((k) => <option key={k} value={k}>{WA_FIELD_LABELS[k] ?? k}</option>)}
                    </Select>
                  </Field>
                ))}
              </div>
            )}
            {tpl && <p className="whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-2)] px-3 py-2 text-sm" aria-label="WhatsApp preview">{preview}</p>}
          </>
        ))}
    </div>
  );
}
