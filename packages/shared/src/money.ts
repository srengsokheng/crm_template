import { Decimal } from 'decimal.js';

export interface LineInput {
  unitPrice: string | number;
  quantity: string | number;
  discountType?: 'percent' | 'amount' | null;
  discountValue?: string | number | null;
  taxRate?: string | number | null;
  taxIncluded?: boolean | null;
}

export interface LineResult {
  listTotal: string;
  discount: string;
  net: string;
  tax: string;
  lineTotal: string;
}

const D = (v: string | number | null | undefined) => new Decimal(v === null || v === undefined || v === '' ? 0 : v);
const money = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * Line math (all decimal-safe):
 *   list = price × qty; discount = percent ? list × p% : fixed (capped at list);
 *   net = list − discount; tax = included ? net − net/(1+r) : net × r;
 *   total = included ? net : net + tax.
 */
export function calcLine(l: LineInput): LineResult {
  const list = D(l.unitPrice).mul(D(l.quantity));
  let discount = new Decimal(0);
  if (l.discountType === 'percent') discount = list.mul(Decimal.min(D(l.discountValue), 100)).div(100);
  else if (l.discountType === 'amount') discount = Decimal.min(D(l.discountValue), list);
  const net = list.minus(discount);
  const rate = D(l.taxRate).div(100);
  const tax = l.taxIncluded ? net.minus(net.div(rate.plus(1))) : net.mul(rate);
  const total = l.taxIncluded ? net : net.plus(tax);
  return {
    listTotal: money(list).toFixed(2),
    discount: money(discount).toFixed(2),
    net: money(net).toFixed(2),
    tax: money(tax).toFixed(2),
    lineTotal: money(total).toFixed(2),
  };
}

export function calcTotals(lines: LineInput[]) {
  const acc = { listTotal: new Decimal(0), discount: new Decimal(0), tax: new Decimal(0), total: new Decimal(0) };
  for (const l of lines) {
    const r = calcLine(l);
    acc.listTotal = acc.listTotal.plus(r.listTotal);
    acc.discount = acc.discount.plus(r.discount);
    acc.tax = acc.tax.plus(r.tax);
    acc.total = acc.total.plus(r.lineTotal);
  }
  return {
    listTotal: acc.listTotal.toFixed(2),
    discount: acc.discount.toFixed(2),
    tax: acc.tax.toFixed(2),
    total: acc.total.toFixed(2),
  };
}

export function sumMoney(values: (string | number | null | undefined)[]): string {
  return values.reduce<Decimal>((a, v) => a.plus(D(v)), new Decimal(0)).toFixed(2);
}
