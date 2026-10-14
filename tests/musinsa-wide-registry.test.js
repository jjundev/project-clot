import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MusinsaWideStore, COUPON_STATE } from '../src/musinsaWide/store.js';
import {
  ENUM_BATCH, ENUM_EMPTY_STOP, ENUM_PROBES, NEIGHBOR_RADIUS, NEIGHBOR_CAP, BACKFILL_FROM, ANON_CONCURRENCY,
  probeNumbers, enumerateNumbers, recheckEmpties, probeNeighbors,
} from '../src/musinsaWide/registry.js';

const DATE = '2026-10-15';
const goodsRow = (goods_no) => ({
  goods_no, cat: '001', brand: 'nike', brand_name: 'Nike', name: `goods ${goods_no}`,
  url: `https://www.musinsa.com/products/${goods_no}`, image_url: null,
  sale_price: 50000, normal_price: 100000, extra_discount: 0, is_sold_out: 0,
});

// counts: couponNo -> goods count (absent = 0). pages: couponNo -> goodsNos of its first page. throw429: numbers whose
// count call answers 429. failing: numbers whose count call fails with a plain error.
function fakeClient({ counts = {}, pages = {}, throw429 = [], failing = [] } = {}) {
  const calls = { count: [], page: [], sleeps: [] };
  const client = {
    sleep: async (ms) => { calls.sleeps.push(ms); },
    async getCouponGoodsCount(n) {
      calls.count.push(n);
      if (throw429.includes(n)) throw Object.assign(new Error('HTTP 429'), { status: 429 });
      if (failing.includes(n)) throw new Error('boom');
      return counts[n] ?? 0;
    },
    async getCouponGoodsPage(n, { page }) {
      calls.page.push([n, page]);
      return { items: (pages[n] ?? []).map((goodsNo) => ({ goodsNo, reviewCount: 1, isSoldOut: false })), totalCount: (pages[n] ?? []).length, hasNext: false };
    },
  };
  return { client, calls, withClient: (fn) => fn(client) };
}

const countsOf = (nums, count = 5) => Object.fromEntries(nums.map((n) => [n, count]));
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

let dir;
let store;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-musinsa-wide-registry-'));
  store = new MusinsaWideStore(path.join(dir, 'musinsa-wide.db'));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('constants match the spec', () => {
  assert.equal(ENUM_BATCH, 50);
  assert.equal(ENUM_EMPTY_STOP, 200);
  assert.deepEqual(ENUM_PROBES, [500, 1000, 2000]);
  assert.equal(NEIGHBOR_RADIUS, 50);
  assert.equal(NEIGHBOR_CAP, 300);
  assert.equal(BACKFILL_FROM, 345000);
  assert.equal(ANON_CONCURRENCY, 2);
});

test('enumerateNumbers stops after 200 empties past the last hit', async () => {
  const f = fakeClient({ counts: countsOf([...range(100, 130), 200]) });
  const r = await enumerateNumbers({ withClient: f.withClient, store, date: DATE, from: 100 });
  assert.equal(r.stop, null);
  assert.equal(r.highest, 200);
  const walked = f.calls.count.filter((n) => n < 500);
  assert.equal(Math.min(...walked), 100);
  assert.ok(Math.max(...walked) <= 200 + 200 + 50, `walked up to ${Math.max(...walked)}`);
  assert.ok(Math.max(...walked) >= 200 + 200, 'walks the full 200 empties');
  for (const d of ENUM_PROBES) assert.equal(f.calls.count.filter((n) => n === 200 + d).length, 1);
  assert.equal(r.hits, 32);
  assert.equal(r.newCoupons, 32);
  assert.equal(r.next, 450);
});

test('a probe hit at lastHit+1000 makes it walk on up to and past the probe', async () => {
  const f = fakeClient({ counts: countsOf([200, 1200]) });
  const r = await enumerateNumbers({ withClient: f.withClient, store, date: DATE, from: 200 });
  assert.equal(r.highest, 1200);
  assert.equal(r.stop, null);
  for (const n of [700, 800, 1000, 1199, 1200, 1201, 1399]) assert.ok(f.calls.count.includes(n), `walked ${n}`);
  // after the hit at 1200 the run restarts: it ends 200 empties later and probes again from there
  assert.ok(f.calls.count.includes(1200 + 500));
  assert.ok(Math.max(...f.calls.count.filter((n) => n < 1500)) <= 1200 + 200 + 50);
  assert.equal(store.getCoupon(1200).state, COUPON_STATE.OUT_OF_SCOPE);
  assert.equal(r.newCoupons, 2, 'the probe-registered coupon counts as new');
  assert.equal(r.hits, 2);
});

