import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COUPON_FIELDS, COUPON_CHECKS_PER_DAY, COUPON_TTL_DAYS, parseCoupon, couponDiscountMusinsa, couponPriceMusinsa,
  checkGoodsCoupons, applyCouponPrices,
} from '../src/musinsaWide/coupons.js';
import { MusinsaWideStore } from '../src/musinsaWide/store.js';

// A raw coupon built from COUPON_FIELDS (the real field names, docs/verify/musinsa-coupon-price.md §2).
const raw = (over = {}) => {
  const base = { id: 359200, name: '무탠다드 깜짝 15% 쿠폰', kind: '%', rate: '15', max: 40000, min: 1000, discount: 10480, until: '2026-10-15T23:59:59+09:00' };
  const merged = { ...base, ...over };
  const out = {};
  for (const [k, field] of Object.entries(COUPON_FIELDS)) if (field && k in merged && merged[k] !== undefined) out[field] = merged[k];
  return out;
};

test('couponDiscountMusinsa floors to 10 won, honours min and max', () => {
  assert.equal(couponDiscountMusinsa(47390, { type: 'PERCENT', percent: 5, price: null, max: null, min: 0 }), 2360);
  assert.equal(couponDiscountMusinsa(101400, { type: 'PERCENT', percent: 12, price: null, max: null, min: 0 }), 12160);
  assert.equal(couponDiscountMusinsa(300000, { type: 'PERCENT', percent: 20, price: null, max: 30000, min: 0 }), 30000);
  assert.equal(couponDiscountMusinsa(9000, { type: 'PRICE', percent: null, price: 3000, max: null, min: 10000 }), 0);
});

test('couponPriceMusinsa subtracts extra discount and the single best coupon', () => {
  const cs = [{ type: 'PERCENT', percent: 5, price: null, max: null, min: 0 }, { type: 'PRICE', percent: null, price: 3000, max: null, min: 0 }];
  assert.equal(couponPriceMusinsa({ sale_price: 98100, extra_discount: 1960 }, cs), 98100 - 1960 - 4900);
  assert.equal(couponPriceMusinsa({ sale_price: 50000, extra_discount: 0 }, []), 50000);
  assert.equal(couponPriceMusinsa({ sale_price: null, extra_discount: 0 }, cs), null);
});

test('parseCoupon reads an explicit rate as PERCENT', () => {
  const c = parseCoupon(raw({ rate: '12' }));
  assert.equal(c.id, '359200');
  assert.equal(c.type, 'PERCENT');
  assert.equal(c.percent, 12);
  assert.equal(c.price, null);
  assert.equal(c.discount, 10480);
  assert.equal(c.until, '2026-10-15');
});

test('parseCoupon falls back to the name percent', () => {
  const c = parseCoupon(raw({ rate: undefined, kind: undefined, name: '실버정기 5%' }));
  assert.equal(c.type, 'PERCENT');
  assert.equal(c.percent, 5);
});

test('parseCoupon falls back to a fixed amount of the discount', () => {
  const c = parseCoupon(raw({ rate: undefined, kind: undefined, name: '3천원 쿠폰', discount: 3000 }));
  assert.equal(c.type, 'PRICE');
  assert.equal(c.price, 3000);
  assert.equal(c.percent, null);
});

test('parseCoupon defaults max to null and min to 0', () => {
  const c = parseCoupon(raw({ max: 0, min: undefined, until: undefined }));
  assert.equal(c.max, null);
  assert.equal(c.min, 0);
  assert.equal(c.until, null);
  assert.equal(parseCoupon(raw({ max: undefined })).max, null);
});

// ---- checkGoodsCoupons / applyCouponPrices ----
const COOKIE = 'sid=SECRET-COOKIE-VALUE';
const NEW_COOKIE = 'sid=SECRET-REFRESHED-VALUE';
const DAY = '2026-10-14';

