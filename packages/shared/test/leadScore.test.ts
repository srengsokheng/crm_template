import { describe, expect, it } from 'vitest';
import { LEAD_SCORE_PARTS, leadTier } from '../src/leadScore.ts';

describe('lead score', () => {
  it('parts add up to 100, half fit and half engagement', () => {
    const sum = (g?: string) => LEAD_SCORE_PARTS.filter((p) => !g || p.group === g).reduce((n, p) => n + p.max, 0);
    expect([sum(), sum('fit'), sum('engagement')]).toEqual([100, 50, 50]);
  });
  it('tiers', () => {
    expect([leadTier(100), leadTier(70), leadTier(69), leadTier(40), leadTier(39), leadTier(0)]).toEqual(['hot', 'hot', 'warm', 'warm', 'cold', 'cold']);
  });
});
