import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISCOVERY_DROP_AFTER_MISSES,
  DISCOVERY_MIN_CATEGORY_FILL,
  isDefaultDiscoveryScan,
  isCompleteDiscoveryScan,
  discoverCategoryGoods,
} from '../src/discovery.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ClotDatabase } from '../src/db.js';
import { buildClotDataPayload } from '../src/visualizer.js';
import { handleDiscover, handleWatch, exportDataForGit } from '../src/cli.js';

const okStats = (counts) => counts.map((count, i) => ({ cat: `c${i}`, ok: true, count }));

test('cleanup constants match the confirmed design', () => {
  assert.equal(DISCOVERY_DROP_AFTER_MISSES, 2);
  assert.equal(DISCOVERY_MIN_CATEGORY_FILL, 0.5);
});

test('isDefaultDiscoveryScan: only the four scope flags make a scan non-default', () => {
  assert.equal(isDefaultDiscoveryScan({}), true);
  assert.equal(isDefaultDiscoveryScan(), true);
  // daily --with-discovery forwards its own flags; none of them narrow the scope
  assert.equal(
    isDefaultDiscoveryScan({ 'with-discovery': true, force: true, concurrency: '4', 'auth-limit': '50' }),
    true
  );
  assert.equal(isDefaultDiscoveryScan({ category: '001' }), false);
  assert.equal(isDefaultDiscoveryScan({ limit: '50' }), false);
  assert.equal(isDefaultDiscoveryScan({ limit: true }), false); // bare `--limit`
  assert.equal(isDefaultDiscoveryScan({ 'min-likes': '500' }), false);
  assert.equal(isDefaultDiscoveryScan({ years: '3' }), false);
});

test('isCompleteDiscoveryScan: default flags, all ok, each category >= 50% of limit', () => {
  assert.equal(isCompleteDiscoveryScan({}, okStats([100, 100, 100, 100, 100]), 100), true);
  assert.equal(isCompleteDiscoveryScan({}, okStats([100, 100, 100, 100, 50]), 100), true); // boundary
  assert.equal(isCompleteDiscoveryScan({}, okStats([100, 100, 100, 100, 49]), 100), false);
  assert.equal(
    isCompleteDiscoveryScan({}, [...okStats([100, 100]), { cat: '003', ok: false, count: 0 }], 100),
    false
  );
  assert.equal(isCompleteDiscoveryScan({ category: '001' }, okStats([100]), 100), false);
  assert.equal(isCompleteDiscoveryScan({}, [], 100), false); // nothing scanned is never complete
});

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-disc-cleanup-'));
  const db = new ClotDatabase(path.join(dir, 'test.db'));
  t.after(() => {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir };
}

// upsertItem binds `url` without a default, so every fixture needs one.
const row = (goodsNo, extra = {}) => ({
  goods_no: goodsNo,
  goods_name: `G${goodsNo}`,
  brand_name: 'B',
  url: `https://www.musinsa.com/products/${goodsNo}`,
  source: 'discovery',
  ...extra,
});

test('db: an old items table gains discovery_misses = 0 for existing rows', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-disc-migrate-'));
  const dbPath = path.join(dir, 'old.db');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = new DatabaseSync(dbPath);
  raw.exec(`CREATE TABLE items (
    goods_no INTEGER PRIMARY KEY, goods_name TEXT NOT NULL, brand_name TEXT, url TEXT NOT NULL,
    image_url TEXT, source TEXT DEFAULT 'like', status TEXT DEFAULT 'ACTIVE',
    first_seen_at TEXT NOT NULL, last_checked_at TEXT,
    lowest_my_price INTEGER, lowest_sale_price INTEGER, lowest_price_date TEXT
  );
  INSERT INTO items (goods_no, goods_name, url, source, first_seen_at)
  VALUES (1, 'old', 'https://www.musinsa.com/products/1', 'discovery', '2026-09-05T00:00:00Z');`);
  raw.close();

  const db = new ClotDatabase(dbPath);
  t.after(() => { try { db.close(); } catch {} });
  assert.equal(db.getItem(1).discovery_misses, 0);
});

