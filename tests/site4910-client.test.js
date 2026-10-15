import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRow, createClient } from '../src/site4910/client.js';

const brand = { sno: 2421, name: '유니클로' };

// Trimmed from a live 2026-10-10 response of the aglo brand goods API.
const fixtureEntry = {
  item: { sno: 71863924, name: '[~10/15 한정특가]유니클로 에어리즘 코튼 크루넥 티셔츠 479781 486102', market_sno: 42296 },
  logging: {
    analytics: {
      MARKET_NAME: '모에모에',
      STANDARD_CATEGORY_NAME: '긴소매티셔츠',
      DISCOUNT_RATE: 57,
      SALES_PRICE: 21600,
      BRAND_SNO: 2421,
      MARKET_TYPE_SNO: '16',
    },
  },
  render: {
    data: {
      image: { url: 'https://d3ha2047wt6x28.cloudfront.net/x' },
      price: '21,600',
      closed_reason: null,
      original_price: '51,300',
    },
  },
};

const withRender = (entry, patch) => ({ ...entry, render: { ...entry.render, data: { ...entry.render.data, ...patch } } });

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Answers token calls from `tokens` and list calls from `lists`, recording every request.
function fakeFetch({ tokens = ['tok-1'], lists }) {
  const calls = [];
  let t = 0;
  let l = 0;
  const fn = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers ?? {} });
    if (url.includes('/anonymous/token/')) return json(200, { token: tokens[Math.min(t++, tokens.length - 1)] });
    const next = lists[Math.min(l++, lists.length - 1)];
    return typeof next === 'function' ? next() : next;
  };
  return { fn, calls };
}

const page = (overrides = {}) => json(200, { total_count: 10529, goods_list: [fixtureEntry], last_sno: 70238284, ...overrides });

test('toRow maps a listing entry', () => {
  const row = toRow(fixtureEntry, brand);
  assert.deepEqual(row, {
    sno: 71863924, brand_sno: 2421, brand: '유니클로',
    name: '[~10/15 한정특가]유니클로 에어리즘 코튼 크루넥 티셔츠 479781 486102',
    market_sno: 42296, market_type_sno: 16, market_name: '모에모에', category: '긴소매티셔츠',
    sale_price: 21600, original_price: 51300, discount_rate: 57,
    image_url: 'https://d3ha2047wt6x28.cloudfront.net/x', url: 'https://4910.kr/goods/71863924', closed: false,
  });
});

test('toRow uses sale_price when original_price is null and flags closed_reason', () => {
  const row = toRow(withRender(fixtureEntry, { original_price: null, closed_reason: 'SOLD_OUT' }), brand);
  assert.equal(row.original_price, 21600);
  assert.equal(row.closed, true);
});

test('toRow gives a null sale_price when SALES_PRICE is missing', () => {
  const entry = { ...fixtureEntry, logging: { analytics: { ...fixtureEntry.logging.analytics, SALES_PRICE: undefined } } };
  const row = toRow(entry, brand);
  assert.equal(row.sale_price, null);
  assert.equal(row.original_price, 51300);
  assert.equal(toRow(withRender(entry, { original_price: null }), brand).original_price, null);
});

