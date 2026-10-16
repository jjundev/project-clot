import { CATEGORIES_MUSINSA } from './client.js';
import { DAILY_GOODS_TARGET } from './partitions.js';

// Run after the Release push so an incomplete attempt remains recoverable but cannot appear green.
export function verifyProductCoverage(run) {
  if (!run || run.complete !== 1) throw new Error('Daily product scan incomplete');
  const categories = JSON.parse(run.category_counts_json ?? 'null');
  if (!Array.isArray(categories) || categories.length !== CATEGORIES_MUSINSA.length ||
      new Set(categories.map(c => c.cat)).size !== CATEGORIES_MUSINSA.length ||
      categories.some(c => !CATEGORIES_MUSINSA.includes(c.cat) || !c.complete || !Number.isSafeInteger(c.scanned) || c.scanned < 0)) {
    throw new Error('Daily category coverage incomplete');
  }
  const selected = categories.reduce((n,c) => n+c.scanned,0);
  if (selected !== DAILY_GOODS_TARGET) throw new Error(`Daily target incomplete: ${selected}/${DAILY_GOODS_TARGET}`);
  return { selected };
}

export function verifyDailyCoverage(run) {
  const { selected } = verifyProductCoverage(run);
  const metrics = JSON.parse(run.coupon_metrics_json ?? 'null');
  const walk = metrics?.walk;
  const coverage = pricingCoverage(walk);
  const p = metrics.pricing;
  if (p?.policy !== ESTIMATE_POLICY || ['priced','direct','estimated','active','unpriced'].some(k=>!Number.isSafeInteger(p[k])||p[k]<0) ||
      p.priced===0 || p.direct+p.estimated!==p.priced || p.priced+p.unpriced!==p.active || p.active<selected ||
      JSON.stringify(p.exceptionCoupons)!==JSON.stringify(coverage.exceptionCoupons)) throw new Error('Daily price provenance incomplete');
  return { selected, couponLists: walk.walked, calls: walk.calls, ...coverage, direct: p.direct, estimated: p.estimated, unpriced: p.unpriced };
}

export const ESTIMATE_POLICY = 'confirmed-benefits-estimate-v1';

// Exceptions never prove a complete list; they only permit the explicitly approved estimate policy.
export function pricingCoverage(walk) {
  const fail = () => { throw new Error('Daily coupon list coverage incomplete'); };
  if (!walk) return fail();
  const exceptionCoupons = walk.exceptions ?? [];
  if (!Array.isArray(exceptionCoupons) || exceptionCoupons.some(n=>!Number.isSafeInteger(n)||n<=0) || new Set(exceptionCoupons).size!==exceptionCoupons.length) return fail();
  if (['requested','walked','failed','remaining'].some(k=>!Number.isSafeInteger(walk[k])||walk[k]<0) ||
      walk.stop || walk.failed || walk.failedCoupons?.length || (walk.suspectEmpty??0)!==exceptionCoupons.length ||
      walk.remaining!==walk.requested-walk.walked || walk.walked+exceptionCoupons.length!==walk.requested ||
      walk.complete!==(walk.remaining===0)) return fail();
  return { coverage: exceptionCoupons.length ? 'estimate-with-exceptions' : 'complete', exceptionCoupons: [...exceptionCoupons].sort((a,b)=>a-b) };
}
