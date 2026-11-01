import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3, Bell, Building2, CheckSquare, Handshake, Home, LogOut, Menu as MenuIcon, Moon, Package, Plus, Search, Settings, Sun, Users, Zap, Monitor, X,
} from 'lucide-react';
import { api, ApiError } from '../lib/api.ts';
import { cn } from '../lib/cn.ts';
import { relative } from '../lib/format.ts';
import { useCan, useMe } from '../lib/hooks.ts';
import { Avatar, Button, IconButton, Spinner } from '../components/ui/primitives.tsx';
import { Menu, Popover } from '../components/ui/overlays.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { CreateProvider, useCreate } from './create.tsx';
import { applyTheme, getTheme, type Theme } from './theme.ts';

interface NavItem { to: string; label: string; icon: ReactNode; badge?: number; show?: boolean }

function useNav(): NavItem[] {
  const { data: me } = useMe();
  const can = useCan();
  const counts = useQuery({ queryKey: ['activity-counts'], queryFn: () => api.get<{ overdue: number; today: number }>('/activities/counts'), refetchInterval: 60_000 });
  return [
    { to: '/', label: 'Home', icon: <Home className="size-[18px]" /> },
    { to: '/activities', label: 'Activities', icon: <CheckSquare className="size-[18px]" />, badge: counts.data?.overdue },
    { to: '/leads', label: 'Leads', icon: <Zap className="size-[18px]" />, show: !!me?.workspace.useLeads && can('lead', 'view') },
    { to: '/deals', label: 'Deals', icon: <Handshake className="size-[18px]" />, show: can('deal', 'view') },
    { to: '/contacts', label: 'Contacts', icon: <Users className="size-[18px]" />, show: can('contact', 'view') },
    { to: '/companies', label: 'Companies', icon: <Building2 className="size-[18px]" />, show: can('company', 'view') },
    { to: '/products', label: 'Products', icon: <Package className="size-[18px]" />, show: can('product', 'view') },
    { to: '/reports', label: 'Reports', icon: <BarChart3 className="size-[18px]" /> },
  ].filter((i) => i.show !== false);
}

function SideLink({ item, compact }: { item: NavItem; compact?: boolean }) {
  return (
    <NavLink to={item.to} end={item.to === '/'} title={compact ? item.label : undefined}
      className={({ isActive }) => cn('group flex items-center gap-3 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors',
        compact && 'justify-center px-0',
        isActive ? 'bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-100' : 'text-muted hover:bg-[var(--surface-2)] hover:text-[var(--text)]')}>
      <span className="relative">
        {item.icon}
        {compact && !!item.badge && <span className="absolute -right-1.5 -top-1.5 size-2 rounded-full bg-rose-500" />}
      </span>
      {!compact && <span className="flex-1">{item.label}</span>}
      {!compact && !!item.badge && <span className="rounded-full bg-rose-500 px-1.5 text-[11px] font-semibold text-white">{item.badge}</span>}
    </NavLink>
  );
}

function Sidebar({ items, onSearch }: { items: NavItem[]; onSearch: () => void }) {
  const { data: me } = useMe();
  return (
    <aside className="sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-base surface md:flex md:w-16 lg:w-60" aria-label="Main navigation">
      <div className="flex h-14 items-center gap-2 px-4 max-lg:justify-center max-lg:px-0">
        <img src="/favicon.svg" alt="" className="size-7" />
        <span className="truncate text-[15px] font-semibold max-lg:hidden">{me?.workspace.name ?? 'Acme CRM'}</span>
      </div>
      <div className="px-3 pb-2 max-lg:px-2">
        <button type="button" onClick={onSearch} className="flex h-9 w-full items-center gap-2 rounded-md border border-base px-2.5 text-[13px] text-muted hover:bg-[var(--surface-2)] max-lg:justify-center max-lg:px-0" aria-label="Open search">
          <Search className="size-4" /><span className="flex-1 text-left max-lg:hidden">Search…</span>
          <kbd className="rounded border border-base px-1 text-[10px] max-lg:hidden">⌘K</kbd>
        </button>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 max-lg:px-2">
        <div className="hidden lg:block">{items.map((i) => <SideLink key={i.to} item={i} />)}</div>
        <div className="lg:hidden">{items.map((i) => <SideLink key={i.to} item={i} compact />)}</div>
      </nav>
      <div className="border-t border-base p-3 max-lg:px-2">
        <div className="hidden lg:block"><SideLink item={{ to: '/settings', label: 'Settings', icon: <Settings className="size-[18px]" /> }} /></div>
        <div className="lg:hidden"><SideLink compact item={{ to: '/settings', label: 'Settings', icon: <Settings className="size-[18px]" /> }} /></div>
      </div>
    </aside>
  );
}

