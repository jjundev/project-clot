import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClotDatabase } from '../src/db.js';
import {
  DEFAULT_DISCOVERY_AUTH_LIMIT,
  parseAuthLimit,
  selectDiscoveryAuthTargets,
  summarizeMyPriceGap,
} from '../src/discovery.js';
import { pickDisplayPrices, exportDataForGit, handleDiscover } from '../src/cli.js';
import { SessionExpiredError } from '../src/myprice.js';
import { formatHotDealsSummary } from '../src/notifier.js';

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-disc-myprice-'));
  const db = new ClotDatabase(path.join(dir, 'test.db'));
  t.after(() => {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir };
}

// upsertItem binds `url` without a default, so every fixture needs one.
const itemRow = (goods_no, extra = {}) => ({
  goods_no, goods_name: `G${goods_no}`, source: 'discovery', url: `https://www.musinsa.com/products/${goods_no}`, ...extra,
});

test('db: getLastMyPriceDates returns latest date with a real my_price only', (t) => {
  const { db } = tempDb(t);
  for (const g of [1, 2, 3]) db.upsertItem(itemRow(g));
  db.recordPriceLog({ goods_no: 1, date: '2026-09-20', my_price: 1000, estimated_my_price: 1100 });
  db.recordPriceLog({ goods_no: 1, date: '2026-09-25', my_price: 900, estimated_my_price: 1000 });
  db.recordPriceLog({ goods_no: 1, date: '2026-09-26', my_price: null, estimated_my_price: 1000 });
  db.recordPriceLog({ goods_no: 2, date: '2026-09-26', my_price: null, estimated_my_price: 500 });

  const map = db.getLastMyPriceDates([1, 2, 3]);
  assert.equal(map.get(1), '2026-09-25');
  assert.equal(map.has(2), false);
  assert.equal(map.has(3), false);
  assert.equal(db.getLastMyPriceDates([]).size, 0);
});

test('db: estimated lowest update keeps the real lowest date once lowest_my_price exists', (t) => {
  const { db } = tempDb(t);
  db.upsertItem(itemRow(10));
  db.upsertItem(itemRow(11));
  db.updateLowestPrice(10, 1000, null, '2026-09-20');

  db.updateLowestEstimatedPrice(10, 900, '2026-09-26');
  db.updateLowestEstimatedPrice(11, 800, '2026-09-26');

  assert.equal(db.getItem(10).lowest_estimated_price, 900);
  assert.equal(db.getItem(10).lowest_price_date, '2026-09-20');
  assert.equal(db.getItem(11).lowest_estimated_price, 800);
  assert.equal(db.getItem(11).lowest_price_date, '2026-09-26');
});

test('parseAuthLimit: default, zero, bad values', () => {
  assert.equal(DEFAULT_DISCOVERY_AUTH_LIMIT, 120);
  assert.equal(parseAuthLimit(undefined), 120);
  assert.equal(parseAuthLimit(''), 120);
  assert.equal(parseAuthLimit(true), 120);
  assert.equal(parseAuthLimit('abc'), 120);
  assert.equal(parseAuthLimit('-5'), 120);
  assert.equal(parseAuthLimit('0'), 0);
  assert.equal(parseAuthLimit('50'), 50);
  assert.equal(parseAuthLimit(7.9), 7);
});

test('selectDiscoveryAuthTargets: never-priced first, then oldest, skips sold out and duplicates', () => {
  const items = [
    { goodsNo: 5, isSoldOut: false },
    { goodsNo: 3, isSoldOut: false },
    { goodsNo: 4, isSoldOut: true },
    { goodsNo: 2, isSoldOut: false },
    { goodsNo: 1, isSoldOut: false },
    { goodsNo: 3, isSoldOut: false },
  ];
  const last = new Map([[5, '2026-09-20'], [2, '2026-09-10'], [1, '2026-09-20']]);

  const all = selectDiscoveryAuthTargets(items, last, 10);
  assert.deepEqual(all.goodsNos, [3, 2, 1, 5]);
  assert.equal(all.eligible, 4);

  const capped = selectDiscoveryAuthTargets(items, last, 2);
  assert.deepEqual(capped.goodsNos, [3, 2]);
  assert.equal(capped.eligible, 4);

  assert.deepEqual(selectDiscoveryAuthTargets(items, last, 0).goodsNos, []);
});

