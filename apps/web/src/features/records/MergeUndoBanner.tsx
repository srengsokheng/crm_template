import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Undo2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { relative } from '../../lib/format.ts';
import { Button } from '../../components/ui/primitives.tsx';
import { ConfirmDialog } from '../../components/ui/overlays.tsx';
import type { MergeEntity } from './MergeDialog.tsx';

interface Undoable { undoId: number; createdAt: string; merged: { id: number; title: string }[] }

/** Undo a merge into this record — offered for 7 days, until the record is edited again. */
export async function undoMerge(entity: MergeEntity, undoId: number) {
  return api.post<{ id: number; restoredIds: number[] }>(`/merge/${entity}/undo/${undoId}`, {});
}

/** Shown on a record that recently absorbed others through a merge. */
export function MergeUndoBanner({ entity, id, canEdit }: { entity: MergeEntity; id: number; canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['merge-undoable', entity, id], queryFn: () => api.get<Undoable | null>(`/merge/${entity}/undoable/${id}`), enabled: canEdit });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const u = q.data;
  if (!canEdit || !u) return null;
  const names = u.merged.map((m) => `“${m.title}”`).join(', ');
  const run = async () => {
    setBusy(true);
    try {
      await undoMerge(entity, u.undoId);
      for (const k of [`${entity}s`, entity === 'company' ? 'companies' : `${entity}s`, entity, 'contact', 'company', 'lead', 'deals', 'timeline', 'history', 'duplicate-pairs', 'merge-undoable']) qc.invalidateQueries({ queryKey: [k] });
      toast.success(`Merge undone — ${names} ${u.merged.length === 1 ? 'is' : 'are'} back`);
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); setConfirm(false); }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm dark:border-brand-500/30 dark:bg-brand-600/10">
      <span className="min-w-0 flex-1">Merged with {names} {relative(u.createdAt)}.</span>
      <Button size="sm" icon={<Undo2 className="size-3.5" />} loading={busy} onClick={() => setConfirm(true)}>Undo merge</Button>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Undo this merge?"
        description={`${names} come${u.merged.length === 1 ? 's' : ''} back as ${u.merged.length === 1 ? 'a separate record' : 'separate records'} with their own details, deals, notes, files and history. Things added here after the merge stay here.`}
        confirmLabel="Undo merge" onConfirm={run} />
    </div>
  );
}
