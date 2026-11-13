import { Check } from 'lucide-react';
import { IMPORT_TARGETS, toCsv, type ImportEntity, type ImportOptions } from '@crm/shared';
import { cn } from '../../lib/cn.ts';
import type { FieldDef } from '../../lib/types.ts';
import { Badge } from '../../components/ui/primitives.tsx';

export const ENTITY: Record<ImportEntity, { one: string; many: string; list: string; Many: string }> = {
  contact: { one: 'contact', many: 'contacts', list: '/contacts', Many: 'Contacts' },
  company: { one: 'company', many: 'companies', list: '/companies', Many: 'Companies' },
  lead: { one: 'lead', many: 'leads', list: '/leads?view=list', Many: 'Leads' },
};
export const isImportEntity = (v: string | undefined): v is ImportEntity => v === 'contact' || v === 'company' || v === 'lead';

export type ImportStatus = 'draft' | 'queued' | 'running' | 'done' | 'failed' | 'canceled';
export interface ImportView {
  id: number; entityType: ImportEntity; fileName: string; status: ImportStatus; headers: string[]; rowCount: number;
  sample: string[][]; mapping: (string | null)[]; options: ImportOptions; processed: number;
  created: number; updated: number; skipped: number; failed: number; error: string | null; undoneAt: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null; createdBy: { id: number; name: string | null };
  issuesTotal?: number;
  issues?: { row: number; action: 'failed' | 'skipped'; message: string | null; recordId: number | null; values: string[] | null }[];
}
export interface PreviewRow { i: number; row: number; action: 'create' | 'update' | 'skip' | 'error'; title: string; recordId?: number; message?: string }
export interface PreviewResult {
  summary: { create: number; update: number; skip: number; error: number; newCompanies: number };
  rows: PreviewRow[]; problems: PreviewRow[];
}

export const STATUS_BADGE: Record<ImportStatus, { label: string; tone: 'slate' | 'brand' | 'green' | 'red' | 'amber' | 'blue' }> = {
  draft: { label: 'Not started', tone: 'slate' }, queued: { label: 'Waiting', tone: 'blue' }, running: { label: 'Importing', tone: 'blue' },
  done: { label: 'Done', tone: 'green' }, failed: { label: 'Failed', tone: 'red' }, canceled: { label: 'Stopped', tone: 'amber' },
};

/** Read a file as text: UTF-8 when valid, otherwise Windows-1252 (what older Excel versions save as "CSV"). */
export async function readCsvFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob(['﻿', text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A CSV with one column per importable field (headers match the auto-mapping) and an example row. */
export function templateCsv(entity: ImportEntity, fields: FieldDef[]): string {
  const EXAMPLE: Record<string, string> = {
    firstName: 'Ada', lastName: 'Lovelace', jobTitle: 'Head of Engineering', email: 'ada@example.com', phone: '+1 555 0100',
    website: 'https://example.com', company: 'Analytical Engines Ltd', name: 'Analytical Engines Ltd', companyName: 'Analytical Engines Ltd',
    title: 'Website inquiry', amount: '2500', currency: 'USD', city: 'London', country: 'United Kingdom', birthday: '1815-12-10',
  };
  const targets = IMPORT_TARGETS[entity].filter((t) => t.key !== 'fullName');
  const head = [...targets.map((t) => t.label), ...fields.map((f) => f.label)];
  const example = [...targets.map((t) => EXAMPLE[t.key] ?? ''), ...fields.map(() => '')];
  return toCsv([head, example]);
}

const STEPS = ['Upload', 'Map columns', 'Review', 'Import'];
export function Steps({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]" aria-label="Import steps">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2" aria-current={i === current ? 'step' : undefined}>
          {i > 0 && <span className="h-px w-4 bg-[var(--border)] sm:w-6" aria-hidden />}
          <span className={cn('flex size-5 items-center justify-center rounded-full text-[11px] font-semibold',
            i < current ? 'bg-emerald-600 text-white' : i === current ? 'bg-brand-600 text-white' : 'bg-[var(--surface-2)] text-muted')}>
            {i < current ? <Check className="size-3" /> : i + 1}
          </span>
          <span className={cn(i === current ? 'font-medium' : 'text-muted', i !== current && 'max-sm:sr-only')}>{s}</span>
        </li>
      ))}
    </ol>
  );
}

export function Stat({ label, value, tone }: { label: string; value: number; tone?: 'green' | 'blue' | 'amber' | 'red' }) {
  const color = { green: 'text-emerald-600 dark:text-emerald-400', blue: 'text-sky-600 dark:text-sky-400', amber: 'text-amber-600 dark:text-amber-400', red: 'text-rose-600 dark:text-rose-400' };
  return (
    <div className="rounded-[var(--radius-card)] border border-base surface px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={cn('tabular mt-0.5 text-xl font-semibold', value > 0 && tone ? color[tone] : '')}>{value.toLocaleString('en-US')}</div>
    </div>
  );
}

export const RESULT_BADGE = {
  create: <Badge tone="green">New</Badge>, update: <Badge tone="blue">Update</Badge>, skip: <Badge tone="amber">Skip</Badge>, error: <Badge tone="red">Error</Badge>,
  created: <Badge tone="green">Created</Badge>, updated: <Badge tone="blue">Updated</Badge>, skipped: <Badge tone="amber">Skipped</Badge>, failed: <Badge tone="red">Failed</Badge>,
} as const;
