import { applyCouponPrices } from './coupons.js';
import { ESTIMATE_POLICY, pricingCoverage } from './coverage.js';

// Only explicit terminal-empty API exceptions permit estimates. Other incomplete walks preserve cached prices.
export function refreshCouponPrices({ store, date, ready, registry }) {
  let coverage = null;
  let refreshDeferred = false;
  if (ready) {
    try { coverage = pricingCoverage(registry?.walk); }
    catch { refreshDeferred = true; }
  }
  const prices = refreshDeferred
    ? { priced:0,direct:0,estimated:0,withCoupon:0,best:new Map(store.getActivePriceRows().map(r=>[r.goods_no,null])),drops:[],lateDrops:[] }
    : applyCouponPrices({ store,date,ready,allowEmptyLists:coverage!=null });
  const pricing = ready && !refreshDeferred ? {
    policy:ESTIMATE_POLICY,priced:prices.priced,direct:prices.direct,estimated:prices.estimated,
    active:prices.best.size,unpriced:prices.best.size-prices.priced,exceptionCoupons:coverage.exceptionCoupons,
  } : null;
  return { prices,refreshDeferred,pricing };
}
