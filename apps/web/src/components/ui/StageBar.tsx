import { Check, X } from 'lucide-react';
import { cn } from '../../lib/cn.ts';
import type { Stage } from '../../lib/types.ts';

/** Clickable pipeline progress bar. Closed stages are handled by the Won/Lost buttons, not here. */
export function StageBar({ stages, currentId, status, onSelect, disabled }: {
  stages: Stage[]; currentId: number; status: 'open' | 'won' | 'lost'; onSelect?: (s: Stage) => void; disabled?: boolean;
}) {
  const open = stages.filter((s) => s.kind === 'open');
  const currentIdx = open.findIndex((s) => s.id === currentId);
  const current = stages.find((s) => s.id === currentId);
  return (
    <div className="flex w-full items-stretch gap-1 overflow-x-auto pb-1" role="list" aria-label="Pipeline stages">
      {open.map((s, i) => {
        const reached = status === 'won' || (status === 'open' && i <= currentIdx);
        const isCurrent = status === 'open' && s.id === currentId;
        return (
          <button key={s.id} type="button" role="listitem" disabled={disabled || !onSelect || isCurrent}
            onClick={() => onSelect?.(s)} aria-current={isCurrent ? 'step' : undefined}
            title={isCurrent ? `Current stage: ${s.name}` : `Move to ${s.name}`}
            className={cn('group relative flex h-8 min-w-24 flex-1 items-center justify-center rounded-md px-3 text-xs font-medium transition-colors',
              status === 'lost' ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-200'
                : reached ? 'bg-brand-600 text-white' : 'bg-[var(--surface-2)] text-muted hover:bg-brand-100 hover:text-brand-700 dark:hover:bg-brand-600/30',
              isCurrent && 'ring-2 ring-brand-300 ring-offset-1 ring-offset-[var(--surface)]', 'disabled:cursor-default')}>
            <span className="truncate">{s.name}</span>
          </button>
        );
      })}
      {status !== 'open' && current && (
        <div className={cn('flex h-8 min-w-24 items-center justify-center gap-1 rounded-md px-3 text-xs font-semibold',
          status === 'won' ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white')}>
          {status === 'won' ? <Check className="size-3.5" /> : <X className="size-3.5" />}{current.name}
        </div>
      )}
    </div>
  );
}
