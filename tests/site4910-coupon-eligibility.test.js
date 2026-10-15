import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCouponConditions, evaluateCouponEligibility as evaluate } from '../src/site4910/coupon-eligibility.js';
import { Store4910 } from '../src/site4910/store.js';

test('quantity and minimum are read from the entire condition array', () => {
  assert.deepEqual(parseCouponConditions(['상품 3개 이상 구매시 사용 가능', '1원 이상 구매 시 최대 100,000원 할인']), { minAmount: 1, minQuantity: 3 });
  assert.deepEqual(parseCouponConditions(['10,000원 이상 구매 시 할인', '설명']), { minAmount: 10000, minQuantity: 1 });
  assert.deepEqual(parseCouponConditions(null), { minAmount: null, minQuantity: null });
});
const coupon = { usable: true, conditions: ['10,000원 이상 구매 시 할인'], hasTargets: true, appOnly: false };
const scope = { kind: 'goods', complete: true, goodsSnos: new Set([1]) };
const check = (c = coupon, s = scope, basePrice = 12850) => evaluate({ coupon: c, goodsSno: 1, quantity: 1, basePrice, scopeEvidence: s });
test('single item never receives multi-item coupons or missing terms', () => {
  assert.equal(check({ ...coupon, conditions: ['상품 3개 이상 구매시 사용 가능', '1원 이상 구매 시 할인'] }).status, 'ineligible');
  assert.equal(check({ ...coupon, conditions: null }).status, 'unknown');
  assert.equal(check(coupon, scope, 9999).status, 'ineligible');
});
test('usable wallet and category count cannot establish product scope', () => {
  assert.equal(check().status, 'eligible');
  assert.equal(check(coupon, { ...scope, goodsSnos: new Set([2]) }).status, 'ineligible');
  assert.equal(check(coupon, { ...scope, complete: false }).status, 'unknown');
  assert.equal(check(coupon, { kind: 'unknown', complete: false }).status, 'unknown');
  assert.equal(check({ ...coupon, appOnly: true }).status, 'ineligible');
  assert.equal(check({ ...coupon, name: '네이버 유입 전용' }).status, 'ineligible');
  assert.equal(check({ ...coupon, conditions: ['알 수 없는 조건'] }).status, 'unknown');
});
test('wallet restriction fields survive database storage', () => {
  const store = new Store4910(':memory:');
  store.replaceWallet('2026-10-16', [{ ...coupon, couponSno: 1 }]);
  const [row] = store.getWallet();
  assert.deepEqual(row.conditions, coupon.conditions);
  assert.equal(row.hasTargets, true);
  assert.equal(row.appOnly, false);
  store.close();
});