test('db: markDiscoveryUnseen counts misses and drops at the threshold', (t) => {
  const { db } = tempDb(t);
  db.upsertItem(row(1));
  db.upsertItem(row(2));
  db.upsertItem(row(3, { status: 'SOLDOUT' }));

  assert.deepEqual(db.markDiscoveryUnseen([2], 2), { dropped: 0 });
  assert.equal(db.getItem(1).discovery_misses, 1);
  assert.equal(db.getItem(1).status, 'ACTIVE');
  assert.equal(db.getItem(2).discovery_misses, 0);

  assert.deepEqual(db.markDiscoveryUnseen([2], 2), { dropped: 2 });
  assert.equal(db.getItem(1).status, 'DROPPED');
  assert.equal(db.getItem(3).status, 'DROPPED'); // SOLDOUT goods drop too
  assert.equal(db.getItem(2).status, 'ACTIVE');

  // Already DROPPED rows are left alone: no further counting, not re-reported.
  assert.deepEqual(db.markDiscoveryUnseen([2], 2), { dropped: 0 });
  assert.equal(db.getItem(1).discovery_misses, 2);
});

test('db: markDiscoveryUnseen never touches VIP or UNLIKED rows', (t) => {
  const { db } = tempDb(t);
  db.upsertItem(row(10, { source: 'like' }));
  db.upsertItem(row(11, { source: 'like', status: 'UNLIKED' }));
  db.markDiscoveryUnseen([], 1);
  db.markDiscoveryUnseen([], 1);
  assert.equal(db.getItem(10).status, 'ACTIVE');
  assert.equal(db.getItem(10).discovery_misses, 0);
  assert.equal(db.getItem(11).status, 'UNLIKED');
});

test('db: markDiscoverySeen resets the counter', (t) => {
  const { db } = tempDb(t);
  db.upsertItem(row(1));
  db.markDiscoveryUnseen([], 2);
  assert.equal(db.getItem(1).discovery_misses, 1);
  db.markDiscoverySeen([1]);
  assert.equal(db.getItem(1).discovery_misses, 0);
  db.markDiscoverySeen([]); // no-op, no throw
});

test('db: promoting a DROPPED goods revives it as a tracked VIP', (t) => {
  const { db } = tempDb(t);
  db.upsertItem(row(1));
  db.markDiscoveryUnseen([], 1);
  assert.equal(db.getItem(1).status, 'DROPPED');

  db.promoteItemToLike(1);
  const it = db.getItem(1);
  assert.equal(it.source, 'like');
  assert.equal(it.status, 'ACTIVE');
  assert.equal(it.discovery_misses, 0);
  assert.ok(db.getActiveVipItems().some((r) => r.goods_no === 1));
});

test('db: promoting keeps a non-DROPPED status as is', (t) => {
  const { db } = tempDb(t);
  db.upsertItem(row(2, { status: 'SOLDOUT' }));
  db.promoteItemToLike(2);
  assert.equal(db.getItem(2).status, 'SOLDOUT');
  assert.equal(db.getItem(2).source, 'like');
});

test('db: DROPPED goods leave every tracking query and the dashboard', (t) => {
  const { db } = tempDb(t);
  db.upsertItem(row(1));
  db.upsertItem(row(2));
  db.recordPriceLog({ goods_no: 1, date: '2026-09-05', sale_price: 10000, estimated_my_price: 9000 });
  db.markDiscoveryUnseen([2], 1);

  assert.equal(db.getItem(1).status, 'DROPPED');
  assert.equal(db.getPriceLogs(1).length, 1); // history kept
  assert.deepEqual(db.getActiveItems().map((r) => r.goods_no), [2]);
  assert.deepEqual(db.getDiscoveredActiveItems().map((r) => r.goods_no), [2]);
  assert.deepEqual(buildClotDataPayload(db.db).items.map((it) => it.n), [2]);
});

