// Missing or ambiguous conditions never grant a single-item discount.
export function parseCouponConditions(conditions) {
  if (!Array.isArray(conditions) || !conditions.length) return { minAmount: null, minQuantity: null };
  const text = conditions.join('\n');
  const amounts = [...text.matchAll(/([\d,]+)원\s*이상/g)].map((m) => Number(m[1].replaceAll(',', '')));
  const quantities = [...text.matchAll(/(\d+)\s*개\s*이상/g)].map((m) => Number(m[1]));
  return {
    minAmount: amounts.length ? Math.max(...amounts) : null,
    minQuantity: quantities.length ? Math.max(...quantities) : amounts.length && !/묶음|다품목|세트|동시|수량/.test(text) ? 1 : null,
  };
}

export function evaluateCouponEligibility({ coupon, goodsSno, quantity = 1, basePrice, scopeEvidence }) {
  const result = (status, reason) => ({ status, reason });
  if (coupon.usable === false) return result('ineligible', 'unusable');
  if (coupon.appOnly) return result('ineligible', 'app-only');
  if (/네이버|유입|경유/.test([coupon.name, ...(coupon.conditions ?? [])].join(' '))) return result('ineligible', 'referral');
  const { minAmount, minQuantity } = parseCouponConditions(coupon.conditions);
  if (minQuantity != null && quantity < minQuantity) return result('ineligible', 'quantity');
  if (minAmount == null || minQuantity == null) return result('unknown', 'conditions');
  if (!Number.isFinite(basePrice) || basePrice <= 0) return result('unknown', 'base-price');
  if (basePrice < minAmount) return result('ineligible', 'minimum');
  if (scopeEvidence?.kind === 'goods' && scopeEvidence.complete === true && scopeEvidence.goodsSnos instanceof Set) {
    return scopeEvidence.goodsSnos.has(Number(goodsSno)) ? result('eligible', 'complete-goods-list') : result('ineligible', 'outside-goods-list');
  }
  // A seller sample or category count is never proof of seller-wide eligibility.
  return result('unknown', 'scope');
}
