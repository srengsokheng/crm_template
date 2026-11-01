import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '../../lib/api.ts';
import type { FieldDef, Stage } from '../../lib/types.ts';
import { RequiredFieldsDialog, requiredFromError } from '../records/record.tsx';
import { ReasonDialog } from './CloseDialog.tsx';

interface Pending { id: number; from: Stage | undefined; to: Stage; title: string; reason?: { reasonId: number | null; note: string } }

/**
 * Stage-change workflow shared by the board and the record page:
 * lost → ask for a reason; server says required fields missing → ask for them; then show an Undo toast.
 */
export function useStageMove(entity: 'deal' | 'lead', opts: { onOptimistic?: (id: number, stageId: number) => void; onSettled?: () => void } = {}) {
  const qc = useQueryClient();
  const [reasonFor, setReasonFor] = useState<Pending | null>(null);
  const [required, setRequired] = useState<{ p: Pending; fields: FieldDef[] } | null>(null);
  const base = entity === 'deal' ? '/deals' : '/leads';

  const send = async (p: Pending, custom?: Record<string, unknown>) => {
    if (entity === 'deal' && p.to.kind !== 'open') {
      return api.post(`${base}/${p.id}/close`, { outcome: p.to.kind, stageId: p.to.id, lostReasonId: p.reason?.reasonId ?? null, lostNote: p.reason?.note || null, custom });
    }
    if (entity === 'lead' && p.to.kind === 'lost') {
      return api.post(`${base}/${p.id}/disqualify`, { stageId: p.to.id, reasonId: p.reason?.reasonId ?? null, note: p.reason?.note || null });
    }
    return api.post(`${base}/${p.id}/move`, { stageId: p.to.id, custom });
  };

  const undo = async (p: Pending) => {
    try {
      if (p.to.kind !== 'open' && entity === 'deal') await api.post(`${base}/${p.id}/reopen`, { stageId: p.from?.kind === 'open' ? p.from.id : undefined });
      else if (p.from) await api.post(`${base}/${p.id}/move`, { stageId: p.from.id });
      qc.invalidateQueries();
      toast.success('Change undone');
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const run = async (p: Pending, custom?: Record<string, unknown>): Promise<void> => {
    opts.onOptimistic?.(p.id, p.to.id);
    try {
      await send(p, custom);
      setRequired(null); setReasonFor(null);
      const verb = p.to.kind === 'won' ? (entity === 'deal' ? 'Won' : 'Converted') : p.to.kind === 'lost' ? (entity === 'deal' ? 'Marked as lost' : 'Disqualified') : `Moved to ${p.to.name}`;
      toast.success(`${verb}: ${p.title}`, { action: p.from && !(entity === 'lead' && p.to.kind === 'lost') ? { label: 'Undo', onClick: () => undo(p) } : undefined });
    } catch (e) {
      const fields = requiredFromError(e);
      if (fields) { setRequired({ p, fields }); }
      else toast.error(errorMessage(e));
      if (!fields) throw e;
    } finally {
      qc.invalidateQueries({ queryKey: [entity + 's-board'] });
      qc.invalidateQueries({ queryKey: [entity + 's'] });
      qc.invalidateQueries({ queryKey: [entity, p.id] });
      qc.invalidateQueries({ queryKey: ['timeline', entity, p.id] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      opts.onSettled?.();
    }
  };

  const move = (id: number, title: string, from: Stage | undefined, to: Stage) => {
    const p: Pending = { id, title, from, to };
    if (to.kind === 'lost') { setReasonFor(p); return; }
    if (entity === 'lead' && to.kind === 'won') { toast.info('Use “Convert” on the lead to turn it into a contact, company and deal.'); return; }
    run(p).catch(() => {});
  };

  const dialogs = (
    <>
      <ReasonDialog open={!!reasonFor} onCancel={() => setReasonFor(null)}
        kind={entity === 'deal' ? 'lost_reason' : 'disqualify_reason'}
        title={entity === 'deal' ? 'Mark deal as lost' : 'Disqualify lead'} confirmLabel={entity === 'deal' ? 'Mark as lost' : 'Disqualify'}
        onConfirm={async (reason) => { const p = { ...reasonFor!, reason }; await run(p).catch(() => {}); }} />
      <RequiredFieldsDialog fields={required?.fields ?? null} onCancel={() => setRequired(null)}
        onSubmit={async (custom) => { await run(required!.p, custom); }} />
    </>
  );
  return { move, dialogs };
}
