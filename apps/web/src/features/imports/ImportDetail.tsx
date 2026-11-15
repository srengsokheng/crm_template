import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeft, Download, ExternalLink, RotateCcw, Square } from 'lucide-react';
import {
  customTargetKey, IMPORT_TARGETS, MATCH_KEY_LABELS, MATCH_KEYS_BY_ENTITY, type DuplicateMode, type ImportEntity, type ImportOptions, type MatchKey,
} from '@crm/shared';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { relative } from '../../lib/format.ts';
import { useFields, usePipelines } from '../../lib/hooks.ts';
import { Badge, Button, Card, Checkbox, ErrorState, Field, PageHeader, Select, Skeleton } from '../../components/ui/primitives.tsx';
import { ConfirmDialog } from '../../components/ui/overlays.tsx';
import { UserSelect } from '../records/form.tsx';
import { ENTITY, RESULT_BADGE, Stat, STATUS_BADGE, Steps, type ImportView, type PreviewResult } from './importUi.tsx';

const LIST_KEYS: Record<ImportEntity, string[]> = { contact: ['contacts', 'companies'], company: ['companies'], lead: ['leads'] };
const recordPath = (entity: ImportEntity, id: number) => `/${ENTITY[entity].many}/${id}`;

export function ImportDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['import', id],
    queryFn: () => api.get<ImportView>(`/imports/${id}`),
    refetchInterval: (query) => (['queued', 'running'].includes(query.state.data?.status ?? '') ? 1000 : false),
  });
  const imp = q.data;
  // When a running import finishes, refresh the lists it changed.
  const prev = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (imp && prev.current && ['queued', 'running'].includes(prev.current) && !['queued', 'running'].includes(imp.status)) {
      for (const k of [...LIST_KEYS[imp.entityType], 'imports']) qc.invalidateQueries({ queryKey: [k] });
    }
    prev.current = imp?.status;
  }, [imp, qc]);

  if (q.isLoading) return <div className="mx-auto max-w-5xl space-y-4"><Skeleton className="h-6 w-48" /><Skeleton className="h-64" /></div>;
  if (q.error || !imp) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return <Card><ErrorState message={notFound ? 'This import does not exist or belongs to someone else.' : errorMessage(q.error)} onRetry={notFound ? undefined : () => q.refetch()} /></Card>;
  }
  const e = ENTITY[imp.entityType];
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Link to={`/import/${imp.entityType}`} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-[var(--text)]"><ArrowLeft className="size-3.5" />Import {e.many}</Link>
      <PageHeader title={imp.fileName} subtitle={<>{imp.rowCount.toLocaleString('en-US')} rows · {imp.headers.length} columns · uploaded {relative(imp.createdAt)}{imp.createdBy.name ? ` by ${imp.createdBy.name}` : ''}</>}
        actions={<Badge tone={STATUS_BADGE[imp.status].tone}>{STATUS_BADGE[imp.status].label}</Badge>} />
      {imp.status === 'draft' ? <Setup imp={imp} onStarted={() => q.refetch()} />
        : ['queued', 'running'].includes(imp.status) ? <Progress imp={imp} onChange={() => q.refetch()} />
        : <Report imp={imp} onChange={() => q.refetch()} />}
    </div>
  );
}

// ───────────────────────── Map columns + options → Review ─────────────────────────

