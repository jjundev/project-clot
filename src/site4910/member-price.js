// A best-coupon candidate is not an applied coupon. Keep the reason alongside every observation.
export function resolveMemberPrice(detail, best) {
  const fail = reason => ({ price: null, reason });
  if (detail.priceBasis !== 'AGLO') return fail('price-basis');
  if (detail.isSoldout || detail.isOpen === false) return fail('unavailable');
  if (detail.optionSno == null || !Number.isFinite(detail.listPrice) || detail.listPrice <= 0) return fail('option-or-base');
  if (best == null) return { price: detail.listPrice, reason: 'no-coupon' };
  if (Number(best.optionSno) !== Number(detail.optionSno)) return fail('option-mismatch');
  if (best.isApplied !== true) return fail(best.isApplied === false ? 'coupon-not-applied' : 'application-unknown');
  if (!Number.isFinite(best.discount) || best.discount < 0 || best.discount > detail.listPrice) return fail('discount');
  return { price: Math.min(detail.listPrice, Math.ceil((detail.listPrice - best.discount) / 10) * 10), reason: 'applied-coupon' };
}
