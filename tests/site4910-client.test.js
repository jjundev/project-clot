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
    market_sno: 42296, market_name: '모에모에', category: '긴소매티셔츠',
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
    linked_option: { original_price: 51300 },
    is_soldout: false,
    is_open: true,
    ...goodsPatch,
  },
});

test('getGoodsDetail maps the anonymous detail', async () => {
  const { fn, calls } = fakeFetch({ lists: [json(200, detailBody())] });
  const client = createClient({ fetchFn: fn, delayMs: 0, retryBaseMs: 0 });
  assert.deepEqual(await client.getGoodsDetail(71863924), {
    sno: 71863924, price: 18360, couponPrice: 18360, listPrice: 21600, originalPrice: 51300, isSoldout: false, isOpen: true,
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
