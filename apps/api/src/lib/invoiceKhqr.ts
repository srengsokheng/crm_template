/** The KHQR (Bakong) payment QR for an invoice's balance due — see lib/khqr.ts. */
import type { KhqrSettings } from '@crm/shared';
import { encodeKhqr } from './khqr.ts';

export type KhqrResult =
  | { available: true; payload: string; amount: string; currency: 'KHR' | 'USD'; expiresAt: string; accountId: string; merchantName: string }
  | { available: false; reason: 'not_configured' | 'not_invoice' | 'not_sent' | 'paid' | 'currency'; message: string };

export function invoiceKhqr(doc: { kind: string; status: string; currency: string; total: string; paid_amount: string; number: string | null }, k: KhqrSettings, now = Date.now()): KhqrResult {
  if (!k.enabled || !k.accountId || !k.merchantName) return { available: false, reason: 'not_configured', message: 'KHQR isn’t set up. An admin can turn it on in Settings → Quotes & invoices.' };
  if (doc.kind !== 'invoice') return { available: false, reason: 'not_invoice', message: 'KHQR is shown on invoices.' };
  if (doc.status === 'paid') return { available: false, reason: 'paid', message: 'This invoice is paid.' };
  if (doc.status !== 'sent') return { available: false, reason: 'not_sent', message: 'The KHQR appears once the invoice is sent.' };
  if (doc.currency !== 'KHR' && doc.currency !== 'USD') return { available: false, reason: 'currency', message: `KHQR only works in riel (KHR) or dollars (USD); this invoice is in ${doc.currency}.` };
  const balance = (Number(doc.total) - Number(doc.paid_amount ?? 0)).toFixed(2);
  if (Number(balance) <= 0) return { available: false, reason: 'paid', message: 'Nothing is left to pay.' };
  const expires = now + k.validDays * 86_400_000;
  const payload = encodeKhqr({
    accountId: k.accountId, merchantName: k.merchantName, city: k.city || 'Phnom Penh', type: k.accountType,
    merchantId: k.accountType === 'merchant' ? k.merchantId || undefined : undefined,
    acquiringBank: k.acquiringBank || undefined,
    currency: doc.currency, amount: balance, billNumber: (doc.number ?? '').slice(0, 25) || undefined, createdAt: now, expiresAt: expires,
  });
  return { available: true, payload, amount: balance, currency: doc.currency, expiresAt: new Date(expires).toISOString(), accountId: k.accountId, merchantName: k.merchantName };
}
