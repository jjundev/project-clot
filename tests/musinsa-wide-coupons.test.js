import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COUPON_FIELDS, parseCoupon, couponDiscountMusinsa, couponPriceMusinsa, keyCouponSet } from '../src/musinsaWide/coupons.js';

// A raw coupon built from COUPON_FIELDS (the real field names, docs/verify/musinsa-coupon-price.md §2).
const raw = (over = {}) => {
  const base = { id: 359200, name: '무탠다드 깜짝 15% 쿠폰', kind: '%', rate: '15', max: 40000, min: 1000, discount: 10480, until: '2026-10-15T23:59:59+09:00' };
  const merged = { ...base, ...over };
  const out = {};
  for (const [k, field] of Object.entries(COUPON_FIELDS)) if (field && k in merged && merged[k] !== undefined) out[field] = merged[k];
  return out;
};

test('couponDiscountMusinsa floors to 10 won, honours min and max', () => {
  assert.equal(couponDiscountMusinsa(47390, { type: 'PERCENT', percent: 5, price: null, max: null, min: 0 }), 2360);
  assert.equal(couponDiscountMusinsa(101400, { type: 'PERCENT', percent: 12, price: null, max: null, min: 0 }), 12160);
  assert.equal(couponDiscountMusinsa(300000, { type: 'PERCENT', percent: 20, price: null, max: 30000, min: 0 }), 30000);
  assert.equal(couponDiscountMusinsa(9000, { type: 'PRICE', percent: null, price: 3000, max: null, min: 10000 }), 0);
});

test('couponPriceMusinsa subtracts extra discount and the single best coupon', () => {
  const cs = [{ type: 'PERCENT', percent: 5, price: null, max: null, min: 0 }, { type: 'PRICE', percent: null, price: 3000, max: null, min: 0 }];
  assert.equal(couponPriceMusinsa({ sale_price: 98100, extra_discount: 1960 }, cs), 98100 - 1960 - 4900);
  assert.equal(couponPriceMusinsa({ sale_price: 50000, extra_discount: 0 }, []), 50000);
  assert.equal(couponPriceMusinsa({ sale_price: null, extra_discount: 0 }, cs), null);
});

test('parseCoupon reads an explicit rate as PERCENT', () => {
  const c = parseCoupon(raw({ rate: '12' }));
  assert.equal(c.id, '359200');
  assert.equal(c.type, 'PERCENT');
  assert.equal(c.percent, 12);
  assert.equal(c.price, null);
  assert.equal(c.discount, 10480);
  assert.equal(c.until, '2026-10-15');
});

test('parseCoupon falls back to the name percent', () => {
  const c = parseCoupon(raw({ rate: undefined, kind: undefined, name: '실버정기 5%' }));
  assert.equal(c.type, 'PERCENT');
  assert.equal(c.percent, 5);
});

test('parseCoupon falls back to a fixed amount of the discount', () => {
  const c = parseCoupon(raw({ rate: undefined, kind: undefined, name: '3천원 쿠폰', discount: 3000 }));
  assert.equal(c.type, 'PRICE');
  assert.equal(c.price, 3000);
  assert.equal(c.percent, null);
});

test('parseCoupon defaults max to null and min to 0', () => {
  const c = parseCoupon(raw({ max: 0, min: undefined, until: undefined }));
  assert.equal(c.max, null);
  assert.equal(c.min, 0);
  assert.equal(c.until, null);
  assert.equal(parseCoupon(raw({ max: undefined })).max, null);
});

test('keyCouponSet infers a minimum from a cheaper sample without the coupon', () => {
  const a = { id: 'A', type: 'PERCENT', percent: 10, price: null, max: null, min: 0, discount: 0 };
  const set = keyCouponSet([{ salePrice: 80000, coupons: [a] }, { salePrice: 20000, coupons: [] }]);
  assert.equal(set[0].min, 20001);
  assert.equal(a.min, 0);
});

test('keyCouponSet hides a key whose cheaper sample has a coupon the pricier lacks', () => {
  const a = { id: 'A', type: 'PERCENT', percent: 10, price: null, max: null, min: 0, discount: 0 };
  assert.equal(keyCouponSet([{ salePrice: 80000, coupons: [] }, { salePrice: 20000, coupons: [a] }]), null);
});

test('keyCouponSet collapses duplicate copies and keeps a coupon present everywhere as is', () => {
  const a = { id: 'A', type: 'PERCENT', percent: 10, price: null, max: null, min: 500, discount: 0 };
  const set = keyCouponSet([{ salePrice: 80000, coupons: [a, { ...a }] }, { salePrice: 20000, coupons: [{ ...a }] }]);
  assert.equal(set.length, 1);
  assert.equal(set[0].min, 500);
});
