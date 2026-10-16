// Musinsa wide scan client: walks a category's REVIEW-sorted listing by following nextPageUrl, and asks the
// usable-coupon API about one goods at a time. Pure of any storage; the caller owns cookies and pacing policy
// beyond the fixed gaps below. The cookie is only ever sent as a header, never put into a message or log.
import { fetchCategoryGoodsPage } from '../discovery.js';
import { USER_AGENT } from '../myprice.js';

export const CATEGORIES_MUSINSA = ['001', '002', '003', '103', '004'];
export const SORT_MUSINSA = 'REVIEW';
export const GENDER_MUSINSA = 'A';
export const DEPTH_PAGES = 100; // 60 goods per page

const COUPON_API = 'https://api.musinsa.com/api2/coupon/coupons/getUsableCouponsByGoodsNo';
export const REQUEST_TIMEOUT_MS = 30_000; // per request; undici's default would let a stalled connection wait ~300 s
const PAGE_ATTEMPTS = 3;
const PAGE_BACKOFF_MS = [2000, 4000]; // waits before attempt 2 and 3

// Anonymous coupon goods list (no cookie). size above 300 comes back empty without an error, so it stays fixed.
export const PLP_API = 'https://api.musinsa.com/api2/coupon/plp/v1/goods';
export const PLP_PAGE_SIZE = 300;
export const ALL_CATEGORIES_PARAM = '001,002,003,103,004';
export const ANON_RETRY_BACKOFF_MS = [2000, 4000]; // waits before attempt 2 and 3
const ANON_ATTEMPTS = 3;

const realSleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export function firstPageUrl(cat) {
  return `https://www.musinsa.com/categories/item/${cat}?gf=${GENDER_MUSINSA}&sortCode=${SORT_MUSINSA}`;
}

