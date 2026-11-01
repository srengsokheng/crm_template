import { api } from '../../lib/api.ts';
import { fromLocalInput, toLocalInput } from '../../lib/format.ts';
import { useAction, useMe } from '../../lib/hooks.ts';
import type { Activity } from '../../lib/types.ts';
import { Button, Field, Input, Select, Textarea } from '../../components/ui/primitives.tsx';
import { Drawer } from '../../components/ui/overlays.tsx';
import { EntityPicker, type PickerItem } from '../../components/ui/EntityPicker.tsx';
import { UserSelect, useForm } from '../records/form.tsx';

const tomorrow9 = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.toISOString(); };

export function ActivityForm({ open, onClose, defaults }: { open: boolean; onClose: () => void; defaults?: Record<string, unknown> }) {
  const { data: me } = useMe();
  const editing = defaults?.activity as Activity | undefined;
  const f = useForm({
    kind: editing?.kind ?? 'task' as Activity['kind'], subject: editing?.subject ?? '', description: editing?.description ?? '',
    dueAt: editing ? editing.dueAt ?? '' : tomorrow9(), priority: editing?.priority ?? 'normal', assigneeId: editing?.assigneeId ?? me?.user.id ?? null as number | null,
    reminder: editing ? '' : '15', deal: null as PickerItem | null, contact: null as PickerItem | null,
  });
  const v = f.values;
  const save = useAction(() => {
    const body = {
      kind: v.kind, subject: v.subject, description: v.description || null, dueAt: v.dueAt || null, priority: v.priority, assigneeId: v.assigneeId,
      ...(v.reminder !== '' ? { reminderMinutesBefore: v.dueAt ? Number(v.reminder) : null } : {}),
    };
    if (editing) return api.patch(`/activities/${editing.id}`, body);
    const links = [v.deal && { entityType: 'deal', entityId: v.deal.id }, v.contact && { entityType: 'contact', entityId: v.contact.id }].filter(Boolean);
    return api.post('/activities', { ...body, links });
  }, {
    success: editing ? 'Activity updated' : 'Activity scheduled', invalidate: [['activities'], ['activity-counts'], ['timeline'], ['dashboard']],
    onSuccess: () => onClose(), onError: (e) => { f.fromError(e); return false; },
  });
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} title={editing ? 'Edit activity' : 'New activity'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>{editing ? 'Save' : 'Schedule'}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Type" htmlFor="a-kind"><Select id="a-kind" value={v.kind} onChange={(e) => f.set('kind', e.target.value as Activity['kind'])}>
            {['task', 'call', 'meeting', 'email', 'deadline'].map((k) => <option key={k} value={k} className="capitalize">{k[0].toUpperCase() + k.slice(1)}</option>)}</Select></Field>
          <Field label="Priority" htmlFor="a-pri"><Select id="a-pri" value={v.priority} onChange={(e) => f.set('priority', e.target.value as Activity['priority'])}>
            <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></Select></Field>
        </div>
        <Field label="Subject" required htmlFor="a-subj" error={f.errors.subject}><Input id="a-subj" autoFocus value={v.subject} invalid={!!f.errors.subject} onChange={(e) => f.set('subject', e.target.value)} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Due" htmlFor="a-due" error={f.errors.dueAt}><Input id="a-due" type="datetime-local" value={toLocalInput(v.dueAt)} onChange={(e) => f.set('dueAt', fromLocalInput(e.target.value) ?? '')} /></Field>
          <Field label="Reminder" htmlFor="a-rem"><Select id="a-rem" value={v.reminder} onChange={(e) => f.set('reminder', e.target.value)}>
            {editing && <option value="">Keep current</option>}
            <option value="0">At due time</option><option value="15">15 min before</option><option value="60">1 hour before</option><option value="1440">1 day before</option></Select></Field>
        </div>
        <Field label="Assigned to" htmlFor="a-user"><UserSelect id="a-user" value={v.assigneeId} onChange={(x) => f.set('assigneeId', x)} /></Field>
        {!editing && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Related deal"><EntityPicker entity="deals" value={v.deal} onChange={(x) => f.set('deal', x)} placeholder="Optional" /></Field>
            <Field label="Related contact"><EntityPicker entity="contacts" value={v.contact} onChange={(x) => f.set('contact', x)} placeholder="Optional" /></Field>
          </div>
        )}
        <Field label="Details" htmlFor="a-desc"><Textarea id="a-desc" value={v.description} onChange={(e) => f.set('description', e.target.value)} /></Field>
        <button type="submit" className="hidden" />
      </form>
    </Drawer>
  );
}