const goodsRow = (goods_no, price, extra = {}) => ({
  goods_no, cat: '001', brand: 'nike', brand_name: '나이키', name: `goods ${goods_no}`,
  url: `https://www.musinsa.com/products/${goods_no}`, image_url: null,
  sale_price: price, normal_price: price * 2, extra_discount: 0, is_sold_out: 0, ...extra,
});

let dir;
let store;
let logs;
const log = (m) => logs.push(String(m));
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-musinsa-wide-coupons-'));
  store = new MusinsaWideStore(path.join(dir, 'musinsa-wide.db'));
  logs = [];
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// A fake client: `byGoods` maps goods_no → raw list, an Error to throw, or a function(cookie).
function fakeClient(byGoods, calls = []) {
  return {
    async getUsableCoupons({ goodsNo, brand, salePrice }, cookie, { onSetCookie } = {}) {
      calls.push({ goodsNo, brand, salePrice, cookie });
      if (onSetCookie) onSetCookie(['sid=rotated; Path=/']);
      const v = byGoods[goodsNo];
      const out = typeof v === 'function' ? v(cookie) : v;
      if (out instanceof Error) throw out;
      return out ?? [];
    },
  };
}
const withClientOf = (client) => (fn) => fn(client);
const provider = (cookie = COOKIE, extra = {}) => {
  let current = cookie; // the session cache: a refresh replaces it, absorb merges onto it
  const p = async (opts = {}) => {
    p.calls.push(opts);
    if (!opts.refresh) return current;
    current = p.refreshTo === undefined ? NEW_COOKIE : p.refreshTo;
    return current;
  };
  p.calls = [];
  p.absorbed = [];
  p.absorb = (h) => {
    p.absorbed.push(h);
    return { cookie: current, revoked: false };
  };
  return Object.assign(p, extra);
};
const authError = () => Object.assign(new Error('rejected'), { code: 'MEMBER_AUTH', status: 401 });
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const run = (over) => checkGoodsCoupons({ store, date: DAY, log, concurrency: 1, ...over });

test('constants match the spec', () => {
  assert.equal(COUPON_CHECKS_PER_DAY, 4000);
  assert.equal(COUPON_TTL_DAYS, 10);
});

test('checkGoodsCoupons stores each picked goods coupons and applyCouponPrices prices it', async () => {
  store.applyScan('2026-10-13', [goodsRow(1, 100000), goodsRow(2, 50000, { extra_discount: 500 }), goodsRow(3, 30000)], { cat: '001', complete: true });
  const calls = [];
  const client = fakeClient({
    1: [raw({ id: 11, rate: '10', max: 0, min: 0 }), raw({ id: 11, rate: '10', max: 0, min: 0 }), raw({ id: 12, rate: '5', max: 0, min: 0 })],
    2: [raw({ id: 21, rate: undefined, kind: undefined, name: '3천원 쿠폰', discount: 3000, max: 0, min: 0 })],
    3: [],
  }, calls);
  const sp = provider();
  const res = await run({ withClient: withClientOf(client), sessionProvider: sp });
  assert.deepEqual(res, { memberStatus: 'ok', checked: 3, failed: 0 });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.cookie === COOKIE));
  assert.deepEqual(calls.map((c) => [c.goodsNo, c.brand, c.salePrice]), [[1, 'nike', 100000], [2, 'nike', 50000], [3, 'nike', 30000]]);
  assert.equal(sp.absorbed.length, 3);

  const stored = Object.fromEntries(store.getActivePriceRows().map((r) => [r.goods_no, r]));
  assert.equal(stored[1].coupons.length, 2); // duplicate id collapsed
  assert.equal(stored[1].coupon_checked_date, DAY);
  assert.deepEqual(stored[3].coupons, []); // checked, no coupons

  const out = applyCouponPrices({ store, date: DAY });
  assert.equal(out.priced, 3);
  assert.equal(out.stale, 0);
  assert.equal(store.getGoods(1).coupon_price, 100000 - 10000);
  assert.equal(store.getGoods(2).coupon_price, 50000 - 500 - 3000);
  assert.equal(store.getGoods(3).coupon_price, 30000);
  assert.ok(!logs.join().includes(COOKIE));
});

