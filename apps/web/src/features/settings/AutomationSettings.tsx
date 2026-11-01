import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bot, Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { useAction, useFields, useMeta, usePipelines } from '../../lib/hooks.ts';
import type { Pipeline, Stage } from '../../lib/types.ts';
import { Badge, Button, Card, Checkbox, Field, IconButton, Input, Segmented, Select, Textarea } from '../../components/ui/primitives.tsx';
import { Drawer } from '../../components/ui/overlays.tsx';
import { StageBadge } from '../../components/ui/StageBadge.tsx';
import { AdminOnly } from './SettingsLayout.tsx';

interface Rule {
  id: number; entityType: 'deal' | 'lead'; pipelineId: number; stageId: number | null; trigger: 'stage_entered' | 'created'; delayMinutes: number;
  conditions: { field: string; op: string; value?: unknown }[]; action: string; config: Record<string, any>; isEnabled: boolean; successCount: number; failedCount: number;
}
const ACTIONS: Record<string, string> = { create_activity: 'Create an activity', notify: 'Send a notification', add_note: 'Add a note', update_field: 'Update a field', assign_owner: 'Assign an owner', move_stage: 'Move to another stage' };
const delayText = (m: number) => (m === 0 ? 'immediately' : m % 1440 === 0 ? `after ${m / 1440} day${m === 1440 ? '' : 's'}` : m % 60 === 0 ? `after ${m / 60} hour${m === 60 ? '' : 's'}` : `after ${m} minutes`);

function useDescribe() {
  const { data: meta } = useMeta();
  const user = (id: unknown) => (id === 'owner' || !id ? 'the owner' : meta?.users.find((u) => u.id === Number(id))?.name ?? 'someone');
  const stage = (id: unknown) => meta?.pipelines.flatMap((p) => p.stages).find((s) => s.id === Number(id))?.name ?? '?';
  return (r: Rule) => {
    const c = r.config;
    switch (r.action) {
      case 'create_activity': return `create a ${c.kind ?? 'task'} “${c.subject}” for ${user(c.assignTo)}, due in ${Number(c.dueInDays ?? 0) ? `${c.dueInDays} day(s)` : 'the same day'}`;
      case 'notify': return `notify ${user(c.userId)}: “${c.title || c.message}”`;
      case 'add_note': return `add the note “${String(c.text).slice(0, 60)}”`;
      case 'update_field': return `set ${c.field} to “${c.value}”`;
      case 'assign_owner': return c.mode === 'round_robin' ? `assign an owner round-robin in team #${c.teamId}` : `assign to ${user(c.userId)}`;
      case 'move_stage': return `move to ${stage(c.stageId)}`;
      default: return r.action;
    }
  };
}

