/**
 * KHQR — Cambodia's national payment QR (Bakong, National Bank of Cambodia). Any Bakong-member bank app (ABA, ACLEDA,
 * Wing, Canadia, …) can scan it and pay into the given Bakong account. Follows the EMVCo merchant-presented format as
 * the official SDK (bakong-khqr) builds it; the tests compare our output with strings that SDK produced.
 *
 * A QR with an amount ("dynamic") must carry a creation and an expiry time (milliseconds), or banks refuse it.
 */
export interface KhqrInput {
  /** Bakong account ID, like "name@aclb" (max 32). */
  accountId: string;
  merchantName: string; // max 25
  city: string; // max 15
  type: 'individual' | 'merchant';
  merchantId?: string; // merchant accounts (max 32)
  acquiringBank?: string; // merchant accounts (max 32)
  currency: 'KHR' | 'USD';
  /** Decimal string; omitted = the payer types the amount (static QR). */
  amount?: string;
  billNumber?: string; // max 25 (the invoice number)
  createdAt?: number; // ms; required with an amount
  expiresAt?: number; // ms; required with an amount
}

const tlv = (tag: string, value: string) => `${tag}${String(value.length).padStart(2, '0')}${value}`;

/** CRC-16/CCITT-FALSE (polynomial 0x1021, start 0xFFFF), as 4 upper-case hex digits. */
export function crc16(s: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(s, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** The amount as KHQR writes it: riel whole; dollars without ".00", otherwise with two decimals. */
export function khqrAmount(amount: string, currency: 'KHR' | 'USD'): string {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('KHQR amount must be more than 0');
  if (currency === 'KHR') return String(Math.round(n));
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function encodeKhqr(i: KhqrInput): string {
  const account = i.type === 'merchant'
    ? tlv('00', i.accountId) + (i.merchantId ? tlv('01', i.merchantId) : '') + (i.acquiringBank ? tlv('02', i.acquiringBank) : '')
    : tlv('00', i.accountId) + (i.acquiringBank ? tlv('02', i.acquiringBank) : '');
  const dynamic = i.amount !== undefined;
  let s = tlv('00', '01') + tlv('01', dynamic ? '12' : '11') + tlv(i.type === 'merchant' ? '30' : '29', account)
    + tlv('52', '5999') + tlv('53', i.currency === 'KHR' ? '116' : '840');
  if (dynamic) s += tlv('54', khqrAmount(i.amount!, i.currency));
  s += tlv('58', 'KH') + tlv('59', i.merchantName) + tlv('60', i.city || 'Phnom Penh');
  if (i.billNumber) s += tlv('62', tlv('01', i.billNumber));
  if (dynamic) {
    if (!i.createdAt || !i.expiresAt || i.expiresAt <= i.createdAt) throw new Error('A KHQR with an amount needs a creation and a later expiry time');
    s += tlv('99', tlv('00', String(i.createdAt)) + tlv('01', String(i.expiresAt)));
  }
  s += '6304';
  return s + crc16(s);
}

/** Reads a KHQR string into its top-level fields (and checks the checksum). For tests and checks. */
export function decodeKhqr(s: string): { valid: boolean; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    fields[tag] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return { valid: i === s.length && fields['63']?.length === 4 && crc16(s.slice(0, -4)) === fields['63'], fields };
}

/** Limits from the KHQR specification, for validating settings. */
export const KHQR_LIMITS = { accountId: 32, merchantName: 25, city: 15, billNumber: 25, merchantId: 32, acquiringBank: 32 } as const;
