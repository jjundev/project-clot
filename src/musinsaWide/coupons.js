// Musinsa coupon math for the wide scan (docs/verify/musinsa-coupon-price.md). A product's coupon price is its
// sale price − the extra discount − the single best coupon (a percent coupon floors to 10 won, capped by the
// coupon's max). Which coupons a brand|category key has is learned from a high and a low sample of the key.
import { floor10 } from '../discovery.js';

// Raw coupon field names of getUsableCouponsByGoodsNo (§2). No fixed-amount field exists, so `amount` is null.
export const COUPON_FIELDS = {
  id: 'couponNo',
  name: 'couponName',
  kind: 'couponKind',
  rate: 'couponValue',
  amount: null,
  max: 'maxLimitAmount',
  min: 'lowPrice',
  discount: 'salePrice',
  until: 'useToDate',
};

/**
 * A raw coupon as { id, name, type, percent, price, max, min, discount, until }. PERCENT when the rate field is a
 * number (coupon kind '%'), else when the name says "N%"; otherwise PRICE with the discount itself as the amount.
 * max: null = uncapped (the API sends 0), min defaults to 0, until is the date part of the expiry or null.
 */
export function parseCoupon(raw) {
  const F = COUPON_FIELDS;
  const name = raw[F.name] ?? null;
  const discount = Number(raw[F.discount]) || 0;
  const rate = raw[F.kind] === '%' && raw[F.rate] != null && raw[F.rate] !== '' ? Number(raw[F.rate]) : NaN;
  const named = String(name ?? '').match(/(\d+)%/);
  let type = 'PRICE';
  let percent = null;
  let price = discount;
  if (Number.isFinite(rate)) {
    type = 'PERCENT';
    percent = rate;
    price = null;
  } else if (named) {
    type = 'PERCENT';
    percent = Number(named[1]);
    price = null;
  }
  const max = Number(raw[F.max]);
  const min = Number(raw[F.min]);
  const until = String(raw[F.until] ?? '').match(/^\d{4}-\d{2}-\d{2}/);
  return {
    id: String(raw[F.id]),
    name,
    type,
    percent,
    price,
    max: max > 0 ? max : null,
    min: min > 0 ? min : 0,
    discount,
    until: until ? until[0] : null,
  };
}

// What one coupon takes off a price P: nothing below its minimum, a percent floored to 10 won, then its cap.
export function couponDiscountMusinsa(P, c) {
  if (P < (c.min ?? 0)) return 0;
  const base = c.type === 'PERCENT' ? floor10((P * c.percent) / 100) : c.price;
  return Math.min(c.max ?? Infinity, base);
}

// The sale price less the extra discount and the single largest coupon; null when the sale price is unknown.
export function couponPriceMusinsa({ sale_price, extra_discount }, coupons) {
  if (sale_price == null) return null;
  const best = Math.max(0, ...coupons.map((c) => couponDiscountMusinsa(sale_price, c)));
  return sale_price - (extra_discount ?? 0) - best;
}

/**
 * The coupons of a key from samples ({ salePrice, coupons }), united by id. A coupon missing from a sample that is
 * cheaper than every sample having it is read as a minimum purchase (min = that price + 1); one missing from a
 * sample that is not cheaper contradicts that, so the key's coupons are unknown: null (hide the key, 'scope').
 */
export function keyCouponSet(samples) {
  const byId = new Map();
  for (const s of samples) {
    for (const c of s.coupons) if (!byId.has(c.id)) byId.set(c.id, { ...c });
  }
  const out = [];
  for (const [id, coupon] of byId) {
    const has = samples.filter((s) => s.coupons.some((c) => c.id === id)).map((s) => s.salePrice);
    const lacks = samples.filter((s) => !s.coupons.some((c) => c.id === id)).map((s) => s.salePrice);
    if (lacks.length) {
      const absent = Math.max(...lacks);
      if (absent >= Math.min(...has)) return null;
      coupon.min = Math.max(coupon.min, absent + 1);
    }
    out.push(coupon);
  }
  return out;
}