test('no session → memberStatus none, no coupon calls', async () => {
  store.applyScan('2026-10-13', [goodsRow(1, 100000)], { cat: '001', complete: true });
  const calls = [];
  const client = fakeClient({}, calls);
  assert.deepEqual(await run({ withClient: withClientOf(client), sessionProvider: null }), { memberStatus: 'none', checked: 0, failed: 0 });
  assert.deepEqual(await run({ withClient: withClientOf(client), sessionProvider: provider(null) }), { memberStatus: 'none', checked: 0, failed: 0 });
  assert.equal(calls.length, 0);
  assert.equal(store.getActivePriceRows()[0].coupons, null);
});

test('MEMBER_AUTH refreshes once and retries; a second failure is expired and never logs the cookie', async () => {
  store.applyScan('2026-10-13', [goodsRow(1, 100000), goodsRow(2, 50000), goodsRow(3, 30000)], { cat: '001', complete: true });

  // First: the refreshed cookie works → the goods is retried and the run goes on.
  const calls = [];
  const client = fakeClient({
    1: (cookie) => (cookie === COOKIE ? authError() : [raw({ id: 11, rate: '10', max: 0, min: 0 })]),
    2: [], 3: [],
  }, calls);
  const sp = provider();
  const res = await run({ withClient: withClientOf(client), sessionProvider: sp });
  assert.deepEqual(res, { memberStatus: 'ok', checked: 3, failed: 0 });
  assert.deepEqual(sp.calls.filter((c) => c.refresh), [{ refresh: true, failedCookie: COOKIE }]);
  assert.deepEqual(calls.map((c) => [c.goodsNo, c.cookie]), [[1, COOKIE], [1, NEW_COOKIE], [2, NEW_COOKIE], [3, NEW_COOKIE]]);
  assert.equal(store.getActivePriceRows()[0].coupons.length, 1);
  assert.ok(!logs.join().includes(COOKIE));
  assert.ok(!logs.join().includes(NEW_COOKIE));

  // Second: still rejected after the refresh → expired, no further goods, no second refresh.
  logs = [];
  const calls2 = [];
  const client2 = fakeClient({ 1: authError(), 2: [], 3: [] }, calls2);
  const sp2 = provider();
  const res2 = await checkGoodsCoupons({ store, date: '2026-10-15', log, concurrency: 1, withClient: withClientOf(client2), sessionProvider: sp2 });
  assert.equal(res2.memberStatus, 'expired');
  assert.equal(res2.checked, 0);
  assert.equal(sp2.calls.filter((c) => c.refresh).length, 1);
  assert.deepEqual(calls2.map((c) => c.goodsNo), [1, 1]);
  assert.ok(!logs.join().includes(COOKIE));
  assert.ok(!logs.join().includes(NEW_COOKIE));

  // No fresh cookie to be had → expired too.
  const sp3 = provider(COOKIE, { refreshTo: null });
  const res3 = await checkGoodsCoupons({ store, date: '2026-10-16', log, concurrency: 1, withClient: withClientOf(fakeClient({ 1: authError() })), sessionProvider: sp3 });
  assert.equal(res3.memberStatus, 'expired');
});