test('summarizeMyPriceGap: median of myPrice - estimate and count below estimate', () => {
  assert.deepEqual(summarizeMyPriceGap([]), { n: 0, medianDiff: null, belowEstimate: 0 });
  assert.deepEqual(
    summarizeMyPriceGap([
      { myPrice: 900, estimatedMyPrice: 1000 },
      { myPrice: 1000, estimatedMyPrice: 1000 },
      { myPrice: 700, estimatedMyPrice: 1000 },
    ]),
    { n: 3, medianDiff: -100, belowEstimate: 2 }
  );
  assert.deepEqual(
    summarizeMyPriceGap([
      { myPrice: 900, estimatedMyPrice: 1000 },
      { myPrice: 750, estimatedMyPrice: 1000 },
    ]),
    { n: 2, medianDiff: -175, belowEstimate: 2 }
  );
});

test('pickDisplayPrices: real latest pairs with real lowest', () => {
  assert.deepEqual(
    pickDisplayPrices({ my_price: 9000, estimated_my_price: 9500, sale_price: 10000 }, { lowest_my_price: 8500, lowest_estimated_price: 9000 }),
    { current: 9000, lowest: 8500 }
  );
  assert.deepEqual(pickDisplayPrices({ my_price: 9000 }, {}), { current: 9000, lowest: 9000 });
});

test('pickDisplayPrices: estimate-only latest does not pair with a real lowest', () => {
  assert.deepEqual(
    pickDisplayPrices({ my_price: null, estimated_my_price: 9500, sale_price: 10000 }, { lowest_my_price: 8500, lowest_estimated_price: 9200 }),
    { current: 9500, lowest: 9200 }
  );
  assert.deepEqual(
    pickDisplayPrices({ my_price: null, estimated_my_price: 9500 }, { lowest_my_price: 8500 }),
    { current: 9500, lowest: null }
  );
});

test('pickDisplayPrices: sale-only and missing latest', () => {
  assert.deepEqual(pickDisplayPrices({ sale_price: 10000 }, { lowest_sale_price: 9000 }), { current: 10000, lowest: 9000 });
  assert.deepEqual(pickDisplayPrices(undefined, {}), { current: null, lowest: null });
  // No price log yet: keep the old fallback chain (existing export test relies on it)
  assert.deepEqual(pickDisplayPrices(undefined, { lowest_my_price: 45000, lowest_sale_price: 48000 }), { current: null, lowest: 45000 });
  assert.deepEqual(pickDisplayPrices(undefined, { lowest_estimated_price: 72000 }), { current: null, lowest: 72000 });
});

test('exportDataForGit uses paired display prices', (t) => {
  const { db, dir } = tempDb(t);
  db.upsertItem(itemRow(20));
  db.recordPriceLog({ goods_no: 20, date: '2026-09-26', my_price: null, estimated_my_price: 9500, sale_price: 10000 });
  db.updateLowestPrice(20, 8500, null, '2026-09-20');
  db.updateLowestEstimatedPrice(20, 9200, '2026-09-26');

  const jsonPath = exportDataForGit({ dbInstance: db, dataDir: dir });
  const row = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')).items.find((it) => it.goods_no === 20);
  assert.equal(row.current_price, 9500);
  assert.equal(row.lowest_price, 9200);
});

const listing = (goodsNo, extra = {}) => ({
  goodsNo, goodsName: `G${goodsNo}`, brandName: 'B', url: `https://www.musinsa.com/products/${goodsNo}`,
  imageUrl: '', normalPrice: 20000, salePrice: 12000, couponPrice: 10000, estimatedMyPrice: 9200,
  likeCount: 5000, isSoldOut: false, source: 'discovery', ...extra,
});
const authInfo = (goodsNo, myPrice) => ({
  goodsNo, goodsName: `G${goodsNo}`, brandName: 'B', normalPrice: 20000, salePrice: 12000, couponPrice: 10000,
  myPrice, estimatedMyPrice: 9300, isSoldOut: false, discontinued: false, priceSource: 'https-auth',
});
const byCategory = (map) => async ({ categoryCode }) => map[categoryCode] || [];

