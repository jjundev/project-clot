import './setup-env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAuthenticatedPriceInfo, extractProductDetail, SessionExpiredError } from '../src/myprice.js';

const GOODS = 2322315;
const DETAIL = {
  goodsNm: 'M160 스트레이트 데님 팬츠', brand: 'waar', comId: 'waar', brandInfo: { brandName: '와르' },
  thumbnailImageUrl: 'https://image.msscdn.net/x.jpg', specialtyCodes: [], isSoldOut: false, goodsSaleType: 'SALE',
  isLimitedDc: false, isRestictedUsePoint: false, maxUsePointRate: 0.07, isPrePoint: false, isGivenPoint: false,
  point: { memberPoint: 10899 },
  goodsPrice: {
    normalPrice: 72100, salePrice: 64890, couponPrice: 45430, finalDiscount: 37, extraDiscountAmount: 0,
    memberDiscountRate: 1.5, memberSavePointRate: 1.5, savePoint: 0,
  },
};

function pageHtml({ goodsNo = GOODS, loggedIn = true, detail = DETAIL, withLoginStatus = true } = {}) {
  const queries = [{ queryKey: ['Detail', goodsNo], state: { data: { data: detail } } }];
  if (withLoginStatus) queries.push({ queryKey: ['Detail', 'LoginStatus'], state: { data: { data: { loggedIn } } } });
  const nextData = { props: { pageProps: { dehydratedState: { queries } } } };
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></html>`;
}

function res(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

const COUPONS = { data: { list: [{ couponName: '와르 추석 30%', salePrice: 19460 }, { couponName: '실버 5%', salePrice: 3240 }], count: 2 } };
const PROMOS = { data: { promotions: [{ isApplicable: true, minAmount: 100000, discountAmount: 5000 }] } };

function makeFetch({ pages = [pageHtml()], coupons = res(200, COUPONS), promos = res(200, PROMOS) } = {}) {
  const calls = [];
  let pageIdx = 0;
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (url.startsWith('https://www.musinsa.com/products/')) {
      const p = pages[Math.min(pageIdx++, pages.length - 1)];
      return typeof p === 'string' ? res(200, p) : p;
    }
    if (url.includes('/coupon/coupons/getUsableCouponsByGoodsNo')) return coupons;
    if (url.includes('/card-promotion')) return promos;
    throw new Error(`unexpected url ${url}`);
  };
  fn.calls = calls;
  return fn;
}

describe('extractProductDetail', () => {
  test('returns null when __NEXT_DATA__ is missing (rate-limited page)', () => {
    assert.equal(extractProductDetail('<html>blocked</html>', GOODS), null);
  });
  test('returns detail and loggedIn flag', () => {
    const r = extractProductDetail(pageHtml({ loggedIn: false }), GOODS);
    assert.equal(r.loggedIn, false);
    assert.equal(r.detail.brand, 'waar');
  });
  test('loggedIn is null when the LoginStatus query is absent (unknown, not logged out)', () => {
    const r = extractProductDetail(pageHtml({ withLoginStatus: false }), GOODS);
    assert.equal(r.loggedIn, null);
  });
});

describe('fetchAuthenticatedPriceInfo', () => {
  test('computes exact myPrice and sends the cookie on every request', async () => {
    const fetchFn = makeFetch();
    const info = await fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=a; app_rtk=b; mss_mac=c', fetchFn, backoffBaseMs: 0 });
    assert.equal(info.myPrice, 41620);
    assert.equal(info.salePrice, 64890);
    assert.equal(info.couponPrice, 45430);
    assert.equal(info.couponName, '와르 추석 30%');
    assert.equal(info.couponDiscount, 19460);
    assert.equal(info.priceSource, 'https-auth');
    assert.equal(info.discontinued, false);
    assert.equal(fetchFn.calls.length, 3);
    for (const c of fetchFn.calls) assert.equal(c.opts.headers.Cookie, 'app_atk=a; app_rtk=b; mss_mac=c');
    const couponUrl = new URL(fetchFn.calls.find((c) => c.url.includes('getUsableCoupons')).url);
    assert.equal(couponUrl.searchParams.get('goodsNo'), String(GOODS));
    assert.equal(couponUrl.searchParams.get('brand'), 'waar');
    assert.equal(couponUrl.searchParams.get('comId'), 'waar');
    assert.equal(couponUrl.searchParams.get('salePrice'), '64890');
    assert.equal(couponUrl.searchParams.has('specialtyCodes'), false);
  });

  test('rejects with SessionExpiredError when the page reports logged out', async () => {
    const fetchFn = makeFetch({ pages: [pageHtml({ loggedIn: false })] });
    await assert.rejects(
      fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=x', fetchFn, backoffBaseMs: 0 }),
      (err) => err instanceof SessionExpiredError && err.name === 'SessionExpiredError'
    );
  });

  test('a page without LoginStatus rejects with a generic error, not SessionExpiredError (keeps the cached cookie)', async () => {
    const fetchFn = makeFetch({ pages: [pageHtml({ withLoginStatus: false })] });
    await assert.rejects(
      fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=x', fetchFn, backoffBaseMs: 0 }),
      (err) => err.name !== 'SessionExpiredError' && /login status unknown/.test(err.message)
    );
  });

  test('404 resolves as discontinued without calling coupon/promo APIs', async () => {
    const fetchFn = makeFetch({ pages: [res(404, 'not found')] });
    const info = await fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=x', fetchFn, backoffBaseMs: 0 });
    assert.deepEqual(info, { status: 404, discontinued: true });
    assert.equal(fetchFn.calls.length, 1);
  });

  test('retries a 200 page without __NEXT_DATA__ (rate limit) and then succeeds', async () => {
    const fetchFn = makeFetch({ pages: ['<html>blocked</html>', res(429, ''), pageHtml()] });
    const info = await fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=x', fetchFn, backoffBaseMs: 0 });
    assert.equal(info.myPrice, 41620);
    assert.equal(fetchFn.calls.filter((c) => c.url.includes('/products/')).length, 3);
  });

  test('gives up after `retries` blocked pages instead of returning a bogus price', async () => {
    const fetchFn = makeFetch({ pages: ['<html>blocked</html>'] });
    await assert.rejects(
      fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=x', fetchFn, retries: 2, backoffBaseMs: 0 }),
      /unavailable after 2 attempts/
    );
  });

  test('coupon API failure rejects (never computes a price without coupons)', async () => {
    const fetchFn = makeFetch({ coupons: res(500, { error: 'x' }) });
    await assert.rejects(
      fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=x', fetchFn, backoffBaseMs: 0 }),
      /HTTP 500/
    );
  });

  test('card-promotion API failure rejects', async () => {
    const fetchFn = makeFetch({ promos: res(503, '') });
    await assert.rejects(
      fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=x', fetchFn, backoffBaseMs: 0 }),
      /HTTP 503/
    );
  });

  test('card-promotion 200 with an unexpected body rejects instead of dropping the card discount', async () => {
    const fetchFn = makeFetch({ promos: res(200, { data: null }) });
    await assert.rejects(
      fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=x', fetchFn, backoffBaseMs: 0 }),
      /Unexpected card-promotion API response/
    );
  });

  test('passes specialtyCodes to the coupon API when present', async () => {
    const fetchFn = makeFetch({ pages: [pageHtml({ detail: { ...DETAIL, specialtyCodes: ['sneaker'] } })] });
    await fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=x', fetchFn, backoffBaseMs: 0 });
    const couponUrl = new URL(fetchFn.calls.find((c) => c.url.includes('getUsableCoupons')).url);
    assert.equal(couponUrl.searchParams.get('specialtyCodes'), 'sneaker');
  });

  test('forwards product-page Set-Cookie headers to onSetCookie', async () => {
    const page = { ...res(200, pageHtml()), headers: { getSetCookie: () => ['app_atk=NEW; Path=/'] } };
    const fetchFn = makeFetch({ pages: [page] });
    const seen = [];
    await fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=OLD; app_rtk=R', fetchFn, onSetCookie: (h) => seen.push(h) });
    assert.deepEqual(seen, [['app_atk=NEW; Path=/']]);
  });

  test('responses without headers or Set-Cookie do not call onSetCookie', async () => {
    const seen = [];
    await fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=OLD; app_rtk=R', fetchFn: makeFetch(), onSetCookie: (h) => seen.push(h) });
    assert.deepEqual(seen, []);
  });
});
