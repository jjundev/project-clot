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
  { sno: 2421, name: '유니클로' },
  { sno: 13647, name: 'GU' },
];

const entry = (brandSno, [sno, price, marketSno = 1]) => ({
  item: { sno, name: `listing ${sno}`, market_sno: marketSno },
  logging: { analytics: { MARKET_NAME: `seller ${marketSno}`, STANDARD_CATEGORY_NAME: 'cat', SALES_PRICE: price, DISCOUNT_RATE: 0 } },
  render: { data: { image: { url: null }, closed_reason: null, original_price: null } },
});

// Sellers 1 and 3 qualify (>= 95%, >= 100 reviews); seller 2 does not.
const MARKETS = {
  1: { satisfaction: 99, reviewsCount: 500 },
  2: { satisfaction: 80, reviewsCount: 500 },
  3: { satisfaction: 97, reviewsCount: 120 },
};

/**
 * One page per brand; a catalog item is [sno, price, marketSno = 1]. A brand in `failing` throws on every call.
 * `stats` counts in-flight listing calls across every client made from the same fakeClients() factory.
 * `member` overrides the member endpoints (getMyCoupons, getMe, getGoodsDetail, getBestCoupon).
 */
function fakeClient(catalog, { failing = [], stats = { inFlight: 0, maxInFlight: 0, marketCalls: 0 }, member = {} } = {}) {
  return {
    async listBrandGoods({ brandSno }) {
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      await new Promise((r) => setImmediate(r));
      stats.inFlight--;
      if (failing.includes(brandSno)) throw Object.assign(new Error('HTTP 503'), { status: 503 });
      const items = catalog[brandSno] ?? [];
      return { totalCount: items.length, entries: items.map((it) => entry(brandSno, it)), lastSno: null };
    },
    async listTopBrands() {
      throw Object.assign(new Error('HTTP 503'), { status: 503 });
    },
    async getMarket(sno) {
      stats.marketCalls++;
      return { sno, name: `seller ${sno}`, isOfficial: false, ...(MARKETS[sno] ?? { satisfaction: null, reviewsCount: null }) };
    },
    async getMyCoupons() {
      throw new Error('getMyCoupons not expected');
    },
    ...member,
  };
}

