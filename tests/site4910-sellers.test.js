import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store4910 } from '../src/site4910/store.js';
import {
  isQualified, refreshMarkets, MIN_SATISFACTION, MIN_REVIEWS, MARKET_RECHECK_DAYS, MAX_MARKET_CHECKS,
} from '../src/site4910/sellers.js';

const TODAY = '2026-10-11';
let dir;
let store;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-4910-sellers-'));
  store = new Store4910(path.join(dir, '4910.db'));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const seed = (sno, checkedDate, qualified, extra = {}) =>
  store.upsertMarket(checkedDate, { sno, name: `m${sno}`, satisfaction: qualified ? 99 : 80, reviewsCount: qualified ? 500 : 5, isOfficial: false, qualified, ...extra });

// A fake client: `data` maps sno -> getMarket() result, or an Error to throw. Records the order of calls.
const fakeClient = (data) => {
  const calls = [];
  return {
    calls,
    async getMarket(sno) {
      calls.push(sno);
      const v = data[sno];
      if (v instanceof Error) throw v;
      return { sno, name: `m${sno}`, satisfaction: v.satisfaction, reviewsCount: v.reviewsCount, isOfficial: false };
    },
  };
};
const GOOD = { satisfaction: 98, reviewsCount: 300 };
const BAD = { satisfaction: 90, reviewsCount: 300 };
const quiet = () => {};

test('constants match the spec', () => {
  assert.equal(MIN_SATISFACTION, 95);
  assert.equal(MIN_REVIEWS, 100);
  assert.equal(MARKET_RECHECK_DAYS, 7);
  assert.equal(MAX_MARKET_CHECKS, 300);
});

test('isQualified needs 95% and 100 reviews; null reviews fail', () => {
  assert.equal(isQualified({ satisfaction: 95, reviewsCount: 100 }), true);
  assert.equal(isQualified({ satisfaction: 94.99, reviewsCount: 1000 }), false);
  assert.equal(isQualified({ satisfaction: 100, reviewsCount: 99 }), false);
  assert.equal(isQualified({ satisfaction: 100, reviewsCount: null }), false);
  assert.equal(isQualified({ satisfaction: null, reviewsCount: 1000 }), false);
});

test('checks new sellers first, then stale ones, up to maxChecks', async () => {
  seed(3, '2026-10-03', true); // 8 days old
  seed(4, '2026-10-01', true); // 10 days old (oldest)
  seed(5, '2026-10-08', true); // 3 days old, fresh
  const client = fakeClient({ 1: GOOD, 2: BAD, 3: GOOD, 4: GOOD, 5: GOOD });
  const r = await refreshMarkets({ client, store, date: TODAY, marketSnos: [3, 4, 5, 1, 2], maxChecks: 3, log: quiet });
  assert.deepEqual(client.calls, [1, 2, 4]);
  assert.equal(r.checked, 3);
  assert.equal(r.failed, 0);
  assert.deepEqual([...r.qualified].sort(), [1, 3, 4, 5]);
  assert.equal(store.getMarkets().get(1).checked_date, TODAY);
  assert.equal(store.getMarkets().get(2).qualified, 0);
  assert.equal(store.getMarkets().get(3).checked_date, '2026-10-03');
});

test('a seller exactly 7 days old is not stale; 8 days is', async () => {
  seed(1, '2026-10-04', true);
  seed(2, '2026-10-03', true);
  const client = fakeClient({ 1: GOOD, 2: BAD });
  const r = await refreshMarkets({ client, store, date: TODAY, marketSnos: [1, 2], log: quiet });
  assert.deepEqual(client.calls, [2]);
  assert.deepEqual([...r.qualified], [1]);
  assert.equal(store.getMarkets().get(2).qualified, 0);
});

test('a failed check keeps the stored verdict; a failed new seller is not qualified', async () => {
  seed(1, '2026-10-01', true);
  seed(2, '2026-10-01', false);
  const client = fakeClient({ 1: new Error('boom'), 2: new Error('boom'), 3: new Error('boom') });
  const r = await refreshMarkets({ client, store, date: TODAY, marketSnos: [1, 2, 3], log: quiet });
  assert.equal(r.checked, 3);
  assert.equal(r.failed, 3);
  assert.deepEqual([...r.qualified], [1]);
  const markets = store.getMarkets();
  assert.equal(markets.has(3), false, 'failed new seller is not stored, so it is retried first next time');
  assert.equal(markets.get(1).checked_date, '2026-10-01');
  assert.equal(markets.get(1).qualified, 1);
});

test('duplicates and null entries are ignored', async () => {
  const client = fakeClient({ 1: GOOD });
  const r = await refreshMarkets({ client, store, date: TODAY, marketSnos: [1, null, 1, undefined, '1'], log: quiet });
  assert.deepEqual(client.calls, [1]);
  assert.deepEqual([...r.qualified], [1]);
});

test('returns only sellers from marketSnos and logs one summary line plus a few failures', async () => {
  seed(99, '2026-10-10', true);
  const data = {};
  for (let i = 1; i <= 20; i += 1) data[i] = new Error('down');
  const lines = [];
  const r = await refreshMarkets({ client: fakeClient(data), store, date: TODAY, marketSnos: Object.keys(data).map(Number), log: (l) => lines.push(l) });
  assert.equal(r.qualified.size, 0);
  assert.equal(r.failed, 20);
  assert.ok(lines.length <= 6, `too chatty: ${lines.length} lines`);
  assert.ok(lines.some((l) => /20/.test(l)));
});

const listing = (sno, market_sno) => ({
  sno, brand_sno: 2421, brand: '유니클로', name: `listing ${sno}`, market_sno, market_name: null, category: null,
  sale_price: 10000, original_price: 10000, discount_rate: null, image_url: null, url: `https://4910.kr/goods/${sno}`,
});

test('new sellers that own ACTIVE listings are checked before other new sellers and stale ones', async () => {
  // Day 1 of seller filtering: 7 and 8 own ACTIVE rows from before, 1 and 2 are new to the store, 3 is stale.
  store.applyScan('2026-10-10', [listing(70, 7), listing(80, 8)]);
  seed(3, '2026-10-01', true);
  const client = fakeClient({ 1: GOOD, 2: GOOD, 3: GOOD, 7: GOOD, 8: BAD });
  const r = await refreshMarkets({ client, store, date: TODAY, marketSnos: [1, 2, 3, 7, 8], maxChecks: 3, log: quiet });
  assert.deepEqual(client.calls, [7, 8, 1]);
  assert.deepEqual([...r.qualified].sort(), [1, 3, 7]);
});

test('past the deadline no seller is checked; stored verdicts stand and new sellers do not qualify', async () => {
  seed(1, '2026-10-01', true); // stale but qualified
  const client = fakeClient({ 1: BAD, 2: GOOD });
  const lines = [];
  const r = await refreshMarkets({ client, store, date: TODAY, marketSnos: [1, 2], deadline: Date.now() - 1, log: (l) => lines.push(l) });
  assert.deepEqual(client.calls, []);
  assert.equal(r.checked, 0);
  assert.deepEqual([...r.qualified], [1]);
  assert.equal(store.getMarkets().has(2), false);
  assert.ok(lines.some((l) => /budget/.test(l)));
  assert.ok(lines.some((l) => /2 left for later/.test(l)));
});