test('a 401 that rotated the cookie, then a 401 on the rotated cookie, still refreshes once before expiring', async () => {
  store.applyScan('2026-10-13', [goodsRow(1, 10000), goodsRow(2, 20000)], { cat: '001', complete: true });
  const ROTATED = 'sid=SECRET-ROTATED-VALUE';
  const make = (acceptFresh) => {
    const sp = provider();
    sp.absorb = () => ({ cookie: ROTATED, revoked: false }); // every response rotates the cached cookie
    const calls = [];
    const client = fakeClient({ 1: (c) => (c === NEW_COOKIE && acceptFresh ? [] : authError()), 2: [] }, calls);
    return { sp, calls, client };
  };

  const rejected = make(false);
  const res = await run({ withClient: withClientOf(rejected.client), sessionProvider: rejected.sp });
  assert.equal(res.memberStatus, 'expired');
  assert.equal(rejected.sp.calls.filter((c) => c.refresh).length, 1);
  assert.deepEqual(rejected.calls.map((c) => c.cookie), [COOKIE, ROTATED, NEW_COOKIE]); // the refreshed cookie is tried once

  logs = [];
  const accepted = make(true);
  const res2 = await checkGoodsCoupons({ store, date: '2026-10-15', log, concurrency: 1, withClient: withClientOf(accepted.client), sessionProvider: accepted.sp });
  assert.equal(res2.memberStatus, 'ok');
  assert.equal(res2.checked, 2);
  assert.equal(accepted.sp.calls.filter((c) => c.refresh).length, 1);
  assert.ok(![COOKIE, ROTATED, NEW_COOKIE].some((c) => logs.join().includes(c)));
});

test('concurrent MEMBER_AUTH triggers a single refresh', async () => {
  store.applyScan('2026-10-13', [goodsRow(1, 10000), goodsRow(2, 20000), goodsRow(3, 30000)], { cat: '001', complete: true });
  const client = fakeClient({ 1: (c) => (c === COOKIE ? authError() : []), 2: (c) => (c === COOKIE ? authError() : []), 3: (c) => (c === COOKIE ? authError() : []) });
  const sp = provider();
  const res = await run({ withClient: withClientOf(client), sessionProvider: sp, concurrency: 3 });
  assert.equal(res.memberStatus, 'ok');
  assert.equal(res.checked, 3);
  assert.equal(sp.calls.filter((c) => c.refresh).length, 1);
});

test('429 stops checking as throttled and keeps what was checked', async () => {
  store.applyScan('2026-10-13', [goodsRow(1, 10000), goodsRow(2, 20000), goodsRow(3, 30000)], { cat: '001', complete: true });
  const calls = [];
  const client = fakeClient({ 1: [raw({ id: 11, rate: '10', max: 0, min: 0 })], 2: httpError(429), 3: [] }, calls);
  const res = await run({ withClient: withClientOf(client), sessionProvider: provider() });
  assert.deepEqual(res, { memberStatus: 'throttled', checked: 1, failed: 0 });
  assert.deepEqual(calls.map((c) => c.goodsNo), [1, 2]);
  const rows = store.getActivePriceRows();
  assert.equal(rows[0].coupons.length, 1);
  assert.equal(rows[1].coupons, null);
  assert.ok(!logs.join().includes(COOKIE));
});

test('a failing goods is skipped and counted as failed', async () => {
  store.applyScan('2026-10-13', [goodsRow(1, 10000), goodsRow(2, 20000), goodsRow(3, 30000)], { cat: '001', complete: true });
  const client = fakeClient({ 1: httpError(500), 2: new Error(`boom ${COOKIE}`), 3: [raw({ id: 31, rate: '10', max: 0, min: 0 })] });
  const res = await run({ withClient: withClientOf(client), sessionProvider: provider() });
  assert.deepEqual(res, { memberStatus: 'ok', checked: 1, failed: 2 });
  const rows = store.getActivePriceRows();
  assert.equal(rows[0].coupons, null);
  assert.equal(rows[1].coupons, null);
  assert.equal(rows[2].coupons.length, 1);
  assert.equal(logs.length, 2);
  assert.ok(logs[0].includes('1') && logs[0].includes('500'));
  assert.ok(!logs.join().includes(COOKIE));
});

test('checking past the deadline starts no new goods', async () => {
  store.applyScan('2026-10-13', [goodsRow(1, 10000), goodsRow(2, 20000)], { cat: '001', complete: true });
  const calls = [];
  const client = fakeClient({}, calls);
  const res = await run({ withClient: withClientOf(client), sessionProvider: provider(), deadline: Date.now() - 1 });
  assert.deepEqual(res, { memberStatus: 'ok', checked: 0, failed: 0 });
  assert.equal(calls.length, 0);

  // A deadline reached mid-run stops the goods not yet started.
  const calls2 = [];
  const client2 = { async getUsableCoupons(args) { calls2.push(args.goodsNo); await new Promise((r) => setTimeout(r, 60)); return []; } };
  const res2 = await run({ withClient: withClientOf(client2), sessionProvider: provider(), deadline: Date.now() + 30 });
  assert.equal(res2.checked, 1);
  assert.deepEqual(calls2, [1]);
});

