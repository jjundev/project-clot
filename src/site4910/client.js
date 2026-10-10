// 4910.kr (Ably's men's mall) brand listing client. Anonymous-token auth only — no login, no cookies.
// The listings are reseller posts (Japanese buying agents), so the tracking unit is the listing sno.
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
  const salePrice = Number(a.SALES_PRICE);
  return {
    sno,
    brand_sno: brand.sno,
    brand: brand.name,
    name: entry.item.name,
    market_sno: entry.item.market_sno ?? null,
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
  let listRequests = 0;

  async function fetchToken() {
    const res = await fetchFn(TOKEN_URL, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Origin: 'https://4910.kr', Referer: 'https://4910.kr/' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw httpError(`4910 anonymous token HTTP ${res.status}`, res.status);
    const body = await res.json();
    if (!body?.token) throw httpError('4910 anonymous token missing in response', res.status);
    token = body.token;
    return token;
  }

  async function listBrandGoods({ brandSno, minPrice = null, maxPrice = null, lastSno = null, limit = PAGE_LIMIT }) {
    const url = listUrl({ brandSno, minPrice, maxPrice, lastSno, limit });
    let refreshed = false;
    let lastStatus;
    let lastMessage = 'unknown error';

    for (let attempt = 0; attempt <= MAX_RETRIES; ) {
      if (listRequests++ > 0) await sleep(delayMs);
      if (!token) await fetchToken();

      let res;
      try {
        res = await fetchFn(url, {
          headers: {
            'User-Agent': USER_AGENT,
            'X-Anonymous-Token': token,
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

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        token = null;
        continue;
      }
      if (res.ok) {
        const body = await res.json();
        return {
          totalCount: Number(body.total_count) || 0,
          entries: Array.isArray(body.goods_list) ? body.goods_list : [],
          lastSno: body.last_sno ?? null,
        };
      }

      lastStatus = res.status;
      lastMessage = `HTTP ${res.status}`;
      if (!(res.status === 429 || res.status >= 500) || attempt === MAX_RETRIES) break;
      await sleep(retryBaseMs * 2 ** attempt++);
    }

    throw httpError(`4910 brand ${brandSno} list failed: ${lastMessage}`, lastStatus);
  }

  return { listBrandGoods };
}
