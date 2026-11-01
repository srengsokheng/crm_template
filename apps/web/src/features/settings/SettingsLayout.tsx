import { NavLink, Outlet } from 'react-router';
import { Lock } from 'lucide-react';
import { cn } from '../../lib/cn.ts';
import { useMe } from '../../lib/hooks.ts';
import { EmptyState, PageHeader } from '../../components/ui/primitives.tsx';

const LINKS = [
  { to: 'workspace', label: 'Workspace' }, { to: 'pipelines', label: 'Pipelines & stages' }, { to: 'fields', label: 'Custom fields' },
  { to: 'lists', label: 'Lists & options' }, { to: 'users', label: 'Users & teams' }, { to: 'roles', label: 'Roles & permissions' },
  { to: 'automation', label: 'Automation' }, { to: 'recycle-bin', label: 'Recycle bin', everyone: true },
];

export function SettingsLayout() {
  const { data: me } = useMe();
  const admin = !!me?.role.isAdmin;
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Settings" className="flex gap-1 overflow-x-auto lg:flex-col">
          {LINKS.filter((l) => admin || l.everyone).map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => cn('whitespace-nowrap rounded-md px-3 py-2 text-[13px] font-medium', isActive ? 'bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-100' : 'text-muted hover:bg-[var(--surface-2)] hover:text-[var(--text)]')}>{l.label}</NavLink>
          ))}
        </nav>
        <div className="min-w-0"><Outlet /></div>
      </div>
    </div>
  );
}

export function AdminOnly({ children }: { children: React.ReactNode }) {
  const { data: me } = useMe();
  if (!me?.role.isAdmin) return <EmptyState icon={<Lock className="size-5" />} title="Admins only" description="Ask a workspace admin to change these settings." />;
  return <>{children}</>;
}