export function AutomationSettings() {
  const [entity, setEntity] = useState<'deal' | 'lead'>('deal');
  const pipelines = usePipelines(entity);
  const [pipelineId, setPipelineId] = useState<number | null>(null);
  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? pipelines[0];
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ['rules', pipeline?.id], enabled: !!pipeline, queryFn: () => api.get<{ data: Rule[] }>(`/automation-rules?pipelineId=${pipeline!.id}`) });
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  const describe = useDescribe();
  const toggle = async (r: Rule) => { try { await api.patch(`/automation-rules/${r.id}`, { isEnabled: !r.isEnabled }); qc.invalidateQueries({ queryKey: ['rules'] }); } catch (e) { toast.error(errorMessage(e)); } };
  const remove = async (r: Rule) => { try { await api.del(`/automation-rules/${r.id}`); qc.invalidateQueries({ queryKey: ['rules'] }); toast.success('Rule deleted'); } catch (e) { toast.error(errorMessage(e)); } };
  const groups: { key: string; title: React.ReactNode; stage: Stage | null; trigger: Rule['trigger'] }[] = pipeline ? [
    { key: 'created', title: `When a ${entity} is created`, stage: null, trigger: 'created' },
    ...pipeline.stages.filter((s) => s.kind !== 'won' || entity === 'deal').map((s) => ({ key: `s${s.id}`, title: <span className="flex items-center gap-1.5">When a {entity} enters <StageBadge name={s.name} color={s.color} /></span>, stage: s, trigger: 'stage_entered' as const })),
  ] : [];
  return (
    <AdminOnly>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={entity} onChange={(v) => { setEntity(v); setPipelineId(null); }} options={[{ value: 'deal', label: 'Deals' }, { value: 'lead', label: 'Leads' }]} />
          {pipelines.length > 1 && <Select aria-label="Pipeline" className="w-auto" value={pipeline?.id ?? ''} onChange={(e) => setPipelineId(Number(e.target.value))}>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}
        </div>
        <p className="text-sm text-muted">Rules run in the background. Use them to schedule follow-ups, notify people or keep data tidy.</p>
        {groups.map((g) => {
          const list = (rules.data?.data ?? []).filter((r) => (g.trigger === 'created' ? r.trigger === 'created' : r.trigger === 'stage_entered' && r.stageId === g.stage?.id));
          return (
            <Card key={g.key} title={g.title} padded={false} actions={<Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setEditing({ entityType: entity, pipelineId: pipeline!.id, stageId: g.stage?.id ?? null, trigger: g.trigger, delayMinutes: 0, action: 'create_activity', config: { kind: 'task', assignTo: 'owner', dueInDays: 1 }, conditions: [], isEnabled: true })}>Add rule</Button>}>
              {list.length ? (
                <ol className="divide-y divide-[var(--border)]">
                  {list.map((r, i) => (
                    <li key={r.id} className="flex items-start gap-3 px-4 py-2.5">
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-violet-100 text-[11px] font-semibold text-violet-700 dark:bg-violet-500/20 dark:text-violet-200">{i + 1}</span>
                      <button type="button" className="min-w-0 flex-1 text-left text-sm" onClick={() => setEditing(r)}>
                        <span className="font-medium capitalize">{delayText(r.delayMinutes)}</span>{r.conditions.length > 0 && <span className="text-muted"> (if {r.conditions.map((c) => `${c.field} ${c.op} ${c.value ?? ''}`).join(' and ')})</span>} → {describe(r)}
                        <div className="text-xs text-muted">{r.successCount} runs{r.failedCount ? ` · ${r.failedCount} failed` : ''}</div>
                      </button>
                      {!r.isEnabled && <Badge>Off</Badge>}
                      <Checkbox checked={r.isEnabled} onChange={() => toggle(r)} label={<span className="sr-only">Enabled</span>} />
                      <IconButton size="sm" label="Delete rule" onClick={() => remove(r)}><Trash2 className="size-3.5" /></IconButton>
                    </li>
                  ))}
                </ol>
              ) : <p className="px-4 py-3 text-sm text-muted">No rules.</p>}
            </Card>
          );
        })}
      </div>
      {editing && pipeline && <RuleForm rule={editing} pipeline={pipeline} onClose={() => setEditing(null)} />}
    </AdminOnly>
  );
}

