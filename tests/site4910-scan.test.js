import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanBrand } from '../src/site4910/client.js';

const brand = { sno: 2421, name: '유니클로' };
const CURSOR_CAP = 3000; // the live API stops paging one query near 3,000 listings

const entry = ({ sno, price }) => ({
  item: { sno, name: `listing ${sno}`, market_sno: 1 },
  logging: { analytics: { MARKET_NAME: 'seller', STANDARD_CATEGORY_NAME: 'cat', SALES_PRICE: price, DISCOUNT_RATE: 0 } },
  render: { data: { image: { url: null }, closed_reason: null, original_price: null } },
});

// Prices spread over 1,000–200,999 so price slices can split the catalog.
const catalog = (n, priceOf = (i) => 1000 + ((i * 7919) % 200000)) =>
  Array.from({ length: n }, (_, i) => ({ sno: n - i, price: priceOf(i) }));

// In-memory stand-in for listBrandGoods: inclusive price filter, NEW order (sno desc), cursor by lastSno, 3k cap.
function fake(items, { brandTotal, cursorCap = CURSOR_CAP, matches = (it, lo, hi) => (lo == null || it.price >= lo) && (hi == null || it.price <= hi), failOn } = {}) {
  let call = 0;
  return {
    async listBrandGoods({ minPrice = null, maxPrice = null, lastSno = null, limit = 500 }) {
      call++;
      if (failOn?.({ minPrice, maxPrice, lastSno, limit, call })) throw new Error('HTTP 503');
      const filtered = items.filter((it) => matches(it, minPrice, maxPrice)).sort((a, b) => b.sno - a.sno);
      const isBrandQuery = minPrice == null && maxPrice == null && lastSno == null;
      const totalCount = isBrandQuery && brandTotal != null ? brandTotal : filtered.length;
      const start = lastSno == null ? 0 : filtered.findIndex((it) => it.sno === lastSno) + 1;
      const stop = Math.min(filtered.length, cursorCap);
      if (start >= stop) return { totalCount, entries: [], lastSno: null };
      const end = Math.min(start + limit, stop);
      const page = filtered.slice(start, end);
      return { totalCount, entries: page.map(entry), lastSno: end < stop ? page.at(-1).sno : null };
    },
  };
}

test('scans a small brand without splitting', async () => {
  const res = await scanBrand(fake(catalog(1200)), brand, { sliceMax: 2500 });
  assert.equal(res.rows.size, 1200);
  assert.equal(res.brandTotal, 1200);
  assert.equal(res.complete, true);
  assert.deepEqual(res.problems, []);
});

test('bisects price ranges until each slice fits and covers the whole brand', async () => {
  const res = await scanBrand(fake(catalog(6000)), brand, { sliceMax: 2500 });
  assert.equal(res.rows.size, 6000);
  assert.equal(res.sliceTotalSum, 6000);
  assert.equal(res.complete, true);
});

test('dedupes a sno seen in two slices', async () => {
  // sno 7 "moves" price between queries, so every slice reports it.
  const items = catalog(6000);
  const matches = (it, lo, hi) => it.sno === 7 || ((lo == null || it.price >= lo) && (hi == null || it.price <= hi));
  const res = await scanBrand(fake(items, { matches }), brand, { sliceMax: 2500 });
  assert.equal([...res.rows.keys()].filter((k) => k === 7).length, 1);
  assert.equal(res.rows.size, 6000);
  assert.equal(res.complete, true);
});

test('a slice error keeps earlier rows and marks the scan incomplete', async () => {
  // Fail the first paging call of the second slice that gets paged.
  let pagedSlices = 0;
  const failOn = ({ limit, lastSno }) => limit !== 1 && lastSno == null && ++pagedSlices === 2;
  const res = await scanBrand(fake(catalog(6000), { failOn }), brand, { sliceMax: 2500 });
  assert.equal(res.complete, false);
  assert.ok(res.rows.size > 0);
  assert.match(res.problems[0], /slice/);
});

test('a single price point above sliceMax is paged as far as it goes and marked incomplete', async () => {
  const res = await scanBrand(fake(catalog(2600, () => 5000)), brand, { sliceMax: 2500 });
  assert.equal(res.complete, false);
  assert.equal(res.rows.size, 2600);
  assert.match(res.problems.join(), /unsplittable/);
});

test('slice total drifting more than 1% from the brand total is incomplete', async () => {
  const res = await scanBrand(fake(catalog(980), { brandTotal: 1000 }), brand, { sliceMax: 2500 });
  assert.equal(res.sliceTotalSum, 980);
  assert.equal(res.complete, false);
});

test('a failing brand-total query returns an empty incomplete scan', async () => {
  const res = await scanBrand(fake(catalog(10), { failOn: () => true }), brand);
  assert.equal(res.complete, false);
  assert.equal(res.brandTotal, null);
  assert.equal(res.rows.size, 0);
  assert.match(res.problems[0], /brand total/);
});

test('closed listings are left out of rows', async () => {
  const items = catalog(3);
  const client = fake(items);
  const original = client.listBrandGoods;
  client.listBrandGoods = async (q) => {
    const r = await original(q);
    r.entries = r.entries.map((e) => (e.item.sno === 2 ? { ...e, render: { data: { ...e.render.data, closed_reason: 'SOLD_OUT' } } } : e));
    return r;
  };
  const res = await scanBrand(client, brand);
  assert.deepEqual([...res.rows.keys()].sort(), [1, 3]);
  assert.equal(res.complete, true);
});

test('a slice that pages out fewer listings than its total is incomplete', async () => {
  // If the API's cursor cap ever drops below sliceMax, paging ends early with last_sno null.
  const res = await scanBrand(fake(catalog(2000), { cursorCap: 1500 }), brand, { sliceMax: 2500 });
  assert.equal(res.rows.size, 1500);
  assert.equal(res.complete, false);
  assert.match(res.problems.join(), /fetched 1500 of 2000/);
});

test('a passed deadline stops the scan and marks it incomplete', async () => {
  const res = await scanBrand(fake(catalog(6000)), brand, { sliceMax: 2500, deadline: Date.now() - 1 });
  assert.equal(res.complete, false);
  assert.equal(res.brandTotal, 6000);
  assert.match(res.problems.join(), /time budget/);
});
