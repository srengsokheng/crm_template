import { cn } from '../../lib/cn.ts';
import { STAGE_SOFT, STAGE_SOLID } from './stageColors.ts';

export function StageBadge({ name, color, className }: { name: string; color?: string | null; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', STAGE_SOFT[color ?? 'slate'] ?? STAGE_SOFT.slate, className)}>
      <span className={cn('size-1.5 rounded-full', STAGE_SOLID[color ?? 'slate'])} />{name}
    </span>
  );
}
