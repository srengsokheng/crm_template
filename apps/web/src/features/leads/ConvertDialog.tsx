import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { usePipelines } from '../../lib/hooks.ts';
import type { FieldDef } from '../../lib/types.ts';
import { Button, Checkbox, Field, Input, Select, Spinner } from '../../components/ui/primitives.tsx';
import { Dialog } from '../../components/ui/overlays.tsx';
import { CustomFieldInput } from '../records/form.tsx';
import { requiredFromError } from '../records/record.tsx';

interface Match { id: number; title: string; matchedOn: string }
interface Preview {
  contactName: string | null; companyName: string | null; contactMatches: Match[]; companyMatches: Match[];
  dealDefaults: { title: string; amount: string | null; pipelineId: number; stageId: number };
  dealRequiredFields: { key: string; label: string; type: string; options: { id: string; label: string }[] }[];
}

type PartyMode = { mode: 'create' } | { mode: 'existing'; id: number } | { mode: 'skip' };

export function ConvertDialog({ leadId, open, onClose }: { leadId: number; open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const pipelines = usePipelines('deal');
  const pv = useQuery({ queryKey: ['convert-preview', leadId], enabled: open, queryFn: () => api.get<Preview>(`/leads/${leadId}/convert-preview`) });
  const [contact, setContact] = useState<PartyMode>({ mode: 'create' });
  const [company, setCompany] = useState<PartyMode>({ mode: 'create' });
  const [deal, setDeal] = useState({ create: true, title: '', amount: '', pipelineId: 0, stageId: 0 });
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [extraRequired, setExtraRequired] = useState<FieldDef[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pv.data) return;
    const p = pv.data;
    setContact(p.contactMatches[0] ? { mode: 'existing', id: p.contactMatches[0].id } : p.contactName ? { mode: 'create' } : { mode: 'skip' });
    setCompany(p.companyMatches[0] ? { mode: 'existing', id: p.companyMatches[0].id } : p.companyName ? { mode: 'create' } : { mode: 'skip' });
    setDeal({ create: true, title: p.dealDefaults.title, amount: p.dealDefaults.amount ?? '', pipelineId: p.dealDefaults.pipelineId, stageId: p.dealDefaults.stageId });
  }, [pv.data]);

  const pipeline = pipelines.find((p) => p.id === deal.pipelineId);
  const required: FieldDef[] = [
    ...(pv.data?.dealRequiredFields ?? []).map((f, i) => ({ ...f, id: -i - 1, entityType: 'deal', required: 'always' as const, requiredStageIds: [], helpText: null, sort: i, isActive: true })),
    ...extraRequired.filter((x) => !(pv.data?.dealRequiredFields ?? []).some((f) => f.key === x.key)),
  ];

  const submit = async () => {
    setSaving(true); setError(null);
    try {
      const r = await api.post<{ dealId: number | null; contactId: number | null; companyId: number | null }>(`/leads/${leadId}/convert`, {
        contact, company,
        deal: deal.create ? { create: true, title: deal.title || null, amount: deal.amount || null, pipelineId: deal.pipelineId, stageId: deal.stageId, custom } : { create: false },
      });
      qc.invalidateQueries();
      toast.success('Lead converted');
      onClose();
      if (r.dealId) nav(`/deals/${r.dealId}`); else if (r.contactId) nav(`/contacts/${r.contactId}`); else if (r.companyId) nav(`/companies/${r.companyId}`);
    } catch (e) {
      const fields = requiredFromError(e);
      if (fields) setExtraRequired(fields);
      setError(errorMessage(e));
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()} title="Convert lead" description="Turn this lead into the records you need. Existing matches are suggested to avoid duplicates." size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} disabled={!pv.data} onClick={submit}>Convert</Button></>}>
      {pv.isLoading || !pv.data ? <div className="flex justify-center py-10"><Spinner /></div> : (
        <div className="space-y-4">
          <PartyChoice title="Contact" name={pv.data.contactName} matches={pv.data.contactMatches} value={contact} onChange={setContact} emptyHint="The lead has no person name." />
          <PartyChoice title="Company" name={pv.data.companyName} matches={pv.data.companyMatches} value={company} onChange={setCompany} emptyHint="The lead has no company name." />
          <section className="rounded-lg border border-base p-3">
            <Checkbox checked={deal.create} onChange={(v) => setDeal((s) => ({ ...s, create: v }))} label={<span className="font-medium">Create a deal</span>} />
            {deal.create && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Deal name" htmlFor="cv-title" className="sm:col-span-2"><Input id="cv-title" value={deal.title} onChange={(e) => setDeal((s) => ({ ...s, title: e.target.value }))} /></Field>
                <Field label="Amount" htmlFor="cv-amt" hint="Products on the lead are copied over"><Input id="cv-amt" inputMode="decimal" value={deal.amount} onChange={(e) => setDeal((s) => ({ ...s, amount: e.target.value }))} /></Field>
                {pipelines.length > 1 && (
                  <Field label="Pipeline" htmlFor="cv-pipe"><Select id="cv-pipe" value={deal.pipelineId} onChange={(e) => { const p = pipelines.find((x) => x.id === Number(e.target.value)); setDeal((s) => ({ ...s, pipelineId: p!.id, stageId: p!.stages.find((x) => x.kind === 'open')!.id })); }}>
                    {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
                )}
                <Field label="Stage" htmlFor="cv-stage"><Select id="cv-stage" value={deal.stageId} onChange={(e) => setDeal((s) => ({ ...s, stageId: Number(e.target.value) }))}>
                  {pipeline?.stages.filter((s) => s.kind === 'open').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
                {required.map((f) => (
                  <Field key={f.key} label={f.label} required htmlFor={`cvf-${f.key}`}><CustomFieldInput id={`cvf-${f.key}`} def={f} value={custom[f.key]} onChange={(v) => setCustom((s) => ({ ...s, [f.key]: v }))} /></Field>
                ))}
              </div>
            )}
          </section>
          {error && <p className="text-sm text-rose-600" role="alert">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}

function PartyChoice({ title, name, matches, value, onChange, emptyHint }: { title: string; name: string | null; matches: Match[]; value: PartyMode; onChange: (v: PartyMode) => void; emptyHint: string }) {
  return (
    <section className="rounded-lg border border-base p-3">
      <div className="mb-2 text-[13px] font-semibold">{title}</div>
      {matches.length > 0 && (
        <div className="mb-2 flex items-start gap-1.5 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-100"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />A similar {title.toLowerCase()} already exists. Linking avoids a duplicate.</div>
      )}
      <div className="space-y-1.5 text-sm">
        {matches.map((m) => (
          <label key={m.id} className="flex cursor-pointer items-center gap-2">
            <input type="radio" name={title} checked={value.mode === 'existing' && value.id === m.id} onChange={() => onChange({ mode: 'existing', id: m.id })} className="accent-[var(--color-brand-600)]" />
            Link to existing <b>{m.title}</b> <span className="text-xs text-muted">(same {m.matchedOn})</span>
          </label>
        ))}
        <label className={`flex items-center gap-2 ${name ? 'cursor-pointer' : 'opacity-50'}`}>
          <input type="radio" name={title} disabled={!name} checked={value.mode === 'create'} onChange={() => onChange({ mode: 'create' })} className="accent-[var(--color-brand-600)]" />
          {name ? <>Create new <b>{name}</b></> : <>Create new — {emptyHint}</>}
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="radio" name={title} checked={value.mode === 'skip'} onChange={() => onChange({ mode: 'skip' })} className="accent-[var(--color-brand-600)]" />Don’t create a {title.toLowerCase()}
        </label>
      </div>
    </section>
  );
}
