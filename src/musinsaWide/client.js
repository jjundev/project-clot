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
const PAGE_ATTEMPTS = 3;
const PAGE_BACKOFF_MS = [2000, 4000]; // waits before attempt 2 and 3

const realSleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export function firstPageUrl(cat) {
  return `https://www.musinsa.com/categories/item/${cat}?gf=${GENDER_MUSINSA}&sortCode=${SORT_MUSINSA}`;
}

export function createMusinsaClient({ fetchFn = fetch, pageDelayMs = 300, couponDelayMs = 700, sleep = realSleep } = {}) {
  let couponCalls = 0;

  // pageUrl null = first page (built here); later pages must be the nextPageUrl the API returned (never built: 403).
  async function getCategoryPage(cat, pageUrl = null) {
    if (pageUrl) await sleep(pageDelayMs);
    const { items, pagination } = await fetchCategoryGoodsPage(cat, pageUrl || firstPageUrl(cat), fetchFn);
    const nextPageUrl = pagination?.hasNext && pagination?.nextPageUrl ? pagination.nextPageUrl : null;
    return { items: Array.isArray(items) ? items : [], nextPageUrl };
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

  return { getCategoryPage, getUsableCoupons, sleep };
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
    name: item.goodsName ?? null,
    url: item.goodsLinkUrl || `https://www.musinsa.com/products/${goodsNo}`,
    image_url: item.thumbnail ?? null,
    sale_price: item.price,
    normal_price: item.normalPrice ?? null,
    extra_discount: item.extraDiscountAmount ?? 0,
    is_sold_out: item.isSoldOut ? 1 : 0,
  };
}

// One page with up to 3 attempts (2s, 4s backoff). An empty list that still has a nextPageUrl counts as a failure.
async function fetchPageWithRetry(client, cat, url, sleep) {
  let lastMessage = '';
  for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(PAGE_BACKOFF_MS[attempt - 1]);
    try {
      const page = await client.getCategoryPage(cat, url);
      if (page.items.length === 0 && page.nextPageUrl) {
        lastMessage = 'empty page with a next page';
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
