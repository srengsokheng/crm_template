import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn.ts';
import { initials } from '../../lib/format.ts';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm disabled:bg-brand-600/60',
  secondary: 'surface border border-base hover:bg-[var(--surface-2)] shadow-sm',
  ghost: 'hover:bg-[var(--surface-2)] text-[var(--text)]',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 shadow-sm',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm',
};
const sizes = { sm: 'h-8 px-2.5 text-[13px] gap-1.5', md: 'h-9 px-3.5 gap-2', lg: 'h-10 px-4 gap-2' };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant; size?: keyof typeof sizes; loading?: boolean; icon?: ReactNode;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }, ref) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading}
      className={cn('inline-flex items-center justify-center rounded-[var(--radius-control)] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-60', variants[variant], sizes[size], className)}
      {...rest}>
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md' }>(
  function IconButton({ label, className, children, size = 'md', type = 'button', ...rest }, ref) {
    return (
      <button ref={ref} type={type} aria-label={label} title={label}
        className={cn('inline-flex items-center justify-center rounded-[var(--radius-control)] text-muted hover:bg-[var(--surface-2)] hover:text-[var(--text)] transition-colors disabled:opacity-50', size === 'sm' ? 'size-7' : 'size-9', className)}
        {...rest}>{children}</button>
    );
  });

const hasWidth = (c?: string) => !!c && /(^|\s)(max-|min-)?w-/.test(c.replace(/(max|min)-w-\S+/g, ''));
const control = 'rounded-[var(--radius-control)] border border-base surface px-3 text-sm placeholder:text-[var(--muted)]/70 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ className, invalid, ...rest }, ref) {
  return <input ref={ref} className={cn(control, !hasWidth(className) && 'w-full', 'h-9', invalid && 'border-rose-500 focus:border-rose-500 focus:ring-rose-500/20', className)} aria-invalid={invalid || undefined} {...rest} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea({ className, invalid, rows = 3, ...rest }, ref) {
  return <textarea ref={ref} rows={rows} className={cn(control, !hasWidth(className) && 'w-full', 'py-2 resize-y', invalid && 'border-rose-500', className)} aria-invalid={invalid || undefined} {...rest} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(function Select({ className, invalid, children, ...rest }, ref) {
  return <select ref={ref} className={cn(control, !hasWidth(className) && 'w-full', 'h-9 pr-8', invalid && 'border-rose-500', className)} aria-invalid={invalid || undefined} {...rest}>{children}</select>;
});

export function Field({ label, error, hint, required, children, className, htmlFor }: {
  label: ReactNode; error?: string; hint?: ReactNode; required?: boolean; children: ReactNode; className?: string; htmlFor?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-[13px] font-medium">
        {label}{required && <span className="text-rose-600"> *</span>}
      </label>
      {children}
      {error ? <p className="text-xs text-rose-600" role="alert">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

const tones = {
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  brand: 'bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-200',
  green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  red: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  amber: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  blue: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
};
export function Badge({ tone = 'slate', children, className }: { tone?: keyof typeof tones; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', tones[tone], className)}>{children}</span>;
}

const avatarColors = ['bg-indigo-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-sky-500', 'bg-violet-500', 'bg-teal-500'];
export function Avatar({ name, size = 'md', className }: { name?: string | null; size?: 'xs' | 'sm' | 'md'; className?: string }) {
  const color = avatarColors[(name ?? '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % avatarColors.length];
  const s = size === 'xs' ? 'size-5 text-[9px]' : size === 'sm' ? 'size-6 text-[10px]' : 'size-8 text-xs';
  return <span title={name ?? undefined} className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', color, s, className)}>{initials(name)}</span>;
}

export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn('size-5 animate-spin text-muted', className)} />;
export const Skeleton = ({ className }: { className?: string }) => <div className={cn('animate-pulse rounded-md bg-[var(--surface-2)]', className)} />;

export function Card({ children, className, title, actions, padded = true }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <section className={cn('surface rounded-[var(--radius-card)] border border-base shadow-xs', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-base px-4 py-3">
          <h2 className="text-[13px] font-semibold">{title}</h2>
          <div className="flex items-center gap-1">{actions}</div>
        </header>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 rounded-full bg-[var(--surface-2)] p-3 text-muted">{icon}</div>}
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center" role="alert">
      <p className="text-sm text-rose-600">{message}</p>
      {onRetry && <Button size="sm" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cn('inline-flex cursor-pointer items-center gap-2 text-sm', disabled && 'cursor-not-allowed opacity-60')}>
      <input type="checkbox" className="size-4 rounded border-base accent-[var(--color-brand-600)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = 'md' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; icon?: ReactNode }[]; size?: 'sm' | 'md' }) {
  return (
    <div className="inline-flex rounded-[var(--radius-control)] border border-base surface p-0.5" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cn('inline-flex items-center gap-1.5 rounded-[calc(var(--radius-control)-2px)] font-medium transition-colors',
            size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-3 text-[13px]',
            value === o.value ? 'bg-[var(--surface-2)] text-[var(--text)] shadow-xs' : 'text-muted hover:text-[var(--text)]')}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}
