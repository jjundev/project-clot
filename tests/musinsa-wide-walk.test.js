import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MusinsaWideStore } from '../src/musinsaWide/store.js';
import { ALL_CATEGORIES_PARAM } from '../src/musinsaWide/client.js';
import { walkCoupon, walkCouponLists } from '../src/musinsaWide/walk.js';

const DATE = '2026-10-15';
const goodsRow = (goods_no, cat = '001') => ({
  goods_no, cat, brand: 'nike', brand_name: 'Nike', name: `goods ${goods_no}`,
  url: `https://www.musinsa.com/products/${goods_no}`, image_url: null,
  sale_price: 50000, normal_price: 100000, extra_discount: 0, is_sold_out: 0, review_count: 10,
});

let dir;
let store;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-musinsa-wide-walk-'));
  store = new MusinsaWideStore(path.join(dir, 'musinsa-wide.db'));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const addGoods = (nos) => store.applyScan(DATE, nos.map((n) => goodsRow(n)), { cat: '001', complete: false });

// pageFn(couponNo, { page, category }) -> page result, or throws. calls records every request.
function fakeClient(pageFn) {
  const calls = [];
  const client = {
    sleep: async () => {},
    async getCouponGoodsPage(couponNo, { page = 1, category = ALL_CATEGORIES_PARAM } = {}) {
      calls.push({ couponNo, page, category });
      return pageFn(couponNo, { page, category });
    },
  };
  return { client, calls, withClient: (fn) => fn(client) };
}

const item = (goodsNo, reviewCount = 1) => ({ goodsNo, reviewCount, isSoldOut: false });

test('combined traversal reads beyond 60 pages and ignores changing totals and review floors', async () => {
  const f = fakeClient((_, { page }) => ({ items: [item(page, page === 70 ? 9999 : 0)], totalCount: page === 1 ? 1 : 90000, hasNext: page < 75 }));
  const r = await walkCoupon(f.client, 7, { '001': 100 });
  assert.equal(r.mode, 'combined');
  assert.equal(r.pages, 75);
  assert.equal(r.goodsNos.length, 75);
  assert.ok(r.goodsNos.includes(70));
  assert.ok(f.calls.every((c) => c.category === ALL_CATEGORIES_PARAM));
});

test('large coupons without stored floors read to hasNext false and deduplicate goods', async () => {
  const f = fakeClient((_, { page }) => ({ items: [item(page), item(999)], totalCount: 100000, hasNext: page < 3 }));
  const r = await walkCoupon(f.client, 7, {});
  assert.equal(r.pages, 3);
  assert.deepEqual(r.goodsNos, [1, 999, 2, 3]);
});

test('empty continuing pages and repeated complete page sequences fail as incomplete', async () => {
  const empty = fakeClient(() => ({ items: [], totalCount: 100, hasNext: true }));
  await assert.rejects(walkCoupon(empty.client, 7, {}), /incomplete/i);
  const repeated = fakeClient((_, { page }) => ({ items: [item(page % 2), item(99)], totalCount: 100, hasNext: true }));
  await assert.rejects(walkCoupon(repeated.client, 7, {}), /incomplete/i);
  assert.equal(repeated.calls.length, 3);
});

test('a finite generous safety bound fails instead of publishing a partial list', async () => {
  const f = fakeClient((_, { page }) => ({ items: [item(page)], totalCount: 1, hasNext: true }));
  await assert.rejects(walkCoupon(f.client, 7, {}), /incomplete/i);
  assert.equal(f.calls.length, 10000);
});

test('incomplete pages preserve yesterday mapping and expose remaining work', async () => {
  addGoods([1, 2]);
  store.replaceCouponGoods(10, '2026-10-14', [2]);
  const f = fakeClient(() => ({ items: [], totalCount: 100, hasNext: true }));
  const r = await walkCouponLists({ withClient: f.withClient, store, date: DATE, couponNos: [10] });
  assert.equal(r.requested, 1);
  assert.equal(r.remaining, 1);
  assert.equal(r.complete, false);
  assert.equal(r.walked, 0);
  assert.deepEqual(r.failedCoupons, [10]);
  assert.deepEqual(store.couponsByGoods().get(2), [10]);
});

test('a non-429 page error is retried; a 429 is thrown at once', async () => {
  let n = 0;
  const flaky = fakeClient(() => {
    if (n++ === 0) throw new Error('boom');
    return { items: [item(1)], totalCount: 1, hasNext: false };
  });
  assert.deepEqual((await walkCoupon(flaky.client, 7, {})).goodsNos, [1]);
  assert.equal(flaky.calls.length, 2);

  const throttled = fakeClient(() => { throw Object.assign(new Error('HTTP 429'), { status: 429 }); });
  await assert.rejects(walkCoupon(throttled.client, 7, {}), (e) => e.status === 429);
  assert.equal(throttled.calls.length, 1);
});

