import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMusinsaClient, scanCategory, toListingRow, anonCall, CATEGORIES_MUSINSA, DEPTH_PAGES, REQUEST_TIMEOUT_MS, PLP_API, PLP_PAGE_SIZE, ALL_CATEGORIES_PARAM, ANON_RETRY_BACKOFF_MS } from '../src/musinsaWide/client.js';

const noSleep = async () => {};
const item = (n, extra = {}) => ({
  goodsNo: n, goodsName: `g${n}`, goodsLinkUrl: `https://www.musinsa.com/products/${n}`, thumbnail: `//img/${n}.jpg`,
  isSoldOut: false, normalPrice: 20000, price: 15000, couponPrice: 14000, extraDiscountAmount: 500, finalPrice: 14500,
  brand: 'brandx', brandName: 'Brand X', reviewCount: 10, ...extra,
});
const htmlPage = (items, pagination) => ({
  ok: true,
  status: 200,
  text: async () => `<script id="__NEXT_DATA__">${JSON.stringify({
    props: { pageProps: { dehydratedState: { queries: [{ queryKey: ['x'], state: { data: { pages: [{ data: { list: items, pagination } }] } } }] } } },
  })}</script>`,
});
const jsonPage = (items, pagination) => ({ ok: true, status: 200, json: async () => ({ data: { list: items, pagination } }) });
const failRes = (status) => ({ ok: false, status });

// First request is the HTML page; later ones are the plp JSON API (url contains /api2/dp/v2/plp/goods).
function chainFetch(pages) {
  const urls = [];
  const fn = async (url) => {
    urls.push(url);
    const idx = urls.length - 1;
    const p = pages[Math.min(idx, pages.length - 1)];
    return typeof p === 'function' ? p() : p;
  };
  fn.urls = urls;
  return fn;
}
const NEXT = (n) => `/api2/dp/v2/plp/goods?page=${n}&sortCode=REVIEW&gf=A&category=001`;

test('constants', () => {
  assert.deepEqual(CATEGORIES_MUSINSA, ['001', '002', '003', '103', '004']);
  assert.equal(DEPTH_PAGES, 100);
});

test('scanCategory follows nextPageUrl and stops at maxPages as complete', async () => {
  const fetchFn = chainFetch([
    htmlPage([item(1), item(2)], { hasNext: true, nextPageUrl: NEXT(2) }),
    jsonPage([item(3)], { hasNext: true, nextPageUrl: NEXT(3) }),
    jsonPage([item(4)], { hasNext: false }),
  ]);
  const client = createMusinsaClient({ fetchFn, sleep: noSleep });
  const res = await scanCategory(client, '001', { maxPages: 2 });
  assert.equal(res.pages, 2);
  assert.equal(res.complete, true);
  assert.deepEqual([...res.rows.keys()], [1, 2, 3]);
  assert.equal(fetchFn.urls.length, 2);
});

test('scanCategory reaches the end of the chain as complete', async () => {
  const fetchFn = chainFetch([
    htmlPage([item(1)], { hasNext: true, nextPageUrl: NEXT(2) }),
    jsonPage([item(2)], { hasNext: false, nextPageUrl: NEXT(3) }),
  ]);
  const res = await scanCategory(createMusinsaClient({ fetchFn, sleep: noSleep }), '001');
  assert.equal(res.pages, 2);
  assert.equal(res.complete, true);
  assert.deepEqual(res.problems, []);
});

test('scanCategory requests the REVIEW first page and never builds page URLs', async () => {
  const fetchFn = chainFetch([
    htmlPage([item(1)], { hasNext: true, nextPageUrl: NEXT(2) }),
    jsonPage([item(2)], { hasNext: true, nextPageUrl: NEXT(3) }),
    jsonPage([item(3)], { hasNext: false }),
  ]);
  await scanCategory(createMusinsaClient({ fetchFn, sleep: noSleep }), '103');
  assert.equal(fetchFn.urls[0], 'https://www.musinsa.com/categories/item/103?gf=A&sortCode=REVIEW');
  assert.equal(fetchFn.urls[1], `https://api.musinsa.com${NEXT(2)}`);
  assert.equal(fetchFn.urls[2], `https://api.musinsa.com${NEXT(3)}`);
});