function Setup({ imp, onStarted }: { imp: ImportView; onStarted: () => void }) {
  const entity = imp.entityType;
  const e = ENTITY[entity];
  const fields = useFields(entity);
  const pipelines = usePipelines('lead');
  const [mapping, setMapping] = useState<(string | null)[]>(imp.mapping);
  const [options, setOptions] = useState<ImportOptions>(imp.options);
  const [step, setStep] = useState<'map' | 'review'>('map');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const set = (patch: Partial<ImportOptions>) => setOptions({ ...options, ...patch });

  const targets = IMPORT_TARGETS[entity];
  const single = useMemo(() => new Set([...targets.filter((t) => !t.multiple).map((t) => t.key), ...fields.map((f) => customTargetKey(f.key))]), [targets, fields]);
  const choose = (col: number, key: string | null) => {
    // A single-value field can only come from one column: choosing it here clears it elsewhere.
    setMapping(mapping.map((k, i) => (i === col ? key : key && single.has(key) && k === key ? null : k)));
  };
  const mapped = mapping.filter(Boolean).length;
  const examples = (col: number) => imp.sample.map((r) => r[col]).filter(Boolean).slice(0, 3);
  const groups = ['Name', 'Contact details', 'Details', 'Address'] as const;

  const cfg = () => ({ mapping, options });
  const fail = (err: unknown) => {
    const details = err instanceof ApiError && Array.isArray(err.details) ? (err.details as string[]) : [err instanceof Error ? err.message : 'Something went wrong'];
    setProblems(details);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const review = async () => {
    setBusy(true); setProblems([]);
    try { setPreview(await api.post<PreviewResult>(`/imports/${imp.id}/preview`, cfg())); setStep('review'); window.scrollTo({ top: 0 }); }
    catch (err) { fail(err); } finally { setBusy(false); }
  };
  const start = async () => {
    setBusy(true);
    try { await api.post(`/imports/${imp.id}/run`, cfg()); onStarted(); }
    catch (err) { fail(err); setStep('map'); setBusy(false); }
  };

  const problemBox = problems.length > 0 && (
    <div role="alert" className="flex gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" /><ul className="space-y-0.5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
    </div>
  );

  if (step === 'review' && preview) {
    const willWrite = preview.summary.create + preview.summary.update;
    return (
      <div className="space-y-4">
        <Steps current={2} />
        {problemBox}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label={`New ${e.many}`} value={preview.summary.create} tone="green" />
          <Stat label="Updates" value={preview.summary.update} tone="blue" />
          <Stat label="Skipped duplicates" value={preview.summary.skip} tone="amber" />
          <Stat label="Rows with problems" value={preview.summary.error} tone="red" />
        </div>
        {preview.summary.newCompanies > 0 && <p className="text-sm text-muted">{preview.summary.newCompanies} new {preview.summary.newCompanies === 1 ? 'company' : 'companies'} will be created for the Company column.</p>}
        {preview.summary.error > 0 && (
          <Card title={`Rows with problems (${preview.summary.error.toLocaleString('en-US')})`} padded={false}>
            <p className="border-b border-base px-4 py-2.5 text-[13px] text-muted">These rows will not be imported. After the import you can download them with the reason, fix them and import that file.</p>
            <ResultList rows={preview.problems.map((p) => ({ key: p.i, row: p.row, title: p.title, badge: RESULT_BADGE.error, note: p.message }))} />
          </Card>
        )}
        <Card title={`First ${Math.min(preview.rows.length, 100)} rows`} padded={false}>
          <ResultList rows={preview.rows.map((p) => ({
            key: p.i, row: p.row, title: p.title, badge: RESULT_BADGE[p.action], note: p.message,
            link: p.recordId ? recordPath(entity, p.recordId) : undefined,
          }))} />
        </Card>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button onClick={() => setStep('map')} disabled={busy}>Back to mapping</Button>
          <Button variant="primary" loading={busy} disabled={willWrite === 0} onClick={start}>
            {willWrite === 0 ? 'Nothing to import' : `Import ${willWrite.toLocaleString('en-US')} ${willWrite === 1 ? 'row' : 'rows'}`}
          </Button>
        </div>
      </div>
    );
  }

  const matchKeys = MATCH_KEYS_BY_ENTITY[entity];
  return (
    <div className="space-y-4">
      <Steps current={1} />
      {problemBox}
      <Card title="Map columns" padded={false}>
        <p className="border-b border-base px-4 py-2.5 text-[13px] text-muted">
          {mapped} of {imp.headers.length} columns will be imported. Pick what each column contains, or “Don’t import” to leave it out.
        </p>
        <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] gap-4 border-b border-base bg-[var(--surface-2)]/60 px-4 py-2 text-xs font-medium text-muted md:grid">
          <span>Column in your file</span><span>Example values</span><span>Import as</span>
        </div>
        <ul className="divide-y divide-[var(--border)]">
          {imp.headers.map((h, col) => (
            <li key={col} className="grid gap-x-4 gap-y-1.5 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] md:items-center">
              <div className="min-w-0 truncate text-sm font-medium" title={h}>{h}</div>
              <div className="min-w-0 truncate text-[13px] text-muted" title={examples(col).join(' · ')}>{examples(col).join(' · ') || <span className="italic">empty in the first rows</span>}</div>
              <Select aria-label={`Import column ${h} as`} value={mapping[col] ?? ''} onChange={(ev) => choose(col, ev.target.value || null)}
                className={cn(!mapping[col] && 'text-muted')}>
                <option value="">Don’t import</option>
                {groups.map((g) => (
                  <optgroup key={g} label={g}>
                    {targets.filter((t) => t.group === g).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </optgroup>
                ))}
                {fields.length > 0 && (
                  <optgroup label="Custom fields">
                    {fields.map((f) => <option key={f.key} value={customTargetKey(f.key)}>{f.label}{f.required === 'always' ? ' (required)' : ''}</option>)}
                  </optgroup>
                )}
              </Select>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Duplicates">
        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="mb-1 text-[13px] font-medium">When a row matches an existing {e.one}</legend>
            {([
              ['skip', 'Skip the row', `Keep the existing ${e.one} as it is.`],
              ['update', `Update the existing ${e.one}`, 'Fill in the mapped values; new emails and phones are added, existing ones kept. Empty cells change nothing.'],
              ['create', `Create a new ${e.one} anyway`, 'Duplicates can be merged later.'],
            ] as [DuplicateMode, string, string][]).map(([v, label, hint]) => (
              <label key={v} className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input type="radio" name="duplicateMode" className="mt-0.5 size-4 accent-[var(--color-brand-600)]" checked={options.duplicateMode === v} onChange={() => set({ duplicateMode: v })} />
                <span><span className="font-medium">{label}</span><span className="block text-xs text-muted">{hint}</span></span>
              </label>
            ))}
          </fieldset>
          {options.duplicateMode !== 'create' && (
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-medium">Recognise existing {e.many} by</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {matchKeys.map((k: MatchKey) => (
                  <Checkbox key={k} label={MATCH_KEY_LABELS[k]} checked={options.matchBy.includes(k)}
                    onChange={(on) => set({ matchBy: on ? [...options.matchBy, k] : options.matchBy.filter((x) => x !== k) })} />
                ))}
              </div>
              <p className="mt-1.5 text-xs text-muted">Checked in this order; rows that repeat earlier rows of the same file count as duplicates too.{entity === 'lead' ? ' Only open leads are matched.' : ''}</p>
            </fieldset>
          )}
        </div>
      </Card>

      <Card title="Other settings">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Owner for rows without one" htmlFor="imp-owner" hint={mapping.includes('owner') ? 'Used when the Owner cell is empty.' : 'New records are assigned to this person.'}>
            <UserSelect id="imp-owner" value={options.ownerId ?? null} onChange={(v) => set({ ownerId: v })} allowEmpty emptyLabel="Me" />
          </Field>
          <Field label="Dates in the file look like" htmlFor="imp-dates" hint="2026-12-31 is always understood.">
            <Select id="imp-dates" value={options.dateFormat} onChange={(ev) => set({ dateFormat: ev.target.value as ImportOptions['dateFormat'] })}>
              <option value="ymd">2026-12-31 (year first)</option>
              <option value="dmy">31/12/2026 (day first)</option>
              <option value="mdy">12/31/2026 (month first)</option>
            </Select>
          </Field>
          {entity === 'lead' && pipelines.length > 1 && (
            <Field label="Pipeline" htmlFor="imp-pipeline">
              <Select id="imp-pipeline" value={options.pipelineId ?? ''} onChange={(ev) => set({ pipelineId: ev.target.value ? Number(ev.target.value) : null })}>
                <option value="">Default pipeline</option>
                {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
          )}
          {entity === 'contact' && mapping.includes('company') && (
            <div className="sm:col-span-2"><Checkbox label="Create companies that don’t exist yet (otherwise those rows are not imported)" checked={options.createCompanies} onChange={(v) => set({ createCompanies: v })} /></div>
          )}
          {entity === 'lead' && (
            <div className="sm:col-span-2"><Checkbox label="Run automation rules for imported leads (e.g. tasks or notes on “lead created”)" checked={options.runAutomation} onChange={(v) => set({ runAutomation: v })} /></div>
          )}
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link to={`/import/${entity}`} className="inline-flex h-9 items-center rounded-[var(--radius-control)] px-3.5 text-sm font-medium hover:bg-[var(--surface-2)]">Choose another file</Link>
        <Button variant="primary" loading={busy} onClick={review}>Review import</Button>
      </div>
    </div>
  );
}

function ResultList({ rows }: { rows: { key: number; row: number; title: string; badge: ReactNode; note?: string | null; link?: string }[] }) {
  if (!rows.length) return <p className="px-4 py-6 text-center text-sm text-muted">Nothing to show.</p>;
  return (
    <ul className="divide-y divide-[var(--border)]">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm">
          <span className="tabular pt-0.5 text-xs text-muted">Row {r.row}</span>
          <div className="min-w-0">
            <div className="truncate font-medium">{r.link ? <Link to={r.link} className="hover:underline">{r.title}</Link> : r.title}</div>
            {r.note && <div className="break-words text-[13px] text-muted">{r.note}</div>}
          </div>
          <span className="pt-0.5">{r.badge}</span>
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────── Running ─────────────────────────

function Progress({ imp, onChange }: { imp: ImportView; onChange: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const pct = imp.rowCount ? Math.round((imp.processed / imp.rowCount) * 100) : 0;
  const stop = async () => {
    setBusy(true);
    try { await api.post(`/imports/${imp.id}/cancel`); toast.success('Import stopped'); onChange(); }
    catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); setConfirm(false); }
  };
  return (
    <div className="space-y-4">
      <Steps current={3} />
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">{imp.status === 'queued' ? 'Starting…' : `Importing ${ENTITY[imp.entityType].many}…`}</h2>
          <span className="tabular text-sm text-muted">{imp.processed.toLocaleString('en-US')} of {imp.rowCount.toLocaleString('en-US')} rows</span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-2)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Import progress">
          <div className="h-full rounded-full bg-brand-600 transition-[width] duration-500" style={{ width: `${Math.max(pct, 2)}%` }} />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Created" value={imp.created} tone="green" /><Stat label="Updated" value={imp.updated} tone="blue" />
          <Stat label="Skipped" value={imp.skipped} tone="amber" /><Stat label="Failed" value={imp.failed} tone="red" />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-muted">You can leave this page; the import keeps running.</p>
          <Button icon={<Square className="size-3.5" />} onClick={() => setConfirm(true)}>Stop import</Button>
        </div>
      </Card>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Stop this import?" confirmLabel="Stop import" danger loading={busy} onConfirm={stop}
        description="Rows already imported stay. The remaining rows are not imported." />
    </div>
  );
}

// ───────────────────────── Report ─────────────────────────

function Report({ imp, onChange }: { imp: ImportView; onChange: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const e = ENTITY[imp.entityType];
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'all' | 'failed' | 'skipped'>('all');
  const issues = (imp.issues ?? []).filter((i) => filter === 'all' || i.action === filter);
  const undo = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ deleted: number; notAllowed: number; alreadyGone: number }>(`/imports/${imp.id}/undo`);
      toast.success(`${r.deleted} ${r.deleted === 1 ? e.one : e.many} moved to the recycle bin${r.notAllowed ? ` · ${r.notAllowed} you may not delete were kept` : ''}`);
      for (const k of LIST_KEYS[imp.entityType]) qc.invalidateQueries({ queryKey: [k] });
      onChange();
    } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); setConfirm(false); }
  };
  const title = imp.status === 'done' ? 'Import finished' : imp.status === 'canceled' ? 'Import stopped' : 'Import failed';
  return (
    <div className="space-y-4">
      <Steps current={4} />
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="mt-0.5 text-[13px] text-muted">
              {imp.processed.toLocaleString('en-US')} of {imp.rowCount.toLocaleString('en-US')} rows processed{imp.finishedAt ? ` · ${relative(imp.finishedAt)}` : ''}
              {imp.undoneAt ? ` · undone ${relative(imp.undoneAt)}` : ''}
            </p>
            {imp.error && <p role="alert" className="mt-2 text-sm text-rose-600">{imp.error}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            {imp.created > 0 && !imp.undoneAt && <Button icon={<RotateCcw className="size-3.5" />} onClick={() => setConfirm(true)}>Undo import</Button>}
            <Button variant="primary" icon={<ExternalLink className="size-3.5" />} onClick={() => nav(e.list)}>View {e.many}</Button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Created" value={imp.created} tone="green" /><Stat label="Updated" value={imp.updated} tone="blue" />
          <Stat label="Skipped" value={imp.skipped} tone="amber" /><Stat label="Failed" value={imp.failed} tone="red" />
        </div>
      </Card>

      {(imp.issuesTotal ?? 0) > 0 && (
        <Card padded={false} title={`Rows not imported (${(imp.issuesTotal ?? 0).toLocaleString('en-US')})`}
          actions={imp.failed > 0 && (
            <a href={`/api/v1/imports/${imp.id}/errors.csv`} download className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-base surface px-2.5 text-[13px] font-medium hover:bg-[var(--surface-2)]">
              <Download className="size-3.5" />Failed rows (CSV)
            </a>
          )}>
          <div className="flex flex-wrap gap-1 border-b border-base px-4 py-2">
            {(['all', 'failed', 'skipped'] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f}
                className={cn('rounded-md px-2.5 py-1 text-xs font-medium', filter === f ? 'bg-[var(--surface-2)]' : 'text-muted hover:text-[var(--text)]')}>
                {{ all: 'All', failed: `Failed (${imp.failed})`, skipped: `Skipped (${imp.skipped})` }[f]}
              </button>
            ))}
          </div>
          <ResultList rows={issues.map((i, n) => ({
            key: n, row: i.row, title: i.values?.filter(Boolean).slice(0, 3).join(' · ') || '—', badge: RESULT_BADGE[i.action], note: i.message,
            link: i.recordId ? recordPath(imp.entityType, i.recordId) : undefined,
          }))} />
          {(imp.issuesTotal ?? 0) > (imp.issues?.length ?? 0) && <p className="border-t border-base px-4 py-2.5 text-xs text-muted">Showing the first {imp.issues?.length} rows. Download the CSV for all failed rows.</p>}
        </Card>
      )}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Undo this import?" confirmLabel="Move to recycle bin" danger loading={busy} onConfirm={undo}
        description={`The ${imp.created.toLocaleString('en-US')} ${imp.created === 1 ? e.one : e.many} this import created go to the recycle bin (restorable for 30 days). Records it updated keep their new values.`} />
    </div>
  );
}