test('a successful walk replaces that coupon\'s goods; a failed one keeps yesterday\'s rows', async () => {
  addGoods([1, 2, 3, 4]);
  store.replaceCouponGoods(10, '2026-10-14', [1, 2]);
  store.replaceCouponGoods(11, '2026-10-14', [3]);
  const f = fakeClient((couponNo) => {
    if (couponNo === 11) throw new Error('boom');
    return { items: [item(2), item(4), item(999)], totalCount: 3, hasNext: false };
  });
  const r = await walkCouponLists({ withClient: f.withClient, store, date: DATE, couponNos: [10, 11] });
  assert.equal(r.walked, 1);
  assert.equal(r.requested, 2);
  assert.equal(r.remaining, 1);
  assert.equal(r.complete, false);
  assert.equal(r.failed, 1);
  assert.equal(r.suspectEmpty, 0);
  assert.equal(r.stop, null);
  assert.deepEqual(r.failedCoupons, [11]);
  assert.equal(r.calls, 1 + 3, 'one page for coupon 10, three attempts for coupon 11');
  const rows = (no) => store.db.prepare('SELECT goods_no, date FROM coupon_goods WHERE coupon_no = ? ORDER BY goods_no').all(no).map((x) => ({ ...x }));
  assert.deepEqual(rows(10), [{ goods_no: 2, date: DATE }, { goods_no: 4, date: DATE }]);
  assert.deepEqual(rows(11), [{ goods_no: 3, date: '2026-10-14' }]);
});

test('an empty list for a coupon that a stored member check holds counts as suspectEmpty and keeps yesterday\'s rows', async () => {
  addGoods([1, 2, 3]);
  store.putGoodsCoupons(1, '2026-10-14', [{ id: '10' }], { sale_price: 50000, extra_discount: 0 });
  store.replaceCouponGoods(10, '2026-10-14', [1, 2]);
  store.replaceCouponGoods(11, '2026-10-14', [3]);
  const f = fakeClient(() => ({ items: [], totalCount: 0, hasNext: false }));
  const r = await walkCouponLists({ withClient: f.withClient, store, date: DATE, couponNos: [10, 11] });
  assert.equal(r.suspectEmpty, 1);
  assert.equal(r.failed, 0);
  assert.equal(r.walked, 1, 'an empty list nothing contradicts is a real empty list');
  assert.deepEqual(r.failedCoupons, []);
  assert.deepEqual(r.exceptions, [10]);
  const rows = (no) => store.db.prepare('SELECT goods_no FROM coupon_goods WHERE coupon_no = ?').all(no).map((x) => x.goods_no);
  assert.deepEqual(rows(10).sort(), [1, 2]);
  assert.deepEqual(rows(11), []);
});

test('429 stops the walk: started coupons finish or fail, unstarted ones keep yesterday\'s rows', async () => {
  addGoods([1, 2, 3, 4, 5, 6]);
  for (const no of [20, 21, 22, 23]) store.replaceCouponGoods(no, '2026-10-14', [6]);
  const f = fakeClient((couponNo) => {
    if (couponNo === 21) throw Object.assign(new Error('HTTP 429'), { status: 429 });
    return { items: [item(1)], totalCount: 1, hasNext: false };
  });
  const r = await walkCouponLists({ withClient: f.withClient, store, date: DATE, couponNos: [20, 21, 22, 23], concurrency: 1 });
  assert.equal(r.stop, 'throttled');
  assert.equal(r.walked, 1);
  assert.deepEqual(f.calls.map((c) => c.couponNo), [20, 21]);
  assert.deepEqual(r.failedCoupons, [21]);
  const dates = (no) => store.db.prepare('SELECT date FROM coupon_goods WHERE coupon_no = ?').all(no).map((x) => x.date);
  assert.deepEqual(dates(20), [DATE]);
  for (const no of [21, 22, 23]) assert.deepEqual(dates(no), ['2026-10-14']);
});

test('a coupon is not started once the deadline has passed', async () => {
  addGoods([1]);
  let t = 0;
  const f = fakeClient(() => { t++; return { items: [item(1)], totalCount: 1, hasNext: false }; });
  const r = await walkCouponLists({ withClient: f.withClient, store, date: DATE, couponNos: [1, 2, 3], concurrency: 1, deadline: 2, now: () => t });
  assert.equal(r.stop, 'deadline');
  assert.equal(r.walked, 2);
  assert.equal(r.requested, 3);
  assert.equal(r.remaining, 1);
  assert.equal(r.complete, false);
  assert.deepEqual(r.failedCoupons, []);
  assert.deepEqual(f.calls.map((c) => c.couponNo), [1, 2]);
});

