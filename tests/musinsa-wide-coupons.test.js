import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COUPON_FIELDS, COUPON_TTL_DAYS, CLASSIFY_CAP, SAMPLE_PER_DAY, BACKFILL_CLASSIFY_CAP, parseCoupon, couponDiscountMusinsa, couponPriceMusinsa,
  createMemberChecker, applyCouponPrices, registryCouponToCalc, bestCoupon, sampleAccuracy,
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

test('parseCoupon reads useFromDate as start', () => {
  assert.equal(parseCoupon(raw({ start: '2026-10-01T00:00:00+09:00' })).start, '2026-10-01');
  assert.equal(parseCoupon(raw({ start: undefined })).start, null);
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

// ---- createMemberChecker / applyCouponPrices ----
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
const activeGoods = () => store.db.prepare("SELECT goods_no, brand, sale_price, extra_discount FROM goods WHERE status = 'ACTIVE' ORDER BY goods_no").all().map((r) => ({ ...r }));
// One checker over every active goods, results written to the store the way the callers do; summarised like the old result.
async function run({ date = DAY, deadline, ...over }) {
  const checker = createMemberChecker({ log, concurrency: 1, ...over });
  await checker.start();
  await checker.check(activeGoods(), { deadline, onResult: (goods, coupons) => store.putGoodsCoupons(goods.goods_no, date, coupons, goods) });
  return { memberStatus: checker.status, checked: checker.calls, failed: checker.failed };
}

test('constants match the spec', () => {
  assert.deepEqual([CLASSIFY_CAP, SAMPLE_PER_DAY, BACKFILL_CLASSIFY_CAP], [200, 200, 1500]);
  assert.equal(COUPON_TTL_DAYS, 10);
});

test('the checker hands each goods coupons to onResult and applyCouponPrices prices them', async () => {
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

  addCoupon(99, { rate: '0' });
  putList(99, [3]); // some coupon list exists, so the registry is in charge; these direct checks are all fresh
  const out = applyCouponPrices({ store, date: DAY, ready: true });
  assert.equal(out.priced, 3);
  assert.equal(out.withCoupon, 2);
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
  const res2 = await run({ date: '2026-10-15', withClient: withClientOf(client2), sessionProvider: sp2 });
  assert.equal(res2.memberStatus, 'expired');
  assert.equal(res2.checked, 0);
  assert.equal(sp2.calls.filter((c) => c.refresh).length, 1);
  assert.deepEqual(calls2.map((c) => c.goodsNo), [1, 1]);
  assert.ok(!logs.join().includes(COOKIE));
  assert.ok(!logs.join().includes(NEW_COOKIE));

  // No fresh cookie to be had → expired too.
  const sp3 = provider(COOKIE, { refreshTo: null });
  const res3 = await run({ date: '2026-10-16', withClient: withClientOf(fakeClient({ 1: authError() })), sessionProvider: sp3 });
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
  const res2 = await run({ date: '2026-10-15', withClient: withClientOf(accepted.client), sessionProvider: accepted.sp });
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

test('two check() calls share one refresh: a second 401 after the refresh ends as expired', async () => {
  store.applyScan('2026-10-13', [goodsRow(1, 10000), goodsRow(2, 20000)], { cat: '001', complete: true });
  const calls = [];
  const client = fakeClient({ 1: (c) => (c === COOKIE ? authError() : []), 2: authError() }, calls);
  const sp = provider();
  const checker = createMemberChecker({ withClient: withClientOf(client), sessionProvider: sp, concurrency: 1, log });
  assert.equal(await checker.start(), 'ok');
  const [g1, g2] = activeGoods();
  const seen = [];
  await checker.check([g1], { onResult: (g) => seen.push(g.goods_no) });
  assert.equal(checker.status, 'ok');
  await checker.check([g2], { onResult: (g) => seen.push(g.goods_no) });
  assert.equal(checker.status, 'expired');
  assert.deepEqual(seen, [1]);
  assert.equal(sp.calls.filter((c) => c.refresh).length, 1); // the second 401 does not refresh again
  assert.deepEqual(calls.map((c) => [c.goodsNo, c.cookie]), [[1, COOKIE], [1, NEW_COOKIE], [2, NEW_COOKIE]]);
  assert.deepEqual([checker.calls, checker.failed], [1, 0]);
  assert.ok(![COOKIE, NEW_COOKIE].some((c) => logs.join().includes(c)));
});

test('onResult gets deduped parsed coupons with start', async () => {
  store.applyScan('2026-10-13', [goodsRow(1, 100000)], { cat: '001', complete: true });
  const dated = (id) => raw({ id, rate: '10', max: 0, min: 0, start: '2026-10-01T00:00:00+09:00' });
  const client = fakeClient({ 1: [dated(11), dated(11), dated(12)] });
  const checker = createMemberChecker({ withClient: withClientOf(client), sessionProvider: provider(), concurrency: 1, log });
  await checker.start();
  const results = [];
  await checker.check(activeGoods(), { onResult: (goods, coupons) => results.push({ goods, coupons }) });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].goods, { goods_no: 1, brand: 'nike', sale_price: 100000, extra_discount: 0 });
  assert.deepEqual(results[0].coupons.map((c) => [c.id, c.start, c.until, c.percent]), [['11', '2026-10-01', '2026-10-15', 10], ['12', '2026-10-01', '2026-10-15', 10]]);
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

test('only HTTP failures end as error with nothing checked', async () => {
  store.applyScan('2026-10-13', [goodsRow(1, 10000), goodsRow(2, 20000)], { cat: '001', complete: true });
  const checker = createMemberChecker({ withClient: withClientOf(fakeClient({ 1: httpError(500), 2: httpError(500) })), sessionProvider: provider(), concurrency: 1, log });
  await checker.start();
  await checker.check(activeGoods(), { onResult: () => assert.fail('no result expected') });
  assert.deepEqual([checker.status, checker.calls, checker.failed], ['error', 0, 2]);
});

test('an onResult that throws counts only as failed, so all-failed writes end as error', async () => {
  store.applyScan('2026-10-13', [goodsRow(1, 10000), goodsRow(2, 20000), goodsRow(3, 30000)], { cat: '001', complete: true });
  const checker = createMemberChecker({ withClient: withClientOf(fakeClient({})), sessionProvider: provider(), concurrency: 1, log });
  await checker.start();
  await checker.check(activeGoods(), { onResult: () => { throw new Error('db gone'); } });
  assert.deepEqual([checker.status, checker.calls, checker.failed], ['error', 0, 3]);
  assert.equal(logs.filter((l) => l.includes('저장 실패')).length, 3);
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

test('the deadline is read from the injected clock', async () => {
  store.applyScan('2026-10-13', [goodsRow(1, 10000), goodsRow(2, 20000), goodsRow(3, 30000)], { cat: '001', complete: true });
  let t = 1000;
  const calls = [];
  const client = { async getUsableCoupons(args) { calls.push(args.goodsNo); t += 10; return []; } };
  // Each call moves the clock 10 past 1000: goods 1 starts at 1000, goods 2 at 1010 (not past 1010), goods 3 at 1020 is.
  const res = await run({ withClient: withClientOf(client), sessionProvider: provider(), deadline: 1010, now: () => t });
  assert.equal(res.checked, 2);
  assert.deepEqual(calls, [1, 2]);
});

// ---- applyCouponPrices from the registry's coupon lists + fresh direct checks ----

// A registered USABLE coupon (10% uncapped by default), as a member call would have registered it.
const addCoupon = (no, over = {}, seen = DAY) => store.upsertMemberCoupons(seen, [parseCoupon(raw({ id: no, rate: '10', max: 0, min: 0, until: '2026-10-31T23:59:59+09:00', ...over }))]);
const retire = (no) => store.db.prepare("UPDATE coupons SET state = 'RETIRED' WHERE coupon_no = ?").run(no);
const putList = (no, goodsNos) => store.replaceCouponGoods(no, DAY, goodsNos);
// A direct-check list, stored on the goods the way the member checker does.
const putDirect = (goodsNo, checked, ...over) => {
  const g = store.getGoods(goodsNo);
  store.putGoodsCoupons(goodsNo, checked, over.map((o) => parseCoupon(raw({ rate: '10', max: 0, min: 0, until: '2026-10-31T23:59:59+09:00', ...o }))), g);
};
const prices = (...nos) => nos.map((n) => store.getGoods(n).coupon_price);

test('not ready or no coupon lists yet: every coupon price is null', () => {
  store.applyScan('2026-10-01', [goodsRow(1, 100000), goodsRow(2, 50000)], { cat: '001', complete: true });
  addCoupon(11);
  putDirect(1, DAY, { id: 21, rate: '30' }); // a fresh direct check must not price anything either
  store.setCouponPrices(new Map([[1, 12345]])); // yesterday's price is overwritten
  const none = applyCouponPrices({ store, date: DAY, ready: true }); // ready, but no coupon list exists
  assert.deepEqual([none.priced, none.withCoupon, none.drops, none.lateDrops], [0, 0, [], []]);
  assert.deepEqual([...none.best], [[1, null], [2, null]]);
  assert.deepEqual(prices(1, 2), [null, null]);

  putList(11, [1]);
  assert.equal(store.couponGoodsCount(), 1);
  for (const ready of [false, undefined]) {
    const out = applyCouponPrices({ store, date: DAY, ready });
    assert.deepEqual([out.priced, out.withCoupon, out.drops, out.lateDrops], [0, 0, [], []]);
    assert.deepEqual([...out.best], [[1, null], [2, null]]);
    assert.deepEqual(prices(1, 2), [null, null]);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM coupon_price_changes').get().n, 0); // an unknown price is not history
});

test("a goods in a usable coupon's list gets that coupon; a goods in no list gets sale − extra", () => {
  store.applyScan('2026-10-01', [goodsRow(1, 100000, { extra_discount: 1000 }), goodsRow(2, 50000, { extra_discount: 500 }), goodsRow(3, 30000)], { cat: '001', complete: true });
  addCoupon(11);
  addCoupon(12, { rate: '5' });
  putList(11, [1]);
  putList(12, [1, 3]);
  const out = applyCouponPrices({ store, date: DAY, ready: true });
  assert.deepEqual(prices(1, 2, 3), [100000 - 1000 - 10000, 50000 - 500, 30000 - 1500]);
  assert.deepEqual([out.priced, out.withCoupon], [3, 2]);
  assert.deepEqual([...out.best], [[1, '11'], [2, null], [3, '12']]);
  assert.deepEqual(out.drops, []);
  assert.deepEqual(out.lateDrops, []);
});

test('an expired, not-yet-started or RETIRED coupon is skipped; the others still apply', () => {
  store.applyScan('2026-10-01', [goodsRow(1, 100000), goodsRow(2, 100000), goodsRow(3, 100000)], { cat: '001', complete: true });
  addCoupon(11, { rate: '20', until: '2026-10-13T23:59:59+09:00' }); // expired yesterday
  addCoupon(12, { rate: '30', start: '2026-10-15T00:00:00+09:00' }); // starts tomorrow
  addCoupon(13, { rate: '40' });
  retire(13);
  addCoupon(14, { rate: '5' }); // the one that applies
  addCoupon(15, { rate: '7', until: `${DAY}T23:59:59+09:00` }); // last day
  addCoupon(16, { rate: '8', start: `${DAY}T00:00:00+09:00` }); // first day
  putList(11, [1]); putList(12, [1]); putList(13, [1]); putList(14, [1]);
  putList(15, [2]); putList(16, [2]);
  // Direct checks: a RETIRED and an expired coupon are skipped, one the registry never saw still applies.
  addCoupon(24, { rate: '35' });
  retire(24);
  putDirect(3, DAY, { id: 24, rate: '35' }, { id: 25, rate: '30', until: '2026-10-13T23:59:59+09:00' }, { id: 26, rate: '6' });
  const out = applyCouponPrices({ store, date: DAY, ready: true });
  assert.deepEqual(prices(1, 2, 3), [95000, 92000, 94000]);
  assert.deepEqual([...out.best], [[1, '14'], [2, '16'], [3, '26']]);
  assert.equal(out.withCoupon, 3);
});

test('a fresh direct check fills a list gap; one older than 10 days does not', () => {
  store.applyScan('2026-10-01', [goodsRow(1, 100000), goodsRow(2, 100000), goodsRow(3, 100000), goodsRow(4, 100000)], { cat: '001', complete: true });
  addCoupon(11, { rate: '5' });
  putList(11, [3]);
  putDirect(1, '2026-10-04', { id: 21, rate: '20' }); // 10 days old: still fresh
  putDirect(2, '2026-10-03', { id: 22, rate: '20' }); // 11 days old: too stale
  putDirect(4, '2026-10-14', { id: 23, rate: '20' }); // fresh
  const out = applyCouponPrices({ store, date: DAY, ready: true });
  assert.deepEqual(prices(1, 2, 3, 4), [80000, 100000, 95000, 80000]);
  assert.deepEqual([...out.best], [[1, '21'], [2, null], [3, '11'], [4, '23']]);
  assert.equal(out.withCoupon, 3);
  assert.equal(out.priced, 4);
});

test('the best of list and direct coupons wins, floored to 10 won', () => {
  store.applyScan('2026-10-01', [goodsRow(1, 47390), goodsRow(2, 47390), goodsRow(3, 47390)], { cat: '001', complete: true });
  addCoupon(11, { rate: '5' }); // 2369.5 → 2360
  putList(11, [1, 2, 3]);
  putDirect(1, DAY, { id: 21, rate: '4' }); // 1895.6 → 1890: the list coupon wins
  putDirect(2, DAY, { id: 22, rate: '8' }); // 3791.2 → 3790: the direct coupon wins
  putDirect(3, DAY, { id: 11, rate: '5' }); // the same coupon on both sides is counted once
  const out = applyCouponPrices({ store, date: DAY, ready: true });
  assert.deepEqual(prices(1, 2, 3), [47390 - 2360, 47390 - 3790, 47390 - 2360]);
  assert.deepEqual([...out.best], [[1, '11'], [2, '22'], [3, '11']]);
});

test('a drop caused by a coupon first seen today that started earlier goes to lateDrops', () => {
  store.applyScan('2026-10-01', [1, 2, 3, 4, 5].map((n) => goodsRow(n, 100000)), { cat: '001', complete: true });
  addCoupon(10, { rate: '5', start: '2026-10-01T00:00:00+09:00' }, '2026-10-01');
  putList(10, [1, 2, 3, 4, 5]);
  const first = applyCouponPrices({ store, date: '2026-10-13', ready: true });
  assert.deepEqual(prices(1, 2, 3, 4, 5), [95000, 95000, 95000, 95000, 95000]);
  assert.deepEqual([first.drops, first.lateDrops], [[], []]);

  addCoupon(11, { rate: '30', start: '2026-10-13T00:00:00+09:00' }); // seen today, started yesterday: late
  addCoupon(12, { rate: '30', start: `${DAY}T00:00:00+09:00` }); // seen today, starts today: on time
  addCoupon(13, { rate: '30', start: '2026-10-10T00:00:00+09:00' }, '2026-10-12'); // seen yesterday: its list is just new
  addCoupon(14, { rate: '30', start: undefined }); // no start date: never late
  putList(11, [1]); putList(12, [2]); putList(13, [3]); putList(14, [4]);
  putDirect(5, DAY, { id: 99, rate: '30', start: '2026-10-01T00:00:00+09:00' }); // not in the registry: never late
  const out = applyCouponPrices({ store, date: DAY, ready: true });
  assert.deepEqual(prices(1, 2, 3, 4, 5), [70000, 70000, 70000, 70000, 70000]);
  assert.deepEqual(out.lateDrops.map((d) => [d.goods_no, d.prevPrice, d.currentPrice]), [[1, 95000, 70000]]);
  assert.deepEqual(out.drops.map((d) => d.goods_no).sort(), [2, 3, 4, 5]);
  assert.ok(out.drops.every((d) => d.dropRate === 26));
});

test('registryCouponToCalc and bestCoupon', () => {
  addCoupon(11, { rate: '12', max: 5000, min: 1000 });
  const calc = registryCouponToCalc(store.getCoupon(11));
  assert.deepEqual(calc, { id: '11', type: 'PERCENT', percent: 12, price: null, max: 5000, min: 1000, until: '2026-10-31' });
  assert.deepEqual(bestCoupon(100000, [calc, { id: '12', type: 'PRICE', percent: null, price: 3000, max: null, min: 0 }]), { id: '11', discount: 5000 });
  assert.deepEqual(bestCoupon(10000, [calc, { id: '12', type: 'PRICE', percent: null, price: 3000, max: null, min: 0 }]), { id: '12', discount: 3000 }); // 11 needs 1000+
  assert.equal(bestCoupon(500, [calc]), null); // below the minimum: no discount
  assert.equal(bestCoupon(100000, []), null);
  assert.equal(bestCoupon(null, [calc]), null);
});

test('sampleAccuracy counts exact/under/over and names the reason of each under', () => {
  const goods = (n) => ({ goods_no: n, sale_price: 100000, extra_discount: 0 });
  store.applyScan('2026-10-01', [1, 2, 3, 4, 5, 6].map((n) => goodsRow(n, 100000)), { cat: '001', complete: true });
  addCoupon(11); // 10k
  addCoupon(13, { rate: '20' });
  addCoupon(14, { rate: '20' });
  addCoupon(16, { rate: '50', until: '2026-10-13T23:59:59+09:00' }); // expired
  store.recordHit(12, DAY, 1, { scopeGoods: [2] }); // PENDING: classified too late for `before`
  putList(11, [1, 5]);
  putList(14, [4]); // listed, but RETIRED in `before`
  putList(16, [6]);
  const before = new Map([[11, 'USABLE'], [12, 'PENDING'], [13, 'USABLE'], [14, 'RETIRED'], [16, 'USABLE']]);
  const c = (id, rate, over = {}) => parseCoupon(raw({ id, rate: String(rate), max: 0, min: 0, until: '2026-10-31T23:59:59+09:00', ...over }));
  const results = [
    { goods: goods(1), coupons: [c(11, 10)] }, // exact
    { goods: goods(2), coupons: [c(12, 20)] }, // under: 12 was not USABLE (not in the list either)
    { goods: goods(3), coupons: [c(13, 20), c(11, 10)] }, // under: 13 is USABLE, its list never had goods 3
    { goods: goods(4), coupons: [c(14, 20)] }, // under: 14 was retired
    { goods: goods(5), coupons: [] }, // over: the list promised 10k
    { goods: goods(6), coupons: [c(16, 50, { until: '2026-10-13T23:59:59+09:00' })] }, // expired on both sides: exact
    { goods: goods(7), coupons: [c(15, 5)] }, // under: 15 is not in the registry at all
  ];
  assert.deepEqual(sampleAccuracy({ store, date: DAY, results, before }), {
    checked: 7, exact: 2, under: 4, over: 1, reasons: { unregistered: 2, listGap: 1, retired: 1 },
  });
  assert.deepEqual(sampleAccuracy({ store, date: DAY, results: [], before }), { checked: 0, exact: 0, under: 0, over: 0, reasons: { unregistered: 0, listGap: 0, retired: 0 } });
});