test('scanCategory skips items without goodsNo', async () => {
  const fetchFn = chainFetch([htmlPage([item(1), { goodsName: 'banner tile' }, item(2)], { hasNext: false })]);
  const res = await scanCategory(createMusinsaClient({ fetchFn, sleep: noSleep }), '001');
  assert.deepEqual([...res.rows.keys()], [1, 2]);
});

test('a page that keeps failing ends the category incomplete with a problem', async () => {
  const sleeps = [];
  const fetchFn = chainFetch([
    htmlPage([item(1)], { hasNext: true, nextPageUrl: NEXT(2) }),
    failRes(403),
  ]);
  const client = createMusinsaClient({ fetchFn, pageDelayMs: 300, sleep: async (ms) => sleeps.push(ms) });
  const res = await scanCategory(client, '001');
  assert.equal(res.complete, false);
  assert.equal(res.pages, 1);
  assert.deepEqual([...res.rows.keys()], [1]);
  assert.equal(res.problems.length, 1);
  assert.match(res.problems[0], /403/);
  assert.equal(fetchFn.urls.length, 4); // page 1 + 3 attempts at page 2
  assert.deepEqual(sleeps.filter((ms) => ms >= 2000), [2000, 4000]);
});

test('a page recovers on retry', async () => {
  let n = 0;
  const fetchFn = chainFetch([
    htmlPage([item(1)], { hasNext: true, nextPageUrl: NEXT(2) }),
    () => (n++ === 0 ? failRes(500) : jsonPage([item(2)], { hasNext: false })),
  ]);
  const res = await scanCategory(createMusinsaClient({ fetchFn, sleep: noSleep }), '001');
  assert.equal(res.complete, true);
  assert.deepEqual([...res.rows.keys()], [1, 2]);
});

test('an empty page that still has nextPageUrl counts as a failure', async () => {
  const fetchFn = chainFetch([htmlPage([], { hasNext: true, nextPageUrl: NEXT(2) })]);
  const res = await scanCategory(createMusinsaClient({ fetchFn, sleep: noSleep }), '001');
  assert.equal(res.complete, false);
  assert.equal(res.pages, 0);
  assert.equal(res.problems.length, 1);
});

test('an empty first page without a next page is incomplete, not an empty complete scan', async () => {
  const sleeps = [];
  const fetchFn = chainFetch([htmlPage([], { hasNext: false })]);
  const client = createMusinsaClient({ fetchFn, sleep: async (ms) => sleeps.push(ms) });
  const res = await scanCategory(client, '001');
  assert.equal(res.complete, false);
  assert.equal(res.pages, 0);
  assert.equal(res.rows.size, 0);
  assert.equal(res.problems.length, 1);
  assert.match(res.problems[0], /empty first page/);
  assert.equal(fetchFn.urls.length, 3);
  assert.deepEqual(sleeps.filter((ms) => ms >= 2000), [2000, 4000]);
});

test('scanCategory past the deadline is incomplete', async () => {
  const fetchFn = chainFetch([htmlPage([item(1)], { hasNext: true, nextPageUrl: NEXT(2) }), jsonPage([item(2)], { hasNext: false })]);
  let t = 1000;
  const res = await scanCategory(createMusinsaClient({ fetchFn, sleep: noSleep }), '001', { deadline: 1500, now: () => (t += 400) });
  assert.equal(res.complete, false);
  assert.equal(res.pages, 1);
  assert.ok(res.problems.some((p) => p.includes('deadline')));
});

test('toListingRow maps listing fields', () => {
  assert.deepEqual(toListingRow(item(7, { isSoldOut: true, extraDiscountAmount: undefined }), '002'), {
    goods_no: 7, cat: '002', brand: 'brandx', brand_name: 'Brand X', name: 'g7',
    url: 'https://www.musinsa.com/products/7', image_url: '//img/7.jpg',
    sale_price: 15000, normal_price: 20000, extra_discount: 0, is_sold_out: 1, review_count: 10,
  });
  assert.equal(toListingRow(item(8, { goodsLinkUrl: undefined }), '002').url, 'https://www.musinsa.com/products/8');
  assert.equal(toListingRow({ goodsName: 'x' }, '002'), null);
});

test('toListingRow defaults a missing name to an empty string', () => {
  assert.equal(toListingRow(item(9, { goodsName: undefined }), '001').name, '');
  assert.equal(toListingRow(item(9, { goodsName: null }), '001').name, '');
});