test('a deadline between pages keeps the previous complete list and starts no further requests', async () => {
  addGoods([1, 2]);
  store.replaceCouponGoods(10, '2026-10-14', [2]);
  let t = 0;
  const f = fakeClient(() => { t = 10; return { items: [item(1)], totalCount: 2, hasNext: true }; });
  const r = await walkCouponLists({ withClient: f.withClient, store, date: DATE, couponNos: [10, 11], deadline: 10, now: () => t });
  assert.equal(r.stop, 'deadline');
  assert.equal(r.walked, 0);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(store.couponsByGoods().get(2), [10]);
  assert.equal(store.couponsByGoods().has(1), false);
});

test('a 429 in another worker stops an in-flight coupon before its next page', async () => {
  addGoods([1, 2]);
  store.replaceCouponGoods(10, '2026-10-14', [2]);
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const f = fakeClient(async (no) => {
    if (no === 11) {
      setImmediate(release);
      throw Object.assign(new Error('429'), { status: 429 });
    }
    await barrier;
    return { items: [item(1)], totalCount: 2, hasNext: true };
  });
  const r = await walkCouponLists({ withClient: f.withClient, store, date: DATE, couponNos: [10, 11], concurrency: 2 });
  assert.equal(r.stop, 'throttled');
  assert.equal(r.walked, 0);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(store.couponsByGoods().get(2), [10]);
});

test('all successful coupons report complete including an empty requested batch', async () => {
  const f = fakeClient(() => ({ items: [], totalCount: 0, hasNext: false }));
  for (const couponNos of [[], [10, 11]]) {
    const r = await walkCouponLists({ withClient: f.withClient, store, date: DATE, couponNos });
    assert.equal(r.requested, couponNos.length);
    assert.equal(r.remaining, 0);
    assert.equal(r.complete, true);
  }
});

test('repeated pages and safety exhaustion preserve prior mapping', async () => {
  addGoods([1, 2]);
  for (const repeating of [true, false]) {
    store.replaceCouponGoods(10, '2026-10-14', [2]);
    const f = fakeClient((_, { page }) => ({ items: [item(repeating ? 1 : page)], totalCount: 1, hasNext: true }));
    const r = await walkCouponLists({ withClient: f.withClient, store, date: DATE, couponNos: [10] });
    assert.equal(r.walked, 0);
    assert.equal(r.remaining, 1);
    assert.equal(r.complete, false);
    assert.deepEqual(store.couponsByGoods().get(2), [10]);
    assert.equal(f.calls.length, repeating ? 2 : 10000);
  }
});

test('deadline reached during retry backoff prevents the retry request', async () => {
  addGoods([1]);
  store.replaceCouponGoods(10, '2026-10-14', [1]);
  let t = 0;
  const f = fakeClient(() => { throw new Error('temporary'); });
  f.client.sleep = async () => { t = 10; };
  const r = await walkCouponLists({ withClient: f.withClient, store, date: DATE, couponNos: [10], deadline: 10, now: () => t });
  assert.equal(r.stop, 'deadline');
  assert.equal(r.calls, 1);
  assert.equal(r.remaining, 1);
  assert.equal(r.complete, false);
  assert.deepEqual(store.couponsByGoods().get(1), [10]);
});

test('a terminal page at the safety boundary is complete', async () => {
  const f = fakeClient((_, { page }) => ({ items: [item(page)], totalCount: 1, hasNext: page < 10000 }));
  const r = await walkCoupon(f.client, 7, {});
  assert.equal(r.pages, 10000);
  assert.equal(r.goodsNos.length, 10000);
});

test('a terminal empty member conflict is an explicit exception, not a transport failure', async()=>{
  addGoods([1]);store.putGoodsCoupons(1,'2026-10-14',[{id:'10'}],{sale_price:50000,extra_discount:0});
  store.replaceCouponGoods(10,'2026-10-14',[1]);
  const f=fakeClient(()=>({items:[],totalCount:0,hasNext:false}));
  const r=await walkCouponLists({withClient:f.withClient,store,date:DATE,couponNos:[10]});
  assert.equal(r.failed,0);assert.deepEqual(r.exceptions,[10]);assert.equal(r.complete,false);assert.equal(r.remaining,1);
  assert.deepEqual(r.failedCoupons,[]);assert.deepEqual(store.couponsByGoods().get(1),[10]);
});