const CATEGORIES = ['001', '002', '003', '103', '004'];

const listing = (goodsNo, extra = {}) => ({
  goodsNo, goodsName: `G${goodsNo}`, brandName: 'B', url: `https://www.musinsa.com/products/${goodsNo}`,
  imageUrl: '', normalPrice: 20000, salePrice: 12000, couponPrice: 10000, estimatedMyPrice: 9200,
  likeCount: 5000, isSoldOut: false, source: 'discovery', ...extra,
});

// Each default category returns `counts[cat] ?? 60` filler goods (>= 50% of limit 100) plus `extra[cat]`.
function fullScan(extra = {}, { counts = {}, fail = [] } = {}) {
  return async ({ categoryCode }) => {
    if (fail.includes(categoryCode)) throw new Error(`HTTP 500 for ${categoryCode}`);
    const base = 100000 + CATEGORIES.indexOf(categoryCode) * 1000;
    const fillers = Array.from({ length: counts[categoryCode] ?? 60 }, (_, i) => listing(base + i));
    return [...fillers, ...(extra[categoryCode] || [])];
  };
}

/** Silences discover output and returns the captured console.log lines. Call once per test. */
function quiet(t) {
  const logs = [];
  t.mock.method(console, 'log', (...a) => logs.push(a.join(' ')));
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  return logs;
}

const discover = (db, dir, discoverFn, flags = {}) =>
  handleDiscover(flags, db, { discoverFn, authLimit: 0, dataDir: dir, today: '2026-09-26' });

const seed = (db, dir, goods) => discover(db, dir, fullScan({ '001': goods }));

test('discover: two consecutive complete misses drop a goods, one miss keeps it', async (t) => {
  const { db, dir } = tempDb(t);
  const logs = quiet(t);
  await seed(db, dir, [listing(1), listing(2)]);

  await discover(db, dir, fullScan({ '001': [listing(2)] }));
  assert.equal(db.getItem(1).status, 'ACTIVE');
  assert.equal(db.getItem(1).discovery_misses, 1);

  await discover(db, dir, fullScan({ '001': [listing(2)] }));
  assert.equal(db.getItem(1).status, 'DROPPED');
  assert.equal(db.getItem(2).status, 'ACTIVE');
  assert.equal(db.getItem(2).discovery_misses, 0);
  assert.equal(db.getPriceLogs(1).length, 1);
  assert.ok(logs.includes('🧹 [Discovery] 2회 연속 미노출 1개 → DROPPED, 재등장 0개 복귀'));
});

const PARTIAL_SCANS = [
  ['--category 001', { category: '001' }, fullScan({ '001': [listing(2)] })],
  ['--limit 50', { limit: '50' }, fullScan({ '001': [listing(2)] })],
  ['a failing category', {}, fullScan({ '001': [listing(2)] }, { fail: ['003'] })],
  ['a category under 50% of limit', {}, fullScan({ '001': [listing(2)] }, { counts: { '004': 49 } })],
];

for (const [label, flags, discoverFn] of PARTIAL_SCANS) {
  test(`discover: partial scan (${label}) changes no miss counts or statuses`, async (t) => {
    const { db, dir } = tempDb(t);
    const logs = quiet(t);
    await seed(db, dir, [listing(1), listing(2)]);

    await discover(db, dir, discoverFn, flags);
    await discover(db, dir, discoverFn, flags);
    assert.equal(db.getItem(1).status, 'ACTIVE');
    assert.equal(db.getItem(1).discovery_misses, 0);
    assert.ok(logs.includes('🧹 [Discovery] 부분 스캔이라 정리를 건너뜀'));
  });
}

async function dropGoods1(db, dir) {
  await seed(db, dir, [listing(1), listing(2)]);
  await discover(db, dir, fullScan({ '001': [listing(2)] }));
  await discover(db, dir, fullScan({ '001': [listing(2)] }));
  assert.equal(db.getItem(1).status, 'DROPPED');
}

