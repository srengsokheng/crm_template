import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Dialog as D } from 'radix-ui';
import { Building2, Handshake, Search, Users, Zap } from 'lucide-react';
import { api } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { useDebounced } from '../lib/hooks.ts';
import { Spinner } from '../components/ui/primitives.tsx';

const ICON: Record<string, typeof Users> = { deal: Handshake, lead: Zap, contact: Users, company: Building2 };
const PATH: Record<string, string> = { deal: 'deals', lead: 'leads', contact: 'contacts', company: 'companies' };
const PAGES = [
  { title: 'Home', to: '/' }, { title: 'Deals', to: '/deals' }, { title: 'Leads', to: '/leads' }, { title: 'Contacts', to: '/contacts' },
  { title: 'Companies', to: '/companies' }, { title: 'Activities', to: '/activities' }, { title: 'Products', to: '/products' },
  { title: 'Reports', to: '/reports' }, { title: 'Settings', to: '/settings' },
];

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const dq = useDebounced(q, 180);
  const nav = useNavigate();
  useEffect(() => { if (!open) { setQ(''); setActive(0); } }, [open]);
  const { data, isFetching } = useQuery({
    queryKey: ['search', dq], enabled: open && dq.trim().length >= 2,
    queryFn: () => api.get<{ data: { type: string; id: number; title: string; subtitle: string | null }[] }>(`/search?q=${encodeURIComponent(dq.trim())}`),
  });
  const records = dq.trim().length >= 2 ? data?.data ?? [] : [];
  const pages = PAGES.filter((p) => !q || p.title.toLowerCase().includes(q.toLowerCase()));
  const items = [
    ...records.map((r) => ({ key: `${r.type}-${r.id}`, title: r.title || 'Untitled', sub: `${r.type[0].toUpperCase()}${r.type.slice(1)}${r.subtitle ? ' · ' + r.subtitle : ''}`, icon: ICON[r.type], to: `/${PATH[r.type]}/${r.id}` })),
    ...pages.map((p) => ({ key: p.to, title: p.title, sub: 'Go to page', icon: Search, to: p.to })),
  ];
  const go = (to: string) => { onOpenChange(false); nav(to); };
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-slate-950/40" />
        <D.Content className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-base surface shadow-2xl focus:outline-none">
          <D.Title className="sr-only">Search</D.Title>
          <D.Description className="sr-only">Search records and pages</D.Description>
          <div className="flex items-center gap-2 border-b border-base px-4">
            <Search className="size-4 text-muted" />
            <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} placeholder="Search deals, leads, contacts, companies…"
              aria-label="Search" className="h-12 w-full bg-transparent text-[15px] outline-none"
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                if (e.key === 'Enter' && items[active]) go(items[active].to);
              }} />
            {isFetching && <Spinner className="size-4" />}
          </div>
          <ul className="max-h-[50vh] overflow-y-auto p-2" role="listbox">
            {items.map((it, i) => {
              const Icon = it.icon;
              return (
                <li key={it.key} role="option" aria-selected={i === active}>
                  <button type="button" onMouseEnter={() => setActive(i)} onClick={() => go(it.to)}
                    className={cn('flex w-full items-center gap-3 rounded-md px-3 py-2 text-left', i === active && 'bg-[var(--surface-2)]')}>
                    <Icon className="size-4 text-muted" />
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{it.title}</span><span className="block truncate text-xs text-muted">{it.sub}</span></span>
                  </button>
                </li>
              );
            })}
            {dq.trim().length >= 2 && !isFetching && records.length === 0 && <li className="px-3 py-2 text-sm text-muted">No records match “{dq}”.</li>}
          </ul>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