test('listBrandGoods fetches a token once and sends the 4910 headers', async () => {
  const { fn, calls } = fakeFetch({ lists: [page(), page()] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  await client.listBrandGoods({ brandSno: 2421 });
  const result = await client.listBrandGoods({ brandSno: 2421, minPrice: 0, maxPrice: 99999, lastSno: 46249290 });

  assert.equal(calls.filter((c) => c.url.includes('/anonymous/token/')).length, 1);
  assert.equal(calls[1].headers['X-Anonymous-Token'], 'tok-1');
  assert.equal(calls[1].headers.Origin, 'https://4910.kr');
  assert.equal(calls[1].headers.Referer, 'https://4910.kr/');
  assert.equal(calls[1].url, 'https://api.a-bly.com/aglo/api/brands/2421/goods/?brand=2421&member_gender=ALL&sorting_type=NEW&limit=500');
  assert.equal(
    calls[2].url,
    'https://api.a-bly.com/aglo/api/brands/2421/goods/?brand=2421&member_gender=ALL&sorting_type=NEW&limit=500&min_price=0&max_price=99999&last_sno=46249290'
  );
  assert.deepEqual(result, { totalCount: 10529, entries: [fixtureEntry], lastSno: 70238284 });
});

test('listBrandGoods refreshes the token once on 401', async () => {
  const { fn, calls } = fakeFetch({ tokens: ['tok-1', 'tok-2'], lists: [json(401, { detail: 'no' }), page()] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  const result = await client.listBrandGoods({ brandSno: 2421 });

  assert.equal(calls.filter((c) => c.url.includes('/anonymous/token/')).length, 2);
  assert.equal(calls.at(-1).headers['X-Anonymous-Token'], 'tok-2');
  assert.equal(result.totalCount, 10529);
});

test('listBrandGoods retries 429/5xx three times then throws with status', async () => {
  const { fn, calls } = fakeFetch({ lists: [json(429, {}), json(503, {}), json(503, {}), json(503, {})] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  await assert.rejects(client.listBrandGoods({ brandSno: 2421 }), (e) => e.status === 503);
  const listCalls = calls.filter((c) => c.url.includes('/goods/'));
  assert.equal(listCalls.length, 4);
});

test('the token request retries a 5xx or a network error', async () => {
  let tokenCalls = 0;
  const fn = async (url) => {
    if (url.includes('/anonymous/token/')) {
      tokenCalls++;
      if (tokenCalls === 1) throw new TypeError('fetch failed');
      if (tokenCalls === 2) return json(502, {});
      return json(200, { token: 'tok-3' });
    }
    return page();
  };
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  const result = await client.listBrandGoods({ brandSno: 2421 });
  assert.equal(tokenCalls, 3);
  assert.equal(result.totalCount, 10529);
});

test('a 403 on the token request fails at once without retrying', async () => {
  let tokenCalls = 0;
  const fn = async () => {
    tokenCalls++;
    return new Response('<html>blocked</html>', { status: 403 });
  };
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  await assert.rejects(client.getToken(), (e) => e.status === 403);
  assert.equal(tokenCalls, 1);
});

const detailBody = (goodsPatch = {}) => ({
  goods: {
    price: 18360,
    price_description: { text: '쿠폰적용가' },
    first_page_rendering: { price: 21600 },
    linked_option: { sno: 430713077, original_price: 51300 },
    is_soldout: false,
    is_open: true,
    ...goodsPatch,
  },
});

test('getGoodsDetail maps the anonymous detail', async () => {
  const { fn, calls } = fakeFetch({ lists: [json(200, detailBody())] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  assert.deepEqual(await client.getGoodsDetail(71863924), {
    sno: 71863924, priceBasis: 'AGLO', price: 18360, couponPrice: 18360, listPrice: 21600, originalPrice: 51300, optionSno: 430713077, isSoldout: false, isOpen: true,
  });
  assert.equal(calls.at(-1).url, 'https://api.a-bly.com/api/v2/goods/71863924/');
  assert.equal(calls.at(-1).headers['X-Anonymous-Token'], 'tok-1');
  assert.equal(calls.at(-1).headers.Authorization, undefined);
});

test('getGoodsDetail gives couponPrice null without the 쿠폰적용가 label', async () => {
  const { fn } = fakeFetch({ lists: [json(200, detailBody({ price_description: null }))] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  const detail = await client.getGoodsDetail(1);
  assert.equal(detail.couponPrice, null);
  assert.equal(detail.price, 18360);
});

test('member calls send only Authorization: JWT and fetch no anonymous token', async () => {
  const { fn, calls } = fakeFetch({ lists: [json(200, detailBody())] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  await client.getGoodsDetail(1, { memberToken: 'mem-tok' });
  assert.equal(calls.filter((c) => c.url.includes('/anonymous/token/')).length, 0);
  assert.equal(calls[0].headers.Authorization, 'JWT mem-tok');
  assert.equal(calls[0].headers['X-Anonymous-Token'], undefined);
  assert.equal(calls[0].headers.Origin, 'https://4910.kr');
  assert.equal(calls[0].headers.Referer, 'https://4910.kr/');
  assert.equal(calls[0].headers.Accept, 'application/json');
});

test('a member 401 or 403 rejects with MEMBER_AUTH and no retry', async () => {
  for (const status of [401, 403]) {
    const { fn, calls } = fakeFetch({ lists: [json(status, { detail: 'no' })] });
    const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
    await assert.rejects(client.getGoodsDetail(1, { memberToken: 'secret-tok' }), (e) => {
      assert.equal(e.code, 'MEMBER_AUTH');
      assert.equal(e.status, status);
      assert.ok(!e.message.includes('secret-tok'));
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('listLikedGoods pages with last_sno', async () => {
  const { fn, calls } = fakeFetch({
    lists: [json(200, { total_count: 1, goods_list: [fixtureEntry], last_sno: 5 }), json(200, { total_count: 1, goods_list: [], last_sno: null })],
  });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  const first = await client.listLikedGoods({ memberToken: 'mem-tok' });
  const second = await client.listLikedGoods({ memberToken: 'mem-tok', lastSno: first.lastSno });
  assert.equal(calls[0].url, 'https://api.a-bly.com/aglo/api/members/me/liked-goods/?limit=100');
  assert.equal(calls[1].url, 'https://api.a-bly.com/aglo/api/members/me/liked-goods/?limit=100&last_sno=5');
  assert.equal(calls[0].headers.Authorization, 'JWT mem-tok');
  assert.deepEqual(first, { entries: [fixtureEntry], lastSno: 5 });
  assert.deepEqual(second, { entries: [], lastSno: null });
});

test('a member 503 is retried like the list call', async () => {
  const { fn, calls } = fakeFetch({ lists: [json(503, {}), json(200, detailBody())] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  const detail = await client.getGoodsDetail(1, { memberToken: 't' });
  assert.equal(detail.price, 18360);
  assert.equal(calls.length, 2);
});

test('getGoodsDetail gives optionSno null without a linked option', async () => {
  const { fn } = fakeFetch({ lists: [json(200, detailBody({ linked_option: null }))] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  const detail = await client.getGoodsDetail(1);
  assert.equal(detail.optionSno, null);
  assert.equal(detail.originalPrice, null);
});

test('toRow gives a null market_type_sno when MARKET_TYPE_SNO is missing', () => {
  const entry = { ...fixtureEntry, logging: { analytics: { ...fixtureEntry.logging.analytics, MARKET_TYPE_SNO: undefined } } };
  assert.equal(toRow(entry, brand).market_type_sno, null);
});

test('listTopBrands pages the ranking anonymously', async () => {
  const body = { brand_list: [{ sno: 2421, name: '유니클로', extra: 'x' }], total_count: 1000, last_sno: 500 };
  const { fn, calls } = fakeFetch({ lists: [json(200, body), json(200, body)] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  const first = await client.listTopBrands({});
  const second = await client.listTopBrands({ lastSno: 500 });
  assert.equal(calls[1].url, 'https://api.a-bly.com/aglo/api/brands/ranking/?limit=100');
  assert.equal(calls[2].url, 'https://api.a-bly.com/aglo/api/brands/ranking/?limit=100&last_sno=500');
  assert.equal(calls[1].headers['X-Anonymous-Token'], 'tok-1');
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.deepEqual(first, { brands: [{ sno: 2421, name: '유니클로' }], lastSno: 500 });
  assert.equal(second.lastSno, 500);
});

test('listTopBrands tolerates an empty page', async () => {
  const { fn } = fakeFetch({ lists: [json(200, {})] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  assert.deepEqual(await client.listTopBrands({ limit: 10 }), { brands: [], lastSno: null });
});

test('getMarket maps satisfaction and a null reviews_count', async () => {
  const body = { market: { sno: 56293, name: 'LUXURYJP', purchasing_satisfaction_ratio: 96.9, reviews_count: null, is_official: false } };
  const { fn, calls } = fakeFetch({ lists: [json(200, body)] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  assert.deepEqual(await client.getMarket(56293), { sno: 56293, name: 'LUXURYJP', satisfaction: 96.9, reviewsCount: null, isOfficial: false });
  assert.equal(calls.at(-1).url, 'https://api.a-bly.com/api/v2/markets/56293/');
  assert.equal(calls.at(-1).headers['X-Anonymous-Token'], 'tok-1');
});

test('getMarket throws when the response has no market object', async () => {
  for (const body of [{}, { market: null }, { detail: 'not found' }]) {
    const { fn } = fakeFetch({ lists: [json(200, body)] });
    const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
    await assert.rejects(client.getMarket(56293), /market 56293 failed: no market in response/);
  }
});

const couponItem = (patch = {}) => ({
  coupon_sno: 51346850,
  coupon_name: '[4910] 첫구매 20% 쿠폰',
  discount_type: 'PERCENT',
  discount_percent: 20,
  discount_price: null,
  max_discount_price: 30000,
  conditions: ['…', '10,000원 이상 구매 시 최대 30,000원 할인'],
  is_usable: true,
  is_in_available_period: true,
  finished_at: '2026-10-31T23:59:59',
  ...patch,
});

test('getMyCoupons sends AGLO headers and parses min/max', async () => {
  const { fn, calls } = fakeFetch({ lists: [json(200, { coupon_apply_list: [couponItem()] })] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  const coupons = await client.getMyCoupons({ memberToken: 'SECRET' });
  assert.equal(calls[0].url, 'https://api.a-bly.com/aglo/api/members/me/coupons/');
  assert.equal(calls[0].headers['X-App-Type'], 'AGLO');
  assert.equal(calls[0].headers['X-App-Version'], '0.1.0');
  assert.equal(calls[0].headers['X-Device-Type'], 'PCWeb');
  assert.equal(calls[0].headers.Authorization, 'JWT SECRET');
  assert.equal(calls[0].headers['X-Anonymous-Token'], undefined);
  assert.deepEqual(coupons, [{
    couponSno: 51346850, name: '[4910] 첫구매 20% 쿠폰', type: 'PERCENT', percent: 20, price: null, max: 30000, min: 10000,
    finishedAt: '2026-10-31T23:59:59', usable: true, conditions: ['…', '10,000원 이상 구매 시 최대 30,000원 할인'], hasTargets: null, appOnly: false,
  }]);
});

test('getMyCoupons maps a fixed-price coupon with no cap or minimum, and unusable states', async () => {
  const items = [
    couponItem({ discount_type: 'PRICE', discount_percent: null, discount_price: 3000, max_discount_price: null, conditions: [], coupon_sno: 1 }),
    couponItem({ coupon_sno: 2, is_in_available_period: false }),
    couponItem({ coupon_sno: 3, is_usable: false }),
  ];
  const { fn } = fakeFetch({ lists: [json(200, { coupon_apply_list: items })] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  const [fixed, outOfPeriod, notUsable] = await client.getMyCoupons({ memberToken: 't' });
  assert.deepEqual(
    { type: fixed.type, percent: fixed.percent, price: fixed.price, max: fixed.max, min: fixed.min, usable: fixed.usable },
    { type: 'PRICE', percent: null, price: 3000, max: Infinity, min: 0, usable: true }
  );
  assert.equal(outOfPeriod.usable, false);
  assert.equal(notUsable.usable, false);
});

test('getMyCoupons returns an empty list when coupon_apply_list is absent', async () => {
  const { fn } = fakeFetch({ lists: [json(200, {})] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  assert.deepEqual(await client.getMyCoupons({ memberToken: 't' }), []);
});

test('a 403 on getMyCoupons rejects with MEMBER_AUTH', async () => {
  const { fn, calls } = fakeFetch({ lists: [json(403, { detail: 'no' })] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  await assert.rejects(client.getMyCoupons({ memberToken: 'secret-tok' }), (e) => {
    assert.equal(e.code, 'MEMBER_AUTH');
    assert.equal(e.status, 403);
    assert.ok(!e.message.includes('secret-tok'));
    return true;
  });
  assert.equal(calls.length, 1);
});

test('getMe returns only emoney', async () => {
  const { fn, calls } = fakeFetch({ lists: [json(200, { emoney: 3000, email: 'x', mobile: 'y' })] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  assert.deepEqual(await client.getMe({ memberToken: 'SECRET' }), { emoney: 3000 });
  assert.equal(calls[0].url, 'https://api.a-bly.com/aglo/api/members/me/');
  assert.equal(calls[0].headers['X-App-Type'], 'AGLO');
  assert.equal(calls[0].headers.Authorization, 'JWT SECRET');
});

test('getBestCoupon encodes options and returns null without a coupon', async () => {
  const best = {
    sno: 51346850, name: '[4910] 첫구매 20% 쿠폰', discount_type: 'PERCENT', discount_price: null, discount_percent: 20,
    max_discount_price: 30000, minimum_price: 10000, coupon_discount: 17080,
  };
  const { fn, calls } = fakeFetch({ lists: [json(200, { best_coupon: best, is_applied: false }), json(200, { best_coupon: null, is_applied: false })] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  const result = await client.getBestCoupon(430713077, { memberToken: 'SECRET' });
  assert.ok(calls[0].url.includes('options=%5B%7B%22sno%22%3A430713077%2C%22ea%22%3A1%7D%5D'));
  assert.ok(calls[0].url.startsWith('https://api.a-bly.com/aglo/api/coupons/best-coupon?'));
  assert.equal(calls[0].headers['X-App-Type'], 'AGLO');
  assert.equal(calls[0].headers.Authorization, 'JWT SECRET');
  assert.deepEqual(result, {
    couponSno: 51346850, optionSno: 430713077, isApplied: false, name: '[4910] 첫구매 20% 쿠폰', discount: 17080, percent: 20, price: null, max: 30000, min: 10000,
  });
  assert.equal(await client.getBestCoupon(430713077, { memberToken: 'SECRET' }), null);
});

test('getBestCoupon defaults an uncapped coupon to max Infinity and a missing minimum to null', async () => {
  const { fn } = fakeFetch({ lists: [json(200, { best_coupon: { sno: '7', name: 'n', discount_price: 2000, coupon_discount: 2000 } })] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  assert.deepEqual(await client.getBestCoupon(1, { memberToken: 't' }), {
    couponSno: 7, optionSno: 1, isApplied: null, name: 'n', discount: 2000, percent: null, price: 2000, max: Infinity, min: null,
  });
});

test('getBestCoupon throws when coupon_discount is missing or not a number', async () => {
  for (const coupon_discount of [undefined, null, 'abc']) {
    const { fn } = fakeFetch({ lists: [json(200, { best_coupon: { sno: 7, name: 'n', coupon_discount } })] });
    const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
    await assert.rejects(client.getBestCoupon(1, { memberToken: 'secret-tok' }), (e) => {
      assert.match(e.message, /best coupon 1 failed: no numeric coupon_discount/);
      assert.notEqual(e.code, 'MEMBER_AUTH');
      assert.ok(!e.message.includes('secret-tok'));
      return true;
    });
  }
});

test('getMyCoupons returns a numeric couponSno', async () => {
  const { fn } = fakeFetch({ lists: [json(200, { coupon_apply_list: [couponItem({ coupon_sno: '51346850' })] })] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  const [c] = await client.getMyCoupons({ memberToken: 't' });
  assert.equal(c.couponSno, 51346850);
});

test('getCouponGoodsPage pages a coupon\'s goods list with AGLO headers', async () => {
  const item = (sno) => ({ item: { sno, market_sno: 10 }, logging: {} });
  const { fn, calls } = fakeFetch({ lists: [
    json(200, { total_count: 924, goods_list: [item(1), item('2')], last_sno: 2 }),
    json(200, { total_count: 924, goods_list: [], last_sno: null }),
  ] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  assert.deepEqual(await client.getCouponGoodsPage(51301683, { memberToken: 'SECRET' }), { totalCount: 924, snos: [1, 2], lastSno: 2 });
  assert.equal(calls[0].url, 'https://api.a-bly.com/aglo/api/coupons/51301683/goods?limit=500');
  assert.equal(calls[0].headers['X-App-Type'], 'AGLO');
  assert.equal(calls[0].headers.Authorization, 'JWT SECRET');
  assert.equal(calls[0].headers['X-Anonymous-Token'], undefined);
  assert.deepEqual(await client.getCouponGoodsPage(51301683, { memberToken: 'SECRET', lastSno: 2, limit: 1 }), { totalCount: 924, snos: [], lastSno: null });
  assert.equal(calls[1].url, 'https://api.a-bly.com/aglo/api/coupons/51301683/goods?limit=1&last_sno=2');
});

test('getCouponCategories returns the category names', async () => {
  const { fn, calls } = fakeFetch({ lists: [json(200, { category_list: [{ sno: 702, name: '아우터', count: 108642 }, { sno: 738, name: '스포츠/레저', count: 12526 }] })] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  assert.deepEqual(await client.getCouponCategories(51345873, { memberToken: 'SECRET' }), ['아우터', '스포츠/레저']);
  assert.equal(calls[0].url, 'https://api.a-bly.com/aglo/api/coupons/51345873/categories');
  assert.equal(calls[0].headers['X-App-Type'], 'AGLO');
  assert.equal(calls[0].headers.Authorization, 'JWT SECRET');
});

test('coupon scope calls throw on a malformed body and reject a 401 with MEMBER_AUTH', async () => {
  const client = (body) => createClient({ fetchFn: fakeFetch({ lists: [json(200, body)] }).fn, delayMs: 0, retryBaseMs: 0 });
  await assert.rejects(client({ goods_list: [] }).getCouponGoodsPage(1, { memberToken: 't' }), /coupon 1 goods failed: no total_count/);
  await assert.rejects(client({}).getCouponCategories(1, { memberToken: 't' }), /coupon 1 categories failed: no category_list/);
  for (const call of [(c) => c.getCouponGoodsPage(1, { memberToken: 'secret-tok' }), (c) => c.getCouponCategories(1, { memberToken: 'secret-tok' })]) {
    const { fn, calls } = fakeFetch({ lists: [json(401, {})] });
    await assert.rejects(call(createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 })), (e) => {
      assert.equal(e.code, 'MEMBER_AUTH');
      assert.ok(!e.message.includes('secret-tok'));
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('detail uses AGLO identity and preserves its price basis', async () => {
  const { fn, calls } = fakeFetch({ lists: [json(200, { goods: { price: 75900, first_page_rendering: { price: 75900 }, linked_option: { sno: 430713077 } } })] });
  const d = await createClient({ fetchFn: fn, delayMs: 0 }).getGoodsDetail(57821918);
  assert.equal(calls[1].headers['X-App-Type'], 'AGLO');
  assert.equal(calls[1].headers['X-App-Version'], '0.1.0');
  assert.equal(calls[1].headers['X-Device-Type'], 'PCWeb');
  assert.equal(d.priceBasis, 'AGLO');
  assert.equal(d.listPrice, 75900);
  assert.equal(d.optionSno, 430713077);
});

test('best coupon preserves true false and missing application state', async () => {
  for (const [raw, want] of [[true, true], [false, false], [undefined, null]]) {
    const { fn } = fakeFetch({ lists: [json(200, { is_applied: raw, best_coupon: { sno: 1, coupon_discount: 3790 } })] });
    const b = await createClient({ fetchFn: fn, delayMs: 0 }).getBestCoupon(430713077, { memberToken: 'test' });
    assert.equal(b.isApplied, want);
    assert.equal(b.optionSno, 430713077);
  }
});

test('wallet preserves all conditions and target restrictions', async () => {
  const conditions = ['상품 3개 이상 구매시 사용 가능', '1원 이상 구매 시 최대 100,000원 할인'];
  const { fn } = fakeFetch({ lists: [json(200, { coupon_apply_list: [{ coupon_sno: 1, conditions, has_targets: true, is_app_only: true }] })] });
  const [c] = await createClient({ fetchFn: fn, delayMs: 0 }).getMyCoupons({ memberToken: 'test' });
  assert.deepEqual(c.conditions, conditions);
  assert.equal(c.hasTargets, true);
  assert.equal(c.appOnly, true);
});

test('malformed successful best coupon responses cannot verify no-coupon prices',async()=>{
  for(const body of [{},null,{best_coupon:null},{best_coupon:null,is_applied:true}]) {
    const {fn}=fakeFetch({lists:[json(200,body)]});
    await assert.rejects(createClient({fetchFn:fn,delayMs:0}).getBestCoupon(1,{memberToken:'test'}));
  }
  const {fn}=fakeFetch({lists:[json(200,{best_coupon:null,is_applied:false})]});
  assert.equal(await createClient({fetchFn:fn,delayMs:0}).getBestCoupon(1,{memberToken:'test'}),null);
});