test('discover: a DROPPED goods listed again comes back with the listing status', async (t) => {
  const { db, dir } = tempDb(t);
  const logs = quiet(t);
  await dropGoods1(db, dir);

  await discover(db, dir, fullScan({ '001': [listing(1, { isSoldOut: true }), listing(2)] }));
  assert.equal(db.getItem(1).status, 'SOLDOUT');
  assert.equal(db.getItem(1).discovery_misses, 0);
  assert.ok(logs.includes('🧹 [Discovery] 2회 연속 미노출 0개 → DROPPED, 재등장 1개 복귀'));
});

test('discover: a partial scan also revives a DROPPED goods', async (t) => {
  const { db, dir } = tempDb(t);
  const logs = quiet(t);
  await dropGoods1(db, dir);

  await discover(db, dir, fullScan({ '001': [listing(1)] }), { category: '001' });
  assert.equal(db.getItem(1).status, 'ACTIVE');
  assert.equal(db.getItem(1).discovery_misses, 0);
  assert.ok(logs.includes('🧹 [Discovery] 부분 스캔이라 정리를 건너뜀 (재등장 1개 복귀)'));
});

test('discover: a partial-scan sighting restarts the miss count', async (t) => {
  const { db, dir } = tempDb(t);
  quiet(t);
  await seed(db, dir, [listing(1), listing(2)]);
  await discover(db, dir, fullScan({ '001': [listing(2)] })); // miss 1
  await discover(db, dir, fullScan({ '001': [listing(1)] }), { category: '001' }); // seen, partial
  await discover(db, dir, fullScan({ '001': [listing(2)] })); // miss 1 again, not 2
  assert.equal(db.getItem(1).status, 'ACTIVE');
  assert.equal(db.getItem(1).discovery_misses, 1);
});

test('discover: a goods listed in two categories is seen once, never missed', async (t) => {
  const { db, dir } = tempDb(t);
  quiet(t);
  const both = fullScan({ '001': [listing(1)], '002': [listing(1)] });
  await discover(db, dir, both);
  await discover(db, dir, both);
  assert.equal(db.getItem(1).status, 'ACTIVE');
  assert.equal(db.getItem(1).discovery_misses, 0);
});

test('discover: VIP goods absent from complete scans are untouched', async (t) => {
  const { db, dir } = tempDb(t);
  quiet(t);
  db.upsertItem({ goods_no: 50, goods_name: 'VIP', url: 'https://www.musinsa.com/products/50', source: 'like' });
  await discover(db, dir, fullScan());
  await discover(db, dir, fullScan());
  assert.equal(db.getItem(50).status, 'ACTIVE');
  assert.equal(db.getItem(50).source, 'like');
  assert.equal(db.getItem(50).discovery_misses, 0);
});

test('discover: a known discovery goods follows the listing sold-out state', async (t) => {
  const { db, dir } = tempDb(t);
  quiet(t);
  await seed(db, dir, [listing(1)]);
  assert.equal(db.getItem(1).status, 'ACTIVE');

  await discover(db, dir, fullScan({ '001': [listing(1, { isSoldOut: true })] }));
  assert.equal(db.getItem(1).status, 'SOLDOUT');

  await discover(db, dir, fullScan({ '001': [listing(1)] }));
  assert.equal(db.getItem(1).status, 'ACTIVE');
});

test('export: DROPPED goods stay in latest_prices.json with their status and a count', async (t) => {
  const { db, dir } = tempDb(t);
  quiet(t);
  await dropGoods1(db, dir);

  const summary = JSON.parse(fs.readFileSync(exportDataForGit({ dbInstance: db, dataDir: dir }), 'utf-8'));
  assert.equal(summary.dropped_items, 1);
  assert.equal(summary.items.find((it) => it.goods_no === 1).status, 'DROPPED');
});

