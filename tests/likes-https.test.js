import './setup-env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchLikedGoodsViaHttps,
  LikesIncompleteError,
  LIKES_TAB_URL,
  LIKED_GOODS_URL,
} from '../src/likes-https.js';
import { SessionExpiredError } from '../src/myprice.js';

const COOKIE = 'app_atk=secret-atk; app_rtk=secret-rtk';
const FIRST = `${LIKED_GOODS_URL}?size=30`;
const PAGE2 = `${LIKED_GOODS_URL}?size=30&cursor=c2&lastIndex=30`;

const goods = (n, extra = {}) => ({
  itemType: 'GOODS', goodsNo: n, goodsName: `Goods ${n}`, brandName: `Brand ${n}`, isSoldOut: false, ...extra,
});
const page = (data, next = null) => ({ body: { meta: { result: 'SUCCESS' }, data, link: { prev: null, next } } });
const tab = (count) => ({ body: { meta: { result: 'SUCCESS' }, data: { goods: count, brand: 0, snap: 0, folder: 0 } } });
const loggedOut = { status: 401, body: { meta: { result: 'FAIL', errorCode: 'LIKE-000-0001' }, data: null } };

/** route(url, callNo) -> { status?, body?, setCookie? }; body undefined = non-JSON response */
function fakeFetch(route) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const r = route(url, calls.length);
    const status = r.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { getSetCookie: () => r.setCookie ?? [] },
      json: async () => {
        if (r.body === undefined) throw new SyntaxError('Unexpected token <');
        return r.body;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

/** pages: { [url]: response }, plus the tab count */
const routes = (count, pages) => (url) => (url === LIKES_TAB_URL ? tab(count) : pages[url] ?? { status: 404, body: null });
const opts = (fetchFn, extra = {}) => ({ fetchFn, delayMs: 0, retryDelayMs: 0, ...extra });

describe('fetchLikedGoodsViaHttps', () => {
  test('follows link.next, keeps only GOODS, maps to the sync shape', async () => {
    const fetchFn = fakeFetch(routes(3, {
      [FIRST]: page([goods(1), { itemType: 'BANNERS' }, goods(2, { isSoldOut: true })], PAGE2),
      [PAGE2]: page([goods(3), { itemType: 'AD_GOODS', content: [goods(99)] }]),
    }));
    const items = await fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn));
    assert.deepEqual(items, [
      { goodsNo: 1, goodsName: 'Goods 1', brandName: 'Brand 1', url: 'https://www.musinsa.com/products/1', status: '판매중' },
      { goodsNo: 2, goodsName: 'Goods 2', brandName: 'Brand 2', url: 'https://www.musinsa.com/products/2', status: '품절' },
      { goodsNo: 3, goodsName: 'Goods 3', brandName: 'Brand 3', url: 'https://www.musinsa.com/products/3', status: '판매중' },
    ]);
    assert.deepEqual(fetchFn.calls.map((c) => c.url), [LIKES_TAB_URL, FIRST, PAGE2, LIKES_TAB_URL]);
    for (const c of fetchFn.calls) {
      assert.equal(c.headers.Cookie, COOKIE);
      assert.equal(c.headers.Accept, 'application/json');
      assert.equal(c.headers.Referer, 'https://www.musinsa.com/');
    }
  });

  test('dedupes a goodsNo repeated across pages', async () => {
    const fetchFn = fakeFetch(routes(2, {
      [FIRST]: page([goods(1), goods(2)], PAGE2),
      [PAGE2]: page([goods(2)]),
    }));
    const items = await fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn));
    assert.deepEqual(items.map((i) => i.goodsNo), [1, 2]);
  });

  test('empty account: total 0 and an empty page -> []', async () => {
    const fetchFn = fakeFetch(routes(0, { [FIRST]: page([]) }));
    assert.deepEqual(await fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn)), []);
  });

  test('total re-read after the last page must match (offsetting like+unlike during paging)', async () => {
    let tabHits = 0;
    const fetchFn = fakeFetch((url) => {
      if (url === LIKES_TAB_URL) return tab(++tabHits === 1 ? 2 : 3);
      return page([goods(1), goods(2)]);
    });
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn)), (err) => {
      assert.ok(err instanceof LikesIncompleteError);
      assert.match(err.message, /changed during paging/);
      return true;
    });
    assert.deepEqual(fetchFn.calls.map((c) => c.url), [LIKES_TAB_URL, FIRST, LIKES_TAB_URL]);
  });

  test('count mismatch -> LikesIncompleteError', async () => {
    const fetchFn = fakeFetch(routes(3, { [FIRST]: page([goods(1), goods(2)]) }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn)), (err) => {
      assert.ok(err instanceof LikesIncompleteError);
      assert.match(err.message, /2 of 3/);
      return true;
    });
  });

  test('missing total -> LikesIncompleteError before any goods page', async () => {
    const fetchFn = fakeFetch((url) => (url === LIKES_TAB_URL ? { body: { meta: { result: 'SUCCESS' }, data: {} } } : page([])));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn)), LikesIncompleteError);
    assert.equal(fetchFn.calls.length, 1);
  });

  test('GOODS item with a wrong schema -> LikesIncompleteError', async () => {
    for (const bad of [goods('5'), goods(0), { itemType: 'GOODS', goodsNo: 5, goodsName: 'x' }]) {
      const fetchFn = fakeFetch(routes(1, { [FIRST]: page([bad]) }));
      await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn)), LikesIncompleteError);
    }
  });

  test('page without a data array, or meta.result != SUCCESS -> LikesIncompleteError', async () => {
    const noArray = fakeFetch(routes(1, { [FIRST]: { body: { meta: { result: 'SUCCESS' }, data: null, link: {} } } }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(noArray)), LikesIncompleteError);
    const failed = fakeFetch(routes(1, { [FIRST]: { body: { meta: { result: 'FAIL', errorCode: 'LIKE-999' }, data: [] } } }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(failed)), LikesIncompleteError);
  });

  test('401 or LIKE-000-0001 -> SessionExpiredError', async () => {
    const onPage = fakeFetch(routes(1, { [FIRST]: loggedOut }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(onPage)), SessionExpiredError);
    const onTab = fakeFetch(() => ({ status: 200, body: { meta: { result: 'FAIL', errorCode: 'LIKE-000-0001' } } }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(onTab)), SessionExpiredError);
  });

  test('429 is retried once on the same URL; a second 429 fails', async () => {
    let firstHits = 0;
    const once = fakeFetch((url) => {
      if (url === LIKES_TAB_URL) return tab(1);
      return ++firstHits === 1 ? { status: 429 } : page([goods(1)]);
    });
    assert.equal((await fetchLikedGoodsViaHttps(COOKIE, opts(once))).length, 1);
    assert.deepEqual(once.calls.map((c) => c.url), [LIKES_TAB_URL, FIRST, FIRST, LIKES_TAB_URL]);

    const twice = fakeFetch((url) => (url === LIKES_TAB_URL ? tab(1) : { status: 429 }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(twice)), /HTTP 429/);
    assert.equal(twice.calls.length, 3);
  });

  test('error messages carry the path only, never the cursor or cookie', async () => {
    const fetchFn = fakeFetch(routes(2, { [FIRST]: page([goods(1)], PAGE2), [PAGE2]: { status: 500 } }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn)), (err) => {
      assert.match(err.message, /HTTP 500/);
      assert.match(err.message, /\/api2\/like\/like-page\/v1\/tab\/goods/);
      assert.doesNotMatch(err.message, /cursor|c2|secret|app_atk/);
      return true;
    });
  });

  test('next on another host, a repeated next, or too many pages -> LikesIncompleteError', async () => {
    const offHost = fakeFetch(routes(2, { [FIRST]: page([goods(1)], 'https://evil.example.com/tab/goods?cursor=x') }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(offHost)), LikesIncompleteError);

    const loop = fakeFetch(routes(9, { [FIRST]: page([goods(1)], PAGE2), [PAGE2]: page([goods(2)], PAGE2) }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(loop)), LikesIncompleteError);

    const endless = fakeFetch((url, n) => (url === LIKES_TAB_URL ? tab(99) : page([goods(n)], `${LIKED_GOODS_URL}?cursor=${n}`)));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(endless, { maxPages: 3 })), /more than 3 pages/);
    assert.equal(endless.calls.length, 4); // tab + 3 pages, never a 4th page
  });

  test('passes Set-Cookie headers to onSetCookie', async () => {
    const seen = [];
    const fetchFn = fakeFetch((url) => (url === LIKES_TAB_URL ? { ...tab(1), setCookie: ['__cf_bm=x; Path=/'] } : page([goods(1)])));
    await fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn, { onSetCookie: (h) => seen.push(h) }));
    assert.deepEqual(seen, [['__cf_bm=x; Path=/'], ['__cf_bm=x; Path=/']]); // tab read before and after paging
  });

  test('waits delayMs before every goods page (sequential)', async () => {
    const fetchFn = fakeFetch(routes(2, { [FIRST]: page([goods(1)], PAGE2), [PAGE2]: page([goods(2)]) }));
    const started = Date.now();
    await fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn, { delayMs: 40 }));
    assert.ok(Date.now() - started >= 75, 'two 40ms gaps: tab->page1, page1->page2');
  });
});
