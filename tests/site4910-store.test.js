import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store4910, DROP_AFTER_MISSES_4910, DROP_ALERT_RATE } from '../src/site4910/store.js';

const row = (sno, price, brand_sno = 2421) => ({
  sno, brand_sno, brand: brand_sno === 2421 ? '유니클로' : 'GU', name: `listing ${sno}`,
  market_sno: 10, market_name: 'seller', category: 'cat', sale_price: price, original_price: price * 2,
  discount_rate: 50, image_url: null, url: `https://4910.kr/goods/${sno}`, closed: false,
});
const BOTH = { completeBrands: [2421, 13647] };

let dir;
let s;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-4910-store-'));
  s = new Store4910(path.join(dir, '4910.db'));
});
afterEach(() => {
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('constants match the spec', () => {
  assert.equal(DROP_AFTER_MISSES_4910, 2);
  assert.equal(DROP_ALERT_RATE, 0.1);
});

test('first scan inserts NEW rows and reports initial', () => {
  const d = s.applyScan('2026-10-10', [row(1, 50000), row(2, 30000)], { completeBrands: [2421] });
  assert.equal(d.initial, true);
  assert.equal(d.added.length, 2);
  assert.deepEqual(s.getChanges(1).map((c) => c.event), ['NEW']);
  assert.equal(s.getGoods(1).lowest_price, 50000);
  assert.equal(s.getGoods(1).first_seen_date, '2026-10-10');

  const d2 = s.applyScan('2026-10-11', [row(1, 50000), row(2, 30000), row(3, 1000)], BOTH);
  assert.equal(d2.initial, false);
  assert.deepEqual(d2.added.map((r) => r.sno), [3]);
});

test('unchanged price writes no history row', () => {
  s.applyScan('2026-10-10', [row(1, 50000)], BOTH);
  const d = s.applyScan('2026-10-11', [row(1, 50000)], BOTH);
  assert.equal(d.priceChanged, 0);
  assert.equal(s.getChanges(1).length, 1);
});

test('an unchanged rescan writes no goods row', () => {
  // data/4910.db is committed daily: rows that did not change must keep their bytes, or every commit rewrites ~16k rows.
  s.applyScan('2026-10-10', [row(1, 50000), row(2, 30000)], BOTH);
  const before = s.db.prepare('SELECT total_changes() AS n').get().n;
  s.applyScan('2026-10-11', [row(1, 50000), row(2, 30000)], BOTH);
  assert.equal(s.db.prepare('SELECT total_changes() AS n').get().n, before);
  assert.equal('last_seen_date' in s.getGoods(1), false);
});

test('a changed name alone updates the row without a history entry', () => {
  s.applyScan('2026-10-10', [row(1, 50000)], BOTH);
  s.applyScan('2026-10-11', [{ ...row(1, 50000), name: 'renamed' }], BOTH);
  assert.equal(s.getGoods(1).name, 'renamed');
  assert.equal(s.getChanges(1).length, 1);
});

test('a listing without a price keeps its last price and logs nothing', () => {
  s.applyScan('2026-10-10', [row(1, 50000), row(2, 1000)], BOTH);
  const d = s.applyScan('2026-10-11', [{ ...row(1, 50000), sale_price: null, original_price: null }, row(2, 1000)], BOTH);
  assert.equal(d.priceChanged, 0);
  assert.equal(s.getChanges(1).length, 1);
  assert.equal(s.getGoods(1).sale_price, 50000);
  assert.equal(s.getGoods(1).misses, 0); // seen, so not a miss
  s.applyScan('2026-10-12', [{ ...row(1, 50000), sale_price: null, original_price: null }, row(2, 1000)], BOTH);
  assert.equal(s.getChanges(1).length, 1);
});

test('a new listing without a price gets its first price as a PRICE change, not a drop', () => {
  s.applyScan('2026-10-10', [row(2, 1000)], BOTH);
  s.applyScan('2026-10-11', [{ ...row(1, 0), sale_price: null, original_price: null }, row(2, 1000)], BOTH);
  const d = s.applyScan('2026-10-12', [row(1, 30000), row(2, 1000)], BOTH);
  assert.equal(d.priceChanged, 1);
  assert.deepEqual(d.drops, []);
  assert.equal(s.getGoods(1).lowest_price, 30000);
});

test('a 10% drop is a Drop; a 9% drop is only a PRICE change', () => {
  s.applyScan('2026-10-10', [row(1, 50000), row(2, 50000)], BOTH);
  const d = s.applyScan('2026-10-11', [row(1, 45000), row(2, 45500)], BOTH);
  assert.equal(d.priceChanged, 2);
  assert.deepEqual(d.drops.map((x) => [x.row.sno, x.prevPrice, x.currentPrice, x.dropRate, x.isNewLowest]), [[1, 50000, 45000, 10, true]]);
  assert.equal(s.getGoods(1).lowest_price_date, '2026-10-11');
  assert.deepEqual(s.getChanges(2).map((c) => [c.event, c.sale_price]), [['NEW', 50000], ['PRICE', 45500]]);
});

test('drops are sorted by drop rate and a rebound is not a new lowest', () => {
  s.applyScan('2026-10-10', [row(1, 50000), row(2, 50000)], BOTH);
  s.applyScan('2026-10-11', [row(1, 20000), row(2, 60000)], BOTH);
  const d = s.applyScan('2026-10-12', [row(1, 30000), row(2, 30000)], BOTH);
  // 2: 60000→30000 = 50% and a new lowest; 1: 20000→30000 is a rise, not a drop
  assert.deepEqual(d.drops.map((x) => [x.row.sno, x.dropRate, x.isNewLowest]), [[2, 50, true]]);

  const d2 = s.applyScan('2026-10-13', [row(1, 27000), row(2, 20000)], BOTH);
  // 2: 30000→20000 = 33% (new lowest); 1: 30000→27000 = 10% but lowest stays 20000
  assert.deepEqual(d2.drops.map((x) => [x.row.sno, x.dropRate, x.isNewLowest]), [[2, 33, true], [1, 10, false]]);
});

test('two complete misses drop a listing; reappearing revives it', () => {
  s.applyScan('2026-10-10', [row(1, 50000), row(2, 1000)], BOTH);
  const d11 = s.applyScan('2026-10-11', [row(2, 1000)], BOTH);
  assert.deepEqual(d11.dropped, []);
  assert.equal(s.getGoods(1).misses, 1);
  const d12 = s.applyScan('2026-10-12', [row(2, 1000)], BOTH);
  assert.equal(d12.dropped[0].sno, 1);
  assert.equal(d12.dropped[0].url, 'https://4910.kr/goods/1');
  assert.equal(s.getGoods(1).status, 'DROPPED');

  const d13 = s.applyScan('2026-10-13', [row(1, 48000), row(2, 1000)], BOTH);
  assert.deepEqual(d13.revived.map((r) => r.sno), [1]);
  assert.deepEqual(d13.added, []);
  assert.equal(s.getGoods(1).status, 'ACTIVE');
  assert.equal(s.getGoods(1).misses, 0);
  assert.equal(s.getGoods(1).sale_price, 48000);
  assert.deepEqual(s.getChanges(1).map((c) => c.event), ['NEW', 'DROPPED', 'REVIVED']);
});

test('incomplete brand freezes misses', () => {
  s.applyScan('2026-10-10', [row(1, 50000), row(9, 7000, 13647)], BOTH);
  s.applyScan('2026-10-11', [], { completeBrands: [2421] });
  assert.equal(s.getGoods(9).misses, 0);
  assert.equal(s.getGoods(1).misses, 1);
});

test('same-day rerun is idempotent', () => {
  s.applyScan('2026-10-10', [row(1, 50000), row(2, 1000)], BOTH);
  s.applyScan('2026-10-11', [row(2, 1000)], BOTH);
  const again = s.applyScan('2026-10-11', [row(2, 1000)], BOTH);
  assert.equal(s.getGoods(1).misses, 1);
  assert.equal(s.getGoods(1).status, 'ACTIVE');
  assert.deepEqual(again.dropped, []);
  assert.equal(s.getChanges(1).length, 1);
});

test('a throw inside applyScan rolls the whole scan back', () => {
  s.applyScan('2026-10-10', [row(1, 50000)], BOTH);
  assert.throws(() => s.applyScan('2026-10-11', [row(2, 1000), { ...row(3, 1000), name: null }], BOTH));
  assert.equal(s.getGoods(2), undefined);
  assert.equal(s.getGoods(1).misses, 0);
});

test('recordScanRun replaces the row for the same date', () => {
  const base = { date: '2026-10-11', brandCounts: [{ sno: 2421, scanned: 1 }], complete: true, changed: 1, added: 1, dropped: 0, durationMs: 10 };
  s.recordScanRun(base);
  s.recordScanRun({ ...base, complete: false, changed: 5, durationMs: 20 });
  const runs = s.db.prepare('SELECT * FROM scan_runs').all();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].complete, 0);
  assert.equal(runs[0].changed, 5);
  assert.equal(runs[0].duration_ms, 20);
  assert.deepEqual(JSON.parse(runs[0].brand_counts_json), base.brandCounts);
});
