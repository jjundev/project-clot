import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { track4910, probe4910 } from '../src/site4910/track.js';
import { createClient } from '../src/site4910/client.js';
import { Store4910 } from '../src/site4910/store.js';

const BRANDS = [
  { sno: 2421, key: 'uniqlo', name: '유니클로' },
  { sno: 13647, key: 'gu', name: 'GU' },
];

const entry = (sno, price) => ({
  item: { sno, name: `listing ${sno}`, market_sno: 1 },
  logging: { analytics: { MARKET_NAME: 'seller', STANDARD_CATEGORY_NAME: 'cat', SALES_PRICE: price, DISCOUNT_RATE: 0 } },
  render: { data: { image: { url: null }, closed_reason: null, original_price: null } },
});

// One page per brand; a brand listed in `failing` throws on every call.
function fakeClient(catalog, { failing = [] } = {}) {
  return {
    async listBrandGoods({ brandSno }) {
      if (failing.includes(brandSno)) throw Object.assign(new Error('HTTP 503'), { status: 503 });
      const items = catalog[brandSno] ?? [];
      return { totalCount: items.length, entries: items.map(([sno, price]) => entry(sno, price)), lastSno: null };
    },
  };
}

const CATALOG = { 2421: [[1, 50000], [2, 30000], [3, 9900]], 13647: [[11, 19900], [12, 29900]] };

let dir;
let store;
const quiet = () => {};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-4910-track-'));
  store = new Store4910(path.join(dir, '4910.db'));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scans every brand and applies one diff', async () => {
  const res = await track4910({ client: fakeClient(CATALOG), store, date: '2026-10-10', brands: BRANDS, log: quiet });
  assert.deepEqual(res.brandCounts.map((b) => [b.name, b.total, b.scanned, b.complete]), [['유니클로', 3, 3, true], ['GU', 2, 2, true]]);
  assert.equal(res.diff.added.length, 5);
  assert.equal(res.diff.initial, true);
  assert.equal(res.date, '2026-10-10');
  const run = store.db.prepare('SELECT * FROM scan_runs').get();
  assert.equal(run.complete, 1);
  assert.equal(run.added, 5);
});

test('brand failure marks it incomplete and keeps the other brand', async () => {
  await track4910({ client: fakeClient(CATALOG), store, date: '2026-10-10', brands: BRANDS, log: quiet });
  const catalog = { ...CATALOG, 2421: [[1, 45000], [2, 30000]] };
  const res = await track4910({ client: fakeClient(catalog, { failing: [13647] }), store, date: '2026-10-11', brands: BRANDS, log: quiet });

  assert.equal(res.brandCounts[0].complete, true);
  assert.equal(res.brandCounts[1].complete, false);
  assert.equal(res.brandCounts[1].total, null);
  assert.match(res.brandCounts[1].problems[0], /HTTP 503/);
  assert.equal(store.getGoods(1).status, 'ACTIVE');
  assert.equal(store.getGoods(1).sale_price, 45000);
  assert.equal(store.getGoods(3).misses, 1); // uniqlo was complete, so its missing listing counts
  assert.equal(store.getGoods(11).misses, 0); // GU was not, so its listings are frozen
  assert.equal(store.db.prepare('SELECT complete FROM scan_runs WHERE date = ?').get('2026-10-11').complete, 0);
});

test('dryRun writes nothing', async () => {
  const res = await track4910({ client: fakeClient(CATALOG), store: null, date: '2026-10-10', brands: BRANDS, dryRun: true, log: quiet });
  assert.equal(res.diff, null);
  assert.equal(res.brandCounts[0].scanned, 3);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM goods').get().n, 0);
});

const json = (status, body) => new Response(JSON.stringify(body), { status });

test('probe4910 reports token and listing checks', async () => {
  const fetchFn = async (url) =>
    url.includes('/anonymous/token/') ? json(200, { token: 'tok' }) : json(200, { total_count: 10529, goods_list: [], last_sno: null });
  const checks = await probe4910({ client: createClient({ fetchFn, delayMs: 0, retryBaseMs: 0 }) });
  assert.deepEqual(checks.map((c) => [c.name, c.ok]), [['4910 anonymous token', true], ['4910 uniqlo listing', true]]);
  assert.match(checks[1].detail, /10529/);
  assert.doesNotMatch(checks.map((c) => c.detail).join(), /tok\b/);
});

test('probe4910 reports a blocked token request without throwing', async () => {
  const fetchFn = async () => new Response('<html>cf</html>', { status: 403 });
  const checks = await probe4910({ client: createClient({ fetchFn, delayMs: 0, retryBaseMs: 0 }) });
  assert.deepEqual(checks.map((c) => [c.name, c.ok]), [['4910 anonymous token', false], ['4910 uniqlo listing', false]]);
  assert.match(checks[0].detail, /403/);
});

test('budgetMs past means every brand is incomplete and nothing is missed', async () => {
  await track4910({ client: fakeClient(CATALOG), store, date: '2026-10-10', brands: BRANDS, log: quiet });
  const res = await track4910({ client: fakeClient({}), store, date: '2026-10-11', brands: BRANDS, budgetMs: -1, log: quiet });
  assert.deepEqual(res.brandCounts.map((b) => b.complete), [false, false]);
  assert.match(res.brandCounts[0].problems.join(), /time budget/);
  assert.equal(store.getGoods(1).misses, 0);
});

test('track4910 throws when no brand could be reached', async () => {
  await assert.rejects(
    track4910({ client: fakeClient(CATALOG, { failing: [2421, 13647] }), store, date: '2026-10-10', brands: BRANDS, log: quiet }),
    /HTTP 503/
  );
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM scan_runs').get().n, 0);
});