function runDiscover(t, db, dir, overrides = {}) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  return handleDiscover({ category: '001' }, db, {
    discoverFn: byCategory({ '001': [listing(1), listing(2)] }),
    sessionProvider: async () => 'app_atk=fake',
    authFetchFn: async (g) => authInfo(g, 8000 + g),
    authDelayMs: 0,
    dataDir: dir,
    today: '2026-09-26',
    ...overrides,
  });
}

test('discover: records real my_price next to the listing estimate', async (t) => {
  const { db, dir } = tempDb(t);
  const out = await runDiscover(t, db, dir);
  const log = db.getLatestPrice(1);
  assert.equal(log.my_price, 8001);
  assert.equal(log.estimated_my_price, 9200); // listing estimate, not the auth one (9300)
  assert.equal(db.getItem(1).lowest_my_price, 8001);
  assert.equal(db.getItem(1).lowest_estimated_price, 9200);
  assert.equal(out.find((it) => it.goodsNo === 2).myPrice, 8002);
});

test('discover: no session provider keeps today behavior (estimate only)', async (t) => {
  const { db, dir } = tempDb(t);
  let calls = 0;
  await runDiscover(t, db, dir, { sessionProvider: null, authFetchFn: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(db.getLatestPrice(1).my_price, null);
  assert.equal(db.getLatestPrice(1).estimated_my_price, 9200);
  assert.equal(db.getItem(1).lowest_my_price, null);
});

test('discover: authLimit 0 skips the auth stage', async (t) => {
  const { db, dir } = tempDb(t);
  let calls = 0;
  await runDiscover(t, db, dir, { authLimit: 0, authFetchFn: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(db.getLatestPrice(1).my_price, null);
});

test('discover: expired session with failed refresh leaves the rest estimate-only', async (t) => {
  const { db, dir } = tempDb(t);
  await runDiscover(t, db, dir, {
    discoverFn: byCategory({ '001': [listing(1), listing(2), listing(3)] }),
    sessionProvider: async ({ refresh } = {}) => (refresh ? null : 'app_atk=fake'),
    authFetchFn: async (g) => { if (g === 2) throw new SessionExpiredError(); return authInfo(g, 8000 + g); },
  });
  assert.equal(db.getLatestPrice(1).my_price, 8001);
  assert.equal(db.getLatestPrice(2).my_price, null);
  assert.equal(db.getLatestPrice(3).my_price, null);
  assert.equal(db.getLatestPrice(3).estimated_my_price, 9200);
});

test('discover: same-day rerun without auth keeps the real price', async (t) => {
  const { db, dir } = tempDb(t);
  await runDiscover(t, db, dir);
  await runDiscover(t, db, dir, { sessionProvider: null });
  assert.equal(db.getLatestPrice(1).my_price, 8001);
});

test('discover: never auth-fetches or records VIP items', async (t) => {
  const { db, dir } = tempDb(t);
  db.upsertItem(itemRow(2, { goods_name: 'VIP', source: 'like' }));
  db.recordPriceLog({ goods_no: 2, date: '2026-09-26', my_price: 7000, sale_price: 12000 });
  const fetched = [];
  await runDiscover(t, db, dir, { authFetchFn: async (g) => { fetched.push(g); return authInfo(g, 8000 + g); } });
  assert.deepEqual(fetched, [1]);
  assert.equal(db.getLatestPrice(2).my_price, 7000);
  assert.equal(db.getItem(2).source, 'like');
});

test('discover: dedupes goods seen in two categories', async (t) => {
  const { db, dir } = tempDb(t);
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const fetched = [];
  await handleDiscover({ category: '001,002' }, db, {
    discoverFn: byCategory({ '001': [listing(1)], '002': [listing(1), listing(2)] }),
    sessionProvider: async () => 'app_atk=fake',
    authFetchFn: async (g) => { fetched.push(g); return authInfo(g, 8000 + g); },
    authDelayMs: 0, dataDir: dir, today: '2026-09-26',
  });
  assert.deepEqual(fetched, [1, 2]);
  assert.equal(db.getLatestPrice(1).my_price, 8001);
});

test('discover: discontinued auth result records no my_price', async (t) => {
  const { db, dir } = tempDb(t);
  await runDiscover(t, db, dir, {
    authFetchFn: async (g) => (g === 1 ? { status: 404, discontinued: true } : authInfo(g, 8002)),
  });
  assert.equal(db.getLatestPrice(1).my_price, null);
  assert.equal(db.getLatestPrice(1).estimated_my_price, 9200);
  assert.equal(db.getLatestPrice(2).my_price, 8002);
});

test('discover: prioritizes goods never priced, respects the cap, logs drops like-for-like', async (t) => {
  const { db, dir } = tempDb(t);
  db.upsertItem(itemRow(1));
  db.recordPriceLog({ goods_no: 1, date: '2026-09-25', my_price: 9000, estimated_my_price: 9200 });
  db.upsertItem(itemRow(2));
  db.recordPriceLog({ goods_no: 2, date: '2026-09-25', my_price: null, estimated_my_price: 9900 });

  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'warn', () => {});
  const fetched = [];
  await handleDiscover({ category: '001' }, db, {
    discoverFn: byCategory({ '001': [listing(1), listing(2), listing(3)] }),
    sessionProvider: async () => 'app_atk=fake',
    authFetchFn: async (g) => { fetched.push(g); return authInfo(g, 8000 + g); },
    authDelayMs: 0, authLimit: 2, dataDir: dir, today: '2026-09-26',
  });

  assert.deepEqual(fetched, [2, 3]); // goods 1 was priced most recently -> deferred
  assert.ok(lines.some((l) => l.includes('[Discovery Auth] 2/2 priced (cap 2, 1 deferred')));
  assert.ok(lines.some((l) => l.includes('myPrice drops vs last myPrice: 0'))); // goods 2 had no real baseline
});

test('discover: counts a real drop only against a previous real price', async (t) => {
  const { db, dir } = tempDb(t);
  db.upsertItem(itemRow(1));
  db.recordPriceLog({ goods_no: 1, date: '2026-09-25', my_price: 9000, estimated_my_price: 9200 });
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'warn', () => {});
  await handleDiscover({ category: '001' }, db, {
    discoverFn: byCategory({ '001': [listing(1)] }),
    sessionProvider: async () => 'app_atk=fake',
    authFetchFn: async (g) => authInfo(g, 8500),
    authDelayMs: 0, dataDir: dir, today: '2026-09-26',
  });
  assert.ok(lines.some((l) => l.includes('myPrice drops vs last myPrice: 1')));
  assert.ok(lines.some((l) => l.includes('myPrice vs estimate: n=1')));
  assert.ok(!lines.some((l) => l.includes('app_atk')));
});

test('hot deals: ranks by estimate and shows the real price when present', () => {
  const msg = formatHotDealsSummary([
    { goodsNo: 1, goodsName: 'Cheap by estimate', brandName: 'B', normalPrice: 20000, estimatedMyPrice: 10000, myPrice: 9500 },
    { goodsNo: 2, goodsName: 'Only real is cheap', brandName: 'B', normalPrice: 20000, estimatedMyPrice: 15000, myPrice: 5000 },
    { goodsNo: 3, goodsName: 'No real price', brandName: 'B', normalPrice: 20000, estimatedMyPrice: 12000, myPrice: null },
  ]);
  const lines = msg.split('\n').filter((l) => /^\d\./.test(l));
  assert.match(lines[0], /Cheap by estimate/);
  assert.match(lines[0], /나의 할인가 <b>9,500원<\/b>/);
  assert.match(lines[1], /No real price/);
  assert.doesNotMatch(lines[1], /나의 할인가/);
  assert.match(lines[2], /Only real is cheap/);
});
