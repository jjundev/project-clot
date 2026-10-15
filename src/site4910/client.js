// 4910.kr (Ably's men's mall) brand listing client. Anonymous-token auth only — no login, no cookies.
// The listings are reseller posts (Japanese buying agents), so the tracking unit is the listing sno.
import { parseCouponConditions } from './coupon-eligibility.js';
import { USER_AGENT } from '../myprice.js';

export const BRANDS_4910 = [
  { sno: 2421, key: 'uniqlo', name: '유니클로' },
  { sno: 13647, key: 'gu', name: 'GU' },
];

export const PAGE_LIMIT = 500;
// One query's cursor stops near 3,000 listings, so a scan splits brands into price slices below that.
export const SLICE_MAX = 2500;
export const COMPLETE_TOLERANCE = 0.01;

const TOKEN_URL = 'https://api.a-bly.com/api/v2/anonymous/token/';
const LIST_BASE = 'https://api.a-bly.com/aglo/api/brands';
const DETAIL_BASE = 'https://api.a-bly.com/api/v2/goods';
const LIKED_URL = 'https://api.a-bly.com/aglo/api/members/me/liked-goods/';
const LIKED_PAGE_LIMIT = 100;
const RANKING_URL = 'https://api.a-bly.com/aglo/api/brands/ranking/';
const MARKET_BASE = 'https://api.a-bly.com/api/v2/markets';
const ME_URL = 'https://api.a-bly.com/aglo/api/members/me/';
const MY_COUPONS_URL = 'https://api.a-bly.com/aglo/api/members/me/coupons/';
const BEST_COUPON_URL = 'https://api.a-bly.com/aglo/api/coupons/best-coupon';
const COUPON_BASE = 'https://api.a-bly.com/aglo/api/coupons';
const COUPON_GOODS_PAGE_LIMIT = 500;
const RANKING_PAGE_LIMIT = 100;
// Wallet and best-coupon endpoints answer only to the web app's identity headers.
const AGLO_HEADERS = { 'X-App-Type': 'AGLO', 'X-App-Version': '0.1.0', 'X-Device-Type': 'PCWeb' };
const COUPON_LABEL = '쿠폰적용가';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

