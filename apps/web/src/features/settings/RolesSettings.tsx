import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { api, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import type { Scope } from '../../lib/types.ts';
import { Badge, Button, Card, Input, Select } from '../../components/ui/primitives.tsx';
import { AdminOnly } from './SettingsLayout.tsx';

interface Role { id: number; name: string; isAdmin: boolean; isSystem: boolean; memberCount: number; grants: Record<string, Record<string, Scope>> }
const ENTITIES = [['lead', 'Leads'], ['deal', 'Deals'], ['contact', 'Contacts'], ['company', 'Companies'], ['product', 'Products'], ['activity', 'Activities']] as const;
const ACTIONS = [['view', 'View'], ['create', 'Create'], ['edit', 'Edit'], ['delete', 'Delete'], ['export', 'Export'], ['import', 'Import']] as const;
/** Actions that are a yes/no switch rather than a record scope. */
const SWITCH_ACTIONS = new Set(['create', 'import']);
const IMPORTABLE = new Set(['lead', 'contact', 'company']);
const SCOPE_LABEL: Record<Scope, string> = { none: 'None', own: 'Own', team: 'Team', all: 'All' };

export function RolesSettings() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ data: Role[] }>('/roles') });
  const [activeId, setActiveId] = useState<number | null>(null);
  const list = roles.data?.data ?? [];
  const active = list.find((r) => r.id === activeId) ?? list[0];
  const [grants, setGrants] = useState<Role['grants']>({});
  const [name, setName] = useState('');
  useEffect(() => { if (active) { setGrants(active.grants); setName(active.name); } }, [active?.id, roles.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const call = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); qc.invalidateQueries({ queryKey: ['roles'] }); qc.invalidateQueries({ queryKey: ['meta'] }); toast.success(ok); } catch (e) { toast.error(errorMessage(e)); } };
  const createRole = async () => {
    try { const r = await api.post<{ id: number }>('/roles', { name: 'New role', grants: {} }); await qc.invalidateQueries({ queryKey: ['roles'] }); setActiveId(r.id); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <AdminOnly>
      <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-1">
          {list.map((r) => (
            <button key={r.id} type="button" onClick={() => setActiveId(r.id)} className={cn('flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-[13px] font-medium', r.id === active?.id ? 'bg-[var(--surface-2)]' : 'text-muted hover:text-[var(--text)]')}>
              {r.name}<span className="text-xs text-muted">{r.memberCount}</span>
            </button>
          ))}
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={createRole}>New role</Button>
        </div>
        {active && (
          <Card className="min-w-0" title={<div className="flex items-center gap-2"><Input aria-label="Role name" value={name} disabled={active.isSystem} onChange={(e) => setName(e.target.value)} className="h-8 w-48 font-semibold" />{active.isSystem && <Badge>Built-in</Badge>}</div>}
            actions={!active.isSystem && <Button size="sm" variant="ghost" onClick={() => call(() => api.del(`/roles/${active.id}`), 'Role deleted').then(() => setActiveId(null))}>Delete</Button>}>
            {active.isAdmin ? <p className="text-sm text-muted">Admins can see and change everything, including settings.</p> : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[600px] text-sm">
                    <thead className="text-left text-xs text-muted"><tr><th className="py-2 pr-3 font-medium" />{ACTIONS.map(([a, l]) => <th key={a} className="px-1 py-2 font-medium">{l}</th>)}</tr></thead>
                    <tbody className="divide-y divide-[var(--border)]">
                      {ENTITIES.map(([e, l]) => (
                        <tr key={e}>
                          <td className="py-2 pr-3 font-medium">{l}</td>
                          {ACTIONS.map(([a]) => (
                            <td key={a} className="px-1 py-1.5">
                              {a === 'import' && !IMPORTABLE.has(e) ? <span className="block px-2 text-xs text-muted" title="Not available for this record type">—</span> : (
                                <Select aria-label={`${l} ${a}`} className="h-8 min-w-[4.75rem] pl-2 text-xs" value={grants[e]?.[a] ?? 'none'}
                                  onChange={(ev) => setGrants({ ...grants, [e]: { ...(grants[e] ?? {}), [a]: ev.target.value as Scope } })}>
                                  {(SWITCH_ACTIONS.has(a) ? (['none', 'all'] as Scope[]) : (['none', 'own', 'team', 'all'] as Scope[])).map((s) => <option key={s} value={s}>{SWITCH_ACTIONS.has(a) ? (s === 'all' ? 'Yes' : 'No') : SCOPE_LABEL[s]}</option>)}
                                </Select>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-xs text-muted">“Own” means records the user owns, “Team” records owned by anyone who shares a team with them, and “All” every record except other people’s private ones. “Import” lets the user upload CSV files; imported rows still need Create, and updating existing records needs Edit on them.</p>
                <div className="mt-3 flex justify-end"><Button variant="primary" onClick={() => call(() => api.patch(`/roles/${active.id}`, { ...(active.isSystem ? {} : { name }), grants }), 'Role saved')}>Save role</Button></div>
              </>
            )}
          </Card>
        )}
      </div>
    </AdminOnly>
  );
}
