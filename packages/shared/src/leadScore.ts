/**
 * Lead score (0–100): how well a lead fits (what we know about them) plus how engaged it is (recent work on it).
 * The API computes it in SQL from these weights (`routes/leads.ts`, LEAD_SCORE); the UI explains it with the labels.
 */
export const LEAD_SCORE_PARTS = [
  { key: 'email', label: 'Has an email address', max: 10, group: 'fit' },
  { key: 'phone', label: 'Has a phone number', max: 10, group: 'fit' },
  { key: 'company', label: 'Company name known', max: 10, group: 'fit' },
  { key: 'title', label: 'Job title known', max: 5, group: 'fit' },
  { key: 'value', label: 'Estimated value (15 from 1,000, 5 above 0)', max: 15, group: 'fit' },
  { key: 'done', label: 'Activities done in the last 30 days (5 each)', max: 20, group: 'engagement' },
  { key: 'next', label: 'A next step is scheduled', max: 10, group: 'engagement' },
  { key: 'notes', label: 'Notes in the last 30 days (5 each)', max: 10, group: 'engagement' },
  { key: 'stage', label: 'Moved past the first stage', max: 10, group: 'engagement' },
] as const;
export type LeadScorePart = (typeof LEAD_SCORE_PARTS)[number]['key'];

export const LEAD_TIERS = ['hot', 'warm', 'cold'] as const;
export type LeadTier = (typeof LEAD_TIERS)[number];
/** Lowest score of each tier. */
export const LEAD_TIER_MIN: Record<LeadTier, number> = { hot: 70, warm: 40, cold: 0 };
export const LEAD_TIER_LABEL: Record<LeadTier, string> = { hot: 'Hot', warm: 'Warm', cold: 'Cold' };

export const leadTier = (score: number): LeadTier => (score >= LEAD_TIER_MIN.hot ? 'hot' : score >= LEAD_TIER_MIN.warm ? 'warm' : 'cold');
