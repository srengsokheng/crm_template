import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MessageSquareText, Pencil, Plus, Trash2 } from 'lucide-react';
import { fillPlaceholders } from '@crm/shared';
import { api, errorMessage } from '../../lib/api.ts';
import { useMe } from '../../lib/hooks.ts';
import { Badge, Button, Checkbox, ErrorState, Field, IconButton, Input, Skeleton, Textarea } from '../../components/ui/primitives.tsx';
import { ConfirmDialog, Dialog, Popover } from '../../components/ui/overlays.tsx';

interface SavedReply { id: number; title: string; body: string; shared: boolean; ownerName: string; canEdit: boolean }

/** Composer button: pick a saved reply (placeholders filled in), or create / edit / delete them. */
export function SavedRepliesMenu({ name, onInsert }: { name: string; onInsert: (text: string) => void }) {
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<SavedReply | 'new' | null>(null);
  const [deleting, setDeleting] = useState<SavedReply | null>(null);
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['saved-replies'], enabled: open, queryFn: () => api.get<{ data: SavedReply[] }>('/inbox/saved-replies') });
  const term = q.trim().toLowerCase();
  const items = (list.data?.data ?? []).filter((r) => !term || r.title.toLowerCase().includes(term) || r.body.toLowerCase().includes(term));
  const pick = (r: SavedReply) => { onInsert(fillPlaceholders(r.body, { name, agent: me?.user.name })); setOpen(false); setQ(''); };
  return (
    <>
      <Popover open={open} onOpenChange={setOpen} align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0"
        trigger={<IconButton label="Saved replies"><MessageSquareText className="size-4" /></IconButton>}>
        <div className="border-b border-base p-2"><Input autoFocus aria-label="Search saved replies" placeholder="Search saved replies" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 text-sm" /></div>
        <div className="max-h-72 overflow-y-auto">
          {list.isLoading ? <div className="space-y-2 p-3"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
            : list.isError ? <ErrorState message={errorMessage(list.error)} onRetry={() => list.refetch()} />
            : items.length === 0 ? <p className="px-3 py-4 text-sm text-muted">{term ? 'No saved replies match.' : 'No saved replies yet. Save answers you send often, then insert them here.'}</p>
            : (
              <ul className="divide-y divide-[var(--border)]">
                {items.map((r) => (
                  <li key={r.id} className="group flex items-start gap-1 px-1">
                    <button type="button" onClick={() => pick(r)} className="min-w-0 flex-1 rounded px-2 py-2 text-left hover:bg-[var(--surface-2)]">
                      <span className="flex items-center gap-1.5 text-sm font-medium"><span className="truncate">{r.title}</span>{r.shared && <Badge>Team</Badge>}</span>
                      <span className="block truncate text-xs text-muted">{r.body}</span>
                    </button>
                    {r.canEdit && <div className="flex shrink-0 py-1.5">
                      <IconButton size="sm" label={`Edit ${r.title}`} onClick={() => { setEditing(r); setOpen(false); }}><Pencil className="size-3.5" /></IconButton>
                      <IconButton size="sm" label={`Delete ${r.title}`} onClick={() => { setDeleting(r); setOpen(false); }}><Trash2 className="size-3.5" /></IconButton>
                    </div>}
                  </li>
                ))}
              </ul>
            )}
        </div>
        <div className="border-t border-base p-2"><Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => { setEditing('new'); setOpen(false); }}>New saved reply</Button></div>
      </Popover>
      <SavedReplyDialog value={editing} onClose={() => setEditing(null)} canShare={!!me?.role.isAdmin} onSaved={() => qc.invalidateQueries({ queryKey: ['saved-replies'] })} />
      <ConfirmDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} danger confirmLabel="Delete" title={`Delete “${deleting?.title ?? ''}”?`}
        description={deleting?.shared ? 'It is removed for the whole team.' : undefined}
        onConfirm={async () => {
          try { await api.del(`/inbox/saved-replies/${deleting!.id}`); qc.invalidateQueries({ queryKey: ['saved-replies'] }); toast.success('Saved reply deleted'); setDeleting(null); }
          catch (e) { toast.error(errorMessage(e)); }
        }} />
    </>
  );
}

function SavedReplyDialog({ value, onClose, canShare, onSaved }: { value: SavedReply | 'new' | null; onClose: () => void; canShare: boolean; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [shared, setShared] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (value === 'new') { setTitle(''); setBody(''); setShared(false); }
    else if (value) { setTitle(value.title); setBody(value.body); setShared(value.shared); }
  }, [value]);
  const save = async () => {
    setSaving(true);
    try {
      if (value === 'new') await api.post('/inbox/saved-replies', { title, body, shared });
      else if (value) await api.patch(`/inbox/saved-replies/${value.id}`, { title, body, ...(canShare ? { shared } : {}) });
      onSaved(); onClose(); toast.success('Saved reply saved');
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <Dialog open={!!value} onOpenChange={(v) => !v && onClose()} title={value === 'new' ? 'New saved reply' : 'Edit saved reply'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!title.trim() || !body.trim() || saving} onClick={save}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Title" htmlFor="sr-title" required><Input id="sr-title" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Opening hours" /></Field>
        <Field label="Text" htmlFor="sr-body" required hint="{{first_name}} and {{name}} become the customer’s name, {{agent}} your name.">
          <Textarea id="sr-body" rows={5} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        {canShare && <Checkbox checked={shared} onChange={setShared} label="Share with the whole team" />}
      </div>
    </Dialog>
  );
}
