import { describe, expect, it } from 'vitest';
import { calcLine, calcTotals, normalizeContactValue, sumMoney } from '../src/index.ts';

describe('line item math', () => {
  it('handles discounts and exclusive tax', () => {
    expect(calcLine({ unitPrice: '1500', quantity: 1, discountType: 'percent', discountValue: 10, taxRate: 10 })).toEqual({
      listTotal: '1500.00', discount: '150.00', net: '1350.00', tax: '135.00', lineTotal: '1485.00',
    });
  });
  it('handles inclusive tax (total equals net)', () => {
    const r = calcLine({ unitPrice: '110', quantity: 1, taxRate: 10, taxIncluded: true });
    expect(r).toMatchObject({ net: '110.00', tax: '10.00', lineTotal: '110.00' });
  });
  it('caps fixed and percentage discounts at the list total', () => {
    expect(calcLine({ unitPrice: '10', quantity: 2, discountType: 'amount', discountValue: 999 }).lineTotal).toBe('0.00');
    expect(calcLine({ unitPrice: '10', quantity: 2, discountType: 'percent', discountValue: 150 }).lineTotal).toBe('0.00');
  });
  it('avoids floating point drift', () => {
    expect(calcLine({ unitPrice: '0.1', quantity: 3 }).lineTotal).toBe('0.30');
    expect(sumMoney(['0.1', '0.2'])).toBe('0.30');
    expect(calcLine({ unitPrice: '19.99', quantity: 3.333 }).lineTotal).toBe('66.63');
  });
  it('sums totals', () => {
    expect(calcTotals([{ unitPrice: '4500', quantity: 3 }, { unitPrice: '1500', quantity: 1, discountType: 'percent', discountValue: 10 }]))
      .toEqual({ listTotal: '15000.00', discount: '150.00', tax: '0.00', total: '14850.00' });
  });
});

describe('normalisation', () => {
  it('normalises emails, phones and websites', () => {
    expect(normalizeContactValue('email', ' Alice@Example.COM ')).toBe('alice@example.com');
    expect(normalizeContactValue('phone', '+1 (555) 010-0199')).toBe('+15550100199');
    expect(normalizeContactValue('website', 'https://www.Acme.com/')).toBe('acme.com');
  });
});
