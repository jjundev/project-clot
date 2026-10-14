import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  trackMusinsa, backfillMusinsaCoupons, BUDGET_MS_MUSINSA, RUN_BUDGET_MS_MUSINSA, ENUM_BUDGET_MS, CLASSIFY_BUDGET_MS,
  BACKFILL_BUDGET_MS, BACKFILL_ENUM_BUDGET_MS, CURSOR_EVERY,
} from '../src/musinsaWide/track.js';
import { MusinsaWideStore } from '../src/musinsaWide/store.js';
import { parseCoupon } from '../src/musinsaWide/coupons.js';
import { ALL_CATEGORIES_PARAM } from '../src/musinsaWide/client.js';

const DAY0 = '2026-10-12';
const DAY1 = '2026-10-13';
const DAY2 = '2026-10-14';
const T0 = Date.parse('2026-10-13T00:00:00Z');
const MIN = 60_000;
const CATS = ['001', '002'];
const COOKIE = 'session=abc';

let dir;
let store;
let clock;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musinsa-wide-track-'));
  store = new MusinsaWideStore(path.join(dir, 'wide.db'));
  clock = { t: T0 };
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const item = (goodsNo, price, over = {}) => ({
  goodsNo, goodsName: `상품 ${goodsNo}`, brand: 'brandx', brandName: '브랜드X', price, normalPrice: price, goodsLinkUrl: `https://www.musinsa.com/products/${goodsNo}`, ...over,
});
const rawCoupon = (id, rate) => ({
  couponNo: id, couponName: `${rate}% 쿠폰`, couponKind: '%', couponValue: String(rate), maxLimitAmount: 0, lowPrice: 0, salePrice: 0, useToDate: '2030-01-01T00:00:00+09:00',
});

/**
 * `catalog` maps cat -> items (one page) or an Error to throw on every page request. `api` is the coupon side:
 * `members` goods_no -> raw member coupons, `counts` coupon_no -> goods count, `lists` coupon_no -> goods numbers,
 * `pageError(couponNo, { page, category })` -> an error to throw, `tick` { count, member } ms the clock moves per call.
 * Every coupon call lands in `api.calls` as { kind: 'count' | 'page' | 'member', no, page?, category?, t }.
 */
function fakeMakeClient(catalog, api = {}) {
  api.calls ??= [];
  const { calls } = api;
  return () => ({
    sleep: async () => {},
    async getCategoryPage(cat) {
      const entry = catalog[cat];
      if (entry instanceof Error) throw entry;
      return { items: entry ?? [], nextPageUrl: null };
    },
    async getUsableCoupons({ goodsNo }) {
      calls.push({ kind: 'member', no: goodsNo, t: clock.t });
      clock.t += api.tick?.member ?? 0;
      return api.members?.[goodsNo] ?? [];
    },
    async getCouponGoodsCount(couponNo) {
      calls.push({ kind: 'count', no: couponNo, t: clock.t });
      clock.t += api.tick?.count ?? 0;
      return api.counts?.[couponNo] ?? 0;
    },
    async getCouponGoodsPage(couponNo, { page = 1, category } = {}) {
      calls.push({ kind: 'page', no: couponNo, page, category, t: clock.t });
      const err = api.pageError?.(couponNo, { page, category });
      if (err) throw err;
      const goods = api.lists?.[couponNo] ?? [];
      return { items: goods.map((goodsNo) => ({ goodsNo, reviewCount: 100, isSoldOut: false })), totalCount: goods.length, hasNext: false };
    },
  });
}

const session = () => Object.assign(async () => COOKIE, { absorb: () => null });
const quiet = [];
const log = (m) => quiet.push(m);

const run = (overrides) => trackMusinsa({ store, date: DAY1, categories: CATS, log, now: () => clock.t, ...overrides });

// The registry after a finished backfill: enumeration goes on from frontier + 1, numbers below enum_floor are old.
const makeReady = ({ frontier = 1000, floor = 900 } = {}) => {
  store.setMeta('backfill_done', DAY0);
  store.setMeta('frontier', frontier);
  store.setMeta('enum_floor', floor);
};
// Registers USABLE coupons the way a member call does: [couponNo, percent] pairs.
const addUsable = (date, ...pairs) => store.upsertMemberCoupons(date, pairs.map(([no, rate]) => parseCoupon(rawCoupon(no, rate))));
const ofKind = (calls, kind) => calls.filter((c) => c.kind === kind);
const listOf = (couponNo) => store.db.prepare('SELECT goods_no, date FROM coupon_goods WHERE coupon_no = ? ORDER BY goods_no').all(couponNo).map((r) => ({ ...r }));
const scanRun = (date) => store.db.prepare('SELECT * FROM scan_runs WHERE date = ?').get(date);
const catalog3 = () => ({ '001': [item(1, 10000), item(2, 20000)], '002': [item(3, 30000)] });
const NO_REASONS = { unregistered: 0, listGap: 0, retired: 0 };

