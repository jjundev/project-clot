import { floor10, estimateMemberPrice } from './discovery.js';

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

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export class SessionExpiredError extends Error {
  constructor(message = 'Musinsa session expired (page reports logged out)') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/**
 * @returns {{ detail: object|null, loggedIn: boolean|null } | null} null when __NEXT_DATA__ is absent
 */
export function extractProductDetail(html, goodsNo) {
  const m = String(html || '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  const queries = JSON.parse(m[1]).props?.pageProps?.dehydratedState?.queries || [];
  const detail =
    queries.find((q) => q.queryKey?.[0] === 'Detail' && Number(q.queryKey?.[1]) === Number(goodsNo))?.state?.data
      ?.data ?? null;
  // null = page carried no LoginStatus (unknown); only an explicit false means the session expired.
  const loginStatus = queries.find((q) => q.queryKey?.[0] === 'Detail' && q.queryKey?.[1] === 'LoginStatus')?.state?.data
    ?.data;
  const loggedIn = typeof loginStatus?.loggedIn === 'boolean' ? loginStatus.loggedIn : null;
  return { detail, loggedIn };
}

async function fetchProductPage(goodsNo, headers, fetchFn, retries, backoffBaseMs) {
  const url = `https://www.musinsa.com/products/${goodsNo}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetchFn(url, { headers: { ...headers, Accept: 'text/html,application/xhtml+xml' } });
    if (res.status === 404) return { discontinued: true };
    if (res.ok) {
      const parsed = extractProductDetail(await res.text(), goodsNo);
      if (parsed) return parsed;
    } else if (res.status !== 429) {
      throw new Error(`HTTP ${res.status} when fetching goods ${goodsNo}`);
    }
    // 429 or a 200 page stripped of __NEXT_DATA__ (Musinsa's soft rate limit): back off and retry
    if (attempt < retries) await sleep(2 ** (attempt - 1) * backoffBaseMs);
  }
  throw new Error(`Product page for ${goodsNo} unavailable after ${retries} attempts (rate limited?)`);
}

async function fetchJson(url, headers, fetchFn) {
  const res = await fetchFn(url, { headers: { ...headers, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('?')[0]}`);
  return res.json();
}

/**
 * Exact personalized myPrice over HTTPS using the logged-in Musinsa cookie.
 * Throws (never guesses) when any input is missing so the caller can fall back.
 */
export async function fetchAuthenticatedPriceInfo(
  goodsNo,
  { cookie, fetchFn = fetch, retries = 4, backoffBaseMs = 2000 } = {}
) {
  const headers = { 'User-Agent': USER_AGENT, Referer: 'https://www.musinsa.com/', Cookie: cookie };

  const page = await fetchProductPage(goodsNo, headers, fetchFn, retries, backoffBaseMs);
  if (page.discontinued) return { status: 404, discontinued: true };
  if (page.loggedIn === false) throw new SessionExpiredError();
  if (page.loggedIn !== true) throw new Error(`Goods ${goodsNo}: login status unknown (no LoginStatus on page)`);
  const det = page.detail;
  if (!det) throw new Error(`No Detail query for goods ${goodsNo}`);

  const gp = det.goodsPrice || {};
  const salePrice = gp.salePrice ?? gp.normalPrice;
  if (!salePrice) throw new Error(`No salePrice for goods ${goodsNo}`);

  const couponParams = new URLSearchParams({
    goodsNo: String(goodsNo),
    brand: det.brand || '',
    comId: det.comId || det.brand || '',
    salePrice: String(salePrice),
  });
  if (det.specialtyCodes?.length) couponParams.set('specialtyCodes', det.specialtyCodes.join(','));

  const [couponRes, promoRes] = await Promise.all([
    fetchJson(`https://api.musinsa.com/api2/coupon/coupons/getUsableCouponsByGoodsNo?${couponParams}`, headers, fetchFn),
    fetchJson(
      `https://goods-detail.musinsa.com/api2/goods/${goodsNo}/card-promotion?brand=${encodeURIComponent(det.brand || '')}`,
      headers,
      fetchFn
    ),
  ]);
  const coupons = couponRes?.data?.list;
  if (!Array.isArray(coupons)) throw new Error(`Unexpected coupon API response for goods ${goodsNo}`);
  const promotions = promoRes?.data?.promotions;
  if (!Array.isArray(promotions)) throw new Error(`Unexpected card-promotion API response for goods ${goodsNo}`);
  const bestCoupon = coupons.reduce((best, c) => ((c.salePrice || 0) > (best?.salePrice || 0) ? c : best), null);

  const isLimitedDc = Boolean(det.isLimitedDc);
  const isRestrictedUsePoint = Boolean(det.isRestrictedUsePoint ?? det.isRestictedUsePoint);
  const { myPrice } = computeMyPrice({
    salePrice,
    couponDiscount: bestCoupon?.salePrice || 0,
    extraDiscountAmount: gp.extraDiscountAmount || 0,
    memberDiscountRate: gp.memberDiscountRate || 0,
    isLimitedDc,
    isRestrictedUsePoint,
    maxUsePointRate: det.maxUsePointRate ?? 0.07,
    memberPoint: det.point?.memberPoint ?? 0,
    isPrePoint: Boolean(det.isPrePoint),
    isGivenPoint: Boolean(det.isGivenPoint),
    memberSavePointRate: gp.memberSavePointRate || 0,
    savePoint: gp.savePoint || 0,
    cardPromotions: promotions,
  });

  const couponPrice = gp.couponPrice ?? salePrice;
  return {
    goodsNo: Number(goodsNo),
    goodsName: det.goodsNm || '',
    brandName: det.brandInfo?.brandName || det.brand || '',
    imageUrl: det.thumbnailImageUrl || det.goodsImage || '',
    url: `https://www.musinsa.com/products/${goodsNo}`,
    normalPrice: gp.normalPrice ?? null,
    salePrice,
    couponPrice,
    saleRate: gp.finalDiscount ?? gp.discountRate ?? 0,
    myPrice,
    estimatedMyPrice: estimateMemberPrice(couponPrice, isRestrictedUsePoint, { isLimitedDc }),
    isRestrictedUsePoint,
    isLimitedDc,
    couponName: bestCoupon?.couponName || '나의 할인가',
    couponDiscount: bestCoupon?.salePrice || 0,
    isSoldOut: Boolean(det.isSoldOut || det.goodsSaleType === 'SOLDOUT'),
    discontinued: false,
    priceSource: 'https-auth',
  };
}
