import { useRef, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, Eye, FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { api, ApiError, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { relative } from '../../lib/format.ts';
import type { RecordType } from '../../lib/types.ts';
import { Button, Card, ErrorState, IconButton, Skeleton, Spinner } from '../../components/ui/primitives.tsx';
import { ConfirmDialog } from '../../components/ui/overlays.tsx';

interface Att { id: number; fileName: string; contentType: string; sizeBytes: number; createdAt: string; uploadedByName: string | null }
const PREVIEW = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

async function upload(entityType: RecordType, entityId: number, file: File) {
  const res = await fetch(`/api/v1/attachments?entityType=${entityType}&entityId=${entityId}&fileName=${encodeURIComponent(file.name)}`, {
    method: 'POST', credentials: 'same-origin', body: file,
    headers: { 'x-requested-with': 'crm', 'content-type': 'application/octet-stream', 'x-file-type': file.type || 'application/octet-stream' },
  });
  if (!res.ok) {
    let msg = `Upload failed (${res.status})`;
    try { msg = (await res.json()).error?.message ?? msg; } catch { /* not JSON */ }
    if (res.status === 413) msg = 'This file is too large';
    throw new ApiError(res.status, 'UPLOAD_FAILED', msg);
  }
}

/** Files attached to a record: upload (button or drop), download, preview images, delete. */
export function Attachments({ entityType, entityId, canEdit }: { entityType: RecordType; entityId: number; canEdit: boolean }) {
  const qc = useQueryClient();
  const key = ['attachments', entityType, entityId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ data: Att[]; maxBytes: number }>(`/attachments?entityType=${entityType}&entityId=${entityId}`) });
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [drag, setDrag] = useState(false);
  const [deleting, setDeleting] = useState<Att | null>(null);
  const max = q.data?.maxBytes ?? 10 * 1024 * 1024;
  const refresh = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['timeline', entityType, entityId] }); };

  const send = async (list: FileList | File[] | null) => {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    const tooBig = picked.filter((f) => f.size > max);
    if (tooBig.length) toast.error(`${tooBig.map((f) => f.name).join(', ')}: larger than ${fileSize(max)}`);
    const ok = picked.filter((f) => f.size <= max && f.size > 0);
    setBusy((b) => b + ok.length);
    let done = 0;
    for (const f of ok) {
      try { await upload(entityType, entityId, f); done++; } catch (e) { toast.error(`${f.name}: ${errorMessage(e)}`); } finally { setBusy((b) => b - 1); }
    }
    if (done) { toast.success(done === 1 ? 'File added' : `${done} files added`); refresh(); }
    if (input.current) input.current.value = '';
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); if (canEdit) void send(e.dataTransfer.files); };
  const remove = async (a: Att) => {
    try { await api.del(`/attachments/${a.id}`); toast.success('File deleted'); refresh(); } catch (e) { toast.error(errorMessage(e)); } finally { setDeleting(null); }
  };
  const files = q.data?.data ?? [];
  return (
    <Card padded={false} title={<span className="flex items-center gap-2"><Paperclip className="size-4 text-muted" />Files ({files.length})</span>}
      actions={canEdit && <Button size="sm" variant="ghost" icon={busy ? <Spinner className="size-3.5" /> : <Upload className="size-3.5" />} disabled={busy > 0} onClick={() => input.current?.click()}>Upload</Button>}>
      <div onDragOver={(e) => { if (canEdit) { e.preventDefault(); setDrag(true); } }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
        className={cn('transition-colors', drag && 'bg-brand-50 dark:bg-brand-600/10')}>
        {canEdit && <input ref={input} type="file" multiple className="sr-only" aria-label="Add files" onChange={(e) => void send(e.target.files)} />}
        {q.isLoading ? <div className="space-y-2 p-4"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
          : q.error ? <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
          : !files.length ? (
            <p className="px-4 py-4 text-sm text-muted">{canEdit ? `No files yet. Drop files here or use Upload (up to ${fileSize(max)} each).` : 'No files.'}</p>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {files.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <FileText className="size-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <a href={`/api/v1/attachments/${a.id}`} download={a.fileName} className="block truncate font-medium text-brand-600 hover:underline dark:text-brand-200" title={a.fileName}>{a.fileName}</a>
                    <div className="truncate text-xs text-muted">{fileSize(a.sizeBytes)} · {a.uploadedByName ?? 'Someone'} · {relative(a.createdAt)}</div>
                  </div>
                  {PREVIEW.has(a.contentType) && (
                    <a href={`/api/v1/attachments/${a.id}?inline=1`} target="_blank" rel="noopener noreferrer" aria-label={`Preview ${a.fileName}`} title="Preview"
                      className="inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-[var(--surface-2)]"><Eye className="size-3.5" /></a>
                  )}
                  <a href={`/api/v1/attachments/${a.id}`} download={a.fileName} aria-label={`Download ${a.fileName}`} title="Download"
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-[var(--surface-2)]"><Download className="size-3.5" /></a>
                  {canEdit && <IconButton size="sm" label={`Delete ${a.fileName}`} onClick={() => setDeleting(a)}><Trash2 className="size-3.5" /></IconButton>}
                </li>
              ))}
            </ul>
          )}
      </div>
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} danger title={`Delete “${deleting?.fileName}”?`}
        description="The file is removed for everyone. This can’t be undone." confirmLabel="Delete file" onConfirm={() => deleting && remove(deleting)} />
    </Card>
  );
}
