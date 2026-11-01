import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Pencil } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { useFields, useUserName } from '../../lib/hooks.ts';
import type { FieldDef } from '../../lib/types.ts';
import { Button, Card, ErrorState, IconButton, Skeleton } from '../../components/ui/primitives.tsx';
import { Dialog } from '../../components/ui/overlays.tsx';
import { CustomFieldInput, customDisplay, useRequiredAt } from './form.tsx';

export function RecordShell({ back, title, subtitle, actions, stageBar, left, right, tabs }: {
  back: { to: string; label: string }; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; stageBar?: ReactNode;
  left: ReactNode; right: ReactNode; tabs?: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <Link to={back.to} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-[var(--text)]"><ArrowLeft className="size-3.5" />{back.label}</Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="break-words text-xl font-semibold tracking-tight">{title}</h1>
            {subtitle && <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">{subtitle}</div>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {stageBar}
      </div>
      {tabs}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <div className="space-y-4">{left}</div>
        <div className="min-w-0 space-y-4">{right}</div>
      </div>
    </div>
  );
}

export function RecordSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-4 w-24" /><Skeleton className="h-7 w-72" /><Skeleton className="h-8 w-full" />
      <div className="grid gap-4 lg:grid-cols-[380px_1fr]"><Skeleton className="h-96" /><Skeleton className="h-96" /></div>
    </div>
  );
}
export function RecordError({ error, back }: { error: unknown; back: string }) {
  const nav = useNavigate();
  const msg = error instanceof ApiError && error.status === 404 ? 'This record was not found. It may have been deleted.' : errorMessage(error);
  return <Card><ErrorState message={msg} /><div className="flex justify-center pb-6"><Button onClick={() => nav(back)}>Back to list</Button></div></Card>;
}

/** Editable row whose draft starts from a given value. */
export function EditRow<T>({ label, value, display, renderEditor, onSave, canEdit = true, required, hint }: {
  label: string; value: T; display: ReactNode; renderEditor: (v: T, set: (v: T) => void) => ReactNode;
  onSave: (v: T) => Promise<unknown>; canEdit?: boolean; required?: boolean; hint?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<T>(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true); setError(null);
    try { await onSave(draft); setEditing(false); } catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <div className="group grid grid-cols-[120px_minmax(0,1fr)] items-start gap-3 py-2 text-sm sm:grid-cols-[140px_minmax(0,1fr)]">
      <div className="pt-1 text-[13px] text-muted">{label}{required && <span className="text-rose-600"> *</span>}</div>
      {editing ? (
        <div className="space-y-1.5" onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); save(); } }}>
          {renderEditor(draft, setDraft)}
          {error && <p className="text-xs text-rose-600">{error}</p>}
          <div className="flex gap-1.5">
            <Button size="sm" variant="primary" loading={saving} onClick={save}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0 break-words pt-0.5">{display}{hint && <div className="text-xs text-muted">{hint}</div>}</div>
          {canEdit && (
            <IconButton size="sm" label={`Edit ${label}`} className="opacity-50 transition-opacity group-hover:opacity-100 focus:opacity-100 max-md:opacity-100" onClick={() => { setDraft(value); setEditing(true); }}>
              <Pencil className="size-3.5" />
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}

export function CustomFieldsRows({ entity, custom, stageId, canEdit, onSave }: {
  entity: string; custom: Record<string, unknown>; stageId?: number | null; canEdit: boolean; onSave: (patch: Record<string, unknown>) => Promise<unknown>;
}) {
  const defs = useFields(entity);
  const userName = useUserName();
  const req = useRequiredAt();
  if (!defs.length) return null;
  return (
    <>
      {defs.map((d) => (
        <EditRow<unknown> key={d.id} label={d.label} value={custom?.[d.key] ?? null} canEdit={canEdit} required={req.isRequired(d, stageId)}
          hint={d.required === 'from_stage' && !req.isRequired(d, stageId) ? `Required from ${req.fromLabel(d)}` : d.helpText ?? undefined}
          display={<span className={customDisplay(d, custom?.[d.key], userName) === '—' ? 'text-muted' : ''}>{customDisplay(d, custom?.[d.key], userName)}</span>}
          renderEditor={(v, set) => <CustomFieldInput def={d} value={v} onChange={set} />}
          onSave={(v) => onSave({ [d.key]: v })} />
      ))}
    </>
  );
}

/** Ask for the custom fields the server said are missing (422 REQUIRED_FIELDS) and retry. */
export function RequiredFieldsDialog({ fields, onCancel, onSubmit, title = 'A few details are needed' }: {
  fields: FieldDef[] | null; onCancel: () => void; onSubmit: (custom: Record<string, unknown>) => Promise<void>; title?: string;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!fields) return null;
  const submit = async () => {
    setSaving(true); setError(null);
    try { await onSubmit(values); setValues({}); } catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onCancel()} title={title} description="Fill these in to move to this stage."
      footer={<><Button onClick={onCancel}>Cancel</Button><Button variant="primary" loading={saving} onClick={submit}>Save and move</Button></>}>
      <div className="space-y-3">
        {fields.map((f) => (
          <div key={f.key} className="space-y-1.5">
            <label className="block text-[13px] font-medium" htmlFor={`rf-${f.key}`}>{f.label}<span className="text-rose-600"> *</span></label>
            <CustomFieldInput id={`rf-${f.key}`} def={f} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
            {f.helpText && <p className="text-xs text-muted">{f.helpText}</p>}
          </div>
        ))}
        {error && <p className="text-sm text-rose-600">{error}</p>}
      </div>
    </Dialog>
  );
}

/** Convert a 422 response into field definitions for RequiredFieldsDialog. */
export function requiredFromError(e: unknown): FieldDef[] | null {
  if (!(e instanceof ApiError) || e.code !== 'REQUIRED_FIELDS' || !Array.isArray(e.details)) return null;
  return (e.details as { key: string; label: string; type: string; options: { id: string; label: string }[]; helpText?: string }[]).map((d, i) => ({
    id: -i - 1, entityType: '', key: d.key, label: d.label, type: d.type, options: d.options ?? [], required: 'always', requiredStageIds: [], helpText: d.helpText ?? null, sort: i, isActive: true,
  }));
}

/** Soft delete with an Undo action in the toast. */
export function useDeleteWithUndo(entityPath: string, label: string, afterDelete?: () => void) {
  const qc = useQueryClient();
  return async (id: number) => {
    try {
      await api.del(`/${entityPath}/${id}`);
      qc.invalidateQueries();
      afterDelete?.();
      toast(`${label} moved to the recycle bin`, {
        action: { label: 'Undo', onClick: async () => { try { await api.post(`/${entityPath}/${id}/restore`); qc.invalidateQueries(); toast.success(`${label} restored`); } catch (e) { toast.error(errorMessage(e)); } } },
        duration: 7000,
      });
    } catch (e) { toast.error(errorMessage(e)); }
  };
}
