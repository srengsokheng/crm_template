/** CSV import: what a column can be mapped to, header auto-mapping, and tolerant cell parsers. Shared by API and web. */

export const IMPORT_ENTITIES = ['contact', 'company', 'lead', 'deal', 'product'] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

export const IMPORT_LIMITS = { maxBytes: 5 * 1024 * 1024, maxRows: 10_000, maxColumns: 100, chunkSize: 200 } as const;

export const DUPLICATE_MODES = ['skip', 'update', 'create'] as const;
export type DuplicateMode = (typeof DUPLICATE_MODES)[number];
export const MATCH_KEYS = ['email', 'phone', 'name', 'website', 'sku'] as const;
export type MatchKey = (typeof MATCH_KEYS)[number];
export const DATE_FORMATS = ['ymd', 'dmy', 'mdy'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

/** Which keys can identify an existing record, per entity (first = default). */
export const MATCH_KEYS_BY_ENTITY: Record<ImportEntity, MatchKey[]> = {
  contact: ['email', 'phone', 'name'],
  company: ['name', 'website', 'email', 'phone'],
  lead: ['email', 'phone'],
  /** Deals match by title (open, won and lost deals alike). */
  deal: ['name'],
  product: ['sku', 'name'],
};
export const MATCH_KEY_LABELS: Record<MatchKey, string> = { email: 'Email', phone: 'Phone', name: 'Name', website: 'Website', sku: 'SKU' };

export interface ImportTarget {
  key: string;
  label: string;
  group: 'Name' | 'Contact details' | 'Details' | 'Address' | 'Pricing';
  /** Several columns may map to it (e.g. "Work email" and "Home email"). */
  multiple?: boolean;
  aliases?: string[];
}

const NAME_PARTS: ImportTarget[] = [
  { key: 'fullName', label: 'Full name', group: 'Name', aliases: ['name', 'contact', 'contact name', 'person', 'full name'] },
  { key: 'firstName', label: 'First name', group: 'Name', aliases: ['given name', 'fname', 'forename'] },
  { key: 'lastName', label: 'Last name', group: 'Name', aliases: ['surname', 'family name', 'lname'] },
];
const METHODS: ImportTarget[] = [
  { key: 'email', label: 'Email', group: 'Contact details', multiple: true, aliases: ['e-mail', 'email address', 'work email', 'home email', 'mail', 'personal email'] },
  { key: 'phone', label: 'Phone', group: 'Contact details', multiple: true, aliases: ['telephone', 'tel', 'mobile', 'cell', 'phone number', 'work phone', 'mobile phone', 'home phone'] },
  { key: 'website', label: 'Website', group: 'Contact details', multiple: true, aliases: ['web', 'url', 'site', 'homepage', 'web site'] },
];
const ADDRESS: ImportTarget[] = [
  { key: 'street', label: 'Street', group: 'Address', aliases: ['address', 'street address', 'address line 1', 'address 1'] },
  { key: 'city', label: 'City', group: 'Address', aliases: ['town'] },
  { key: 'region', label: 'Region / state', group: 'Address', aliases: ['state', 'province', 'county', 'region'] },
  { key: 'postalCode', label: 'Postal code', group: 'Address', aliases: ['zip', 'zip code', 'postcode', 'post code', 'postal code'] },
  { key: 'country', label: 'Country', group: 'Address' },
];
const OWNER: ImportTarget = { key: 'owner', label: 'Owner (name or email)', group: 'Details', aliases: ['owner', 'assigned to', 'responsible', 'sales rep', 'account owner', 'lead owner', 'contact owner'] };
const DESCRIPTION: ImportTarget = { key: 'description', label: 'Description', group: 'Details', aliases: ['notes', 'note', 'comments', 'comment', 'about'] };
const SOURCE: ImportTarget = { key: 'source', label: 'Source', group: 'Details', aliases: ['lead source', 'channel'] };

export const IMPORT_TARGETS: Record<ImportEntity, ImportTarget[]> = {
  contact: [
    ...NAME_PARTS,
    { key: 'jobTitle', label: 'Job title', group: 'Details', aliases: ['title', 'position', 'role', 'job'] },
    ...METHODS,
    { key: 'company', label: 'Company', group: 'Details', aliases: ['company name', 'organization', 'organisation', 'account', 'employer'] },
    { key: 'type', label: 'Contact type', group: 'Details', aliases: ['type', 'category'] },
    SOURCE,
    { key: 'birthday', label: 'Birthday', group: 'Details', aliases: ['date of birth', 'dob', 'birth date'] },
    ...ADDRESS, DESCRIPTION, OWNER,
  ],
  company: [
    { key: 'name', label: 'Company name', group: 'Name', aliases: ['company', 'name', 'organization', 'organisation', 'account', 'account name', 'business name'] },
    ...METHODS,
    { key: 'type', label: 'Company type', group: 'Details', aliases: ['type', 'category'] },
    { key: 'industry', label: 'Industry', group: 'Details', aliases: ['sector', 'vertical'] },
    { key: 'size', label: 'Company size', group: 'Details', aliases: ['size', 'employees', 'headcount', 'number of employees'] },
    SOURCE,
    { key: 'annualRevenue', label: 'Annual revenue', group: 'Details', aliases: ['revenue', 'turnover'] },
    { key: 'currency', label: 'Currency', group: 'Details' },
    ...ADDRESS, DESCRIPTION, OWNER,
  ],
  lead: [
    { key: 'title', label: 'Lead title', group: 'Name', aliases: ['title', 'subject', 'lead', 'lead name', 'opportunity'] },
    ...NAME_PARTS,
    { key: 'jobTitle', label: 'Job title', group: 'Details', aliases: ['position', 'role', 'job'] },
    { key: 'companyName', label: 'Company name', group: 'Details', aliases: ['company', 'organization', 'organisation', 'account'] },
    ...METHODS,
    SOURCE,
    { key: 'sourceDetails', label: 'Source details', group: 'Details', aliases: ['campaign', 'source description', 'referrer'] },
    { key: 'amount', label: 'Amount', group: 'Details', aliases: ['value', 'budget', 'deal value', 'expected revenue', 'estimated value'] },
    { key: 'currency', label: 'Currency', group: 'Details' },
    { key: 'stage', label: 'Stage', group: 'Details', aliases: ['status', 'lead status', 'lead stage'] },
    ...ADDRESS, DESCRIPTION, OWNER,
  ],
  deal: [
    { key: 'title', label: 'Deal name', group: 'Name', aliases: ['title', 'deal', 'deal title', 'opportunity', 'opportunity name', 'name', 'subject'] },
    { key: 'amount', label: 'Amount', group: 'Pricing', aliases: ['value', 'deal value', 'deal amount', 'revenue', 'price', 'total'] },
    { key: 'currency', label: 'Currency', group: 'Pricing' },
    { key: 'stage', label: 'Stage', group: 'Details', aliases: ['status', 'deal stage', 'pipeline stage', 'phase'] },
    { key: 'expectedCloseDate', label: 'Expected close date', group: 'Details', aliases: ['close date', 'closing date', 'expected close', 'due date', 'close'] },
    { key: 'probability', label: 'Probability %', group: 'Details', aliases: ['probability', 'chance', 'likelihood', 'win probability'] },
    { key: 'company', label: 'Company', group: 'Details', aliases: ['company name', 'account', 'account name', 'customer', 'client', 'organization', 'organisation'] },
    { key: 'contact', label: 'Contact (email or name)', group: 'Details', multiple: true, aliases: ['contact', 'contact email', 'contact name', 'email', 'person'] },
    { key: 'dealType', label: 'Deal type', group: 'Details', aliases: ['type', 'deal type', 'category'] },
    SOURCE, DESCRIPTION, OWNER,
  ],
  product: [
    { key: 'name', label: 'Product name', group: 'Name', aliases: ['product', 'name', 'item', 'item name', 'title', 'product name'] },
    { key: 'sku', label: 'SKU / code', group: 'Name', aliases: ['code', 'item code', 'product code', 'article', 'part number', 'ref'] },
    { key: 'unitPrice', label: 'Price', group: 'Pricing', aliases: ['unit price', 'price', 'list price', 'rate', 'cost'] },
    { key: 'currency', label: 'Currency', group: 'Pricing' },
    { key: 'unit', label: 'Unit', group: 'Pricing', aliases: ['uom', 'unit of measure', 'units'] },
    { key: 'taxRate', label: 'Tax %', group: 'Pricing', aliases: ['tax', 'vat', 'vat %', 'tax rate', 'gst'] },
    { key: 'taxIncluded', label: 'Price includes tax (yes/no)', group: 'Pricing', aliases: ['tax included', 'incl tax', 'including tax', 'vat included'] },
    { key: 'category', label: 'Category', group: 'Details', aliases: ['group', 'product category', 'family', 'type'] },
    { key: 'isActive', label: 'Active (yes/no)', group: 'Details', aliases: ['active', 'enabled', 'status', 'available'] },
    DESCRIPTION,
  ],
};

export const customTargetKey = (fieldKey: string) => `custom.${fieldKey}`;

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/**
 * Suggest a target for every CSV header. Matches the target key, label or an alias (ignoring case, spaces and
 * punctuation); custom fields match by label or key. A single-value target is used at most once.
 */
export function suggestMapping(entity: ImportEntity, headers: string[], customFields: { key: string; label: string }[] = []): (string | null)[] {
  const candidates: { key: string; names: string[]; multiple: boolean }[] = [
    ...IMPORT_TARGETS[entity].map((t) => ({ key: t.key, names: [t.key, t.label, ...(t.aliases ?? [])].map(norm), multiple: !!t.multiple })),
    ...customFields.map((f) => ({ key: customTargetKey(f.key), names: [norm(f.label), norm(f.key)], multiple: false })),
  ];
  const used = new Set<string>();
  return headers.map((h) => {
    const n = norm(h);
    if (!n) return null;
    const hit = candidates.find((c) => c.names.includes(n) && (c.multiple || !used.has(c.key)));
    if (!hit) return null;
    used.add(hit.key);
    return hit.key;
  });
}

/** Mapping problems that block an import (returned as field errors). */
export function mappingErrors(entity: ImportEntity, mapping: (string | null)[], customKeys: string[]): string[] {
  const targets = new Map(IMPORT_TARGETS[entity].map((t) => [t.key, t]));
  const errors: string[] = [];
  const seen = new Map<string, number>();
  for (const key of mapping) {
    if (!key) continue;
    if (key.startsWith('custom.')) {
      if (!customKeys.includes(key.slice(7))) errors.push(`Unknown custom field "${key.slice(7)}"`);
    } else if (!targets.has(key)) errors.push(`Unknown field "${key}"`);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    const t = targets.get(key);
    if (count > 1 && !t?.multiple) errors.push(`"${t?.label ?? key.slice(7)}" is mapped to ${count} columns; choose one`);
  }
  const has = (...keys: string[]) => keys.some((k) => seen.has(k));
  if (entity === 'contact' && !has('fullName', 'firstName', 'lastName')) errors.push('Map a column to First name, Last name or Full name');
  if (entity === 'company' && !has('name')) errors.push('Map a column to Company name');
  if (entity === 'lead' && !has('title', 'fullName', 'firstName', 'lastName', 'companyName', 'email', 'phone')) {
    errors.push('Map at least a title, a name, a company or a phone/email column');
  }
  if (entity === 'deal' && !has('title')) errors.push('Map a column to Deal name');
  if (entity === 'product' && !has('name')) errors.push('Map a column to Product name');
  return errors;
}

// ───────────────────────── Cell parsers (lenient, return null when invalid) ─────────────────────────

/** "Ada Lovelace" → [Ada, Lovelace]; "Lovelace, Ada" → [Ada, Lovelace]; "Ada" → [Ada, null]. */
export function splitFullName(v: string): [string | null, string | null] {
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) return [null, null];
  if (s.includes(',')) {
    const [last, first] = s.split(',', 2).map((x) => x.trim());
    return [first || null, last || null];
  }
  const i = s.lastIndexOf(' ');
  return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
}

