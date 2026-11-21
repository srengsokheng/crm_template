import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';

/**
 * Arrow-key movement inside a group of tabs (WAI-ARIA tabs pattern): Left/Right (and Home/End) move to the
 * neighbouring tab and select it. Only the selected tab is in the Tab order (roving tabindex).
 */
export function useRovingKeys<T extends string>(values: T[], value: T, onChange: (v: T) => void) {
  const refs = useRef(new Map<T, HTMLButtonElement | null>());
  const onKeyDown = (e: KeyboardEvent) => {
    const i = values.indexOf(value);
    const next = e.key === 'ArrowRight' ? values[(i + 1) % values.length]
      : e.key === 'ArrowLeft' ? values[(i - 1 + values.length) % values.length]
      : e.key === 'Home' ? values[0] : e.key === 'End' ? values[values.length - 1] : undefined;
    if (next === undefined) return;
    e.preventDefault();
    onChange(next);
    refs.current.get(next)?.focus();
  };
  const ref = (v: T) => (el: HTMLButtonElement | null) => { refs.current.set(v, el); };
  return { onKeyDown, ref };
}

export interface TabItem<T extends string> { value: T; label: ReactNode; icon?: ReactNode; badge?: ReactNode }

/**
 * Underline tabs for switching what a page or card shows (Activities buckets, the record composer). For a compact
 * either/or switch in a toolbar, use `Segmented`.
 */
export function Tabs<T extends string>({ value, onChange, items, label, className }: {
  value: T; onChange: (v: T) => void; items: TabItem<T>[]; label: string; className?: string;
}) {
  const keys = useRovingKeys(items.map((i) => i.value), value, onChange);
  return (
    <div role="tablist" aria-label={label} onKeyDown={keys.onKeyDown} className={cn('flex gap-1 overflow-x-auto border-b border-base', className)}>
      {items.map((it) => (
        <button key={it.value} ref={keys.ref(it.value)} type="button" role="tab" aria-selected={value === it.value} tabIndex={value === it.value ? 0 : -1}
          onClick={() => onChange(it.value)}
          className={cn('-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
            value === it.value ? 'border-brand-600 text-brand-700 dark:text-brand-200' : 'border-transparent text-muted hover:text-[var(--text)]')}>
          {it.icon}{it.label}{it.badge}
        </button>
      ))}
    </div>
  );
}

export interface RadioOption<T extends string> { value: T; label: ReactNode; hint?: ReactNode; disabled?: boolean }

/** A vertical list of choices, one of which is picked; optional hint under each. Uses native radios (keyboard for free). */
export function RadioGroup<T extends string>({ value, onChange, options, legend, hideLegend, className }: {
  value: T | null; onChange: (v: T) => void; options: RadioOption<T>[]; legend: ReactNode; hideLegend?: boolean; className?: string;
}) {
  const name = useId();
  return (
    <fieldset className={cn('space-y-2', className)}>
      <legend className={hideLegend ? 'sr-only' : 'mb-1 text-[13px] font-medium'}>{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className={cn('flex items-start gap-2.5 text-sm', o.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')}>
          <input type="radio" name={name} value={o.value} className="mt-0.5 size-4 shrink-0 accent-[var(--color-brand-600)]" checked={value === o.value}
            disabled={o.disabled} onChange={() => onChange(o.value)} />
          <span>{o.label}{o.hint && <span className="block text-xs text-muted">{o.hint}</span>}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** An on/off setting that takes effect at once (for a choice inside a form that is saved later, use `Checkbox`). */
export function Switch({ checked, onChange, label, hint, disabled, hideLabel, className }: {
  checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean;
  /** Keep the label for screen readers only (e.g. a switch at the end of a list row that already names the item). */
  hideLabel?: boolean; className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex items-start gap-4', hideLabel ? 'shrink-0' : 'justify-between', disabled && 'opacity-60', className)}>
      <label htmlFor={id} className={cn(hideLabel ? 'sr-only' : 'text-sm', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
        {label}{hint && <span className="block text-xs text-muted">{hint}</span>}
      </label>
      <button id={id} type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={cn('relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed',
          checked ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-600')}>
        <span aria-hidden className={cn('inline-block size-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
    </div>
  );
}
