import { describe, expect, it } from 'vitest';
import { crc16, decodeKhqr, encodeKhqr, khqrAmount } from '../src/lib/khqr.ts';

// Produced by the official Bakong SDK (bakong-khqr 1.0.20) with the clock fixed at 1763450000000.
const SDK = {
  usd: '00020101021229220018sreng_sokheng@aclb52045999530384054071250.505802KH5913Acme Robotics6010Phnom Penh62120108INV-00429934001317634500000000113176405480000063042205',
  khr: '00020101021229220018sreng_sokheng@aclb52045999530311654064120005802KH5913Acme Robotics6010Phnom Penh62120108INV-00439934001317634500000000113176405480000063047F9A',
  merchant: '00020101021230360009acme@abaa010712345670208ABA Bank5204599953038405402995802KH5916Acme Robotics Co6009Siem Reap62090105INV-799340013176345000000001131764054800000630413D7',
  static: '00020101021129220018sreng_sokheng@aclb5204599953038405802KH5913Acme Robotics6010Phnom Penh6304D2DE',
};
const times = { createdAt: 1763450000000, expiresAt: 1764054800000 };
const me = { accountId: 'sreng_sokheng@aclb', merchantName: 'Acme Robotics', city: 'Phnom Penh', type: 'individual' as const };

describe('KHQR', () => {
  it('builds exactly what the official Bakong SDK builds', () => {
    expect(encodeKhqr({ ...me, currency: 'USD', amount: '1250.50', billNumber: 'INV-0042', ...times })).toBe(SDK.usd);
    expect(encodeKhqr({ ...me, currency: 'KHR', amount: '412000.00', billNumber: 'INV-0043', ...times })).toBe(SDK.khr);
    expect(encodeKhqr({ accountId: 'acme@abaa', merchantName: 'Acme Robotics Co', city: 'Siem Reap', type: 'merchant', merchantId: '1234567', acquiringBank: 'ABA Bank',
      currency: 'USD', amount: '99.00', billNumber: 'INV-7', ...times })).toBe(SDK.merchant);
    expect(encodeKhqr({ ...me, currency: 'USD' })).toBe(SDK.static);
  });

  it('checksums and decodes', () => {
    expect(crc16('123456789')).toBe('29B1'); // the standard CRC-16/CCITT-FALSE check value
    const d = decodeKhqr(SDK.usd);
    expect(d.valid).toBe(true);
    expect(d.fields).toMatchObject({ '01': '12', '53': '840', '54': '1250.50', '59': 'Acme Robotics' });
    expect(decodeKhqr(SDK.usd.replace('1250.50', '1250.51')).valid).toBe(false); // tampered amount
  });

  it('writes amounts the KHQR way and refuses a priced QR without times', () => {
    expect(khqrAmount('412000.40', 'KHR')).toBe('412000');
    expect(khqrAmount('10.00', 'USD')).toBe('10');
    expect(khqrAmount('10.5', 'USD')).toBe('10.50');
    expect(() => khqrAmount('0', 'USD')).toThrow();
    expect(() => encodeKhqr({ ...me, currency: 'USD', amount: '5' })).toThrow(/expiry/);
  });
});
