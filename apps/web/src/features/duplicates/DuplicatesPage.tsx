import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Combine, CopyCheck, EyeOff } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { relative } from '../../lib/format.ts';
import { useCan } from '../../lib/hooks.ts';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Segmented, Skeleton } from '../../components/ui/primitives.tsx';
import { MergeDialog } from '../records/MergeDialog.tsx';

type Entity = 'contact' | 'company' | 'lead';
interface Side { id: number; title: string; createdAt: string; ownerName: string | null }
interface Pair { a: number; b: number; reasons: { kind: string; value: string }[]; left: Side; right: Side }

const NOUN = { contact: { many: 'contacts', path: '/contacts' }, company: { many: 'companies', path: '/companies' }, lead: { many: 'leads', path: '/leads' } };
const REASON: Record<string, string> = { email: 'Same email', phone: 'Same phone', website: 'Same website', name: 'Same name', similar_name: 'Similar name' };
/** Reasons whose value is worth showing next to the label. */
const SHOW_VALUE = new Set(['email', 'phone', 'website']);

export function DuplicatesPage() {
  const { entity } = useParams();
  if (entity !== 'contact' && entity !== 'company' && entity !== 'lead') return <Navigate to="/duplicates/contact" replace />;
  return <Duplicates entity={entity} />;
}

function Duplicates({ entity }: { entity: Entity }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const can = useCan();
  const n = NOUN[entity];
  const q = useQuery({ queryKey: ['duplicate-pairs', entity], queryFn: () => api.get<{ data: Pair[]; more: boolean }>(`/duplicates/pairs?entityType=${entity}`) });
  const [merging, setMerging] = useState<Pair | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['duplicate-pairs', entity] });
  const dismiss = async (p: Pair) => {
    setBusy(`${p.a}-${p.b}`);
    try { await api.post('/duplicates/dismiss', { entityType: entity, ids: [p.a, p.b] }); toast.success('Marked as not a duplicate'); refresh(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const canAct = can(entity, 'edit');
  return (
    <div className="mx-auto max-w-5xl">
      <Link to={n.path} className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted hover:text-[var(--text)]"><ArrowLeft className="size-3.5" />{n.many[0].toUpperCase() + n.many.slice(1)}</Link>
      <PageHeader title="Find duplicates" subtitle="Records that share an email, phone or website, or have the same or a very similar name. Merge two — or add more in the merge window."
        actions={<Segmented value={entity} onChange={(v) => nav(`/duplicates/${v}`)} options={[{ value: 'contact', label: 'Contacts' }, { value: 'company', label: 'Companies' }, { value: 'lead', label: 'Leads' }]} />} />
      {q.isLoading ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>
        : q.error ? <Card><ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} /></Card>
        : !q.data?.data.length ? <Card><EmptyState icon={<CopyCheck className="size-5" />} title={`No duplicate ${n.many} found`} description={`Nothing shares an email, phone, website or a similar name${entity === 'lead' ? ' (converted leads are not checked)' : ''}. Pairs you marked as not duplicates stay hidden.`} /></Card>
        : (
          <div className="space-y-2">
            <p className="text-sm text-muted">{q.data.data.length}{q.data.more ? '+' : ''} possible {q.data.data.length === 1 ? 'pair' : 'pairs'}, strongest matches first.</p>
            <ul className="space-y-2">
              {q.data.data.map((p) => (
                <li key={`${p.a}-${p.b}`} className="surface rounded-[var(--radius-card)] border border-base p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {p.reasons.map((r) => <Badge key={r.kind} tone={r.kind === 'similar_name' ? 'slate' : 'amber'}>{REASON[r.kind] ?? r.kind}{SHOW_VALUE.has(r.kind) ? `: ${r.value}` : ''}</Badge>)}
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {[p.left, p.right].map((s) => (
                      <Link key={s.id} to={`${n.path}/${s.id}`} className="min-w-0 rounded-md border border-base px-3 py-2 hover:bg-[var(--surface-2)]/60">
                        <div className="truncate font-medium">{s.title || '—'}</div>
                        <div className="truncate text-xs text-muted">#{s.id} · added {relative(s.createdAt)}{s.ownerName ? ` · ${s.ownerName}` : ''}</div>
                      </Link>
                    ))}
                  </div>
                  {canAct && (
                    <div className="mt-2 flex flex-wrap justify-end gap-2">
                      <Button size="sm" variant="ghost" icon={<EyeOff className="size-3.5" />} loading={busy === `${p.a}-${p.b}`} onClick={() => dismiss(p)}>Not a duplicate</Button>
                      <Button size="sm" variant="primary" icon={<Combine className="size-3.5" />} onClick={() => setMerging(p)}>Merge…</Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      {merging && (
        <MergeDialog entity={entity} open onOpenChange={(o) => !o && setMerging(null)}
          current={{ id: merging.left.id, name: merging.left.title, emails: [], phones: [] }}
          initialOther={{ id: merging.right.id, label: merging.right.title }}
          onMerged={() => { setMerging(null); refresh(); }} />
      )}
    </div>
  );
}
