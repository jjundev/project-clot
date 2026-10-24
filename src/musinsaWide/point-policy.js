// Anonymous point-use policy. Never infer permission from missing fields.
export const POINT_TTL_MS = 604800000;
export const POINT_POLICY_VERSION = 'points-max-use-v1';
const money = n => Number.isSafeInteger(n) && n >= 0;
const rate = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const instant = n => Number.isSafeInteger(n) && Math.abs(n) <= 8640000000000000;
function error(code, status) {
  return Object.assign(new Error(`Point policy ${code}${status == null ? '' : ` (${status})`}`), {code,...(status == null ? {} : {status})});
}
export function parsePointPolicy(body, goodsNo, checkedAtMs) {
  const d = body?.data, a = d?.isRestictedUsePoint, b = d?.isRestrictedUsePoint;
  const restricted = a === undefined ? b : a;
  if (!Number.isSafeInteger(goodsNo) || goodsNo <= 0 || !instant(checkedAtMs) || body?.meta?.result !== 'SUCCESS' ||
      d?.goodsNo !== goodsNo || typeof restricted !== 'boolean' ||
      (a !== undefined && b !== undefined && a !== b) || !rate(d?.maxUsePointRate) ||
      !money(d?.goodsPrice?.salePrice) || !money(d?.goodsPrice?.extraDiscountAmount)) throw error('SCHEMA_CHANGED');
  return {goodsNo,restricted,maxUseRate:d.maxUsePointRate,observedSalePrice:d.goodsPrice.salePrice,
    observedExtraDiscount:d.goodsPrice.extraDiscountAmount,checkedAt:new Date(checkedAtMs).toISOString()};
}
export async function fetchPointPolicy(goodsNo, {fetchFn=fetch, now=Date.now, timeoutMs=15000} = {}) {
  if (!Number.isSafeInteger(goodsNo) || goodsNo <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw error('SCHEMA_CHANGED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(15000, timeoutMs));
  try {
    const response = await fetchFn(`https://goods-detail.musinsa.com/api2/goods/${goodsNo}`, {
      signal:controller.signal,redirect:'error',credentials:'omit',headers:{Accept:'application/json'},
    });
    if (!response.ok) throw error('HTTP', response.status);
    let body;
    try { body = await response.json(); } catch { if(controller.signal.aborted)throw error('TIMEOUT');throw error('SCHEMA_CHANGED'); }
    return parsePointPolicy(body, goodsNo, now());
  } catch (e) {
    if (controller.signal.aborted) throw error('TIMEOUT');
    if (['HTTP','SCHEMA_CHANGED','TIMEOUT'].includes(e?.code)) throw e;
    throw error('NETWORK');
  } finally { clearTimeout(timer); }
}
export function evaluatePointEstimate({basis,policy,asOfMs,couponFresh}) {
  const result = {state:'UNKNOWN',price:null,discount:null,checkedAt:policy?.checkedAt ?? null,maxUseRate:policy?.maxUseRate ?? null};
  const state = s => ({...result,state:s});
  if (basis.status !== 'ACTIVE') return state('OUT_OF_SCOPE');
  if (!couponFresh || !money(basis.couponPrice) || !['DIRECT','ESTIMATED'].includes(basis.couponSource)) return state('COUPON_UNAVAILABLE');
  if (!policy || policy.goodsNo !== basis.goodsNo || typeof policy.restricted !== 'boolean' || !rate(policy.maxUseRate) ||
      !money(policy.observedSalePrice) || !money(policy.observedExtraDiscount)) return state('UNKNOWN');
  const age = asOfMs - Date.parse(policy.checkedAt);
  if (!instant(asOfMs) || !Number.isFinite(age) || age < 0 || age >= POINT_TTL_MS) return state('STALE');
  if (basis.salePrice !== policy.observedSalePrice || basis.extraDiscount !== policy.observedExtraDiscount) return state('POLICY_BASE_MISMATCH');
  const discount = policy.restricted ? 0 : 10 * Math.floor(basis.couponPrice * policy.maxUseRate / 10);
  return {...result,state:policy.restricted?'RESTRICTED':'ELIGIBLE',price:basis.couponPrice-discount,discount};
}
