import { floor10 } from './discovery.js';

/**
 * Reproduces the "나의 할인가" math that the Musinsa product page runs client-side.
 * Verified 109/109 against OpenCLI `musinsa my-prices` on 2026-09-26.
 * @returns {{ myPrice: number, breakdown: object }}
 */
export function computeMyPrice({
  salePrice,
  couponDiscount = 0,
  extraDiscountAmount = 0,
  memberDiscountRate = 0,
  isLimitedDc = false,
  isRestrictedUsePoint = false,
  maxUsePointRate = 0.07,
  memberPoint = 0,
  isPrePoint = false,
  isGivenPoint = false,
  memberSavePointRate = 0,
  savePoint = 0,
  cardPromotions = [],
}) {
  const base = salePrice - couponDiscount - extraDiscountAmount;
  const gradeDiscount = isLimitedDc ? 0 : floor10((base * memberDiscountRate) / 100);
  const afterGrade = base - gradeDiscount;
  const pointMax = isRestrictedUsePoint ? 0 : floor10(afterGrade * maxUsePointRate);
  const pointDiscount = Math.min(pointMax, Math.max(0, memberPoint || 0));
  const basicPrice = afterGrade - pointDiscount;
  const prePointDiscount = isPrePoint
    ? floor10((basicPrice * memberSavePointRate) / 100) + (isGivenPoint ? savePoint || 0 : 0)
    : 0;
  const afterPrePoint = basicPrice - prePointDiscount;
  const eligible = (cardPromotions || []).filter(
    (p) => p && p.isApplicable && afterPrePoint >= (p.minAmount ?? 0)
  );
  const instantDiscount = eligible.length ? Math.max(...eligible.map((p) => p.discountAmount || 0)) : 0;

  return {
    myPrice: afterPrePoint - instantDiscount,
    breakdown: { base, gradeDiscount, pointDiscount, basicPrice, prePointDiscount, instantDiscount },
  };
}