// A makeClient that counts its calls; every client shares one stats object.
function fakeClients(catalog, opts = {}) {
  const stats = { inFlight: 0, maxInFlight: 0, marketCalls: 0 };
  const makeClient = () => {
    makeClient.calls++;
    return fakeClient(catalog, { ...opts, stats });
  };
  makeClient.calls = 0;
  makeClient.stats = stats;
  return makeClient;
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

const count = (sql, ...args) => store.db.prepare(sql).get(...args).n;

test('scans every brand and merges the per-brand diffs', async () => {
  const res = await track4910({ makeClient: fakeClients(CATALOG), store, date: '2026-10-10', brands: BRANDS, log: quiet });
  assert.deepEqual(
    res.brandCounts.map((b) => [b.name, b.total, b.scanned, b.complete, b.qualifiedRows]),
    [['유니클로', 3, 3, true, 3], ['GU', 2, 2, true, 2]]
  );
  assert.equal(res.diff.added.length, 5);
  assert.equal(res.diff.initial, true); // computed before the first brand was written
  assert.equal(res.date, '2026-10-10');
  const run = store.db.prepare('SELECT * FROM scan_runs').get();
  assert.equal(run.complete, 1);
  assert.equal(run.added, 5);
  assert.deepEqual(JSON.parse(run.brand_counts_json).map((b) => b.qualifiedRows), [3, 2]);

  // Day 2: drops from both brands come back as one list, largest drop first.
  const catalog = { 2421: [[1, 40000], [2, 30000], [3, 9900]], 13647: [[11, 9900], [12, 29900]] };
  const next = await track4910({ makeClient: fakeClients(catalog), store, date: '2026-10-11', brands: BRANDS, log: quiet });
  assert.equal(next.diff.initial, false);
  assert.equal(next.diff.priceChanged, 2);
  assert.deepEqual(next.diff.drops.map((d) => [d.row.sno, d.dropRate]), [[11, 50], [1, 20]]);
});

test('scans brands concurrently with one client per worker', async () => {
  const brands = [1, 2, 3, 4, 5].map((sno) => ({ sno, name: `b${sno}` }));
  const catalog = Object.fromEntries(brands.map((b) => [b.sno, [[b.sno * 100, 10000]]]));
  const makeClient = fakeClients(catalog);
  const res = await track4910({ makeClient, store, date: '2026-10-10', brands, concurrency: 3, log: quiet });
  assert.equal(makeClient.calls, 3);
  assert.equal(makeClient.stats.maxInFlight, 3);
  assert.deepEqual(res.brandCounts.map((b) => b.sno), [1, 2, 3, 4, 5]); // brand order kept

  const few = fakeClients(CATALOG);
  await track4910({ makeClient: few, store, date: '2026-10-11', brands: BRANDS, concurrency: 3, log: quiet });
  assert.equal(few.calls, 2);
});

test('keeps only qualified sellers and marks the rest OUT_OF_SCOPE', async () => {
  // Before seller filtering: seller 2's listing and a listing of a brand that left the list are both ACTIVE.
  const legacy = (sno, brandSno, marketSno) => ({
    sno, brand_sno: brandSno, brand: 'b', name: 'old', market_sno: marketSno, market_name: null, category: null,
    url: `https://4910.kr/goods/${sno}`, image_url: null, sale_price: 20000, original_price: 20000, discount_rate: null,
  });
  store.applyScan('2026-10-09', [legacy(4, 2421, 2), legacy(99, 555, 1)]);
  const catalog = { 2421: [[1, 50000], [4, 20000, 2], [5, 15000, 2]], 13647: [[11, 19900]] };
  const res = await track4910({ makeClient: fakeClients(catalog), store, date: '2026-10-10', brands: BRANDS, log: quiet });

  assert.deepEqual(res.sellers, { seen: 2, qualified: 1, checked: 2 });
  assert.equal(res.outOfScope, 2);
  assert.deepEqual(res.brandCounts.map((b) => [b.scanned, b.qualifiedRows]), [[3, 1], [1, 1]]);
  assert.equal(store.getGoods(1).status, 'ACTIVE');
  assert.equal(store.getGoods(4).status, 'OUT_OF_SCOPE');
  assert.equal(store.getGoods(4).misses, 0);
  assert.equal(store.getGoods(5), undefined); // never stored
  assert.equal(store.getGoods(99).status, 'OUT_OF_SCOPE');
  assert.equal(store.getGoods(99).misses, 0);
  assert.deepEqual(res.diff.added.map((r) => r.sno), [1, 11]);
  assert.equal(store.getMarkets().get(2).qualified, 0);
});

test('an incomplete brand does not push its listings to OUT_OF_SCOPE or misses', async () => {
  // GU's listings come from seller 3 only, so on day 2 (GU unreachable) seller 3 is not among today's sellers.
  const day1 = { ...CATALOG, 13647: [[11, 19900, 3], [12, 29900, 3]] };
  await track4910({ makeClient: fakeClients(day1), store, date: '2026-10-10', brands: BRANDS, log: quiet });
  const day2 = { ...day1, 2421: [[1, 45000], [2, 30000]] };
  const res = await track4910({ makeClient: fakeClients(day2, { failing: [13647] }), store, date: '2026-10-11', brands: BRANDS, log: quiet });

  assert.equal(res.brandCounts[0].complete, true);
  assert.equal(res.brandCounts[1].complete, false);
  assert.equal(res.brandCounts[1].total, null);
  assert.match(res.brandCounts[1].problems[0], /HTTP 503/);
  assert.equal(res.outOfScope, 0);
  assert.equal(store.getGoods(1).sale_price, 45000);
  assert.equal(store.getGoods(3).misses, 1); // uniqlo was complete, so its missing listing counts
  // GU was not: its listings stay ACTIVE (their seller is still qualified in the store) and take no miss.
  assert.equal(store.getGoods(11).status, 'ACTIVE');
  assert.equal(store.getGoods(11).misses, 0);
  assert.equal(count('SELECT complete AS n FROM scan_runs WHERE date = ?', '2026-10-11'), 0);
});

test('without a member token the scan still stores rows and coupon_price stays null', async () => {
  await track4910({ makeClient: fakeClients(CATALOG), store, date: '2026-10-10', brands: BRANDS, log: quiet });
  store.setCouponPrices(new Map([[1, 40000]])); // yesterday's value must not survive today
  const res = await track4910({ makeClient: fakeClients(CATALOG), store, date: '2026-10-11', brands: BRANDS, log: quiet });

  assert.equal(res.coupons.memberStatus, 'none');
  assert.equal(res.coupons.priced, 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM goods WHERE status = 'ACTIVE'"), 5);
  assert.equal(count('SELECT COUNT(*) AS n FROM goods WHERE coupon_price IS NOT NULL'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM scan_runs'), 2);
});

const WALLET = [{ couponSno: 7, name: '10% 쿠폰', type: 'PERCENT', percent: 10, price: null, max: Infinity, min: 10000, finishedAt: null, usable: true }];

test('with a member token the qualified sellers get coupon prices', async () => {
  const member = {
    async getMyCoupons() { return WALLET; },
    async getMe() { return { emoney: 1200 }; },
    async getGoodsDetail(sno) { return { optionSno: sno * 10 }; },
    async getBestCoupon(optionSno) { return { couponSno: 7, name: '10% 쿠폰', discount: optionSno === 10 ? 5000 : 1990 }; },
  };
  const res = await track4910({
    makeClient: fakeClients(CATALOG, { member }), store, date: '2026-10-10', brands: BRANDS, memberToken: 'T', log: quiet,
  });
  const { walletChanges, ...coupons } = res.coupons;
  assert.deepEqual(coupons, { memberStatus: 'ok', wallet: 1, emoney: 1200, eligible: 1, mismatched: 0, priced: 5 });
  assert.deepEqual(walletChanges.added, ['10% 쿠폰']);
  assert.equal(store.getGoods(1).coupon_price, 45000);
  assert.equal(store.getGoods(11).coupon_price, 17910);
  assert.equal(store.getGoods(3).coupon_price, 9900); // below the coupon minimum
});

test('a coupon failure does not stop the scan', async () => {
  const member = { async getMyCoupons() { throw Object.assign(new Error('4910 my coupons failed: HTTP 500'), { status: 500 }); } };
  const lines = [];
  const res = await track4910({
    makeClient: fakeClients(CATALOG, { member }), store, date: '2026-10-10', brands: BRANDS, memberToken: 'zz-secret', log: (l) => lines.push(l),
  });
  assert.equal(res.coupons.memberStatus, 'error');
  assert.equal(res.coupons.priced, 0);
  assert.equal(res.diff.added.length, 5);
  assert.equal(count('SELECT COUNT(*) AS n FROM scan_runs'), 1);
  assert.doesNotMatch(lines.join('\n'), /zz-secret/);
});

test('dry-run writes nothing', async () => {
  const makeClient = fakeClients(CATALOG);
  // No brand list given: the (failing) ranking falls back to the pinned brands, and nothing is stored.
  const res = await track4910({ makeClient, store, date: '2026-10-12', dryRun: true, log: quiet });
  assert.equal(res.diff, null);
  assert.equal(res.coupons, null);
  assert.equal(res.outOfScope, 0);
  assert.deepEqual(res.sellers, { seen: 1, qualified: null, checked: 0 });
  assert.deepEqual(res.brandCounts.map((b) => [b.sno, b.scanned]), [[2421, 3], [13647, 2]]);
  assert.equal(makeClient.stats.marketCalls, 0);
  for (const table of ['goods', 'markets', 'brands', 'scan_runs', 'wallet_coupons']) {
    assert.equal(count(`SELECT COUNT(*) AS n FROM ${table}`), 0, table);
  }

  const noStore = await track4910({ makeClient: fakeClients(CATALOG), store: null, date: '2026-10-12', brands: BRANDS, dryRun: true, log: quiet });
  assert.equal(noStore.brandCounts[0].scanned, 3);
});

test('budgetMs past means every brand is incomplete and nothing is missed', async () => {
  await track4910({ makeClient: fakeClients(CATALOG), store, date: '2026-10-10', brands: BRANDS, log: quiet });
  const res = await track4910({ makeClient: fakeClients({}), store, date: '2026-10-11', brands: BRANDS, budgetMs: -1, log: quiet });
  assert.deepEqual(res.brandCounts.map((b) => b.complete), [false, false]);
  assert.match(res.brandCounts[0].problems.join(), /time budget/);
  assert.equal(store.getGoods(1).misses, 0);
  assert.equal(store.getGoods(1).status, 'ACTIVE');
});

test('no brand reachable throws', async () => {
  await assert.rejects(
    track4910({ makeClient: fakeClients(CATALOG, { failing: [2421, 13647] }), store, date: '2026-10-10', brands: BRANDS, log: quiet }),
    /HTTP 503/
  );
  assert.equal(count('SELECT COUNT(*) AS n FROM scan_runs'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM markets'), 0);
});

const json = (status, body) => new Response(JSON.stringify(body), { status });
const ANON_CHECKS = ['4910 anonymous token', '4910 uniqlo listing', '4910 brand ranking', '4910 seller'];

// Anonymous endpoints answer; `likedStatus` / `couponsStatus` set the member endpoints' answers.
const probeFetch = ({ likedStatus = 200, couponsStatus = 200 } = {}) => async (url) => {
  if (url.includes('/anonymous/token/')) return json(200, { token: 'tok' });
  if (url.includes('/brands/ranking/')) return json(200, { brand_list: [{ sno: 2421, name: '유니클로' }], last_sno: 1 });
  if (url.includes('/markets/')) return json(200, { market: { sno: 56293, name: 'seller', purchasing_satisfaction_ratio: 98, reviews_count: 4321 } });
  if (url.includes('liked-goods')) return likedStatus === 200 ? json(200, { goods_list: [], last_sno: null }) : new Response('{}', { status: likedStatus });
  if (url.includes('/me/coupons/')) {
    if (couponsStatus !== 200) return new Response('{}', { status: couponsStatus });
    const coupon = (sno, usable) => ({ coupon_sno: sno, coupon_name: `secret coupon ${sno}`, is_usable: usable, is_in_available_period: true });
    return json(200, { coupon_apply_list: [coupon(1, true), coupon(2, true), coupon(3, false)] });
  }
  return json(200, { total_count: 10529, goods_list: [], last_sno: null });
};
const probeClient = (opts) => createClient({ fetchFn: probeFetch(opts), delayMs: 0, retryBaseMs: 0 });

test('probe4910 reports token, listing, ranking and seller checks', async () => {
  const checks = await probe4910({ client: probeClient() });
  assert.deepEqual(checks.map((c) => [c.name, c.ok]), ANON_CHECKS.map((n) => [n, true]));
  assert.match(checks[1].detail, /10529/);
  assert.match(checks[2].detail, /2421/);
  assert.match(checks[3].detail, /98/);
  assert.doesNotMatch(checks.map((c) => c.detail).join(), /tok\b/);
});

test('probe4910 keeps checking when one anonymous check fails', async () => {
  const fetchFn = async (url) => (url.includes('/brands/ranking/') ? new Response('{}', { status: 404 }) : probeFetch()(url));
  const checks = await probe4910({ client: createClient({ fetchFn, delayMs: 0, retryBaseMs: 0 }) });
  assert.deepEqual(checks.map((c) => [c.name, c.ok]), ANON_CHECKS.map((n) => [n, n !== '4910 brand ranking']));
  assert.match(checks[2].detail, /404/);
});

test('probe4910 reports a blocked token request without throwing', async () => {
  const fetchFn = async () => new Response('<html>cf</html>', { status: 403 });
  const checks = await probe4910({ client: createClient({ fetchFn, delayMs: 0, retryBaseMs: 0 }) });
  assert.deepEqual(checks.map((c) => [c.name, c.ok]), ANON_CHECKS.map((n) => [n, false]));
  assert.match(checks[0].detail, /403/);
  assert.match(checks[3].detail, /skipped/);
});

const SECRET_TOKEN = 'zz-distinctive-member-token-9f3a';

test('probe4910 adds member login and coupon checks when a token is given', async () => {
  const checks = await probe4910({ client: probeClient(), memberToken: SECRET_TOKEN });
  assert.deepEqual(checks.map((c) => [c.name, c.ok]), [...ANON_CHECKS, '4910 member login', '4910 member coupons'].map((n) => [n, true]));
  assert.equal(checks[4].detail, 'liked page ok, no exp'); // not a JWT with exp
  assert.equal(checks[5].detail, '3 coupons, 2 usable');
  assert.doesNotMatch(JSON.stringify(checks), new RegExp(SECRET_TOKEN));
  assert.doesNotMatch(JSON.stringify(checks), /secret coupon/);
});

test('probe4910 reports the days left when the member token has an exp', async () => {
  const exp = Math.floor(Date.now() / 1000) + 10 * 86400 + 3600;
  const jwt = `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
  const checks = await probe4910({ client: probeClient(), memberToken: jwt });
  assert.equal(checks[4].detail, 'liked page ok, exp in 10d');
});

test('probe4910 reports an expired member token', async () => {
  const checks = await probe4910({ client: probeClient({ likedStatus: 401, couponsStatus: 401 }), memberToken: SECRET_TOKEN });
  assert.deepEqual(checks.map((c) => [c.name, c.ok]), [...ANON_CHECKS.map((n) => [n, true]), ['4910 member login', false], ['4910 member coupons', false]]);
  assert.match(checks[4].detail, /401/);
  assert.match(checks[5].detail, /401/);
  assert.doesNotMatch(JSON.stringify(checks), new RegExp(SECRET_TOKEN));
});