test('every request, category pages and the coupon call, carries a timeout signal', async () => {
  assert.equal(REQUEST_TIMEOUT_MS, 30_000);
  const seen = [];
  const fetchFn = async (url, opts) => {
    seen.push(opts?.signal);
    if (String(url).includes('getUsableCouponsByGoodsNo')) {
      return { ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => ({ data: { list: [] } }) };
    }
    return htmlPage([item(1)], { hasNext: false });
  };
  const client = createMusinsaClient({ fetchFn, sleep: noSleep });
  await client.getCategoryPage('001');
  await client.getUsableCoupons({ goodsNo: 1, brand: 'b', salePrice: 1 }, 'c=1');
  assert.equal(seen.length, 2);
  for (const signal of seen) assert.ok(signal instanceof AbortSignal);
});

test('getUsableCoupons sends the cookie, passes Set-Cookie on, and maps 401 to MEMBER_AUTH without the cookie in the message', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) {
      return { ok: true, status: 200, headers: { getSetCookie: () => ['a=1; Path=/'] }, json: async () => ({ data: { list: [{ couponNo: 1 }] } }) };
    }
    return { ok: false, status: 401, headers: { getSetCookie: () => [] } };
  };
  const client = createMusinsaClient({ fetchFn, sleep: noSleep });
  const got = [];
  const list = await client.getUsableCoupons({ goodsNo: 55, brand: 'brandx', salePrice: 15000 }, 'SECRET=cookie', { onSetCookie: (c) => got.push(...c) });
  assert.deepEqual(list, [{ couponNo: 1 }]);
  assert.deepEqual(got, ['a=1; Path=/']);
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://api.musinsa.com/api2/coupon/coupons/getUsableCouponsByGoodsNo');
  assert.equal(u.searchParams.get('goodsNo'), '55');
  assert.equal(u.searchParams.get('brand'), 'brandx');
  assert.equal(u.searchParams.get('comId'), 'brandx');
  assert.equal(u.searchParams.get('salePrice'), '15000');
  assert.equal(u.searchParams.has('specialtyCodes'), false);
  assert.equal(calls[0].opts.headers.Cookie, 'SECRET=cookie');
  assert.equal(calls[0].opts.headers.Referer, 'https://www.musinsa.com/');
  assert.ok(calls[0].opts.headers['User-Agent']);

  await assert.rejects(
    client.getUsableCoupons({ goodsNo: 55, brand: 'brandx', salePrice: 15000 }, 'SECRET=cookie'),
    (err) => err.code === 'MEMBER_AUTH' && !err.message.includes('SECRET') && !String(err.stack).includes('SECRET=cookie')
  );
});

test('getUsableCoupons throws a 429 with err.status 429 and no retry', async () => {
  let n = 0;
  const fetchFn = async () => { n++; return { ok: false, status: 429, headers: { getSetCookie: () => [] } }; };
  const client = createMusinsaClient({ fetchFn, sleep: noSleep });
  await assert.rejects(client.getUsableCoupons({ goodsNo: 1, brand: 'b', salePrice: 1 }, 'c=1'), (err) => err.status === 429 && err.code !== 'MEMBER_AUTH');
  assert.equal(n, 1);
});

test('getUsableCoupons rejects a response without data.list', async () => {
  const fetchFn = async () => ({ ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => ({ data: {} }) });
  const client = createMusinsaClient({ fetchFn, sleep: noSleep });
  await assert.rejects(client.getUsableCoupons({ goodsNo: 1, brand: 'b', salePrice: 1 }, 'c=1'), /Unexpected coupon API response/);
});

test('coupon calls are spaced by couponDelayMs after the first', async () => {
  const sleeps = [];
  const fetchFn = async () => ({ ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => ({ data: { list: [] } }) });
  const client = createMusinsaClient({ fetchFn, couponDelayMs: 700, sleep: async (ms) => sleeps.push(ms) });
  await client.getUsableCoupons({ goodsNo: 1, brand: 'b', salePrice: 1 }, 'c');
  await client.getUsableCoupons({ goodsNo: 2, brand: 'b', salePrice: 1 }, 'c');
  assert.deepEqual(sleeps, [700]);
});

