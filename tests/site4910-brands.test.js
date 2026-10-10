import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store4910 } from '../src/site4910/store.js';
import { resolveBrands, TOP_BRANDS_4910, PINNED_BRANDS_4910 } from '../src/site4910/brands.js';

const MONDAY = new Date('2026-10-12T03:00:00Z');
const TUESDAY = new Date('2026-10-13T03:00:00Z');
const UNIQLO = PINNED_BRANDS_4910[0];
const GU = PINNED_BRANDS_4910[1];

// Brands 1..total, with GU at rank 5 (sno 13647); the client pages them like the real ranking API.
function fakeClient(total, { failAfterCalls = Infinity } = {}) {
  const all = Array.from({ length: total }, (_, i) => ({ sno: i === 4 ? GU.sno : i + 1, name: i === 4 ? 'GU' : `brand ${i + 1}` }));
  const calls = [];
  return {
    calls,
    async listTopBrands({ limit = 100, lastSno = null } = {}) {
      calls.push({ limit, lastSno });
      if (calls.length > failAfterCalls) throw new Error('ranking down');
      const start = lastSno == null ? 0 : all.findIndex((b) => b.sno === lastSno) + 1;
      const brands = all.slice(start, start + limit);
      const last = start + limit < all.length ? brands.at(-1).sno : null;
      return { brands, lastSno: last };
    },
  };
}
const failingClient = () => ({
  calls: [],
  async listTopBrands() {
    this.calls.push(1);
    throw new Error('ranking down');
  },
});

let dir;
let store;
const logs = [];
const log = (line) => logs.push(line);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-4910-brands-'));
  store = new Store4910(path.join(dir, '4910.db'));
  logs.length = 0;
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('constants match the spec', () => {
  assert.equal(TOP_BRANDS_4910, 100);
  assert.deepEqual(PINNED_BRANDS_4910, [{ sno: 2421, name: '유니클로' }, { sno: 13647, name: 'GU' }]);
});

test('refreshes on Monday and merges pinned brands without duplicates', async () => {
  const client = fakeClient(150);
  const { brands, refreshed } = await resolveBrands({ client, store, date: '2026-10-12', now: MONDAY, log });
  assert.equal(refreshed, true);
  assert.equal(brands.length, 101); // top 100 (GU among them) + Uniqlo
  assert.equal(new Set(brands.map((b) => b.sno)).size, 101);
  assert.deepEqual(brands.slice(0, 2), [{ sno: 1, name: 'brand 1' }, { sno: 2, name: 'brand 2' }]);
  assert.deepEqual(brands.at(-1), UNIQLO);
  assert.equal(brands.filter((b) => b.sno === GU.sno).length, 1);
  assert.equal(client.calls.length, 1);
  // persisted for the rest of the week
  const stored = store.getActiveBrands();
  assert.equal(stored.length, 101);
  assert.equal(stored.find((b) => b.sno === UNIQLO.sno).pinned, true);
});

test('pages the ranking until n brands are collected', async () => {
  const client = fakeClient(250);
  const { brands } = await resolveBrands({ client, store, date: '2026-10-12', now: MONDAY, n: 150, log });
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].lastSno, 100);
  assert.equal(brands.length, 151); // 150 ranked (GU among them) + Uniqlo
});

test('stops paging when the ranking runs out before n', async () => {
  const client = fakeClient(120);
  const { brands } = await resolveBrands({ client, store, date: '2026-10-12', now: MONDAY, n: 300, log });
  assert.equal(client.calls.length, 2);
  assert.equal(brands.length, 121); // 120 ranked + Uniqlo
});

test('uses stored brands on other days without calling the ranking', async () => {
  store.upsertBrands('2026-10-12', [{ sno: 7, name: 'seven' }, { sno: 8, name: 'eight' }], PINNED_BRANDS_4910);
  const client = fakeClient(150);
  const { brands, refreshed } = await resolveBrands({ client, store, date: '2026-10-13', now: TUESDAY, log });
  assert.equal(refreshed, false);
  assert.equal(client.calls.length, 0);
  assert.deepEqual(brands, [{ sno: 7, name: 'seven' }, { sno: 8, name: 'eight' }, UNIQLO, GU]);
});

test('stored list still gets pinned brands that are missing', async () => {
  store.upsertBrands('2026-10-12', [{ sno: 7, name: 'seven' }], []);
  const { brands } = await resolveBrands({ client: fakeClient(10), store, date: '2026-10-13', now: TUESDAY, log });
  assert.deepEqual(brands, [{ sno: 7, name: 'seven' }, UNIQLO, GU]);
});

test('refreshes when the table is empty even midweek', async () => {
  const client = fakeClient(150);
  const { brands, refreshed } = await resolveBrands({ client, store, date: '2026-10-13', now: TUESDAY, log });
  assert.equal(refreshed, true);
  assert.equal(client.calls.length, 1);
  assert.equal(brands.length, 101);
});

test('a ranking failure falls back to stored, then to pinned', async () => {
  store.upsertBrands('2026-10-05', [{ sno: 7, name: 'seven' }], PINNED_BRANDS_4910);
  const stored = await resolveBrands({ client: failingClient(), store, date: '2026-10-12', now: MONDAY, log });
  assert.equal(stored.refreshed, false);
  assert.deepEqual(stored.brands, [{ sno: 7, name: 'seven' }, UNIQLO, GU]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /ranking down/);

  const empty = new Store4910(path.join(dir, 'empty.db'));
  try {
    const pinnedOnly = await resolveBrands({ client: failingClient(), store: empty, date: '2026-10-12', now: MONDAY, log });
    assert.equal(pinnedOnly.refreshed, false);
    assert.deepEqual(pinnedOnly.brands, PINNED_BRANDS_4910);
    assert.equal(empty.getActiveBrands().length, 0); // fallback is not persisted
  } finally {
    empty.close();
  }
});

test('a failure on a later page keeps the stored list untouched', async () => {
  store.upsertBrands('2026-10-05', [{ sno: 7, name: 'seven' }], PINNED_BRANDS_4910);
  const client = fakeClient(250, { failAfterCalls: 1 });
  const { brands, refreshed } = await resolveBrands({ client, store, date: '2026-10-12', now: MONDAY, n: 200, log });
  assert.equal(refreshed, false);
  assert.deepEqual(brands, [{ sno: 7, name: 'seven' }, UNIQLO, GU]);
  assert.equal(store.getActiveBrands().length, 3);
});

test('an empty ranking is treated as a failure, not as an empty list', async () => {
  store.upsertBrands('2026-10-05', [{ sno: 7, name: 'seven' }], PINNED_BRANDS_4910);
  const { brands, refreshed } = await resolveBrands({ client: fakeClient(0), store, date: '2026-10-12', now: MONDAY, log });
  assert.equal(refreshed, false);
  assert.equal(brands.length, 3);
  assert.equal(logs.length, 1);
});

test('store null (dry-run) always fetches the ranking and saves nothing', async () => {
  const client = fakeClient(150);
  const { brands, refreshed } = await resolveBrands({ client, store: null, date: '2026-10-13', now: TUESDAY, log });
  assert.equal(refreshed, true);
  assert.equal(client.calls.length, 1);
  assert.equal(brands.length, 101);
});

test('store null falls back to the pinned brands when the ranking fails', async () => {
  const { brands, refreshed } = await resolveBrands({ client: failingClient(), store: null, date: '2026-10-13', now: TUESDAY, log });
  assert.equal(refreshed, false);
  assert.deepEqual(brands, PINNED_BRANDS_4910);
  assert.equal(logs.length, 1);
});
