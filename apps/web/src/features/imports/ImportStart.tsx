import { useRef, useState, type DragEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Download, FileSpreadsheet, History, UploadCloud } from 'lucide-react';
import { IMPORT_LIMITS , type ImportEntity, importPermissionEntity } from '@crm/shared';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { relative } from '../../lib/format.ts';
import { useCan, useFields } from '../../lib/hooks.ts';
import { Badge, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui/primitives.tsx';
import { FeedList, useFeed } from '../../components/ui/FeedList.tsx';
import { downloadText, ENTITY, isImportEntity, readCsvFile, STATUS_BADGE, Steps, templateCsv, type ImportView } from './importUi.tsx';

export function ImportStart() {
  const { entity } = useParams();
  if (!isImportEntity(entity)) return <Navigate to="/contacts" replace />;
  return <ImportStartFor entity={entity} />;
}

function ImportStartFor({ entity }: { entity: ImportEntity }) {
  const nav = useNavigate();
  const can = useCan();
  const fields = useFields(entity);
  const e = ENTITY[entity];
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const history = useFeed<ImportView>(['imports', entity], '/imports', { entityType: entity }, { limit: 20 });

  const send = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!/\.(csv|txt|tsv)$/i.test(file.name)) {
      setError('Choose a .csv file. In Excel or Google Sheets use File → Save as / Download → CSV.');
      return;
    }
    if (file.size > IMPORT_LIMITS.maxBytes) { setError('This file is larger than 5 MB. Split it into smaller files.'); return; }
    if (file.size === 0) { setError('This file is empty.'); return; }
    setBusy(file.name);
    try {
      const content = await readCsvFile(file);
      const r = await api.post<ImportView>('/imports', { entityType: entity, fileName: file.name, content });
      nav(`/imports/${r.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : errorMessage(err));
      setBusy(null);
    } finally {
      if (input.current) input.current.value = '';
    }
  };
  const onDrop = (ev: DragEvent) => { ev.preventDefault(); setDrag(false); void send(ev.dataTransfer.files[0]); };

  if (!can(importPermissionEntity(entity), 'import')) {
    return (
      <div>
        <PageHeader title={`Import ${e.many}`} />
        <Card><EmptyState title="You can't import here" description={`Ask a workspace admin to allow importing ${e.many} for your role.`} action={<Link to={e.list} className="text-sm font-medium text-brand-600 hover:underline">Back to {e.many}</Link>} /></Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Link to={e.list} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-[var(--text)]"><ArrowLeft className="size-3.5" />{e.Many}</Link>
      <PageHeader title={`Import ${e.many}`} subtitle="Add or update many records at once from a spreadsheet." />
      {entity === 'deal_line' && (
        <p className="mb-4 max-w-2xl text-sm text-muted">
          Each row adds one product line to a deal that already exists — matched by <strong>Deal name</strong> (or <strong>Deal ID</strong> when names repeat).
          Products are matched by SKU or name; a product that isn’t in your list needs a unit price. The deal amount is recalculated unless it was set by hand.
        </p>
      )}
      <Steps current={0} />
      <Card>
        <label
          onDragOver={(ev) => { ev.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
          className={cn('flex cursor-pointer flex-col items-center justify-center gap-3 rounded-[var(--radius-card)] border-2 border-dashed px-6 py-10 text-center transition-colors',
            drag ? 'border-brand-500 bg-brand-50 dark:bg-brand-600/10' : 'border-base hover:bg-[var(--surface-2)]/60', busy && 'pointer-events-none opacity-70')}>
          {busy ? <Spinner className="size-7" /> : <UploadCloud className="size-8 text-muted" />}
          <div>
            <div className="text-sm font-medium">{busy ? `Reading ${busy}…` : 'Drop a CSV file here, or click to choose one'}</div>
            <div className="mt-1 text-xs text-muted">Up to {IMPORT_LIMITS.maxRows.toLocaleString('en-US')} rows and 5 MB. The first row must contain column names.</div>
          </div>
          <input ref={input} type="file" accept=".csv,.txt,.tsv,text/csv" className="sr-only" aria-label="CSV file" disabled={!!busy}
            onChange={(ev) => void send(ev.target.files?.[0])} />
        </label>
        {error && <p role="alert" className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[13px] text-muted">
          <span className="flex items-center gap-2"><FileSpreadsheet className="size-4 shrink-0" />Comma, semicolon or tab separated. You choose what each column means in the next step.</span>
          <Button size="sm" icon={<Download className="size-3.5" />} onClick={() => downloadText(`${e.many}-template.csv`, templateCsv(entity, fields))}>Download template</Button>
        </div>
      </Card>

      <Card title={<span className="flex items-center gap-2"><History className="size-4 text-muted" />Recent imports</span>} padded={false}>
        <FeedList feed={history} skeletonRows={2} label="Recent imports" empty={<p className="px-4 py-6 text-center text-sm text-muted">No {e.one} imports yet.</p>}>
              {(items) => items.map((imp) => (
                <li key={imp.id}>
                  <Link to={`/imports/${imp.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm hover:bg-[var(--surface-2)]/70">
                    <span className="min-w-0 flex-1 truncate font-medium">{imp.fileName}</span>
                    <Badge tone={STATUS_BADGE[imp.status].tone}>{STATUS_BADGE[imp.status].label}</Badge>
                    <span className="tabular text-xs text-muted">
                      {imp.status === 'draft' ? `${imp.rowCount.toLocaleString('en-US')} rows` : `${imp.created} new · ${imp.updated} updated · ${imp.failed} failed`}
                    </span>
                    <span className="w-full text-xs text-muted sm:w-auto">{imp.createdBy.name} · {relative(imp.createdAt)}</span>
                  </Link>
                </li>
              ))}
        </FeedList>
      </Card>
    </div>
  );
}