export function createMusinsaClient({ fetchFn: baseFetch = fetch, pageDelayMs = 300, couponDelayMs = 700, anonDelayMs = 500, sleep = realSleep } = {}) {
  let couponCalls = 0;
  let anonCalls = 0;
  const fetchFn = (url, opts = {}) => baseFetch(url, { ...opts, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  // pageUrl null = first page (built here); later pages must be the nextPageUrl the API returned (never built: 403).
  async function getCategoryPage(cat, pageUrl = null) {
    if (pageUrl) await sleep(pageDelayMs);
    const { items, pagination } = await fetchCategoryGoodsPage(cat, pageUrl || firstPageUrl(cat), async (...args) => {
      const res = await fetchFn(...args);
      if (!res.ok) throw Object.assign(new Error(`Category page HTTP ${res.status}`), { status: res.status });
      if (String(args[0]).includes('/api2/dp/v2/plp/goods')) {
        const body = await res.json();
        if (!Array.isArray(body?.data?.list) || typeof body?.data?.pagination?.hasNext !== 'boolean') {
          throw new Error('malformed category JSON page');
        }
        return { ok: true, json: async () => body };
      }
      return res;
    });
    if (pagination?.hasNext && !pagination?.nextPageUrl) throw new Error('Category page promises next page without cursor');
    const nextPageUrl = pagination?.hasNext && pagination?.nextPageUrl ? pagination.nextPageUrl : null;
    return { items: Array.isArray(items) ? items : [], nextPageUrl };
  }

  async function getCategoryPartitions(root) {
    const res = await fetchFn(firstPageUrl(root), {
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://www.musinsa.com/' },
    });
    if (!res.ok) throw Object.assign(new Error(`Category taxonomy HTTP ${res.status}`), { status: res.status });
    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    let roots;
    try {
      const queries = JSON.parse(match?.[1]).props?.pageProps?.dehydratedState?.queries;
      roots = queries?.find(q => q.queryKey?.[0] === 'category/Category')?.state?.data?.data?.list;
    } catch { /* Report all invalid shapes consistently below. */ }
    const children = Array.isArray(roots) ? roots.find(r => r.categoryCode === root)?.categoryList : null;
    if (!Array.isArray(children) || !children.length || children.some(c =>
      typeof c.categoryCode !== 'string' || !c.categoryCode.startsWith(root) ||
      c.categoryCode.length !== root.length + 3 || c.parentCategoryCode !== root) ||
      new Set(children.map(c => c.categoryCode)).size !== children.length) {
      throw new Error(`Invalid or missing category taxonomy for ${root}`);
    }
    return children.map(c => ({ code: c.categoryCode, root }));
  }

  // The caller (one worker per client) owns 429 handling; no retry here.
  async function getUsableCoupons({ goodsNo, brand, salePrice }, cookie, { onSetCookie } = {}) {
    if (couponCalls++ > 0) await sleep(couponDelayMs);
    const params = new URLSearchParams({
      goodsNo: String(goodsNo),
      brand: brand || '',
      comId: brand || '',
      salePrice: String(salePrice),
    });
    const res = await fetchFn(`${COUPON_API}?${params}`, {
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://www.musinsa.com/', Cookie: cookie },
    });
    const setCookies = res.headers?.getSetCookie?.() ?? [];
    if (onSetCookie && setCookies.length) onSetCookie(setCookies);
    if (res.status === 401 || res.status === 403) {
      const err = new Error(`Musinsa coupon API rejected the member session (HTTP ${res.status}) for goods ${goodsNo}`);
      err.code = 'MEMBER_AUTH';
      err.status = res.status;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`Musinsa coupon API HTTP ${res.status} for goods ${goodsNo}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    const list = json?.data?.list;
    if (!Array.isArray(list)) throw new Error(`Unexpected coupon API response for goods ${goodsNo}`);
    return list;
  }

  // Anonymous GET against the coupon plp API: no Cookie header. One counter spaces the count and list calls alike.
  async function anonGetJson(url, what) {
    if (anonCalls++ > 0) await sleep(anonDelayMs);
    const res = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT, Referer: 'https://www.musinsa.com/' } });
    if (!res.ok) {
      const err = new Error(`Musinsa coupon goods ${what} HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function plpParams(couponNo, category) {
    return new URLSearchParams({ couponNo: String(couponNo), couponKind: 'PRODUCT', caller: 'COUPON', gf: GENDER_MUSINSA, category });
  }

  async function getCouponGoodsCount(couponNo, { category = ALL_CATEGORIES_PARAM } = {}) {
    const json = await anonGetJson(`${PLP_API}/count?${plpParams(couponNo, category)}`, 'count');
    const count = json?.data;
    if (typeof count !== 'number' || !Number.isFinite(count)) throw new Error(`Unexpected coupon goods count response for coupon ${couponNo}`);
    return count;
  }

  async function getCouponGoodsPage(couponNo, { page = 1, category = ALL_CATEGORIES_PARAM } = {}) {
    const params = plpParams(couponNo, category);
    params.set('sortCode', SORT_MUSINSA);
    params.set('page', String(page));
    params.set('size', String(PLP_PAGE_SIZE));
    const json = await anonGetJson(`${PLP_API}?${params}`, 'list');
    const list = json?.data?.list;
    if (json?.meta?.result !== 'SUCCESS' || !Array.isArray(list)) throw new Error(`Unexpected coupon goods list response for coupon ${couponNo}`);
    return {
      items: list.map((it) => ({ goodsNo: Number(it.goodsNo), reviewCount: it.reviewCount ?? null, isSoldOut: Boolean(it.isSoldOut) })),
      totalCount: json.data.pagination?.totalCount ?? list.length,
      hasNext: Boolean(json.data.pagination?.hasNext),
    };
  }

  return { getCategoryPartitions, getCategoryPage, getUsableCoupons, getCouponGoodsCount, getCouponGoodsPage, sleep };
}

// Retry wrapper for the anonymous calls: a 429 is rethrown at once (the caller stops the phase), anything else waits
// 2s then 4s and retries, three attempts in all; the last error is thrown.
export async function anonCall(fn, { sleep = realSleep, beforeAttempt } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < ANON_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(ANON_RETRY_BACKOFF_MS[attempt - 1]);
    // Outside the retry catch: a deadline, quota or sibling stop must abort immediately.
    beforeAttempt?.();
    try {
      return await fn();
    } catch (err) {
      if (err?.status === 429) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

export function toListingRow(item, cat) {
  if (!item || item.goodsNo == null || item.goodsNo === '') return null;
  const goodsNo = Number(item.goodsNo);
  if (!Number.isFinite(goodsNo) || goodsNo <= 0) return null;
  return {
    goods_no: goodsNo,
    cat,
    brand: item.brand ?? null,
    brand_name: item.brandName ?? null,
    name: item.goodsName ?? '', // goods.name is NOT NULL: one nameless listing must not abort the run
    url: item.goodsLinkUrl || `https://www.musinsa.com/products/${goodsNo}`,
    image_url: item.thumbnail ?? null,
    sale_price: item.price,
    normal_price: item.normalPrice ?? null,
    extra_discount: item.extraDiscountAmount ?? 0,
    is_sold_out: item.isSoldOut ? 1 : 0,
    review_count: item.reviewCount ?? null,
  };
}

// One page with up to 3 attempts (2s, 4s backoff). An empty list that still has a nextPageUrl counts as a failure.
async function fetchPageWithRetry(client, cat, url, sleep) {
  let lastMessage = '';
  for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(PAGE_BACKOFF_MS[attempt - 1]);
    try {
      const page = await client.getCategoryPage(cat, url);
      // An empty first page is never a real end of chain: fetchCategoryGoodsPage returns it silently for a changed
      // __NEXT_DATA__ shape or a block page served with HTTP 200. Later empty pages only fail when a next page is promised.
      if (page.items.length === 0 && (url === null || page.nextPageUrl)) {
        lastMessage = url === null ? 'empty first page' : 'empty page with a next page';
        continue;
      }
      return { page };
    } catch (err) {
      lastMessage = err.message;
    }
  }
  return { error: lastMessage };
}

export async function scanCategory(client, cat, { maxPages = DEPTH_PAGES, deadline = Infinity, sleep = client.sleep ?? realSleep, now = Date.now } = {}) {
  const rows = new Map();
  const problems = [];
  let pages = 0;
  let url = null;
  let complete = false;

  while (true) {
    if (pages >= maxPages) {
      complete = true;
      break;
    }
    if (now() >= deadline) {
      problems.push(`${cat}: deadline reached after ${pages} pages`);
      break;
    }
    const { page, error } = await fetchPageWithRetry(client, cat, url, sleep);
    if (!page) {
      problems.push(`${cat}: page ${pages + 1} failed after ${PAGE_ATTEMPTS} attempts: ${error}`);
      break;
    }
    pages++;
    for (const item of page.items) {
      const row = toListingRow(item, cat);
      if (row) rows.set(row.goods_no, row);
    }
    if (!page.nextPageUrl) {
      complete = true;
      break;
    }
    url = page.nextPageUrl;
  }

  return { cat, rows, pages, complete, problems };
}
