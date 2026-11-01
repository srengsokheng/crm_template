/** Normalise contact methods for duplicate detection. */
export function normalizeContactValue(kind: string, value: string): string {
  const v = value.trim();
  if (kind === 'email') return v.toLowerCase();
  if (kind === 'phone') {
    const digits = v.replace(/[^\d+]/g, '');
    return digits.startsWith('+') ? '+' + digits.slice(1).replace(/\+/g, '') : digits.replace(/\+/g, '');
  }
  if (kind === 'website') return v.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  return v.toLowerCase();
}

export function personName(first?: string | null, last?: string | null): string {
  return [first, last].filter((x) => x && x.trim()).join(' ').trim();
}
