import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackMusinsa, BUDGET_MS_MUSINSA, RUN_BUDGET_MS_MUSINSA } from '../src/musinsaWide/track.js';
import { MusinsaWideStore } from '../src/musinsaWide/store.js';

const DAY1 = '2026-10-13';
const DAY2 = '2026-10-14';
const CATS = ['001', '002'];
const COOKIE = 'session=abc';

let dir;
let store;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musinsa-wide-track-'));
  store = new MusinsaWideStore(path.join(dir, 'wide.db'));
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

// `catalog` maps cat -> items (one page) or an Error to throw on every page request. `coupons` maps goods_no -> raw list.
function fakeMakeClient(catalog, coupons = {}, couponCalls = []) {
  return () => ({
    sleep: async () => {},
    async getCategoryPage(cat) {
      const entry = catalog[cat];
      if (entry instanceof Error) throw entry;
      return { items: entry ?? [], nextPageUrl: null };
    },
    async getUsableCoupons({ goodsNo }) {
      couponCalls.push(goodsNo);
      return coupons[goodsNo] ?? [];
    },
  });
}

const session = () => Object.assign(async () => COOKIE, { absorb: () => null });
const quiet = [];
const log = (m) => quiet.push(m);

const run = (overrides) => trackMusinsa({ store, date: DAY1, categories: CATS, log, ...overrides });

test('budgets are 20 and 35 minutes', () => {
  assert.equal(BUDGET_MS_MUSINSA, 20 * 60_000);
  assert.equal(RUN_BUDGET_MS_MUSINSA, 35 * 60_000);
});

test('dry run scans and writes nothing', async () => {
  const makeClient = fakeMakeClient({ '001': [item(1, 10000), item(2, 20000)], '002': [item(3, 30000)] });
  const res = await run({ makeClient, dryRun: true, sessionProvider: session() });
  assert.equal(res.diff, null);
  assert.equal(res.coupons, null);
  assert.deepEqual(res.categoryCounts.map((c) => [c.cat, c.scanned, c.pages, c.complete]), [['001', 2, 1, true], ['002', 1, 1, true]]);
  assert.equal(store.isEmpty(), true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM scan_runs').get().n, 0);
});

test('a full run records listings, checks coupons and prices them', async () => {
  const couponCalls = [];
  const makeClient = fakeMakeClient(
    { '001': [item(1, 10000), item(2, 20000)], '002': [item(3, 30000, { extraDiscountAmount: 500 })] },
    { 1: [rawCoupon(11, 10)], 3: [rawCoupon(31, 10), rawCoupon(32, 5)] }, couponCalls,
  );
  const res = await run({ makeClient, sessionProvider: session() });
  assert.equal(res.date, DAY1);
  assert.equal(res.diff.initial, true);
  assert.equal(res.diff.added.length, 3);
  assert.equal(res.coupons.memberStatus, 'ok');
  assert.equal(res.coupons.checked, 3);
  assert.equal(res.coupons.failed, 0);
  assert.equal(res.coupons.priced, 3);
  assert.equal(res.coupons.stale, 0);
  assert.equal(store.getGoods(1).coupon_price, 9000);
  assert.equal(store.getGoods(2).coupon_price, 20000);
  assert.equal(store.getGoods(3).coupon_price, 30000 - 500 - 3000);
  const row = store.db.prepare('SELECT * FROM scan_runs WHERE date = ?').get(DAY1);
  assert.equal(row.complete, 1);
  assert.equal(row.added, 3);
  assert.equal(row.coupons_ok, 1);
  assert.equal(row.coupon_checks, 3);
  assert.deepEqual(JSON.parse(row.category_counts_json).map((c) => c.cat), ['001', '002']);
  assert.ok(res.durationMs >= 0);
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

test('without a session the scan is stored and coupon prices come from the stored coupons', async () => {
  const makeClient1 = fakeMakeClient({ '001': [item(1, 10000)], '002': [] }, { 1: [rawCoupon(11, 10)] });
  await run({ makeClient: makeClient1, date: DAY1, sessionProvider: session() });
  assert.equal(store.getGoods(1).coupon_price, 9000);

  const lines = [];
  const couponCalls = [];
  const makeClient2 = fakeMakeClient({ '001': [item(1, 8000)], '002': [] }, {}, couponCalls);
  const res = await run({ makeClient: makeClient2, date: DAY2, sessionProvider: null, log: (m) => lines.push(m) });
  assert.deepEqual(couponCalls, []);
  assert.equal(res.coupons.memberStatus, 'none');
  assert.equal(res.coupons.checked, 0);
  assert.equal(res.coupons.priced, 1);
  assert.equal(store.getGoods(1).coupon_price, 7200);
  assert.ok(lines.includes('⚠️ [무신사] 쿠폰 조회 none — 저장된 쿠폰 목록으로 계산'));
  const row = store.db.prepare('SELECT * FROM scan_runs WHERE date = ?').get(DAY2);
  assert.equal(row.coupons_ok, 0);
  assert.equal(row.coupon_checks, 0);
});

test('a coupon check that throws becomes memberStatus error and prices still run', async () => {
  const makeClient = fakeMakeClient({ '001': [item(1, 10000)], '002': [] });
  const boom = Object.assign(async () => { throw new Error('nope'); }, { absorb: () => null });
  const res = await run({ makeClient, sessionProvider: boom });
  assert.equal(res.coupons.memberStatus, 'error');
  assert.equal(res.coupons.priced, 0);
  assert.equal(res.coupons.stale, 1);
});

test('the coupon check throwing is logged as memberStatus error and the run still finishes', async () => {
  const makeClient = fakeMakeClient({ '001': [item(1, 10000)], '002': [] });
  store.pickSample = () => { throw new Error('db gone'); };
  const lines = [];
  const res = await run({ makeClient, sessionProvider: session(), log: (m) => lines.push(m) });
  assert.deepEqual([res.coupons.memberStatus, res.coupons.checked, res.coupons.failed], ['error', 0, 0]);
  assert.ok(lines.includes('⚠️ [무신사] 쿠폰 조회 error — 저장된 쿠폰 목록으로 계산'));
  assert.equal(store.db.prepare('SELECT coupons_ok FROM scan_runs WHERE date = ?').get(DAY1).coupons_ok, 0);
});