function MobileNav({ items }: { items: NavItem[] }) {
  const [more, setMore] = useState(false);
  const loc = useLocation();
  useEffect(() => setMore(false), [loc.pathname]);
  const primary = items.filter((i) => ['/', '/deals', '/contacts', '/activities'].includes(i.to));
  const rest = [...items.filter((i) => !primary.includes(i)), { to: '/settings', label: 'Settings', icon: <Settings className="size-[18px]" /> }];
  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-base surface pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Main navigation">
        {primary.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => cn('relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium', isActive ? 'text-brand-600' : 'text-muted')}>
            {i.icon}{i.label}
            {!!i.badge && <span className="absolute right-[30%] top-1.5 size-2 rounded-full bg-rose-500" />}
          </NavLink>
        ))}
        <button type="button" onClick={() => setMore(true)} className="flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-muted"><MenuIcon className="size-[18px]" />More</button>
      </nav>
      {more && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-label="More navigation">
          <div className="absolute inset-0 bg-slate-950/40" onClick={() => setMore(false)} />
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl surface p-4 pb-8 shadow-2xl">
            <div className="mb-2 flex items-center justify-between"><span className="text-sm font-semibold">More</span><IconButton label="Close" onClick={() => setMore(false)}><X className="size-4" /></IconButton></div>
            <div className="grid grid-cols-3 gap-2">
              {rest.map((i) => (
                <Link key={i.to} to={i.to} className="flex flex-col items-center gap-1 rounded-lg border border-base p-3 text-xs font-medium">{i.icon}{i.label}</Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Notifications() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data } = useQuery({
    queryKey: ['notifications'], refetchInterval: 30_000,
    queryFn: () => api.get<{ unread: number; data: { id: number; title: string; body: string | null; entityType: string | null; entityId: number | null; readAt: string | null; createdAt: string }[] }>('/notifications'),
  });
  const markRead = async () => { await api.post('/notifications/read', {}); qc.invalidateQueries({ queryKey: ['notifications'] }); };
  const go = (n: { entityType: string | null; entityId: number | null }) => {
    if (n.entityType === 'activity') nav('/activities');
    else if (n.entityType && n.entityId) nav(`/${n.entityType === 'company' ? 'companies' : n.entityType + 's'}/${n.entityId}`);
  };
  return (
    <Popover align="end" className="w-[min(22rem,calc(100vw-1rem))] p-0" trigger={
      <IconButton label={`Notifications${data?.unread ? ` (${data.unread} unread)` : ''}`} className="relative">
        <Bell className="size-[18px]" />
        {!!data?.unread && <span className="absolute right-1.5 top-1.5 flex min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white">{data.unread}</span>}
      </IconButton>
    }>
      <div className="flex items-center justify-between border-b border-base px-3 py-2.5">
        <span className="text-sm font-semibold">Notifications</span>
        {!!data?.unread && <button type="button" className="text-xs font-medium text-brand-600" onClick={markRead}>Mark all read</button>}
      </div>
      <ul className="max-h-96 overflow-y-auto">
        {(data?.data ?? []).map((n) => (
          <li key={n.id}>
            <button type="button" onClick={() => go(n)} className={cn('w-full border-b border-base px-3 py-2.5 text-left hover:bg-[var(--surface-2)]', !n.readAt && 'bg-brand-50/50 dark:bg-brand-600/10')}>
              <div className="text-sm font-medium">{n.title}</div>
              {n.body && <div className="truncate text-xs text-muted">{n.body}</div>}
              <div className="mt-0.5 text-[11px] text-muted">{relative(n.createdAt)}</div>
            </button>
          </li>
        ))}
        {!data?.data.length && <li className="px-3 py-8 text-center text-sm text-muted">You’re all caught up.</li>}
      </ul>
    </Popover>
  );
}

function TopBar({ onSearch }: { onSearch: () => void }) {
  const { data: me } = useMe();
  const can = useCan();
  const create = useCreate();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [theme, setTheme] = useState<Theme>(getTheme());
  const logout = async () => { await api.post('/auth/logout', {}); qc.clear(); nav('/login', { replace: true }); };
  const cycleTheme = (t: Theme) => { setTheme(t); applyTheme(t); };
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-base bg-[var(--bg)]/85 px-4 backdrop-blur md:px-6">
      <div className="flex items-center gap-2 md:hidden">
        <img src="/favicon.svg" alt="" className="size-7" />
      </div>
      <button type="button" onClick={onSearch} className="flex h-9 flex-1 items-center gap-2 rounded-md border border-base surface px-3 text-[13px] text-muted md:hidden" aria-label="Open search">
        <Search className="size-4" />Search
      </button>
      <div className="flex-1 max-md:hidden" />
      <Menu trigger={<Button variant="primary" size="md" icon={<Plus className="size-4" />} aria-label="Create new"><span className="max-sm:hidden">New</span></Button>}
        items={[
          { label: 'Lead', icon: <Zap className="size-4" />, onSelect: () => create.open('lead'), hidden: !me?.workspace.useLeads || !can('lead', 'create') },
          { label: 'Deal', icon: <Handshake className="size-4" />, onSelect: () => create.open('deal'), hidden: !can('deal', 'create') },
          { label: 'Contact', icon: <Users className="size-4" />, onSelect: () => create.open('contact'), hidden: !can('contact', 'create') },
          { label: 'Company', icon: <Building2 className="size-4" />, onSelect: () => create.open('company'), hidden: !can('company', 'create') },
          { label: 'Activity', icon: <CheckSquare className="size-4" />, onSelect: () => create.open('activity'), hidden: !can('activity', 'create') },
        ]} />
      <Notifications />
      <Menu trigger={<button type="button" className="rounded-full" aria-label="Account menu"><Avatar name={me?.user.name} /></button>}
        items={[
          { label: <div><div className="font-medium">{me?.user.name}</div><div className="text-xs text-muted">{me?.role.name}</div></div>, onSelect: () => {}, disabled: true },
          'separator',
          { label: 'Light theme', icon: <Sun className="size-4" />, onSelect: () => cycleTheme('light'), hidden: theme === 'light' },
          { label: 'Dark theme', icon: <Moon className="size-4" />, onSelect: () => cycleTheme('dark'), hidden: theme === 'dark' },
          { label: 'System theme', icon: <Monitor className="size-4" />, onSelect: () => cycleTheme('system'), hidden: theme === 'system' },
          'separator',
          { label: 'Sign out', icon: <LogOut className="size-4" />, onSelect: logout },
        ]} />
    </header>
  );
}

export function AppLayout() {
  const me = useMe();
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (me.isLoading) return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>;
  if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" replace />;
  if (me.error) return <div className="p-8 text-center text-sm text-rose-600">Could not load your account: {(me.error as Error).message}</div>;
  return (
    <CreateProvider>
      <Shell onSearch={() => setSearchOpen(true)} />
      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
    </CreateProvider>
  );
}

function Shell({ onSearch }: { onSearch: () => void }) {
  const items = useNav();
  return (
    <div className="flex min-h-dvh">
      <Sidebar items={items} onSearch={onSearch} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onSearch={onSearch} />
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 pb-24 pt-5 md:px-6 md:pb-10">
          <Suspense fallback={<div className="flex justify-center py-20"><Spinner /></div>}><Outlet /></Suspense>
        </main>
      </div>
      <MobileNav items={items} />
    </div>
  );
}
