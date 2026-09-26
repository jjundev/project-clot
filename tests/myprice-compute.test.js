import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeMyPrice } from '../src/myprice.js';

const PROMO_5K = { isApplicable: true, minAmount: 100000, discountAmount: 5000 };

describe('computeMyPrice (verified against OpenCLI my-prices on 2026-09-26)', () => {
  test('595039: grade 1.5% + point capped by memberPoint + card instant 5000', () => {
    const r = computeMyPrice({
      salePrice: 229000, memberDiscountRate: 1.5, memberPoint: 10899, cardPromotions: [PROMO_5K],
    });
    assert.equal(r.myPrice, 209671);
    assert.deepEqual(r.breakdown, {
      base: 229000, gradeDiscount: 3430, pointDiscount: 10899, basicPrice: 214671, prePointDiscount: 0, instantDiscount: 5000,
    });
  });

  test('2322315: best coupon applied, promo below minAmount ignored', () => {
    const r = computeMyPrice({
      salePrice: 64890, couponDiscount: 19460, memberDiscountRate: 1.5, memberPoint: 10899, cardPromotions: [PROMO_5K],
    });
    assert.equal(r.myPrice, 41620);
    assert.equal(r.breakdown.instantDiscount, 0);
  });

  test('6047897: picks the largest eligible promo', () => {
    const r = computeMyPrice({
      salePrice: 499000, couponDiscount: 34930, memberDiscountRate: 1.5, memberPoint: 10899,
      cardPromotions: [PROMO_5K, { isApplicable: true, minAmount: 300000, discountAmount: 15000 }],
    });
    assert.equal(r.myPrice, 431211);
  });

  test('4663718: extraDiscountAmount reduces the base before point usage; limited DC skips grade', () => {
    const r = computeMyPrice({
      salePrice: 86400, couponDiscount: 10360, extraDiscountAmount: 8560, memberDiscountRate: 1.5,
      isLimitedDc: true, memberPoint: 10899,
    });
    assert.equal(r.breakdown.pointDiscount, 4720);
    assert.equal(r.myPrice, 62760);
  });

  test('3933001: pre-point = floor10(basic × rate) + savePoint when isGivenPoint', () => {
    const r = computeMyPrice({
      salePrice: 119000, couponDiscount: 12000, memberDiscountRate: 1.5, isLimitedDc: true, memberPoint: 10899,
      isPrePoint: true, isGivenPoint: true, memberSavePointRate: 1.5, savePoint: 110, cardPromotions: [PROMO_5K],
    });
    assert.equal(r.breakdown.prePointDiscount, 1600);
    assert.equal(r.breakdown.instantDiscount, 0); // 97910 < 100000
    assert.equal(r.myPrice, 97910);
  });

  test('3982118: restricted point use + extra discount only', () => {
    const r = computeMyPrice({
      salePrice: 22800, extraDiscountAmount: 4050, isLimitedDc: true, isRestrictedUsePoint: true, memberPoint: 10899,
    });
    assert.equal(r.myPrice, 18750);
  });

  test('promotions with isApplicable=false are ignored', () => {
    const r = computeMyPrice({
      salePrice: 229000, memberPoint: 0, cardPromotions: [{ isApplicable: false, minAmount: 0, discountAmount: 9000 }],
    });
    assert.equal(r.breakdown.instantDiscount, 0);
    assert.equal(r.breakdown.pointDiscount, 0); // memberPoint 0 caps point usage at 0
    assert.equal(r.myPrice, 229000);
  });
});
