import { useState } from 'react';
import { useDict } from '../../lib/hooks.ts';
import { Button, Field, Select, Textarea } from '../../components/ui/primitives.tsx';
import { Dialog } from '../../components/ui/overlays.tsx';

/** Asks for a reason when a deal is lost (or a lead disqualified). */
export function ReasonDialog({ open, onCancel, onConfirm, kind = 'lost_reason', title = 'Mark deal as lost', confirmLabel = 'Mark as lost' }: {
  open: boolean; onCancel: () => void; onConfirm: (v: { reasonId: number | null; note: string }) => Promise<void>; kind?: string; title?: string; confirmLabel?: string;
}) {
  const reasons = useDict(kind);
  const [reasonId, setReasonId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()} title={title} description="Recording why helps you spot patterns in your reports." size="sm"
      footer={<>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="danger" loading={busy} disabled={reasons.length > 0 && !reasonId}
          onClick={async () => { setBusy(true); try { await onConfirm({ reasonId, note }); setReasonId(null); setNote(''); } finally { setBusy(false); } }}>{confirmLabel}</Button>
      </>}>
      <div className="space-y-3">
        <Field label="Reason" required={reasons.length > 0} htmlFor="reason">
          <Select id="reason" value={reasonId ?? ''} onChange={(e) => setReasonId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Choose a reason…</option>
            {reasons.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </Select>
        </Field>
        <Field label="Comment" htmlFor="reason-note"><Textarea id="reason-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional details" /></Field>
      </div>
    </Dialog>
  );
}