test('plp constants', () => {
  assert.equal(PLP_API, 'https://api.musinsa.com/api2/coupon/plp/v1/goods');
  assert.equal(PLP_PAGE_SIZE, 300);
  assert.equal(ALL_CATEGORIES_PARAM, '001,002,003,103,004');
  assert.deepEqual(ANON_RETRY_BACKOFF_MS, [2000, 4000]);
});

test('getCouponGoodsCount builds the count URL without a cookie', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ data: 42 }) };
  };
  const client = createMusinsaClient({ fetchFn, sleep: noSleep });
  assert.equal(await client.getCouponGoodsCount(360001), 42);
  assert.ok(calls[0].url.startsWith(`${PLP_API}/count?`));
  assert.equal(calls[0].url.slice(calls[0].url.indexOf('?') + 1), 'couponNo=360001&couponKind=PRODUCT&caller=COUPON&gf=A&category=001%2C002%2C003%2C103%2C004');
  const headers = calls[0].opts.headers;
  assert.equal(Object.keys(headers).some((k) => k.toLowerCase() === 'cookie'), false);
  assert.equal(headers.Referer, 'https://www.musinsa.com/');
  assert.ok(headers['User-Agent']);
});

test('getCouponGoodsCount rejects a non-numeric data and honours the category option', async () => {
  const urls = [];
  const fetchFn = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => ({ data: { oops: 1 } }) }; };
  const client = createMusinsaClient({ fetchFn, sleep: noSleep });
  await assert.rejects(client.getCouponGoodsCount(5, { category: '001' }), /Unexpected coupon goods count response/);
  assert.equal(new URL(urls[0]).searchParams.get('category'), '001');
});

test('getCouponGoodsPage asks sortCode=REVIEW size=300 and maps items', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        meta: { result: 'SUCCESS' },
        data: { list: [{ goodsNo: '7', reviewCount: 10, isSoldOut: false }], pagination: { totalCount: 1, hasNext: false } },
      }),
    };
  };
  const client = createMusinsaClient({ fetchFn, sleep: noSleep });
  const got = await client.getCouponGoodsPage(360001, { page: 2 });
  assert.deepEqual(got, { items: [{ goodsNo: 7, reviewCount: 10, isSoldOut: false }], totalCount: 1, hasNext: false });
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, PLP_API);
  assert.equal(u.searchParams.get('couponNo'), '360001');
  assert.equal(u.searchParams.get('sortCode'), 'REVIEW');
  assert.equal(u.searchParams.get('size'), '300');
  assert.equal(u.searchParams.get('page'), '2');
  assert.equal(u.searchParams.get('category'), '001,002,003,103,004');
  assert.equal(Object.keys(calls[0].opts.headers).some((k) => k.toLowerCase() === 'cookie'), false);
});

test('getCouponGoodsPage defaults to page 1, nulls a missing reviewCount, and rejects a bad response', async () => {
  let body = { meta: { result: 'SUCCESS' }, data: { list: [{ goodsNo: 8, isSoldOut: true }], pagination: { totalCount: 1, hasNext: true } } };
  const urls = [];
  const fetchFn = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => body }; };
  const client = createMusinsaClient({ fetchFn, sleep: noSleep });
  assert.deepEqual(await client.getCouponGoodsPage(1), { items: [{ goodsNo: 8, reviewCount: null, isSoldOut: true }], totalCount: 1, hasNext: true });
  assert.equal(new URL(urls[0]).searchParams.get('page'), '1');
  body = { meta: { result: 'FAIL' }, data: { list: [] } };
  await assert.rejects(client.getCouponGoodsPage(1), /Unexpected coupon goods list response/);
  body = { meta: { result: 'SUCCESS' }, data: {} };
  await assert.rejects(client.getCouponGoodsPage(1), /Unexpected coupon goods list response/);
});

test('anonymous calls are spaced by anonDelayMs and carry a timeout signal', async () => {
  const sleeps = [];
  const seen = [];
  const fetchFn = async (url, opts) => {
    seen.push(opts?.signal);
    if (String(url).includes('/count?')) return { ok: true, status: 200, json: async () => ({ data: 1 }) };
    return { ok: true, status: 200, json: async () => ({ meta: { result: 'SUCCESS' }, data: { list: [], pagination: { totalCount: 0, hasNext: false } } }) };
  };
  const client = createMusinsaClient({ fetchFn, anonDelayMs: 500, sleep: async (ms) => sleeps.push(ms) });
  await client.getCouponGoodsCount(1);
  assert.deepEqual(sleeps, []);
  await client.getCouponGoodsPage(1);
  assert.deepEqual(sleeps, [500]);
  assert.equal(seen.length, 2);
  for (const signal of seen) assert.ok(signal instanceof AbortSignal);
});