test('limit caps how many goods are picked', async () => {
  store.applyScan('2026-10-13', [goodsRow(1, 10000), goodsRow(2, 20000), goodsRow(3, 30000)], { cat: '001', complete: true });
  const calls = [];
  const res = await run({ withClient: withClientOf(fakeClient({}, calls)), sessionProvider: provider(), limit: 2 });
  assert.equal(res.checked, 2);
  assert.equal(calls.length, 2);
});

test('a check 11 days old is stale and priced null; 9 days old is priced', async () => {
  store.applyScan('2026-10-01', [goodsRow(1, 100000), goodsRow(2, 100000), goodsRow(3, 100000), goodsRow(4, 100000)], { cat: '001', complete: true });
  const c = [parseCoupon(raw({ id: 11, rate: '10', max: 0, min: 0 }))];
  const info = { sale_price: 100000, extra_discount: 0 };
  store.putGoodsCoupons(1, '2026-10-05', c, info); // 9 days
  store.putGoodsCoupons(2, '2026-10-04', c, info); // 10 days
  store.putGoodsCoupons(3, '2026-10-03', c, info); // 11 days
  // goods 4 never checked
  const out = applyCouponPrices({ store, date: DAY });
  assert.equal(out.priced, 2);
  assert.equal(out.stale, 2);
  assert.equal(store.getGoods(1).coupon_price, 90000);
  assert.equal(store.getGoods(2).coupon_price, 90000);
  assert.equal(store.getGoods(3).coupon_price, null);
  assert.equal(store.getGoods(4).coupon_price, null);
});

test('an expired coupon (until before date) is left out of the price', () => {
  store.applyScan('2026-10-01', [goodsRow(1, 100000)], { cat: '001', complete: true });
  store.putGoodsCoupons(1, '2026-10-13', [
    parseCoupon(raw({ id: 11, rate: '20', max: 0, min: 0, until: '2026-10-13T23:59:59+09:00' })), // expired on DAY
    parseCoupon(raw({ id: 12, rate: '5', max: 0, min: 0, until: '2026-10-14T23:59:59+09:00' })), // last day: still valid
    parseCoupon(raw({ id: 13, rate: '7', max: 0, min: 0, until: undefined })), // no expiry
  ], { sale_price: 100000, extra_discount: 0 });
  applyCouponPrices({ store, date: DAY });
  assert.equal(store.getGoods(1).coupon_price, 93000);
});

test('applyCouponPrices logs price changes and returns drops, biggest first', () => {
  store.applyScan('2026-10-01', [goodsRow(1, 100000), goodsRow(2, 100000), goodsRow(3, 100000)], { cat: '001', complete: true });
  const info = { sale_price: 100000, extra_discount: 0 };
  const cp = (rate) => [parseCoupon(raw({ id: 1, rate: String(rate), max: 0, min: 0 }))];
  for (const n of [1, 2, 3]) store.putGoodsCoupons(n, '2026-10-12', cp(5), info);
  const first = applyCouponPrices({ store, date: '2026-10-13' });
  assert.deepEqual(first.drops, []);
  store.putGoodsCoupons(1, DAY, cp(20), info);
  store.putGoodsCoupons(2, DAY, cp(40), info);
  const out = applyCouponPrices({ store, date: DAY });
  assert.deepEqual(out.drops.map((d) => [d.goods_no, d.prevPrice, d.currentPrice]), [[2, 95000, 60000], [1, 95000, 80000]]);
  assert.ok(out.drops[0].dropRate > out.drops[1].dropRate);
});