test('budgets are 20 and 35 minutes; enumeration 12 and classification 15', () => {
  assert.equal(BUDGET_MS_MUSINSA, 20 * 60_000);
  assert.equal(RUN_BUDGET_MS_MUSINSA, 35 * 60_000);
  assert.equal(ENUM_BUDGET_MS, 12 * 60_000);
  assert.equal(CLASSIFY_BUDGET_MS, 15 * 60_000);
});

test('dry run scans and writes nothing', async () => {
  const makeClient = fakeMakeClient({ '001': [item(1, 10000), item(2, 20000)], '002': [item(3, 30000)] });
  const res = await run({ makeClient, dryRun: true, sessionProvider: session() });
  assert.equal(res.diff, null);
  assert.equal(res.coupons, null);
  assert.equal(res.registry, null);
  assert.deepEqual(res.categoryCounts.map((c) => [c.cat, c.scanned, c.pages, c.complete]), [['001', 2, 1, true], ['002', 1, 1, true]]);
  assert.equal(store.isEmpty(), true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM scan_runs').get().n, 0);
});

test('log lines name each category and flag incomplete ones', async () => {
  const lines = [];
  const makeClient = fakeMakeClient({ '001': [item(1, 10000)], '002': new Error('boom') });
  await run({ makeClient, log: (m) => lines.push(m) });
  assert.ok(lines.includes('[무신사] 001: 1개 1페이지'));
  assert.ok(lines.some((l) => l.startsWith('[무신사] 002: 0개 0페이지 (불완전: ')));
});

test('one failing category is incomplete and its listings take no misses', async () => {
  const both = fakeMakeClient({ '001': [item(1, 10000)], '002': [item(3, 30000)] });
  await run({ makeClient: both, date: '2026-10-11' });
  const oneDown = fakeMakeClient({ '001': [item(1, 10000)], '002': new Error('boom') });
  for (const date of ['2026-10-12', '2026-10-13', '2026-10-14']) {
    const res = await run({ makeClient: oneDown, date });
    assert.equal(res.categoryCounts[1].complete, false);
    assert.match(res.categoryCounts[1].problems[0], /^002: page 1 failed/);
  }
  assert.equal(store.getGoods(3).status, 'ACTIVE');
  assert.equal(store.getGoods(3).misses, 0);
  const row = store.db.prepare('SELECT * FROM scan_runs WHERE date = ?').get('2026-10-14');
  assert.equal(row.complete, 0);
});

test('a category that throws inside scanning is caught as incomplete', async () => {
  const make = fakeMakeClient({ '001': [item(1, 10000)], '002': [item(3, 30000)] });
  let made = 0;
  // The second client (cat 002's worker) breaks before scanCategory reads a page: the throw escapes scanCategory itself.
  const makeClient = () => {
    const client = make();
    if (made++ === 1) Object.defineProperty(client, 'sleep', { get() { throw new Error('kaboom'); } });
    return client;
  };
  const res = await run({ makeClient });
  assert.equal(res.categoryCounts[0].complete, true);
  assert.equal(res.categoryCounts[1].complete, false);
  assert.equal(res.categoryCounts[1].scanned, 0);
  assert.deepEqual(res.categoryCounts[1].problems, ['scan: kaboom']);
});

test('every category failing throws with the first problem', async () => {
  const makeClient = fakeMakeClient({ '001': new Error('blocked'), '002': new Error('blocked') });
  await assert.rejects(run({ makeClient }), /001: page 1 failed after 3 attempts: blocked/);
  assert.equal(store.isEmpty(), true);
});

test('partial (--category/--depth) counts no misses anywhere', async () => {
  const full = fakeMakeClient({ '001': [item(1, 10000), item(2, 20000)], '002': [item(3, 30000)] });
  await run({ makeClient: full, date: '2026-10-11' });
  const narrow = fakeMakeClient({ '001': [item(1, 10000)], '002': [item(3, 30000)] });
  for (const date of ['2026-10-12', '2026-10-13', '2026-10-14']) {
    await run({ makeClient: narrow, date, partial: true });
  }
  assert.equal(store.getGoods(2).status, 'ACTIVE');
  assert.equal(store.getGoods(2).misses, 0);
  const row = store.db.prepare('SELECT * FROM scan_runs WHERE date = ?').get('2026-10-14');
  assert.equal(row.complete, 0);
});


// ---- the daily registry flow ----

test('not ready: no coupon API calls at all, prices null, ready false in the result', async () => {
  // A registry left half-built: a pending coupon, a usable one with a list. None of it may be touched.
  store.recordHit(1001, DAY0, 3, { scopeGoods: [1] });
  addUsable(DAY0, [950, 10]);
  let sessionReads = 0;
  const sessionProvider = Object.assign(async () => { sessionReads++; return COOKIE; }, { absorb: () => null });
  const api = { counts: { 1001: 5 }, lists: { 950: [1] }, members: { 1: [rawCoupon(950, 10)] } };
  const lines = [];
  const res = await run({ makeClient: fakeMakeClient(catalog3(), api), sessionProvider, log: (m) => lines.push(m) });

  assert.deepEqual(api.calls, []);
  assert.equal(sessionReads, 0);
  assert.equal(res.registry, null);
  assert.deepEqual(res.coupons, {
    memberStatus: 'skipped', checked: 0, failed: 0, priced: 0, withCoupon: 0, stale: 3, drops: [], lateDrops: 0, dropsSuppressed: false, ready: false,
  });
  assert.deepEqual([1, 2, 3].map((n) => store.getGoods(n).coupon_price), [null, null, null]);
  assert.ok(lines.includes('⚠️ [무신사] 쿠폰 등록부 미완성 — backfill 필요'));
  assert.equal(store.getCoupon(1001).state, 'PENDING');
  assert.equal(store.getMeta('registry_first_priced'), null);
  const row = scanRun(DAY1);
  assert.equal(row.coupon_metrics_json, null);
  assert.equal(row.coupons_ok, 0);
  assert.equal(row.coupon_checks, 0);
});

test('ready: phases run in order and the registry metrics land in scan_runs.coupon_metrics_json', async () => {
  makeReady();
  const api = {
    counts: { 1001: 5 },
    lists: { 1001: [1, 2, 99], 777: [1] },
    // Classifying 1001 on goods 1 also turns up 777, an old number the registry never saw: a neighbour centre.
    members: { 1: [rawCoupon(1001, 10), rawCoupon(777, 5)], 2: [rawCoupon(1001, 10)] },
  };
  const res = await run({ makeClient: fakeMakeClient(catalog3(), api), sessionProvider: session() });

  assert.deepEqual(res.registry, {
    // 1001 hit, then 249 empties walked (5 batches) and the +500/+1000/+2000 probes past 1001.
    enum: { probed: 253, hits: 1, newCoupons: 1, highest: 1001, stop: null },
    recheck: { probed: 0, newPositive: 0, stop: null },
    classify: { calls: 1, usable: 1, other: 0, outOfScope: 0, pending: 0 },
    neighbors: { probed: 100, hits: 0, stop: null },
    walk: { walked: 2, failed: 0, suspectEmpty: 0, calls: 2, stop: null },
    sample: { checked: 2, exact: 2, under: 0, over: 0, reasons: NO_REASONS },
    counts: { usable: 2, pending: 0, expiredYesterday: 0, added: 1, retired: 0 },
  });
  assert.deepEqual(res.coupons, {
    memberStatus: 'ok', checked: 3, failed: 0, priced: 3, withCoupon: 2, stale: 0, drops: [], lateDrops: 0, dropsSuppressed: true, ready: true,
  });
  // The coupon found by the enumeration was classified USABLE, walked and now prices its goods.
  assert.equal(store.getCoupon(1001).state, 'USABLE');
  assert.deepEqual(listOf(1001), [{ goods_no: 1, date: DAY1 }, { goods_no: 2, date: DAY1 }]);
  assert.deepEqual([1, 2, 3].map((n) => store.getGoods(n).coupon_price), [9000, 18000, 30000]);
  assert.equal(store.getMeta('frontier'), '1001');

  // Order: enumeration counts → classification (goods 1) → sample and walk → neighbour counts.
  const calls = api.calls;
  const idx = (pred) => calls.findIndex(pred);
  const lastIdx = (pred) => calls.findLastIndex(pred);
  const isEnumCount = (c) => c.kind === 'count' && c.no >= 1001;
  const isNeighborCount = (c) => c.kind === 'count' && c.no >= 727 && c.no <= 827;
  const isWalkPage = (c) => c.kind === 'page' && c.category === ALL_CATEGORIES_PARAM;
  assert.deepEqual(calls.find((c) => c.kind === 'page'), { kind: 'page', no: 1001, page: 1, category: undefined, t: T0 }); // the enumeration's first page
  assert.ok(lastIdx(isEnumCount) < idx((c) => c.kind === 'member'));
  assert.equal(calls.find((c) => c.kind === 'member').no, 1);
  assert.ok(idx((c) => c.kind === 'member') < idx(isWalkPage));
  assert.deepEqual(calls.filter(isWalkPage).map((c) => c.no).sort(), [1001, 777]);
  assert.ok(Math.max(lastIdx(isWalkPage), lastIdx((c) => c.kind === 'member')) < idx(isNeighborCount));
  assert.equal(calls.filter(isNeighborCount).length, 100);

  const row = scanRun(DAY1);
  assert.deepEqual(JSON.parse(row.coupon_metrics_json), res.registry);
  assert.equal(row.coupons_ok, 1);
  assert.equal(row.coupon_checks, 3);
});

test('a coupon first found by the sample is walked the same day', async () => {
  makeReady();
  addUsable(DAY0, [950, 10]);
  const api = {
    lists: { 950: [1], 5000: [2, 3], 500: [3] },
    // 5000 is new and above the floor; 500 is new and old (below enum_floor 900): a neighbour centre.
    members: { 1: [rawCoupon(950, 10)], 2: [rawCoupon(5000, 20)], 3: [rawCoupon(500, 5)] },
  };
  const res = await run({ makeClient: fakeMakeClient(catalog3(), api), sessionProvider: session() });

  assert.deepEqual(res.registry.walk, { walked: 3, failed: 0, suspectEmpty: 0, calls: 3, stop: null });
  assert.deepEqual(res.registry.neighbors, { probed: 100, hits: 0, stop: null });
  assert.equal(res.registry.counts.added, 2);
  assert.deepEqual(listOf(5000).map((r) => r.goods_no), [2, 3]);
  assert.deepEqual(listOf(500).map((r) => r.goods_no), [3]);
  assert.deepEqual([1, 2, 3].map((n) => store.getGoods(n).coupon_price), [9000, 16000, 24000]);
  // The sample-found coupons were walked after the sample: no member call comes after their pages.
  const calls = api.calls;
  const firstLate = calls.findIndex((c) => c.kind === 'page' && (c.no === 5000 || c.no === 500));
  assert.ok(firstLate > calls.findLastIndex((c) => c.kind === 'member'));
  assert.ok(calls.some((c) => c.kind === 'count' && c.no === 450));
  assert.ok(!calls.some((c) => c.kind === 'count' && c.no === 500)); // a registered number is no neighbour to ask about
});

test('anonymous 429 during the walk: unwalked coupons keep yesterday\'s lists, prices and scan_runs still written', async () => {
  makeReady();
  addUsable(DAY0, [950, 10], [960, 20]);
  await run({ makeClient: fakeMakeClient(catalog3(), { lists: { 950: [1], 960: [2] } }), sessionProvider: session() });
  assert.deepEqual(listOf(950), [{ goods_no: 1, date: DAY1 }]);

  const throttled = () => Object.assign(new Error('HTTP 429'), { status: 429 });
  const api = { lists: { 950: [1, 2], 960: [] }, pageError: (no, { category }) => (category === ALL_CATEGORIES_PARAM ? throttled() : null) };
  const res = await run({ makeClient: fakeMakeClient(catalog3(), api), date: DAY2, sessionProvider: session() });

  assert.equal(res.registry.walk.stop, 'throttled');
  assert.equal(res.registry.walk.walked, 0);
  assert.ok(res.registry.walk.failed >= 1);
  assert.deepEqual(listOf(950), [{ goods_no: 1, date: DAY1 }]);
  assert.deepEqual(listOf(960), [{ goods_no: 2, date: DAY1 }]);
  assert.deepEqual([1, 2, 3].map((n) => store.getGoods(n).coupon_price), [9000, 16000, 30000]);
  assert.equal(res.coupons.priced, 3);
  const row = scanRun(DAY2);
  assert.ok(row);
  assert.equal(JSON.parse(row.coupon_metrics_json).walk.stop, 'throttled');
});

test('no session: enumeration and the walk still run; classification and sample are skipped; memberStatus none', async () => {
  makeReady();
  addUsable(DAY0, [950, 10]);
  store.recordHit(990, DAY0, 3, { scopeGoods: [1] });
  const api = { counts: { 1001: 2 }, lists: { 1001: [3], 950: [1] }, members: { 1: [rawCoupon(950, 10)] } };
  const lines = [];
  const res = await run({ makeClient: fakeMakeClient(catalog3(), api), sessionProvider: null, log: (m) => lines.push(m) });

  assert.equal(res.coupons.memberStatus, 'none');
  assert.equal(res.coupons.checked, 0);
  assert.deepEqual(ofKind(api.calls, 'member'), []);
  assert.ok(ofKind(api.calls, 'count').length > 0);
  assert.equal(res.registry.enum.newCoupons, 1);
  assert.deepEqual(res.registry.classify, { calls: 0, usable: 0, other: 0, outOfScope: 0, pending: 2 });
  assert.equal(res.registry.sample.checked, 0);
  assert.equal(res.registry.walk.walked, 1);
  assert.ok(api.calls.some((c) => c.kind === 'page' && c.no === 950 && c.category === ALL_CATEGORIES_PARAM));
  assert.equal(store.getGoods(1).coupon_price, 9000);
  assert.ok(lines.includes('⚠️ [무신사] 회원 세션 none — 판별·표본 생략'));
  const row = scanRun(DAY1);
  assert.equal(row.coupons_ok, 0);
  assert.equal(row.coupon_checks, 0);
});

test('a session that throws is memberStatus error and the registry still prices from its lists', async () => {
  makeReady();
  addUsable(DAY0, [950, 10]);
  const boom = Object.assign(async () => { throw new Error('nope'); }, { absorb: () => null });
  const api = { lists: { 950: [1] } };
  const res = await run({ makeClient: fakeMakeClient(catalog3(), api), sessionProvider: boom });
  assert.equal(res.coupons.memberStatus, 'error');
  assert.deepEqual(ofKind(api.calls, 'member'), []);
  assert.equal(res.coupons.priced, 3);
  assert.equal(store.getGoods(1).coupon_price, 9000);
});

test('the first ready run suppresses coupon drops once and records registry_first_priced', async () => {
  // The old flow's last logged coupon price for goods 1: 10,000.
  store.logCouponPriceChanges('2026-10-01', [{ goods_no: 1, sale_price: 10000, coupon_price: 10000 }]);
  makeReady();

  // Ready but no list to price from yet: still suppressed, and not yet the first priced day.
  const day0 = await run({ makeClient: fakeMakeClient(catalog3()), date: DAY0, sessionProvider: session() });
  assert.equal(day0.coupons.dropsSuppressed, true);
  assert.equal(store.getMeta('registry_first_priced'), null);

  // The first day priced from the registry: 10,000 → 8,000 is the switch, not news.
  addUsable(DAY0, [950, 20]);
  const api = { lists: { 950: [1] } };
  const day1 = await run({ makeClient: fakeMakeClient(catalog3(), api), sessionProvider: session() });
  assert.equal(store.getGoods(1).coupon_price, 8000);
  assert.deepEqual(day1.coupons.drops, []);
  assert.equal(day1.coupons.lateDrops, 0);
  assert.equal(day1.coupons.dropsSuppressed, true);
  assert.equal(store.getMeta('registry_first_priced'), DAY1);

  // A same-day rerun logs the same switch against the day before: still suppressed.
  const rerun = await run({ makeClient: fakeMakeClient(catalog3(), api), sessionProvider: session() });
  assert.deepEqual(rerun.coupons.drops, []);
  assert.equal(rerun.coupons.dropsSuppressed, true);
  assert.equal(store.getMeta('registry_first_priced'), DAY1);

  // The next day a real drop is reported.
  const cheaper = { '001': [item(1, 8000), item(2, 20000)], '002': [item(3, 30000)] };
  const day2 = await run({ makeClient: fakeMakeClient(cheaper, api), date: DAY2, sessionProvider: session() });
  assert.equal(day2.coupons.dropsSuppressed, false);
  assert.deepEqual(day2.coupons.drops, [{ goods_no: 1, prevPrice: 8000, currentPrice: 6400, dropRate: 20 }]);
  assert.equal(store.getMeta('registry_first_priced'), DAY1);
});

test('phase deadlines: enumeration stops at 12 min, classification at 15 min', async () => {
  makeReady();
  store.recordEmpty(995, DAY0); // an empty number the recheck would ask about
  const goods = [1, 2, 3, 4, 5, 6];
  for (const g of goods) store.recordHit(900 + g, DAY0, 1, { scopeGoods: [g] });
  const catalog = { '001': [1, 2, 3].map((g) => item(g, 10000)), '002': [4, 5, 6].map((g) => item(g, 10000)) };
  // Every count and member call takes a minute.
  const api = { tick: { count: MIN, member: MIN } };
  const res = await run({ makeClient: fakeMakeClient(catalog, api), sessionProvider: session(), concurrency: 1 });

  const counts = ofKind(api.calls, 'count');
  assert.equal(res.registry.enum.stop, 'deadline');
  assert.equal(res.registry.enum.probed, counts.length);
  assert.ok(counts.length > 0 && counts.every((c) => c.t < T0 + ENUM_BUDGET_MS));
  assert.deepEqual(res.registry.recheck, { probed: 0, newPositive: 0, stop: 'deadline' });
  // Classification starts at minute 12; goods start until the clock is past minute 15, one at a time.
  const members = ofKind(api.calls, 'member');
  assert.equal(res.registry.classify.calls, 4);
  assert.ok(members.slice(0, 4).every((c) => c.t <= T0 + CLASSIFY_BUDGET_MS));
  assert.equal(res.registry.classify.pending, 2);
  // The sample (run deadline 35 min) still checks the two goods classification never reached.
  assert.equal(res.registry.sample.checked, 2);
  assert.equal(members.length, 6);
});

test('a phase that throws is marked error and the run goes on', async () => {
  makeReady();
  addUsable(DAY0, [950, 10]);
  store.maxCouponNo = () => { throw new Error('db gone'); };
  store.pickSample = () => { throw new Error('db gone'); };
  const lines = [];
  const res = await run({ makeClient: fakeMakeClient(catalog3(), { lists: { 950: [1] } }), sessionProvider: session(), log: (m) => lines.push(m) });
  assert.equal(res.registry.enum.stop, 'error');
  assert.equal(res.registry.sample.stop, 'error');
  assert.equal(res.registry.walk.walked, 1);
  assert.equal(store.getGoods(1).coupon_price, 9000);
  assert.equal(JSON.parse(scanRun(DAY1).coupon_metrics_json).enum.stop, 'error');
  assert.ok(lines.includes('⚠️ [무신사] 번호 순회 실패 (Error)'));
  assert.ok(lines.includes('⚠️ [무신사] 표본 조회 실패 (Error)'));
  assert.ok(!lines.join('\n').includes('db gone'));
  assert.ok(!lines.join('\n').includes(COOKIE));
});

test('a same-day rerun re-checks no goods and doubles no lists or observations', async () => {
  makeReady();
  addUsable(DAY0, [950, 10]);
  const api = { lists: { 950: [1, 2] }, members: { 1: [rawCoupon(950, 10)], 2: [rawCoupon(950, 10)] } };
  await run({ makeClient: fakeMakeClient(catalog3(), api), sessionProvider: session() });
  const count = (table) => store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const after1 = { members: ofKind(api.calls, 'member').length, goods: count('coupon_goods'), obs: count('coupon_observations') };
  assert.deepEqual(after1, { members: 3, goods: 2, obs: 2 });

  const res = await run({ makeClient: fakeMakeClient(catalog3(), api), sessionProvider: session() });
  assert.equal(ofKind(api.calls, 'member').length, 3);
  assert.equal(res.registry.sample.checked, 0);
  assert.equal(count('coupon_goods'), 2);
  assert.equal(count('coupon_observations'), 2);
  assert.equal(scanRun(DAY1).coupon_checks, 3);
  assert.deepEqual([1, 2, 3].map((n) => store.getGoods(n).coupon_price), [9000, 18000, 30000]);
});

// --- backfill ---

const goodsRow = (goods_no) => ({
  goods_no, cat: '001', brand: 'brandx', brand_name: '브랜드X', name: `상품 ${goods_no}`,
  url: `https://www.musinsa.com/products/${goods_no}`, image_url: null,
  sale_price: 10000, normal_price: 10000, extra_discount: 0, is_sold_out: 0,
});
const addGoods = (...nos) => store.applyScan(DAY0, nos.map(goodsRow), { cat: '001', complete: true });
const backfill = (overrides) => backfillMusinsaCoupons({ store, date: DAY1, log, now: () => clock.t, ...overrides });
const backfillMeta = () => Object.fromEntries(['enum_floor', 'enum_cursor', 'backfill_done'].map((k) => [k, store.getMeta(k)]));

test('backfill budgets are 160 and 130 minutes; the cursor is saved every 1000 numbers', () => {
  assert.equal(BACKFILL_BUDGET_MS, 160 * MIN);
  assert.equal(BACKFILL_ENUM_BUDGET_MS, 130 * MIN);
  assert.equal(CURSOR_EVERY, 1000);
});

test('first backfill seeds stored coupons, sets enum_floor and walks from 345000 through a sparse gap up to the highest known coupon', async () => {
  addGoods(1, 2);
  // The old per-goods flow stored coupon 345300 on goods 1: seeded USABLE, and the highest number known.
  store.putGoodsCoupons(1, DAY0, [parseCoupon(rawCoupon(345300, 10))], goodsRow(1));
  const api = {
    counts: { 345010: 3, 345120: 2, 345300: 4 }, lists: { 345010: [2], 345120: [1] }, members: { 2: [rawCoupon(345010, 20)] },
  };
  const res = await backfill({ makeClient: fakeMakeClient({}, api), sessionProvider: session() });

  assert.equal(res.seeded, 1);
  assert.equal(res.from, 345000);
  assert.equal(res.done, true);
  assert.equal(res.stop, null);
  assert.equal(res.hits, 3);
  assert.equal(res.memberStatus, 'ok');
  assert.deepEqual(backfillMeta(), { enum_floor: '345000', enum_cursor: null, backfill_done: DAY1 });
  const counts = ofKind(api.calls, 'count').map((c) => c.no);
  assert.equal(Math.min(...counts), 345000);
  assert.ok(counts.includes(345299) && counts.includes(345300)); // the 180-number gap does not end the walk
  assert.ok(res.next > 345300 && res.probed === counts.length);
  // 345010 covers goods 2 (a member call returns it); 345120 covers goods 1, whose call does not return it.
  assert.equal(store.getCoupon(345010).state, 'USABLE');
  assert.equal(store.getCoupon(345120).state, 'OTHER');
  assert.equal(res.classify.calls, 2);
  assert.equal(res.classify.usable, 1);
  assert.equal(res.classify.other, 1);
  // No sample, list walk or price: that is the daily run's job. The only page calls are the new coupons' first pages.
  assert.deepEqual(ofKind(api.calls, 'page').map((c) => c.no).sort(), [345010, 345120]);
});

test('a backfill cut by the enumeration deadline saves enum_cursor and is not done; the next one resumes there and finishes', async () => {
  addGoods(1);
  store.putGoodsCoupons(1, DAY0, [parseCoupon(rawCoupon(345300, 10))], goodsRow(1));
  const api1 = { counts: { 345010: 3, 345300: 4 }, lists: { 345010: [1] }, tick: { count: MIN } };
  // Three minutes of enumeration at a minute per call: the walk stops early.
  const cut = await backfill({ makeClient: fakeMakeClient({}, api1), enumBudgetMs: 3 * MIN, concurrency: 1 });
  assert.equal(cut.done, false);
  assert.equal(cut.stop, 'deadline');
  assert.equal(cut.seeded, 1);
  assert.equal(cut.memberStatus, 'none');
  assert.equal(cut.classify.calls, 0);
  const meta = backfillMeta();
  assert.equal(meta.enum_floor, '345000');
  assert.equal(meta.backfill_done, null);
  assert.equal(meta.enum_cursor, String(cut.next)); // exactly where the run stopped, below the CURSOR_EVERY save step
  assert.ok(cut.next >= 345000 && cut.next < 345300);

  // The next run resumes at the saved cursor, does not seed again and finishes.
  const api2 = { counts: { 345300: 4 } };
  const resumed = await backfill({ makeClient: fakeMakeClient({}, api2), date: DAY2 });
  assert.equal(resumed.from, cut.next);
  assert.equal(resumed.seeded, 0);
  assert.equal(resumed.done, true);
  assert.equal(Math.min(...ofKind(api2.calls, 'count').map((c) => c.no)), cut.next);
  assert.deepEqual(backfillMeta(), { enum_floor: '345000', enum_cursor: null, backfill_done: DAY2 });
});

test('a resumed backfill does not seed again: settled OTHER rows stay settled', async () => {
  addGoods(1);
  store.putGoodsCoupons(1, DAY0, [parseCoupon(rawCoupon(345300, 10))], goodsRow(1));
  const cut = await backfill({ makeClient: fakeMakeClient({}, { tick: { count: MIN } }), enumBudgetMs: MIN, concurrency: 1 });
  assert.equal(cut.done, false);
  store.db.prepare("UPDATE coupons SET state = 'OTHER' WHERE coupon_no = 345300").run(); // settled by a classification
  const res = await backfill({ makeClient: fakeMakeClient({}, { counts: { 345300: 4 } }), date: DAY2 });
  assert.equal(res.seeded, 0);
  assert.equal(store.getCoupon(345300).state, 'OTHER');
});

test('an explicit from starts a first backfill there; a saved cursor wins over it', async () => {
  const api = { counts: { 346100: 1 } };
  const first = await backfill({ makeClient: fakeMakeClient({}, api), from: 346000 });
  assert.equal(first.from, 346000);
  assert.equal(store.getMeta('enum_floor'), '346000');
  assert.equal(Math.min(...ofKind(api.calls, 'count').map((c) => c.no)), 346000);

  store.setMeta('backfill_done', null);
  store.setMeta('enum_cursor', 346500);
  const again = await backfill({ makeClient: fakeMakeClient({}, {}), from: 346000 });
  assert.equal(again.from, 346500);
  assert.equal(store.getMeta('enum_floor'), '346000');
});

test('the cursor is saved every 1000 numbers during the walk', async () => {
  // Hits keep the walk going (200 empties in a row would end it): one coupon every 100 numbers up to 347500.
  const counts = {};
  for (let no = 345050; no <= 347500; no += 100) counts[no] = 1;
  const saves = [];
  const setMeta = store.setMeta.bind(store);
  store.setMeta = (key, value) => {
    if (key === 'enum_cursor') saves.push(value);
    setMeta(key, value);
  };
  const res = await backfill({ makeClient: fakeMakeClient({}, { counts }) });
  assert.equal(res.done, true);
  // The end of the enumeration is saved too, and cleared once the classification has returned.
  assert.deepEqual(saves.slice(-2), [res.next, null]);
  const periodic = saves.slice(0, -2);
  assert.ok(periodic.length >= 2);
  assert.ok(periodic.every((n, i) => n - (i === 0 ? 345000 : periodic[i - 1]) >= CURSOR_EVERY));
});

test('backfill records no empty numbers', async () => {
  addGoods(1);
  store.putGoodsCoupons(1, DAY0, [parseCoupon(rawCoupon(345300, 10))], goodsRow(1));
  const res = await backfill({ makeClient: fakeMakeClient({}, { counts: { 345010: 3, 345300: 4 }, lists: { 345010: [1] } }) });
  assert.equal(res.done, true);
  assert.ok(res.probed > 300);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM coupon_empty_numbers').get().n, 0);
});

test('backfill classification is capped at 1500', async () => {
  const goods = Array.from({ length: 1600 }, (_, i) => i + 1);
  addGoods(...goods);
  // 1600 pending coupons, each covering its own goods.
  for (const g of goods) store.recordHit(345000 + g, DAY0, 1, { scopeGoods: [g] });
  const api = {};
  const res = await backfill({ makeClient: fakeMakeClient({}, api), sessionProvider: session() });
  assert.equal(res.classify.calls, 1500);
  assert.equal(ofKind(api.calls, 'member').length, 1500);
  assert.equal(res.classify.pending, 100);
  assert.equal(res.done, true);
});

test('done sets backfill_done and clears enum_cursor; a following trackMusinsa is ready', async () => {
  store.setMeta('enum_cursor', 345000);
  const res = await backfill({ makeClient: fakeMakeClient({}, {}), sessionProvider: session() });
  assert.equal(res.done, true);
  assert.equal(store.getMeta('backfill_done'), DAY1);
  assert.equal(store.getMeta('enum_cursor'), null);

  const api = {};
  const tracked = await run({ makeClient: fakeMakeClient(catalog3(), api), date: DAY2, sessionProvider: session() });
  assert.equal(tracked.coupons.ready, true);
  assert.notEqual(tracked.registry, null);
});

test('without a member session the classification is skipped but the enumeration still finishes', async () => {
  addGoods(1);
  const api = { counts: { 345010: 1 }, lists: { 345010: [1] } };
  const res = await backfill({ makeClient: fakeMakeClient({}, api) });
  assert.equal(res.memberStatus, 'none');
  assert.equal(res.done, true);
  assert.equal(res.classify.calls, 0);
  assert.equal(res.classify.pending, 1);
  assert.deepEqual(ofKind(api.calls, 'member'), []);
  assert.equal(store.getMeta('backfill_done'), DAY1);
});

test('an enumeration that throws is stop error: not done, the cursor kept, and the classification still runs', async () => {
  addGoods(1);
  store.recordHit(345010, DAY0, 1, { scopeGoods: [1] });
  store.setMeta('enum_cursor', 345200);
  store.maxCouponNo = () => { throw new Error('db gone'); };
  const lines = [];
  const api = { members: { 1: [rawCoupon(345010, 10)] } };
  const res = await backfill({ makeClient: fakeMakeClient({}, api), sessionProvider: session(), log: (m) => lines.push(m) });
  assert.equal(res.stop, 'error');
  assert.equal(res.done, false);
  assert.equal(res.next, 345200);
  assert.equal(store.getMeta('enum_cursor'), '345200');
  assert.equal(store.getMeta('backfill_done'), null);
  assert.equal(res.classify.calls, 1);
  assert.ok(lines.includes('⚠️ [무신사] 번호 순회 실패 (Error)'));
  assert.ok(!lines.join('\n').includes('db gone'));
});

test('a throttled backfill keeps its place: the cursor is the first number of the cut batch', async () => {
  const makeClient = fakeMakeClient({}, { counts: { 345010: 1 } });
  const throttled = () => {
    const client = makeClient();
    const count = client.getCouponGoodsCount.bind(client);
    client.getCouponGoodsCount = async (no) => {
      if (no >= 345100) throw Object.assign(new Error('429'), { status: 429 });
      return count(no);
    };
    return client;
  };
  const res = await backfill({ makeClient: throttled });
  assert.equal(res.stop, 'throttled');
  assert.equal(res.done, false);
  assert.equal(res.next, 345100);
  assert.equal(store.getMeta('enum_cursor'), '345100');
});

test('a classification that fails after a finished enumeration leaves the cursor at the end and is not done; the next run re-walks only the tail, classifies and finishes', async () => {
  addGoods(1);
  store.putGoodsCoupons(1, DAY0, [parseCoupon(rawCoupon(345300, 10))], goodsRow(1));
  const counts = { 345010: 3, 345300: 4 };
  const lists = { 345010: [1] };
  const pendingCoupons = store.pendingCoupons.bind(store);
  store.pendingCoupons = () => { throw new Error('killed'); };
  const first = await backfill({ makeClient: fakeMakeClient({}, { counts, lists }), sessionProvider: session() });
  assert.equal(first.done, false);
  assert.equal(first.stop, 'error');
  assert.equal(store.getMeta('backfill_done'), null);
  assert.equal(store.getMeta('enum_cursor'), String(first.next));
  assert.ok(first.next > 345300);

  store.pendingCoupons = pendingCoupons;
  const api = { counts, lists, members: { 1: [rawCoupon(345010, 10)] } };
  const second = await backfill({ makeClient: fakeMakeClient({}, api), sessionProvider: session(), date: DAY2 });
  assert.equal(second.from, first.next);
  assert.equal(second.seeded, 0);
  // Only the tail past the last coupon: the empty stretch and the three look-ahead probes, not the 345000-345300 walk.
  assert.ok(second.probed <= 250 + 3 && second.probed < first.probed);
  assert.equal(Math.min(...ofKind(api.calls, 'count').map((c) => c.no)), first.next);
  assert.equal(second.classify.calls, 1);
  assert.equal(store.getCoupon(345010).state, 'USABLE');
  assert.equal(second.done, true);
  assert.deepEqual(backfillMeta(), { enum_floor: '345000', enum_cursor: null, backfill_done: DAY2 });
});
