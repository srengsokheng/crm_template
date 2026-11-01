import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Plus, Star, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { usePipelines } from '../../lib/hooks.ts';
import type { Pipeline, Stage } from '../../lib/types.ts';
import { Badge, Button, Card, Field, IconButton, Input, Segmented, Select } from '../../components/ui/primitives.tsx';
import { ConfirmDialog, Dialog } from '../../components/ui/overlays.tsx';
import { STAGE_SOLID } from '../../components/ui/stageColors.ts';
import { AdminOnly } from './SettingsLayout.tsx';

const COLORS = Object.keys(STAGE_SOLID);

export function PipelinesSettings() {
  const [entity, setEntity] = useState<'deal' | 'lead'>('deal');
  const pipelines = usePipelines(entity);
  const qc = useQueryClient();
  const [newName, setNewName] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['meta'] });
  const add = async () => {
    try { await api.post('/pipelines', { entityType: entity, name: newName }); setNewName(''); refresh(); toast.success('Pipeline added'); } catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <AdminOnly>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented value={entity} onChange={setEntity} options={[{ value: 'deal', label: 'Deal pipelines' }, { value: 'lead', label: 'Lead stages' }]} />
          {entity === 'deal' && (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newName.trim()) add(); }}>
              <Input aria-label="New pipeline name" placeholder="New pipeline name" value={newName} onChange={(e) => setNewName(e.target.value)} className="w-52" />
              <Button type="submit" icon={<Plus className="size-4" />} disabled={!newName.trim()}>Add pipeline</Button>
            </form>
          )}
        </div>
        {pipelines.map((p) => <PipelineCard key={p.id} p={p} canDelete={entity === 'deal' && pipelines.length > 1} onChange={refresh} />)}
      </div>
    </AdminOnly>
  );
}

function PipelineCard({ p, canDelete, onChange }: { p: Pipeline; canDelete: boolean; onChange: () => void }) {
  const [name, setName] = useState(p.name);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Stage | null>(null);
  const [moveTo, setMoveTo] = useState<number | null>(null);
  const [confirmPipe, setConfirmPipe] = useState(false);
  const call = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); onChange(); if (ok) toast.success(ok); return true; } catch (e) { toast.error(errorMessage(e)); return false; } };
  const ordered = [...p.stages].sort((a, b) => a.sort - b.sort);
  const move = (i: number, dir: -1 | 1) => {
    const ids = ordered.map((s) => s.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    call(() => api.post(`/pipelines/${p.id}/stages/reorder`, { ids }));
  };
  return (
    <Card padded={false} title={
      <div className="flex items-center gap-2">
        <Input aria-label="Pipeline name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== p.name && call(() => api.patch(`/pipelines/${p.id}`, { name }), 'Renamed')} className="h-8 w-56 font-semibold" />
        {p.isDefault ? <Badge tone="brand">Default</Badge> : p.entityType === 'deal' && <Button size="sm" variant="ghost" icon={<Star className="size-3.5" />} onClick={() => call(() => api.patch(`/pipelines/${p.id}`, { isDefault: true }), 'Default pipeline changed')}>Make default</Button>}
      </div>
    } actions={canDelete && !p.isDefault && <IconButton label="Delete pipeline" onClick={() => setConfirmPipe(true)}><Trash2 className="size-4" /></IconButton>}>
      <ul className="divide-y divide-[var(--border)]">
        {ordered.map((s, i) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
            <div className="flex flex-col">
              <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="text-muted disabled:opacity-30"><ArrowUp className="size-3.5" /></button>
              <button type="button" aria-label="Move down" disabled={i === ordered.length - 1} onClick={() => move(i, 1)} className="text-muted disabled:opacity-30"><ArrowDown className="size-3.5" /></button>
            </div>
            <StageEditor s={s} onSave={(patch) => call(() => api.patch(`/stages/${s.id}`, patch))} />
            {s.kind !== 'won' && <IconButton size="sm" label={`Delete ${s.name}`} onClick={() => { setDeleting(s); setMoveTo(null); }}><Trash2 className="size-3.5" /></IconButton>}
          </li>
        ))}
      </ul>
      <div className="border-t border-base px-4 py-2.5"><Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>Add stage</Button></div>
      <AddStage open={adding} onClose={() => setAdding(false)} onAdd={(body) => call(() => api.post(`/pipelines/${p.id}/stages`, body), 'Stage added').then((ok) => ok && setAdding(false))} />
      <Dialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} title={`Delete “${deleting?.name}”?`} size="sm"
        description="If records are in this stage, choose where to move them."
        footer={<><Button onClick={() => setDeleting(null)}>Cancel</Button><Button variant="danger" onClick={() => call(() => api.del(`/stages/${deleting!.id}`, { moveToStageId: moveTo }), 'Stage deleted').then((ok) => ok && setDeleting(null))}>Delete stage</Button></>}>
        <Field label="Move records to" htmlFor="move-to"><Select id="move-to" value={moveTo ?? ''} onChange={(e) => setMoveTo(e.target.value ? Number(e.target.value) : null)}>
          <option value="">(Only if it has records)</option>{ordered.filter((x) => x.id !== deleting?.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
      </Dialog>
      <ConfirmDialog open={confirmPipe} onOpenChange={setConfirmPipe} danger title={`Delete pipeline “${p.name}”?`} description="Only empty pipelines can be deleted." confirmLabel="Delete"
        onConfirm={() => call(() => api.del(`/pipelines/${p.id}`), 'Pipeline deleted').then(() => setConfirmPipe(false))} />
    </Card>
  );
}