test('anon 429 throws err.status 429; anonCall does not retry it', async () => {
  let n = 0;
  const fetchFn = async () => { n++; return { ok: false, status: 429 }; };
  const client = createMusinsaClient({ fetchFn, sleep: noSleep });
  await assert.rejects(client.getCouponGoodsCount(1), (err) => err.status === 429);
  assert.equal(n, 1);
  const sleeps = [];
  await assert.rejects(anonCall(() => client.getCouponGoodsCount(1), { sleep: async (ms) => sleeps.push(ms) }), (err) => err.status === 429);
  assert.equal(n, 2);
  assert.deepEqual(sleeps, []);
});

test('anonCall retries a 503 after 2000 then 4000 ms and gives up after 3 attempts', async () => {
  const fetchFn = (() => { let n = 0; return async () => { n++; return { ok: false, status: 503, n }; }; })();
  const client = createMusinsaClient({ fetchFn, anonDelayMs: 0, sleep: noSleep });
  const sleeps = [];
  let attempts = 0;
  await assert.rejects(
    anonCall(() => { attempts++; return client.getCouponGoodsCount(1); }, { sleep: async (ms) => sleeps.push(ms) }),
    (err) => err.status === 503
  );
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [2000, 4000]);
});

test('anonCall returns the result once a retry succeeds', async () => {
  let n = 0;
  const sleeps = [];
  const got = await anonCall(async () => { if (++n < 2) throw new Error('boom'); return 'ok'; }, { sleep: async (ms) => sleeps.push(ms) });
  assert.equal(got, 'ok');
  assert.deepEqual(sleeps, [2000]);
});

test('toListingRow keeps reviewCount as review_count', () => {
  assert.equal(toListingRow(item(1, { reviewCount: 1234 }), '001').review_count, 1234);
  assert.equal(toListingRow(item(2, { reviewCount: undefined }), '001').review_count, null);
});

const taxonomyPage = (roots) => ({ ok: true, status: 200, text: async () => `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { dehydratedState: { queries: [{ queryKey: ['category/Category'], state: { data: { data: { list: roots } } } }] } } } })}</script>` });
test('getCategoryPartitions reads immediate children of matching taxonomy root', async () => {
  const client = createMusinsaClient({ fetchFn: async () => taxonomyPage([{ categoryCode: '001', categoryList: [
    { categoryCode: '001001', parentCategoryCode: '001', categoryList: [{ categoryCode: '001001001' }] },
    { categoryCode: '001002', parentCategoryCode: '001' },
  ] }]), sleep: noSleep });
  assert.deepEqual(await client.getCategoryPartitions('001'), [{ code: '001001', root: '001' }, { code: '001002', root: '001' }]);
});
test('getCategoryPartitions rejects missing, empty, mismatched and malformed taxonomy', async () => {
  for (const roots of [[], [{ categoryCode: '002', categoryList: [] }], [{ categoryCode: '001', categoryList: [] }], [{ categoryCode: '001', categoryList: [{ categoryCode: '002001', parentCategoryCode: '002' }] }]]) {
    await assert.rejects(createMusinsaClient({ fetchFn: async () => taxonomyPage(roots) }).getCategoryPartitions('001'), /taxonomy/i);
  }
  await assert.rejects(createMusinsaClient({ fetchFn: async () => htmlPage([], {}) }).getCategoryPartitions('001'), /taxonomy/i);
});
test('category page preserves throttling status and rejects missing JSON list or cursor', async () => {
  await assert.rejects(createMusinsaClient({ fetchFn: async () => failRes(429), sleep: noSleep }).getCategoryPage('001'), err => err.status === 429);
  await assert.rejects(createMusinsaClient({ fetchFn: async () => ({ ok: true, json: async () => ({ data: { pagination: { hasNext: false } } }) }), sleep: noSleep }).getCategoryPage('001', NEXT(2)), /malformed/);
  await assert.rejects(createMusinsaClient({ fetchFn: async () => jsonPage([item(1)], { hasNext: true }), sleep: noSleep }).getCategoryPage('001', NEXT(2)), /cursor/);
});