// One listing page with a single recent goods; `likesOk` decides whether the like-count API answers.
function listingPageFetch({ likesOk }) {
  return async (url) => {
    if (url.includes('like.musinsa.com')) {
      if (!likesOk) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ data: { contents: { items: [{ relationId: '7001', count: 1500 }] } } }) };
    }
    const nextData = { props: { pageProps: { dehydratedState: { queries: [{ queryKey: ['001'], state: { data: { pages: [{ data: {
      list: [{ goodsNo: 7001, goodsName: 'P', brandName: 'B', price: 50000, finalPrice: 45000,
        thumbnail: 'https://image.msscdn.net/images/goods_img/20260701/7001/7001_1_500.jpg' }],
      pagination: { hasNext: false },
    } }] } } }] } } } };
    return { ok: true, text: async () => `<script id="__NEXT_DATA__">${JSON.stringify(nextData)}</script>` };
  };
}

test('discoverCategoryGoods reports a failed like-count batch through onDegraded', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let degraded = 0;
  const onDegraded = () => { degraded++; };
  const base = { categoryCode: '001', limit: 10, minLikes: 1000, years: 2, delayMs: 0, onDegraded };

  assert.equal((await discoverCategoryGoods({ ...base, fetchFn: listingPageFetch({ likesOk: true }) })).length, 1);
  assert.equal(degraded, 0);
  assert.equal((await discoverCategoryGoods({ ...base, fetchFn: listingPageFetch({ likesOk: false }) })).length, 0);
  assert.equal(degraded, 1);
});

test('discover: a category with a failed like-count batch makes the scan partial', async (t) => {
  const { db, dir } = tempDb(t);
  const logs = quiet(t);
  await seed(db, dir, [listing(1), listing(2)]);

  const inner = fullScan({ '001': [listing(2)] });
  const flaky = async (args) => {
    if (args.categoryCode === '002') args.onDegraded?.(); // one like batch failed, the rest still came back
    return inner(args);
  };
  await discover(db, dir, flaky);
  await discover(db, dir, flaky);
  assert.equal(db.getItem(1).status, 'ACTIVE');
  assert.equal(db.getItem(1).discovery_misses, 0);
  assert.ok(logs.includes('🧹 [Discovery] 부분 스캔이라 정리를 건너뜀'));
});

const watchInfo = (goodsNo, extra = {}) => ({
  goodsNo, goodsName: `G${goodsNo}`, brandName: 'B', url: `https://www.musinsa.com/products/${goodsNo}`,
  imageUrl: '', normalPrice: 20000, salePrice: 12000, saleRate: 40, myPrice: null,
  isSoldOut: false, discontinued: false, ...extra,
});

test('watch: a DROPPED discovery goods becomes a tracked manual goods', async (t) => {
  const { db, dir } = tempDb(t);
  quiet(t);
  await dropGoods1(db, dir);

  await handleWatch(['1'], { dbInstance: db, dataDir: dir, fetchInfoFn: async (g) => watchInfo(g) });
  const it = db.getItem(1);
  assert.equal(it.source, 'manual'); // not 'like': sync would unlike a goods missing from Musinsa likes
  assert.equal(it.status, 'ACTIVE');
  assert.equal(it.discovery_misses, 0);
  assert.ok(db.getActiveVipItems().some((r) => r.goods_no === 1));
});

test('watch: a watched discovery goods is no longer subject to cleanup', async (t) => {
  const { db, dir } = tempDb(t);
  quiet(t);
  await seed(db, dir, [listing(1), listing(2)]);
  await handleWatch(['1'], { dbInstance: db, dataDir: dir, fetchInfoFn: async (g) => watchInfo(g) });

  await discover(db, dir, fullScan({ '001': [listing(2)] }));
  await discover(db, dir, fullScan({ '001': [listing(2)] }));
  assert.equal(db.getItem(1).status, 'ACTIVE');
  assert.equal(db.getItem(1).source, 'manual');
});