function StageEditor({ s, onSave }: { s: Stage; onSave: (patch: Record<string, unknown>) => void }) {
  const [name, setName] = useState(s.name);
  return (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <Select aria-label="Color" value={s.color} onChange={(e) => onSave({ color: e.target.value })} className={cn('h-8 w-24 text-xs')}>
        {COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
      </Select>
      <span className={cn('size-3 rounded-full', STAGE_SOLID[s.color])} />
      <Input aria-label="Stage name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== s.name && onSave({ name })} className="h-8 min-w-36 flex-1" />
      <Badge tone={s.kind === 'won' ? 'green' : s.kind === 'lost' ? 'red' : 'slate'}>{s.kind}</Badge>
      {s.kind === 'open' && <>
        <label className="flex items-center gap-1 text-xs text-muted">Prob.<Input aria-label="Probability" type="number" min={0} max={100} defaultValue={s.probability ?? ''} onBlur={(e) => onSave({ probability: e.target.value === '' ? null : Number(e.target.value) })} className="h-8 w-16" />%</label>
        <label className="flex items-center gap-1 text-xs text-muted" title="Warn when a record sits in this stage longer than this">Idle after<Input aria-label="Idle days" type="number" min={1} defaultValue={s.rotDays ?? ''} onBlur={(e) => onSave({ rotDays: e.target.value === '' ? null : Number(e.target.value) })} className="h-8 w-16" />d</label>
      </>}
    </div>
  );
}

function AddStage({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (b: Record<string, unknown>) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('open');
  const [color, setColor] = useState('sky');
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()} title="Add stage" size="sm"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={() => { onAdd({ name, kind, color }); setName(''); }}>Add</Button></>}>
      <div className="space-y-3">
        <Field label="Name" htmlFor="st-name"><Input id="st-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Type" htmlFor="st-kind"><Select id="st-kind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="open">In progress</option><option value="lost">Lost / failed</option></Select></Field>
        <Field label="Color" htmlFor="st-color"><Select id="st-color" value={color} onChange={(e) => setColor(e.target.value)}>{COLORS.map((c) => <option key={c}>{c}</option>)}</Select></Field>
      </div>
    </Dialog>
  );
}