test('mustReach keeps walking through a 400-number gap below it', async () => {
  const f = fakeClient({ counts: countsOf([100, 600]) });
  const r = await enumerateNumbers({ withClient: f.withClient, store, date: DATE, from: 100, mustReach: 600 });
  assert.equal(r.highest, 600);
  assert.ok(store.getCoupon(600));
  // the 400 gap is walked number by number; 600 is reached by the walk, not asked as a +500 probe
  assert.ok(f.calls.count.includes(450));
  assert.equal(f.calls.count.filter((n) => n === 600).length, 1);

  // 590 is not on a probe offset of 100, so only mustReach gets the walk there
  const g = fakeClient({ counts: countsOf([100, 590]) });
  const s2 = new MusinsaWideStore(path.join(dir, 'short.db'));
  const short = await enumerateNumbers({ withClient: g.withClient, store: s2, date: DATE, from: 100 });
  s2.close();
  assert.equal(short.highest, 100);
  const h = fakeClient({ counts: countsOf([100, 590]) });
  const reached = await enumerateNumbers({ withClient: h.withClient, store, date: DATE, from: 100, mustReach: 590 });
  assert.equal(reached.highest, 590);
});

test('only empties below the highest hit are recorded', async () => {
  const f = fakeClient({ counts: countsOf([100, 110]) });
  const r = await enumerateNumbers({ withClient: f.withClient, store, date: DATE, from: 100 });
  assert.equal(r.highest, 110);
  // empties are recorded as of DATE; look at them from a later day
  const later = '2026-10-16';
  assert.deepEqual(store.emptyNumbersToRecheck(later), range(101, 109));
  assert.equal(store.getCoupon(100).state, COUPON_STATE.OUT_OF_SCOPE);

  const g = fakeClient({ counts: countsOf([100, 110]) });
  const s2 = new MusinsaWideStore(path.join(dir, 's2.db'));
  await enumerateNumbers({ withClient: g.withClient, store: s2, date: DATE, from: 100, recordEmpties: false });
  assert.deepEqual(s2.emptyNumbersToRecheck(later), []);
  s2.close();
});

test('a new number\'s first page sets PENDING with ACTIVE goods, OUT_OF_SCOPE without; a known number only updates last_count', async () => {
  store.applyScan(DATE, [goodsRow(11), goodsRow(12)], { cat: '001', complete: true });
  const f = fakeClient({ counts: { 10: 7, 20: 3, 30: 4 }, pages: { 10: [11, 99, 12], 20: [98, 99], 30: [11] } });
  const r = await probeNumbers({ withClient: f.withClient, store, date: DATE, numbers: [10, 20, 30, 40] });
  assert.deepEqual(r.hits, [10, 20, 30]);
  assert.deepEqual(r.empties, [40]);
  assert.deepEqual(r.newCoupons, [10, 20, 30]);
  assert.equal(r.probed, 4);
  assert.equal(r.stop, null);

  const c10 = store.getCoupon(10);
  assert.equal(c10.state, COUPON_STATE.PENDING);
  assert.deepEqual(c10.scope_goods, [11, 12]);
  assert.equal(c10.last_count, 7);
  assert.equal(store.getCoupon(20).state, COUPON_STATE.OUT_OF_SCOPE);
  assert.ok(!store.getCoupon(40));

  // known number: count call only, no page, last_count moves, state stays
  const g = fakeClient({ counts: { 10: 9 } });
  const again = await probeNumbers({ withClient: g.withClient, store, date: DATE, numbers: [10] });
  assert.deepEqual(again.hits, [10]);
  assert.deepEqual(again.newCoupons, []);
  assert.deepEqual(g.calls.page, []);
  assert.equal(store.getCoupon(10).last_count, 9);
  assert.equal(store.getCoupon(10).state, COUPON_STATE.PENDING);
});

test('429 stops with throttled and keeps what was recorded', async () => {
  const cursors = [];
  const f = fakeClient({ counts: countsOf([101, 102, 103]), throw429: [110] });
  const r = await enumerateNumbers({ withClient: f.withClient, store, date: DATE, from: 100, onCursor: (c) => cursors.push(c) });
  assert.equal(r.stop, 'throttled');
  assert.ok(store.getCoupon(101));
  assert.ok(store.getCoupon(103));
  assert.ok(r.probed < ENUM_BATCH);
  assert.ok(!f.calls.count.includes(150), 'the next batch is not started');
  assert.equal(r.next, 100); // the cut-short batch stays the cursor
  assert.deepEqual(cursors, []);
  // a 429 is not retried
  assert.equal(f.calls.count.filter((n) => n === 110).length, 1);
  assert.deepEqual(f.calls.sleeps, []);
});

test('a number that keeps failing stops with error after 3 attempts', async () => {
  const f = fakeClient({ counts: countsOf([101]), failing: [105] });
  const r = await probeNumbers({ withClient: f.withClient, store, date: DATE, numbers: [101, 105, 106] });
  assert.equal(r.stop, 'error');
  assert.equal(f.calls.count.filter((n) => n === 105).length, 3);
  assert.deepEqual(f.calls.sleeps, [2000, 4000]);
  assert.ok(store.getCoupon(101));
});

