import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MusinsaWideStore, COUPON_STATE } from '../src/musinsaWide/store.js';
import {
  ENUM_BATCH, ENUM_EMPTY_STOP, ENUM_PROBES, NEIGHBOR_RADIUS, NEIGHBOR_CAP, BACKFILL_FROM, ANON_CONCURRENCY,
  probeNumbers, enumerateNumbers, recheckEmpties, probeNeighbors, planClassification, classifyPending,
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
  // No hit: no empties are recorded; the safe starting boundary remains the frontier.
  assert.equal(store.getMeta('frontier'), '999');
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

test('neighbor count budget survives a reopened store and resets on the next date', async () => {
  const f = fakeClient();
  const args = { withClient: f.withClient, store, date: DATE, centers: [1000, 5000, 9000] };
  await probeNeighbors({ ...args, cap: 250 });
  const reopened = new MusinsaWideStore(path.join(dir, 'musinsa-wide.db'));
  try {
    const rest = await probeNeighbors({ ...args, store: reopened });
    assert.equal(rest.probed, 50);
    assert.equal(f.calls.count.length, 300);
    assert.equal((await probeNeighbors(args)).probed, 0);
    assert.equal((await probeNeighbors({ ...args, date: '2026-10-16' })).probed, 300);
  } finally { reopened.close(); }
});

test('a slow failed count cannot lift a missing daily frontier past the missing number', async () => {
  const client = {
    sleep: async () => {},
    async getCouponGoodsCount(no) {
      if (no === 100) { await new Promise(setImmediate); throw Object.assign(new Error('429'), { status: 429 }); }
      return 1;
    },
    async getCouponGoodsPage() { return { items: [] }; },
  };
  const r = await enumerateNumbers({ withClient: (fn) => fn(client), store, date: DATE, from: 100 });
  assert.equal(r.stop, 'throttled');
  assert.equal(store.getMeta('frontier'), '99');
  assert.equal(r.highest, null);
  const retry = fakeClient();
  await enumerateNumbers({ withClient: retry.withClient, store, date: DATE, from: Number(store.getMeta('frontier')) + 1, mustReach: store.maxCouponNo() });
  assert.ok(retry.calls.count.includes(100));
});

test('failed neighbor count attempts and retries also spend the daily budget', async () => {
  const f = fakeClient({ failing: [950] });
  await probeNeighbors({ withClient: f.withClient, store, date: DATE, centers: [1000], cap: 1 });
  const g = fakeClient();
  const r = await probeNeighbors({ withClient: g.withClient, store, date: DATE, centers: [1000, 5000, 9000] });
  assert.equal(f.calls.count.length + g.calls.count.length, 300);
  assert.equal(r.stop, null);
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

test('a probe hit recorded before a 429 counts as a hit but does not lift highest or the frontier', async () => {
  const f = fakeClient({ counts: countsOf([200, 700]), throw429: [1200] });
  const r = await enumerateNumbers({ withClient: f.withClient, store, date: DATE, from: 200 });
  assert.equal(r.stop, 'throttled');
  assert.ok(store.getCoupon(700));
  assert.equal(r.highest, 200);
  assert.equal(r.hits, 2);
  assert.equal(r.newCoupons, 2);
  assert.equal(store.getMeta('frontier'), '200');
  // no trailing empties are remembered above highest
  assert.deepEqual(store.emptyNumbersToRecheck('2026-10-16'), []);

  // the next run starts at frontier+1 and walks the numbers the probes jumped over
  const g = fakeClient({ counts: countsOf([200, 700]) });
  const next = await enumerateNumbers({ withClient: g.withClient, store, date: DATE, from: 201, mustReach: store.maxCouponNo() });
  for (const n of [450, 699, 700]) assert.ok(g.calls.count.includes(n), `walked ${n}`);
  assert.equal(next.highest, 700);
  assert.equal(next.stop, null);
  assert.equal(store.getMeta('frontier'), '700');
});

// --- classification of new coupons ---

const info = (entries) => new Map(Object.entries(entries).map(([g, v]) => [Number(g), { review_count: 0, is_sold_out: 0, status: 'ACTIVE', ...v }]));
const pendingOf = (couponNo, scope_goods) => ({ coupon_no: couponNo, scope_goods });
const memberCoupon = (id) => ({ id: String(id), name: `coupon ${id}`, type: 'PERCENT', percent: 10, price: null, max: 5000, min: 0, start: null, until: '2026-12-31' });

// Stands in for createMemberChecker: answers each goods from `answers` (goods_no -> coupon ids), in order, and stops
// after `stopAfter` goods when given. Records the goods it was asked about.
function fakeChecker({ answers = {}, stopAfter = Infinity, status = 'ok' } = {}) {
  const checker = {
    asked: [],
    calls: 0,
    get status() { return status; },
    async check(goodsList, { deadline, onResult } = {}) {
      checker.deadline = deadline;
      for (const goods of goodsList) {
        if (checker.calls >= stopAfter) {
          status = 'throttled';
          return;
        }
        checker.asked.push(goods);
        await onResult?.(goods, (answers[goods.goods_no] ?? []).map(memberCoupon));
        checker.calls++;
      }
    },
  };
  return checker;
}

// Active goods with the given review counts; couponScopes: couponNo -> goodsNos of its first page.
function seedPending(reviews, couponScopes) {
  store.applyScan(DATE, Object.entries(reviews).map(([g, review_count]) => ({ ...goodsRow(Number(g)), review_count })), { cat: '001', complete: true });
  for (const [no, scope] of Object.entries(couponScopes)) store.recordHit(Number(no), DATE, 10, { scopeGoods: scope });
}
const stateOf = (no) => store.getCoupon(no).state;

test('planClassification picks the goods covering most pending coupons, ties by reviews then goods_no', () => {
  const pending = [pendingOf(10, [1, 2]), pendingOf(20, [2, 3]), pendingOf(30, [4]), pendingOf(40, [5, 6])];
  const goods = info({ 1: { review_count: 20 }, 2: { review_count: 10 }, 3: { review_count: 5 }, 4: { review_count: 1 }, 5: { review_count: 7 }, 6: { review_count: 7 } });
  const { plan, unclassifiable } = planClassification(pending, goods);
  // 2 covers two coupons; then 30 (goods 4, 1 review), 40 (goods 5 and 6 tie on reviews: smaller goods_no); 1 and 3 are spent.
  assert.deepEqual(plan, [
    { goods_no: 2, couponNos: [10, 20] },
    { goods_no: 5, couponNos: [40] },
    { goods_no: 4, couponNos: [30] },
  ]);
  assert.deepEqual(unclassifiable, []);
});

test('planClassification never picks a sold-out or non-ACTIVE goods', () => {
  const pending = [pendingOf(10, [1, 2]), pendingOf(20, [1, 3])];
  const goods = info({ 1: { is_sold_out: 1, review_count: 99 }, 2: { review_count: 1 }, 3: { status: 'OUT_OF_SCOPE', review_count: 50 } });
  const { plan, unclassifiable } = planClassification(pending, goods);
  assert.deepEqual(plan, [{ goods_no: 2, couponNos: [10] }]);
  assert.deepEqual(unclassifiable, [20]);
});

test('a pending coupon whose scope goods are all sold out or gone is unclassifiable', () => {
  const pending = [pendingOf(10, [1, 2]), pendingOf(20, [9]), pendingOf(30, [3])];
  const goods = info({ 1: { is_sold_out: 1 }, 2: { status: 'OUT_OF_SCOPE' }, 3: {} }); // 9 is not in goods at all
  const { plan, unclassifiable } = planClassification(pending, goods);
  assert.deepEqual(unclassifiable, [10, 20]);
  assert.deepEqual(plan, [{ goods_no: 3, couponNos: [30] }]);
});

test('classifyPending marks returned coupons USABLE and the rest of the covered ones OTHER', async () => {
  seedPending({ 1: 10, 2: 5 }, { 100: [1], 101: [1], 102: [1], 200: [2], 300: [99] });
  const checker = fakeChecker({ answers: { 1: [100, 102], 2: [] } });
  const r = await classifyPending({ store, checker, date: DATE });
  assert.equal(stateOf(100), COUPON_STATE.USABLE);
  assert.equal(stateOf(102), COUPON_STATE.USABLE);
  assert.equal(stateOf(101), COUPON_STATE.OTHER);
  assert.equal(stateOf(200), COUPON_STATE.OTHER);
  assert.equal(stateOf(300), COUPON_STATE.OUT_OF_SCOPE);
  assert.equal(r.calls, 2);
  assert.equal(r.usable, 2);
  assert.equal(r.other, 2);
  assert.equal(r.outOfScope, 1);
  assert.equal(r.pending, 0);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.checks.map((c) => c.goods_no).sort(), [1, 2]);
  assert.deepEqual(r.checks.find((c) => c.goods_no === 1).couponNos, [100, 102]);
  assert.deepEqual(r.checks.find((c) => c.goods_no === 2).couponNos, []);
  // The result is stored on the goods, priced at the checked values.
  const g = store.getGoods(1);
  assert.equal(g.coupon_checked_date, DATE);
  assert.deepEqual(JSON.parse(g.coupons_json).map((c) => c.id), ['100', '102']);
  assert.equal(g.coupon_checked_sale_price, 50000);
});

test('classifyPending hands the checker full goods rows and its deadline', async () => {
  seedPending({ 1: 10 }, { 100: [1] });
  const checker = fakeChecker({ answers: { 1: [100] } });
  await classifyPending({ store, checker, date: DATE, deadline: 12345 });
  assert.equal(checker.deadline, 12345);
  assert.equal(checker.asked[0].goods_no, 1);
  assert.equal(checker.asked[0].brand, 'nike');
  assert.equal(checker.asked[0].sale_price, 50000);
  assert.equal(checker.asked[0].extra_discount, 0);
});

test('classifyPending stops at cap; leftovers stay PENDING and are counted', async () => {
  seedPending({ 1: 30, 2: 20, 3: 10 }, { 100: [1], 200: [2], 300: [3] });
  const checker = fakeChecker({ answers: {} });
  const r = await classifyPending({ store, checker, date: DATE, cap: 2 });
  assert.deepEqual(checker.asked.map((g) => g.goods_no), [1, 2]); // ties on coverage go to more reviews
  assert.equal(r.calls, 2);
  assert.equal(r.other, 2);
  assert.equal(r.pending, 1);
  assert.equal(stateOf(300), COUPON_STATE.PENDING);
});

test('a checker that stops mid-way leaves the coupons of unchecked goods PENDING', async () => {
  seedPending({ 1: 30, 2: 20 }, { 100: [1], 200: [2] });
  const checker = fakeChecker({ answers: { 1: [100] }, stopAfter: 1 });
  const r = await classifyPending({ store, checker, date: DATE });
  assert.equal(r.calls, 1);
  assert.equal(r.usable, 1);
  assert.equal(r.pending, 1);
  assert.equal(stateOf(100), COUPON_STATE.USABLE);
  assert.equal(stateOf(200), COUPON_STATE.PENDING);
  assert.deepEqual(r.checks.map((c) => c.goods_no), [1]);
});

test('a coupon a member result returns before its own goods is checked becomes USABLE, not OTHER', async () => {
  seedPending({ 1: 30, 2: 20 }, { 100: [1], 200: [2], 201: [2] });
  // goods 2 (covers 200, 201) goes first; its result also holds 100, which goods 1 was planned for.
  const checker = fakeChecker({ answers: { 2: [200, 100], 1: [] } });
  await classifyPending({ store, checker, date: DATE });
  assert.equal(stateOf(100), COUPON_STATE.USABLE);
  assert.equal(stateOf(200), COUPON_STATE.USABLE);
  assert.equal(stateOf(201), COUPON_STATE.OTHER);
});

test('an old-numbered coupon newly seen in a member result becomes a neighbour centre', async () => {
  seedPending({ 1: 10 }, { 350001: [1] });
  store.setMeta('enum_floor', 345000);
  // 334342 is not in the registry and sits below the floor, 360000 is new but above it, 350001 is known.
  const checker = fakeChecker({ answers: { 1: [350001, 334342, 360000] } });
  const r = await classifyPending({ store, checker, date: DATE });
  assert.deepEqual(r.neighborCenters, [334342]);
  assert.deepEqual(r.added.sort((a, b) => a - b), [334342, 360000]);
  assert.equal(stateOf(334342), COUPON_STATE.USABLE);
  assert.deepEqual(r.checks[0].couponNos, [350001, 334342, 360000]);
  assert.equal(r.usable, 1); // only the pending coupon the check settled
});

test('without enum_floor no neighbour centres are produced', async () => {
  seedPending({ 1: 10 }, { 350001: [1] });
  const checker = fakeChecker({ answers: { 1: [350001, 334342] } });
  const r = await classifyPending({ store, checker, date: DATE });
  assert.deepEqual(r.neighborCenters, []);
  assert.deepEqual(r.added, [334342]);
});

test('a non-ok checker classifies nothing', async () => {
  seedPending({ 1: 10 }, { 100: [1], 200: [99] });
  const checker = fakeChecker({ answers: { 1: [100] }, status: 'none' });
  const r = await classifyPending({ store, checker, date: DATE });
  assert.equal(r.calls, 0);
  assert.equal(r.usable + r.other + r.outOfScope, 0);
  assert.deepEqual(r.checks, []);
  assert.deepEqual(r.neighborCenters, []);
  assert.deepEqual(r.added, []);
  assert.equal(checker.asked.length, 0);
  assert.equal(stateOf(100), COUPON_STATE.PENDING);
  assert.equal(stateOf(200), COUPON_STATE.PENDING); // not even the unclassifiable one is touched
});
