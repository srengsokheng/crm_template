import type { ReactNode } from 'react';
import { Dialog as D, DropdownMenu as DM, Popover as P } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn.ts';
import { Button, IconButton } from './primitives.tsx';

export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'md' }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-[1px] data-[state=open]:animate-in" />
        <D.Content className={cn('fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[14px] border border-base surface shadow-xl focus:outline-none',
          size === 'sm' ? 'max-w-sm' : size === 'lg' ? 'max-w-2xl' : 'max-w-lg')}>
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div>
              <D.Title className="text-base font-semibold">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-sm text-muted">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
            </div>
            <D.Close asChild><IconButton label="Close" size="sm"><X className="size-4" /></IconButton></D.Close>
          </div>
          <div className="px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-base px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Right-side drawer used for create/edit forms. Full screen on phones. */
export function Drawer({ open, onOpenChange, title, children, footer, width = 'md' }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: 'md' | 'lg';
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-slate-950/40" />
        <D.Content className={cn('fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-base surface shadow-2xl focus:outline-none', width === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg')}>
          <div className="flex items-center justify-between border-b border-base px-5 py-3.5">
            <D.Title className="text-base font-semibold">{title}</D.Title>
            <D.Description className="sr-only">{title}</D.Description>
            <D.Close asChild><IconButton label="Close"><X className="size-4" /></IconButton></D.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-base px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = 'Confirm', danger, loading, onConfirm }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: string; description?: ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean; onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} size="sm"
      footer={<>
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
      </>} />
  );
}

export interface MenuItem { label: ReactNode; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; hidden?: boolean }
export function Menu({ trigger, items, align = 'end' }: { trigger: ReactNode; items: (MenuItem | 'separator')[]; align?: 'start' | 'end' }) {
  const visible = items.filter((i) => i === 'separator' || !i.hidden);
  return (
    <DM.Root>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content align={align} sideOffset={4} className="z-50 min-w-44 rounded-lg border border-base surface p-1 shadow-lg">
          {visible.map((it, i) => it === 'separator'
            ? <DM.Separator key={i} className="my-1 h-px bg-[var(--border)]" />
            : (
              <DM.Item key={i} disabled={it.disabled} onSelect={it.onSelect}
                className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--surface-2)] data-[disabled]:opacity-50',
                  it.danger && 'text-rose-600')}>
                {it.icon}{it.label}
              </DM.Item>
            ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export function Popover({ trigger, children, open, onOpenChange, align = 'start', className }: {
  trigger: ReactNode; children: ReactNode; open?: boolean; onOpenChange?: (v: boolean) => void; align?: 'start' | 'end' | 'center'; className?: string;
}) {
  return (
    <P.Root open={open} onOpenChange={onOpenChange}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content align={align} sideOffset={4} className={cn('z-50 w-72 rounded-lg border border-base surface p-3 shadow-lg focus:outline-none', className)}>
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