const pad = (n: number) => String(n).padStart(2, '0');
const validDate = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/** Parse a date cell to YYYY-MM-DD. A 4-digit-year-first value is always read as Y-M-D; otherwise `format` decides. */
export function parseDateCell(v: string, format: DateFormat = 'ymd'): string | null {
  // Drop a trailing time ("2026-03-01 14:30", "2026-03-01T14:30:00Z").
  const s = v.trim().replace(/[T\s]+\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*(am|pm)?\s*(Z|[+-]\d{2}:?\d{2})?$/i, '');
  let y: number, m: number, d: number;
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  const other = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (other && format !== 'ymd') {
    const [a, b, yy] = [Number(other[1]), Number(other[2]), Number(other[3])];
    y = other[3].length === 2 ? (yy < 50 ? 2000 + yy : 1900 + yy) : yy;
    [d, m] = format === 'dmy' ? [a, b] : [b, a];
  } else return null;
  return validDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/**
 * Normalise a number cell to a plain decimal string ("1,500.50" / "1.500,50" / "$ 1 500" → "1500.50" / "1500.50" / "1500").
 * Returns null when the cell is not a number.
 */
export function normalizeNumberCell(v: string): string | null {
  let s = v.trim().replace(/[\s']/g, '').replace(/^[^\d.,-]+|[^\d.,]+$/g, '');
  if (!s) return null;
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    s = s.split(dec === '.' ? ',' : '.').join('');
    if (dec === ',') s = s.replace(',', '.');
  } else if (lastComma >= 0) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3}){2,}$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return (neg ? '-' : '') + s;
}

const TRUE = new Set(['yes', 'y', 'true', '1', 'x', 'on', '✓', '✔']);
const FALSE = new Set(['no', 'n', 'false', '0', 'off', '-']);
export function parseBoolCell(v: string): boolean | null {
  const s = v.trim().toLowerCase();
  return TRUE.has(s) ? true : FALSE.has(s) ? false : null;
}

/** Split a multi-value cell ("A; B, C" or "A|B"). */
export const splitListCell = (v: string) => v.split(/[;,|\n]/).map((x) => x.trim()).filter(Boolean);
