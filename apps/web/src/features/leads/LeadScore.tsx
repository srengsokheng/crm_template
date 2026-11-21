import { Flame } from 'lucide-react';
import { LEAD_SCORE_PARTS, LEAD_TIER_LABEL, leadTier, type LeadTier } from '@crm/shared';
import { cn } from '../../lib/cn.ts';
import { Card } from '../../components/ui/primitives.tsx';

const TONE: Record<LeadTier, string> = {
  hot: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-200',
  warm: 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200',
  cold: 'bg-sky-50 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200',
};

/** "Hot 85" — the lead's tier and score. */
export function ScoreBadge({ score, className }: { score: number; className?: string }) {
  const tier = leadTier(score);
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular whitespace-nowrap', TONE[tier], className)}
      title={`Lead score ${score} of 100`}>
      {tier === 'hot' && <Flame className="size-3" aria-hidden />}{LEAD_TIER_LABEL[tier]} {score}
    </span>
  );
}

/** The score on the lead page, with what makes it up (so people know how to raise it). */
export function LeadScoreCard({ score, parts }: { score: number; parts: Record<string, number> }) {
  return (
    <Card title={<span className="flex items-center gap-2">Lead score <ScoreBadge score={score} /></span>}>
      {(['fit', 'engagement'] as const).map((g) => (
        <div key={g} className="mb-3 last:mb-0">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{g === 'fit' ? 'Fit' : 'Engagement (last 30 days)'}</div>
          <ul className="space-y-1 text-[13px]">
            {LEAD_SCORE_PARTS.filter((p) => p.group === g).map((p) => {
              const got = parts[p.key] ?? 0;
              return (
                <li key={p.key} className="flex items-center justify-between gap-3">
                  <span className={cn(got === 0 && 'text-muted')}>{p.label}</span>
                  <span className={cn('shrink-0 tabular', got === 0 ? 'text-muted' : 'font-medium')}>{got}/{p.max}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </Card>
  );
}
