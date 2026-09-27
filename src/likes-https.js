import { USER_AGENT, SessionExpiredError } from './myprice.js';

export const LIKES_TAB_URL = 'https://like.musinsa.com/api2/like/like-page/v1/tab';
export const LIKED_GOODS_URL = 'https://like.musinsa.com/api2/like/like-page/v1/tab/goods';
const LIKE_HOST = 'like.musinsa.com';
const LOGGED_OUT_CODE = 'LIKE-000-0001';

// The tab total lags the list right after new likes (observed +1 twice, 2026-09-27).
// A shortfall would mass-unlike. Accepting a surplus can keep an unliked item tracked a day longer,
// and while the total lags it can hide a missing like, unliked for one run until the next reactivates it.
export const LIKES_TOTAL_LAG_TOLERANCE = 3;

/** The liked list came back incomplete or in an unexpected shape: discard it, never apply it partially. */
export class LikesIncompleteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LikesIncompleteError';
  }
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// Error messages name the path only: the query carries the cursor, headers carry the cookie.
const pathOf = (url) => new URL(url).pathname;

async function getLikeJson(url, headers, { fetchFn, onSetCookie, retryDelayMs }) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetchFn(url, { headers });
    const setCookies = res.headers?.getSetCookie?.() ?? [];
    if (onSetCookie && setCookies.length) onSetCookie(setCookies);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.status === 401 || body?.meta?.errorCode === LOGGED_OUT_CODE) {
      throw new SessionExpiredError('Musinsa like API reports logged out');
    }
    if ((res.status === 429 || res.status >= 500) && attempt === 1) {
      await sleep(retryDelayMs);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${pathOf(url)}`);
    if (body?.meta?.result !== 'SUCCESS') {
      throw new LikesIncompleteError(`like API result ${body?.meta?.result ?? 'missing'} for ${pathOf(url)}`);
    }
    return body;
  }
}

function checkedNext(next, seen) {
  if (next === null || next === undefined) return null;
  let parsed;
  try {
    parsed = new URL(next);
  } catch {
    throw new LikesIncompleteError('unexpected next link (not a URL)');
  }
  if (parsed.protocol !== 'https:' || parsed.host !== LIKE_HOST) {
    throw new LikesIncompleteError(`unexpected next link host ${parsed.host}`);
  }
  if (seen.has(next)) throw new LikesIncompleteError('next link repeats an earlier page');
  return next;
}

/**
 * Every liked goods item over authenticated HTTPS (like.musinsa.com), sequentially.
 * Throws instead of returning a partial list: the caller would otherwise mark the
 * missing items UNLIKED. A small surplus over the total is accepted (the total lags).
 */
export async function fetchLikedGoodsViaHttps(
  cookie,
  { fetchFn = fetch, delayMs = 700, retryDelayMs = 2000, pageSize = 30, maxPages = 50, onSetCookie = null } = {}
) {
  const headers = {
    'User-Agent': USER_AGENT,
    Referer: 'https://www.musinsa.com/',
    Origin: 'https://www.musinsa.com',
    Accept: 'application/json',
    Cookie: cookie,
  };
  const reqOpts = { fetchFn, onSetCookie, retryDelayMs };

  const expected = (await getLikeJson(LIKES_TAB_URL, headers, reqOpts))?.data?.goods;
  if (!Number.isInteger(expected) || expected < 0) throw new LikesIncompleteError('like tab has no goods total');

  const byGoodsNo = new Map();
  const seen = new Set();
  let url = `${LIKED_GOODS_URL}?size=${pageSize}`;
  for (let pageNo = 1; url; pageNo++) {
    if (pageNo > maxPages) throw new LikesIncompleteError(`more than ${maxPages} pages`);
    seen.add(url);
    await sleep(delayMs);
    const body = await getLikeJson(url, headers, reqOpts);
    if (!Array.isArray(body.data)) throw new LikesIncompleteError(`page ${pageNo} has no data array`);
    for (const it of body.data) {
      if (it?.itemType !== 'GOODS') continue; // banners and ads are not likes
      if (
        !Number.isInteger(it.goodsNo) ||
        it.goodsNo <= 0 ||
        typeof it.goodsName !== 'string' ||
        typeof it.brandName !== 'string'
      ) {
        throw new LikesIncompleteError(`page ${pageNo}: unexpected GOODS item schema`);
      }
      if (!byGoodsNo.has(it.goodsNo)) {
        byGoodsNo.set(it.goodsNo, {
          goodsNo: it.goodsNo,
          goodsName: it.goodsName,
          brandName: it.brandName,
          url: `https://www.musinsa.com/products/${it.goodsNo}`,
          status: it.isSoldOut ? '품절' : '판매중',
        });
      }
    }
    url = checkedNext(body.link?.next, seen);
  }

  // Re-read the total: a like and an unlike during paging can shift the cursor window yet keep the count equal.
  await sleep(delayMs);
  const after = (await getLikeJson(LIKES_TAB_URL, headers, reqOpts))?.data?.goods;
  if (after !== expected) {
    throw new LikesIncompleteError(`liked goods total changed during paging (${expected} -> ${after ?? 'missing'})`);
  }
  const received = byGoodsNo.size;
  if (received < expected) {
    throw new LikesIncompleteError(`received ${received} of ${expected} liked goods`);
  }
  if (received > expected + LIKES_TOTAL_LAG_TOLERANCE) {
    throw new LikesIncompleteError(
      `received ${received} liked goods, total ${expected} (more than ${LIKES_TOTAL_LAG_TOLERANCE} over)`
    );
  }
  if (received > expected) {
    console.warn(`[Sync HTTPS Notice] like total lags the list (${received} listed, total ${expected}); accepting`);
  }
  return [...byGoodsNo.values()];
}