test('deadline stops before the next batch', async () => {
  const f = fakeClient({ counts: countsOf([100, 160]) });
  let t = 0;
  const now = () => t;
  const r = await enumerateNumbers({
    withClient: f.withClient, store, date: DATE, from: 100, deadline: 1000, now,
    onCursor: () => { t += 600; },
  });
  // batch 1 at t=0, batch 2 at t=600, then t=1200 >= deadline
  assert.equal(r.stop, 'deadline');
  assert.equal(r.next, 200);
  assert.equal(Math.max(...f.calls.count), 199);
  assert.ok(store.getCoupon(100));
  assert.ok(store.getCoupon(160));
  assert.equal(r.highest, 160);
});

test('onCursor reports the next number after every batch', async () => {
  const f = fakeClient({});
  const cursors = [];
  const r = await enumerateNumbers({ withClient: f.withClient, store, date: DATE, from: 1000, onCursor: (c) => cursors.push(c) });
  assert.equal(r.highest, null);
  assert.equal(r.stop, null);
  assert.deepEqual(cursors, [1050, 1100, 1150, 1200]);
  // nothing found: the empties below no hit are not recorded, the frontier is not touched
  assert.equal(store.getMeta('frontier'), null);
});

test('frontier meta advances only upward', async () => {
  store.setMeta('frontier', 500);
  const f = fakeClient({ counts: countsOf([300]) });
  await enumerateNumbers({ withClient: f.withClient, store, date: DATE, from: 300 });
  assert.equal(store.getMeta('frontier'), '500');

  const g = fakeClient({ counts: countsOf([700]) });
  await enumerateNumbers({ withClient: g.withClient, store, date: DATE, from: 650 });
  assert.equal(store.getMeta('frontier'), '700');
});

test('recheckEmpties counts numbers that turned positive', async () => {
  store.recordEmpty(10, '2026-10-13');
  store.recordEmpty(11, '2026-10-13');
  store.recordEmpty(12, '2026-10-14');
  store.recordEmpty(13, DATE); // today: not asked again
  const f = fakeClient({ counts: { 11: 4 } });
  const r = await recheckEmpties({ withClient: f.withClient, store, date: DATE });
  assert.deepEqual(f.calls.count.sort((a, b) => a - b), [10, 11, 12]);
  assert.equal(r.probed, 3);
  assert.equal(r.newPositive, 1);
  assert.ok(store.getCoupon(11));
  // the numbers still empty keep their first-seen date
  assert.deepEqual(store.emptyNumbersToRecheck('2026-10-16'), [10, 12, 13]);
});

test('probeNeighbors probes ±50 of each center, skips known numbers, caps at 300', async () => {
  store.recordHit(1000, DATE, 3); // known: skipped
  const f = fakeClient({ counts: { 1010: 2 } });
  const r = await probeNeighbors({ withClient: f.withClient, store, date: DATE, centers: [1000] });
  const asked = f.calls.count;
  assert.equal(asked.length, 100); // -50..+50 is 101 numbers, minus the known center
  assert.ok(!asked.includes(1000));
  assert.ok(asked.includes(950) && asked.includes(1050));
  assert.ok(!asked.includes(949) && !asked.includes(1051));
  assert.deepEqual([r.probed, r.hits], [100, 1]);
  // empties are not recorded
  assert.deepEqual(store.emptyNumbersToRecheck('2026-10-16'), []);

  // overlapping centers do not ask a number twice; the cap stops the collection
  const g = fakeClient({});
  const s2 = new MusinsaWideStore(path.join(dir, 's2.db'));
  const capped = await probeNeighbors({ withClient: g.withClient, store: s2, date: DATE, centers: [1000, 1020, 5000, 9000, 20000] });
  assert.equal(capped.probed, NEIGHBOR_CAP);
  assert.equal(new Set(g.calls.count).size, NEIGHBOR_CAP);
  assert.ok(g.calls.count.includes(950) && g.calls.count.includes(1070));
  assert.ok(!g.calls.count.includes(20000));
  s2.close();
});

test('a stop mid-batch leaves next and the cursor at that batch\'s first number', async () => {
  const f = fakeClient({ counts: countsOf([120, 160, 230]), throw429: [260] });
  const cursors = [];
  const r = await enumerateNumbers({ withClient: f.withClient, store, date: DATE, from: 100, onCursor: (c) => cursors.push(c) });
  assert.equal(r.stop, 'throttled');
  // batches 100-149, 150-199, 200-249 completed; 250-299 was cut short by the 429 at 260
  assert.equal(r.next, 250);
  assert.deepEqual(cursors, [150, 200, 250]);
  assert.ok(cursors.every((c) => c <= 250));
  assert.ok(store.getCoupon(230));
  assert.equal(r.highest, 230);
});

test('a probe hit recorded before a 429 still counts and lifts highest and the frontier', async () => {
  const f = fakeClient({ counts: countsOf([200, 700]), throw429: [1200] });
  const r = await enumerateNumbers({ withClient: f.withClient, store, date: DATE, from: 200 });
  assert.equal(r.stop, 'throttled');
  assert.ok(store.getCoupon(700));
  assert.equal(r.highest, 700);
  assert.equal(r.hits, 2);
  assert.equal(r.newCoupons, 2);
  assert.equal(store.getMeta('frontier'), '700');
});