function parsePrice(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function toRow(entry, brand) {
  const a = entry.logging?.analytics ?? {};
  const d = entry.render?.data ?? {};
  const sno = Number(entry.item.sno);
  const salePrice = parsePrice(a.SALES_PRICE); // null when missing; the store then keeps the last known price
  return {
    sno,
    brand_sno: brand.sno,
    brand: brand.name,
    name: entry.item.name,
    market_sno: entry.item.market_sno ?? null,
    market_type_sno: Number(a.MARKET_TYPE_SNO) || null,
    market_name: a.MARKET_NAME ?? null,
    category: a.STANDARD_CATEGORY_NAME ?? null,
    sale_price: salePrice,
    original_price: parsePrice(d.original_price) ?? salePrice,
    discount_rate: a.DISCOUNT_RATE == null ? null : Number(a.DISCOUNT_RATE),
    image_url: d.image?.url ?? null,
    url: `https://4910.kr/goods/${sno}`,
    closed: Boolean(d.closed_reason),
  };
}

function listUrl({ brandSno, minPrice, maxPrice, lastSno, limit }) {
  let url = `${LIST_BASE}/${brandSno}/goods/?brand=${brandSno}&member_gender=ALL&sorting_type=NEW&limit=${limit}`;
  if (minPrice != null) url += `&min_price=${minPrice}`;
  if (maxPrice != null) url += `&max_price=${maxPrice}`;
  if (lastSno != null) url += `&last_sno=${lastSno}`;
  return url;
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function createClient({ fetchFn = fetch, delayMs = 300, retryBaseMs = 1000 } = {}) {
  let token = null;
  let requests = 0;

  // Retries network errors, 429 and 5xx like the list call; any other status (a Cloudflare 403) fails at once.
  async function fetchToken() {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchFn(TOKEN_URL, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Origin: 'https://4910.kr', Referer: 'https://4910.kr/' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (attempt === MAX_RETRIES) throw httpError(`4910 anonymous token: ${err.name}: ${err.message}`, undefined);
        await sleep(retryBaseMs * 2 ** attempt);
        continue;
      }
      if (res.ok) {
        const body = await res.json();
        if (!body?.token) throw httpError('4910 anonymous token missing in response', res.status);
        token = body.token;
        return token;
      }
      if (!(res.status === 429 || res.status >= 500) || attempt === MAX_RETRIES) {
        throw httpError(`4910 anonymous token HTTP ${res.status}`, res.status);
      }
      await sleep(retryBaseMs * 2 ** attempt);
    }
  }

  // One GET with the shared spacing, timeout and retry (network errors, 429, 5xx). Anonymous calls send the
  // anonymous token and refresh it once on 401; member calls send only `Authorization: JWT` (never the token
  // value in a message) and fail at once with code MEMBER_AUTH on 401/403. `aglo` adds the web app identity headers.
  async function getJson(url, { memberToken = null, label, aglo = true }) {
    let refreshed = false;
    let lastStatus;
    let lastMessage = 'unknown error';

    for (let attempt = 0; attempt <= MAX_RETRIES; ) {
      if (requests++ > 0) await sleep(delayMs);
      if (!memberToken && !token) await fetchToken();

      let res;
      try {
        res = await fetchFn(url, {
          headers: {
            'User-Agent': USER_AGENT,
            ...(aglo ? AGLO_HEADERS : {}),
            ...(memberToken ? { Authorization: `JWT ${memberToken}` } : { 'X-Anonymous-Token': token }),
            Origin: 'https://4910.kr',
            Referer: 'https://4910.kr/',
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        lastStatus = undefined;
        lastMessage = `${err.name}: ${err.message}`;
        if (attempt === MAX_RETRIES) break;
        await sleep(retryBaseMs * 2 ** attempt++);
        continue;
      }

      if (memberToken && (res.status === 401 || res.status === 403)) {
        const err = httpError(`4910 ${label} failed: member token rejected (HTTP ${res.status})`, res.status);
        err.code = 'MEMBER_AUTH';
        throw err;
      }
      if (!memberToken && res.status === 401 && !refreshed) {
        refreshed = true;
        token = null;
        continue;
      }
      if (res.ok) return res.json();

      lastStatus = res.status;
      lastMessage = `HTTP ${res.status}`;
      if (!(res.status === 429 || res.status >= 500) || attempt === MAX_RETRIES) break;
      await sleep(retryBaseMs * 2 ** attempt++);
    }

    throw httpError(`4910 ${label} failed: ${lastMessage}`, lastStatus);
  }

  async function listBrandGoods({ brandSno, minPrice = null, maxPrice = null, lastSno = null, limit = PAGE_LIMIT }) {
    const body = await getJson(listUrl({ brandSno, minPrice, maxPrice, lastSno, limit }), { label: `brand ${brandSno} list` });
    return {
      totalCount: Number(body.total_count) || 0,
      entries: Array.isArray(body.goods_list) ? body.goods_list : [],
      lastSno: body.last_sno ?? null,
    };
  }

  // Goods detail. With a member token the price is the member's price; the coupon price is goods.price only
  // when Ably labels it 쿠폰적용가.
  async function getGoodsDetail(sno, { memberToken = null } = {}) {
    const body = await getJson(`${DETAIL_BASE}/${sno}/`, { memberToken, label: `goods ${sno} detail` });
    const g = body?.goods ?? {};
    const price = parsePrice(g.price);
    return {
      sno: Number(sno),
      priceBasis: 'AGLO',
      price,
      couponPrice: g.price_description?.text === COUPON_LABEL ? price : null,
      listPrice: parsePrice(g.first_page_rendering?.price),
      originalPrice: parsePrice(g.linked_option?.original_price),
      optionSno: g.linked_option?.sno ?? null,
      isSoldout: Boolean(g.is_soldout),
      isOpen: Boolean(g.is_open),
    };
  }

  // One page of the member's liked goods, newest first; lastSno is null on the last page.
  async function listLikedGoods({ memberToken, lastSno = null, limit = LIKED_PAGE_LIMIT }) {
    let url = `${LIKED_URL}?limit=${limit}`;
    if (lastSno != null) url += `&last_sno=${lastSno}`;
    const body = await getJson(url, { memberToken, label: 'liked goods list' });
    return {
      entries: Array.isArray(body.goods_list) ? body.goods_list : [],
      lastSno: body.last_sno ?? null,
    };
  }

  // One page of the brand ranking (anonymous); lastSno is the cursor for the next page.
  async function listTopBrands({ limit = RANKING_PAGE_LIMIT, lastSno = null } = {}) {
    let url = `${RANKING_URL}?limit=${limit}`;
    if (lastSno != null) url += `&last_sno=${lastSno}`;
    const body = await getJson(url, { label: 'brand ranking' });
    return {
      brands: (Array.isArray(body.brand_list) ? body.brand_list : []).map((b) => ({ sno: Number(b.sno), name: b.name })),
      lastSno: body.last_sno ?? null,
    };
  }

  // A seller's (market's) public profile; satisfaction is a percentage, reviewsCount is null when Ably omits it.
  // A body without a market object throws: read as all-null it would store the seller as unqualified for a week.
  async function getMarket(sno) {
    const body = await getJson(`${MARKET_BASE}/${sno}/`, { label: `market ${sno}` });
    const m = body?.market;
    if (!m || typeof m !== 'object') throw httpError(`4910 market ${sno} failed: no market in response`, undefined);
    return {
      sno: Number(m.sno ?? sno),
      name: m.name ?? null,
      satisfaction: m.purchasing_satisfaction_ratio ?? null,
      reviewsCount: m.reviews_count ?? null,
      isOfficial: Boolean(m.is_official),
    };
  }

  // The member's coupon wallet. min comes from the human-readable condition text ("10,000원 이상 구매 시 ...").
  async function getMyCoupons({ memberToken }) {
    const body = await getJson(MY_COUPONS_URL, { memberToken, aglo: true, label: 'my coupons' });
    return (Array.isArray(body.coupon_apply_list) ? body.coupon_apply_list : []).map((c) => ({
      couponSno: Number(c.coupon_sno),
      name: c.coupon_name ?? null,
      type: c.discount_type === 'PERCENT' ? 'PERCENT' : 'PRICE',
      percent: c.discount_percent ?? null,
      price: c.discount_price ?? null,
      max: c.max_discount_price ?? Infinity,
      min: parseCouponConditions(c.conditions).minAmount ?? 0,
      finishedAt: c.finished_at ?? null,
      usable: Boolean(c.is_usable && c.is_in_available_period),
      conditions: Array.isArray(c.conditions) ? c.conditions.map(String) : null,
      hasTargets: typeof c.has_targets === 'boolean' ? c.has_targets : null,
      appOnly: Boolean(c.is_app_only),
    }));
  }

  // Only the e-money balance; the rest of the profile is personal data we never keep.
  async function getMe({ memberToken }) {
    const body = await getJson(ME_URL, { memberToken, aglo: true, label: 'member profile' });
    return { emoney: Number(body.emoney) || 0 };
  }

  // The coupon Ably would apply to one option (quantity 1), or null when none applies. A coupon without a numeric
  // coupon_discount throws (callers skip that sample) rather than pricing with NaN. min is null when Ably omits it.
  async function getBestCoupon(optionSno, { memberToken }) {
    const options = encodeURIComponent(JSON.stringify([{ sno: Number(optionSno), ea: 1 }]));
    const body = await getJson(`${BEST_COUPON_URL}?options=${options}`, { memberToken, aglo: true, label: `best coupon ${optionSno}` });
    const c = body?.best_coupon;
    if (!c) return null;
    const discount = c.coupon_discount == null ? NaN : Number(c.coupon_discount);
    if (!Number.isFinite(discount)) throw httpError(`4910 best coupon ${optionSno} failed: no numeric coupon_discount`, undefined);
    return {
      couponSno: Number(c.sno),
      optionSno: Number(optionSno),
      isApplied: typeof body.is_applied === 'boolean' ? body.is_applied : null,
      name: c.name ?? null,
      discount,
      percent: c.discount_percent ?? null,
      price: c.discount_price ?? null,
      max: c.max_discount_price ?? Infinity,
      min: c.minimum_price == null ? null : Number(c.minimum_price),
    };
  }

  // One page of the goods a coupon is limited to (an event list); lastSno is the cursor for the next page. A body
  // without a numeric total_count throws: read as 0 it would scope the coupon to nothing.
  async function getCouponGoodsPage(couponSno, { memberToken, lastSno = null, limit = COUPON_GOODS_PAGE_LIMIT }) {
    let url = `${COUPON_BASE}/${couponSno}/goods?limit=${limit}`;
    if (lastSno != null) url += `&last_sno=${lastSno}`;
    const label = `coupon ${couponSno} goods`;
    const body = await getJson(url, { memberToken, aglo: true, label });
    const totalCount = body?.total_count == null ? NaN : Number(body.total_count);
    if (!Number.isFinite(totalCount)) throw httpError(`4910 ${label} failed: no total_count`, undefined);
    return {
      totalCount,
      snos: (Array.isArray(body.goods_list) ? body.goods_list : []).map((e) => Number(e?.item?.sno)).filter(Number.isFinite),
      lastSno: body.last_sno ?? null,
    };
  }

  // The names of the categories a coupon reaches. A body without category_list throws rather than reading as none.
  async function getCouponCategories(couponSno, { memberToken }) {
    const label = `coupon ${couponSno} categories`;
    const body = await getJson(`${COUPON_BASE}/${couponSno}/categories`, { memberToken, aglo: true, label });
    if (!Array.isArray(body?.category_list)) throw httpError(`4910 ${label} failed: no category_list`, undefined);
    return body.category_list.map((c) => String(c?.name ?? c?.sno));
  }

  // Returns the cached anonymous token, fetching one first if needed (the runner probe checks this step alone).
  const getToken = async () => token ?? fetchToken();

  return {
    listBrandGoods, getToken, getGoodsDetail, listLikedGoods, listTopBrands, getMarket, getMyCoupons, getMe, getBestCoupon,
    getCouponGoodsPage, getCouponCategories,
  };
}

const sliceLabel = (lo, hi) => `${lo}-${hi ?? '∞'}`;

/**
 * Enumerates every open listing of one brand. A single query's cursor stops near 3,000 listings, so the
 * price axis is bisected until each slice reports at most sliceMax. The scan is complete only when every
 * slice succeeded, the slice totals add up to the brand total, and the listings actually paged out add up to
 * the slice totals (both within COMPLETE_TOLERANCE) — the store counts misses (and later drops listings) only
 * for complete scans, so a cursor that ends early must never pass as complete. Past `deadline` the scan stops.
 */
export async function scanBrand(client, brand, { sliceMax = SLICE_MAX, deadline = Infinity } = {}) {
  const result = { brandSno: brand.sno, brandTotal: null, sliceTotalSum: 0, rows: new Map(), complete: false, problems: [] };
  try {
    result.brandTotal = (await client.listBrandGoods({ brandSno: brand.sno, limit: 1 })).totalCount;
  } catch (err) {
    result.problems.push(`brand total: ${err.message}`);
    return result;
  }

  const maxPages = Math.ceil(sliceMax / PAGE_LIMIT) + 5;
  const stack = [[0, null]];
  let fetched = 0; // every entry paged out, closed ones included, to compare against the API's totals
  let outOfTime = false;
  while (stack.length && !outOfTime) {
    const [lo, hi] = stack.pop();
    if (Date.now() > deadline) {
      outOfTime = true;
      break;
    }
    try {
      const { totalCount } = await client.listBrandGoods({ brandSno: brand.sno, minPrice: lo, maxPrice: hi, limit: 1 });
      if (totalCount > sliceMax && (hi === null || hi > lo)) {
        if (hi === null) {
          const mid = Math.max(lo * 2, 100_000);
          stack.push([mid, null], [lo, mid - 1]);
        } else {
          const mid = Math.floor((lo + hi) / 2);
          stack.push([mid + 1, hi], [lo, mid]);
        }
        continue;
      }
      if (totalCount > sliceMax) result.problems.push(`unsplittable ${sliceLabel(lo, hi)}: ${totalCount} listings`);
      result.sliceTotalSum += totalCount;
      if (totalCount === 0) continue;

      let lastSno = null;
      let pages = 0;
      do {
        if (Date.now() > deadline) {
          outOfTime = true;
          break;
        }
        if (pages++ >= maxPages) {
          result.problems.push(`slice ${sliceLabel(lo, hi)}: page cap ${maxPages} reached`);
          break;
        }
        const page = await client.listBrandGoods({ brandSno: brand.sno, minPrice: lo, maxPrice: hi, lastSno });
        fetched += page.entries.length;
        for (const entry of page.entries) {
          const row = toRow(entry, brand);
          if (!row.closed) result.rows.set(row.sno, row);
        }
        lastSno = page.entries.length ? page.lastSno : null;
      } while (lastSno !== null);
    } catch (err) {
      result.problems.push(`slice ${sliceLabel(lo, hi)}: ${err.message}`);
    }
  }

  if (outOfTime) result.problems.push('time budget exceeded');
  const drift = Math.abs(result.sliceTotalSum - result.brandTotal);
  if (drift > result.brandTotal * COMPLETE_TOLERANCE) {
    result.problems.push(`slice totals ${result.sliceTotalSum} vs brand total ${result.brandTotal}`);
  }
  if (result.sliceTotalSum - fetched > result.sliceTotalSum * COMPLETE_TOLERANCE) {
    result.problems.push(`fetched ${fetched} of ${result.sliceTotalSum}`);
  }
  result.complete = result.problems.length === 0;
  return result;
}
