import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MusinsaWideStore } from '../src/musinsaWide/store.js';
import { ALL_CATEGORIES_PARAM } from '../src/musinsaWide/client.js';
import { SMALL_COUPON_MAX, MAX_PAGES_PER_CAT, WALK_EXTRA_PAGES, walkCoupon, walkCouponLists } from '../src/musinsaWide/walk.js';

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

test('constants match the spec', () => {
  assert.equal(SMALL_COUPON_MAX, 3000);
  assert.equal(MAX_PAGES_PER_CAT, 60);
  assert.equal(WALK_EXTRA_PAGES, 1);
});

test('a coupon with ≤3000 goods in the five categories is read whole with the combined filter', async () => {
  const f = fakeClient((_, { page }) => ({ items: [item(page * 10), item(page * 10 + 1)], totalCount: 2500, hasNext: page < 3 }));
  const r = await walkCoupon(f.client, 7, {});
  assert.equal(r.mode, 'combined');
  assert.equal(r.pages, 3);
  assert.deepEqual(r.goodsNos, [10, 11, 20, 21, 30, 31]);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.map((c) => c.page), [1, 2, 3]);
  for (const c of f.calls) assert.equal(c.category, ALL_CATEGORIES_PARAM);
});

test('a large coupon is read per category and stops one page after the review floor', async () => {
  const reviews = [500, 200, 90, 50, 10];
  const f = fakeClient((_, { page, category }) => {
    if (category === ALL_CATEGORIES_PARAM) return { items: [item(1)], totalCount: SMALL_COUPON_MAX + 1, hasNext: true };
    return { items: [item(Number(category) * 100 + page, reviews[page - 1])], totalCount: 9999, hasNext: true };
  });
  const r = await walkCoupon(f.client, 7, { '001': 100, '002': 100, '003': 100, '103': 100, '004': 100 });
  assert.equal(r.mode, 'per-category');
  assert.equal(f.calls.filter((c) => c.category === '001').length, 4);
  assert.deepEqual(f.calls.filter((c) => c.category === '001').map((c) => c.page), [1, 2, 3, 4]);
  assert.equal(r.pages, 1 + 4 * 5);
  assert.ok(r.goodsNos.includes(104) && !r.goodsNos.includes(105));
});

test('a category without a stored review floor is read for one page only', async () => {
  const f = fakeClient((_, { page, category }) => {
    if (category === ALL_CATEGORIES_PARAM) return { items: [], totalCount: 5000, hasNext: true };
    return { items: [item(Number(category) * 100 + page, 5)], totalCount: 9999, hasNext: true };
  });
  const r = await walkCoupon(f.client, 7, { '001': 100 });
  assert.equal(f.calls.filter((c) => c.category === '002').length, 1);
  assert.equal(f.calls.filter((c) => c.category === '001').length, 1 + WALK_EXTRA_PAGES);
  assert.equal(r.pages, 1 + 2 + 4);
});

test('per-category reading ends at hasNext false and never exceeds 60 pages', async () => {
  const f = fakeClient((_, { page, category }) => {
    if (category === ALL_CATEGORIES_PARAM) return { items: [], totalCount: 9000, hasNext: true };
    if (category === '001') return { items: [item(page)], totalCount: 9999, hasNext: page < 2 }; // ends at page 2
    return { items: [item(Number(category) * 1000 + page, 1_000_000)], totalCount: 9999, hasNext: true }; // never below the floor
  });
  const floors = { '001': 1, '002': 1, '003': 1, '103': 1, '004': 1 };
  const r = await walkCoupon(f.client, 7, floors);
  assert.equal(f.calls.filter((c) => c.category === '001').length, 2);
  for (const cat of ['002', '003', '103', '004']) assert.equal(f.calls.filter((c) => c.category === cat).length, MAX_PAGES_PER_CAT);
  assert.equal(r.pages, 1 + 2 + 4 * MAX_PAGES_PER_CAT);
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
  assert.equal(r.failed, 1);
  assert.equal(r.walked, 1, 'an empty list nothing contradicts is a real empty list');
  assert.deepEqual(r.failedCoupons, [10]);
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