function RuleForm({ rule, pipeline, onClose }: { rule: Partial<Rule>; pipeline: Pipeline; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: meta } = useMeta();
  const fields = useFields(rule.entityType ?? 'deal');
  const [r, setR] = useState<Partial<Rule>>(rule);
  const unit = (r.delayMinutes ?? 0) % 1440 === 0 && r.delayMinutes ? 1440 : (r.delayMinutes ?? 0) % 60 === 0 && r.delayMinutes ? 60 : 1;
  const [delayUnit, setDelayUnit] = useState(unit);
  const cfg = r.config ?? {};
  const setCfg = (patch: Record<string, unknown>) => setR({ ...r, config: { ...cfg, ...patch } });
  const cond = r.conditions?.[0];
  const save = useAction(() => {
    const body = { entityType: r.entityType, pipelineId: r.pipelineId, stageId: r.stageId ?? null, trigger: r.trigger, delayMinutes: r.delayMinutes ?? 0, conditions: r.conditions ?? [], action: r.action, config: r.config ?? {}, isEnabled: r.isEnabled ?? true };
    return r.id ? api.patch(`/automation-rules/${r.id}`, body) : api.post('/automation-rules', body);
  }, { success: 'Rule saved', onSuccess: () => { qc.invalidateQueries({ queryKey: ['rules'] }); onClose(); } });
  const users = meta?.users.filter((u) => u.status === 'active') ?? [];
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={r.id ? 'Edit rule' : 'New rule'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save rule</Button></>}>
      <div className="space-y-4">
        <div className="flex items-center gap-2 rounded-lg bg-violet-50 p-3 text-sm text-violet-900 dark:bg-violet-500/10 dark:text-violet-100"><Bot className="size-4" />
          {r.trigger === 'created' ? `When a ${r.entityType} is created` : `When a ${r.entityType} enters ${pipeline.stages.find((s) => s.id === r.stageId)?.name}`}
        </div>
        <Field label="Run">
          <div className="flex gap-2">
            <Select aria-label="When" className="w-40" value={r.delayMinutes ? 'later' : 'now'} onChange={(e) => setR({ ...r, delayMinutes: e.target.value === 'now' ? 0 : delayUnit })}>
              <option value="now">Immediately</option><option value="later">After a delay</option>
            </Select>
            {!!r.delayMinutes && <>
              <Input aria-label="Delay amount" type="number" min={1} className="w-20" value={(r.delayMinutes ?? 0) / delayUnit} onChange={(e) => setR({ ...r, delayMinutes: Math.max(1, Number(e.target.value)) * delayUnit })} />
              <Select aria-label="Delay unit" className="w-28" value={delayUnit} onChange={(e) => { const u = Number(e.target.value); setR({ ...r, delayMinutes: ((r.delayMinutes ?? 0) / delayUnit) * u }); setDelayUnit(u); }}>
                <option value={1}>minutes</option><option value={60}>hours</option><option value={1440}>days</option>
              </Select>
            </>}
          </div>
          {!!r.delayMinutes && r.trigger === 'stage_entered' && <p className="text-xs text-muted">Skipped if the record has left the stage by then.</p>}
        </Field>
        <Field label="Only if (optional)">
          <div className="flex flex-wrap gap-2">
            <Select aria-label="Condition field" className="w-40" value={cond?.field ?? ''} onChange={(e) => setR({ ...r, conditions: e.target.value ? [{ field: e.target.value, op: cond?.op ?? 'gt', value: cond?.value ?? '' }] : [] })}>
              <option value="">No condition</option><option value="amount">Amount</option><option value="probability">Probability</option><option value="sourceId">Source</option>
              {fields.map((f) => <option key={f.key} value={`custom.${f.key}`}>{f.label}</option>)}
            </Select>
            {cond && <>
              <Select aria-label="Operator" className="w-32" value={cond.op} onChange={(e) => setR({ ...r, conditions: [{ ...cond, op: e.target.value }] })}>
                <option value="gt">is more than</option><option value="lt">is less than</option><option value="eq">equals</option><option value="neq">is not</option><option value="empty">is empty</option><option value="not_empty">is set</option>
              </Select>
              {!['empty', 'not_empty'].includes(cond.op) && <Input aria-label="Value" className="w-32" value={String(cond.value ?? '')} onChange={(e) => setR({ ...r, conditions: [{ ...cond, value: e.target.value }] })} />}
            </>}
          </div>
        </Field>
        <Field label="Then" htmlFor="r-action"><Select id="r-action" value={r.action} onChange={(e) => setR({ ...r, action: e.target.value, config: e.target.value === 'create_activity' ? { kind: 'task', assignTo: 'owner', dueInDays: 1 } : {} })}>
          {Object.entries(ACTIONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        {r.action === 'create_activity' && <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type" htmlFor="ra-kind"><Select id="ra-kind" value={cfg.kind ?? 'task'} onChange={(e) => setCfg({ kind: e.target.value })}>{['task', 'call', 'meeting', 'email', 'deadline'].map((k) => <option key={k} value={k}>{k}</option>)}</Select></Field>
            <Field label="Due in (days)" htmlFor="ra-due"><Input id="ra-due" type="number" min={0} value={cfg.dueInDays ?? 1} onChange={(e) => setCfg({ dueInDays: Number(e.target.value) })} /></Field>
          </div>
          <Field label="Subject" htmlFor="ra-subj" hint="You can use {{title}}, {{amount}} and {{owner}}"><Input id="ra-subj" value={cfg.subject ?? ''} onChange={(e) => setCfg({ subject: e.target.value })} placeholder="Follow up on {{title}}" /></Field>
          <Field label="Assign to" htmlFor="ra-user"><Select id="ra-user" value={cfg.assignTo ?? 'owner'} onChange={(e) => setCfg({ assignTo: e.target.value })}><option value="owner">Record owner</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
        </>}
        {r.action === 'notify' && <>
          <Field label="Notify" htmlFor="rn-user"><Select id="rn-user" value={cfg.userId ?? 'owner'} onChange={(e) => setCfg({ userId: e.target.value })}><option value="owner">Record owner</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
          <Field label="Title" htmlFor="rn-title"><Input id="rn-title" value={cfg.title ?? ''} onChange={(e) => setCfg({ title: e.target.value })} placeholder="{{title}} needs attention" /></Field>
          <Field label="Message" htmlFor="rn-msg"><Textarea id="rn-msg" value={cfg.message ?? ''} onChange={(e) => setCfg({ message: e.target.value })} /></Field>
        </>}
        {r.action === 'add_note' && <Field label="Note" htmlFor="rnote"><Textarea id="rnote" value={cfg.text ?? ''} onChange={(e) => setCfg({ text: e.target.value })} /></Field>}
        {r.action === 'update_field' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Field" htmlFor="ru-field"><Select id="ru-field" value={cfg.field ?? ''} onChange={(e) => setCfg({ field: e.target.value })}>
              <option value="">Choose…</option>{r.entityType === 'deal' && <option value="probability">Probability</option>}<option value="description">Description</option><option value="visibility">Visibility</option>
              {fields.map((f) => <option key={f.key} value={`custom.${f.key}`}>{f.label}</option>)}</Select></Field>
            <Field label="Value" htmlFor="ru-val"><Input id="ru-val" value={cfg.value ?? ''} onChange={(e) => setCfg({ value: e.target.value })} /></Field>
          </div>
        )}
        {r.action === 'assign_owner' && <>
          <Field label="How" htmlFor="ro-mode"><Select id="ro-mode" value={cfg.mode ?? 'fixed'} onChange={(e) => setCfg({ mode: e.target.value })}><option value="fixed">A specific person</option><option value="round_robin">Round-robin within a team (fewest open records)</option></Select></Field>
          {cfg.mode === 'round_robin'
            ? <Field label="Team" htmlFor="ro-team"><Select id="ro-team" value={cfg.teamId ?? ''} onChange={(e) => setCfg({ teamId: Number(e.target.value) })}><option value="">Choose…</option>{meta?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
            : <Field label="Person" htmlFor="ro-user"><Select id="ro-user" value={cfg.userId ?? ''} onChange={(e) => setCfg({ userId: Number(e.target.value) })}><option value="">Choose…</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>}
        </>}
        {r.action === 'move_stage' && <Field label="Target stage" htmlFor="rm-stage"><Select id="rm-stage" value={cfg.stageId ?? ''} onChange={(e) => setCfg({ stageId: Number(e.target.value) })}><option value="">Choose…</option>
          {pipeline.stages.filter((s) => s.id !== r.stageId && !(r.entityType === 'lead' && s.kind === 'won')).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>}
      </div>
    </Drawer>
  );
}
