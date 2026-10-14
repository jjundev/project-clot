import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MusinsaWideStore, defaultMusinsaWideDbPath, OUT_AFTER_MISSES, DROP_ALERT_RATE, STATUS_OUT_OF_SCOPE, COUPON_STATE,
  LIVENESS_DAYS, LIVENESS_MIN_OBS, REGISTRY_KEEP_DAYS, EMPTY_RECHECK_DAYS, shiftDate,
} from '../src/musinsaWide/store.js';

const row = (goods_no, price, cat = '001', extra = {}) => ({
  goods_no, cat, brand: 'nike', brand_name: '나이키', name: `goods ${goods_no}`,
  url: `https://www.musinsa.com/products/${goods_no}`, image_url: null,
  sale_price: price, normal_price: price * 2, extra_discount: 0, is_sold_out: 0, ...extra,
});
const D1 = '2026-10-10';
const D2 = '2026-10-11';
const D3 = '2026-10-12';
const scan = (cat, complete = true) => ({ cat, complete });

let dir;
let s;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-musinsa-wide-store-'));
  s = new MusinsaWideStore(path.join(dir, 'musinsa-wide.db'));
});
afterEach(() => {
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('constants and default path match the spec', () => {
  assert.equal(OUT_AFTER_MISSES, 2);
  assert.equal(DROP_ALERT_RATE, 0.1);
  assert.equal(STATUS_OUT_OF_SCOPE, 'OUT_OF_SCOPE');
  assert.equal(defaultMusinsaWideDbPath(), process.env.CLOT_MUSINSA_WIDE_DB_PATH);
  assert.notEqual(path.basename(path.dirname(defaultMusinsaWideDbPath())), 'data');
});

test('isEmpty flips after the first insert', () => {
  assert.equal(s.isEmpty(), true);
  s.applyScan(D1, [row(1, 50000)], scan('001'));
  assert.equal(s.isEmpty(), false);
});

test('applyScan logs NEW once and skips unchanged rows', () => {
  const d1 = s.applyScan(D1, [row(1, 50000), row(2, 30000)], scan('001'));
  assert.equal(d1.added.length, 2);
  const g = s.getGoods(1);
  assert.equal(g.lowest_price, 50000);
  assert.equal(g.lowest_price_date, D1);
  assert.equal(g.first_seen_date, D1);
  assert.equal(g.status, 'ACTIVE');
  const d2 = s.applyScan(D2, [row(1, 50000), row(2, 30000)], scan('001'));
  assert.equal(d2.added.length, 0);
  assert.equal(d2.priceChanged, 0);
  assert.equal(s.getChanges(1).length, 1);
  assert.deepEqual(s.getChanges(1).map((c) => c.event), ['NEW']);
});

test('a price change logs PRICE and a >=10% drop', () => {
  s.applyScan(D1, [row(1, 50000), row(2, 50000)], scan('001'));
  const d = s.applyScan(D2, [row(1, 44000), row(2, 48000)], scan('001'));
  assert.equal(d.priceChanged, 2);
  assert.equal(d.drops.length, 1);
  assert.equal(d.drops[0].row.goods_no, 1);
  assert.equal(d.drops[0].prevPrice, 50000);
  assert.equal(d.drops[0].currentPrice, 44000);
  assert.equal(d.drops[0].dropRate, 12);
  assert.deepEqual(s.getChanges(1).map((c) => c.event), ['NEW', 'PRICE']);
  assert.equal(s.getGoods(1).lowest_price, 44000);
  assert.equal(s.getGoods(1).lowest_price_date, D2);
  const d3 = s.applyScan(D3, [row(1, 45000), row(2, 48000)], scan('001'));
  assert.equal(d3.drops.length, 0); // a rise is not a drop
  assert.equal(s.getGoods(1).lowest_price, 44000);
});

test('a change in extra_discount alone rewrites the row but logs no PRICE', () => {
  s.applyScan(D1, [row(1, 50000)], scan('001'));
  const d = s.applyScan(D2, [row(1, 50000, '001', { extra_discount: 3000 })], scan('001'));
  assert.equal(d.priceChanged, 0);
  assert.equal(s.getGoods(1).extra_discount, 3000);
  assert.equal(s.getChanges(1).length, 1);
});

test('a listing seen without a price keeps its last known price and logs nothing', () => {
  s.applyScan(D1, [row(1, 50000)], scan('001'));
  const d = s.applyScan(D2, [row(1, null)], scan('001'));
  assert.equal(d.priceChanged, 0);
  assert.equal(s.getGoods(1).sale_price, 50000);
  assert.equal(s.getGoods(1).misses, 0);
  assert.equal(s.getChanges(1).length, 1);
});

test('one complete miss keeps ACTIVE; two consecutive go OUT_OF_SCOPE without a price_changes row', () => {
  s.applyScan(D1, [row(1, 50000), row(2, 30000)], scan('001'));
  const d2 = s.applyScan(D2, [row(2, 30000)], scan('001'));
  assert.equal(d2.outOfScope, 0);
  assert.equal(s.getGoods(1).status, 'ACTIVE');
  assert.equal(s.getGoods(1).misses, 1);
  assert.equal(s.getGoods(1).last_miss_date, D2);
  const d3 = s.applyScan(D3, [row(2, 30000)], scan('001'));
  assert.equal(d3.outOfScope, 1);
  assert.equal(s.getGoods(1).status, STATUS_OUT_OF_SCOPE);
  assert.deepEqual(s.getChanges(1).map((c) => c.event), ['NEW']);
  assert.equal(s.getGoods(2).status, 'ACTIVE');
  // a later scan does not count misses for a non-ACTIVE row, and does not report it again
  const d4 = s.applyScan('2026-10-13', [row(2, 30000)], scan('001'));
  assert.equal(d4.outOfScope, 0);
  assert.equal(s.getGoods(1).misses, 2);
});

test('a miss followed by a sighting resets the miss count', () => {
  s.applyScan(D1, [row(1, 50000), row(2, 30000)], scan('001'));
  s.applyScan(D2, [row(2, 30000)], scan('001'));
  s.applyScan(D3, [row(1, 50000), row(2, 30000)], scan('001'));
  const g = s.getGoods(1);
  assert.equal(g.misses, 0);
  assert.equal(g.last_miss_date, null);
  assert.equal(g.status, 'ACTIVE');
  assert.equal(s.getChanges(1).length, 1);
});

test('a same-day rerun counts the miss once', () => {
  s.applyScan(D1, [row(1, 50000), row(2, 30000)], scan('001'));
  s.applyScan(D2, [row(2, 30000)], scan('001'));
  s.applyScan(D2, [row(2, 30000)], scan('001'));
  assert.equal(s.getGoods(1).misses, 1);
  assert.equal(s.getGoods(1).status, 'ACTIVE');
});

test('a same-day rerun writes no duplicate price_changes rows', () => {
  s.applyScan(D1, [row(1, 50000)], scan('001'));
  s.applyScan(D2, [row(1, 44000)], scan('001'));
  const rerun = s.applyScan(D2, [row(1, 44000)], scan('001'));
  assert.equal(rerun.priceChanged, 0);
  assert.equal(rerun.added.length, 0);
  assert.deepEqual(s.getChanges(1).map((c) => c.event), ['NEW', 'PRICE']);
});

test('an incomplete category scan counts no misses', () => {
  s.applyScan(D1, [row(1, 50000), row(2, 30000)], scan('001'));
  s.applyScan(D2, [row(2, 30000)], scan('001', false));
  s.applyScan(D3, [row(2, 30000)], scan('001', false));
  assert.equal(s.getGoods(1).misses, 0);
  assert.equal(s.getGoods(1).status, 'ACTIVE');
  assert.equal(s.getGoods(1).last_miss_date, null);
});

test('a miss in 001 never touches 002 rows', () => {
  s.applyScan(D1, [row(1, 50000, '001')], scan('001'));
  s.applyScan(D1, [row(2, 30000, '002')], scan('002'));
  s.applyScan(D2, [], scan('001'));
  s.applyScan(D3, [], scan('001'));
  assert.equal(s.getGoods(1).status, STATUS_OUT_OF_SCOPE);
  assert.equal(s.getGoods(2).status, 'ACTIVE');
  assert.equal(s.getGoods(2).misses, 0);
});

test('an OUT_OF_SCOPE listing that reappears is REVIVED', () => {
  s.applyScan(D1, [row(1, 50000), row(2, 30000)], scan('001'));
  s.applyScan(D2, [row(2, 30000)], scan('001'));
  s.applyScan(D3, [row(2, 30000)], scan('001'));
  assert.equal(s.getGoods(1).status, STATUS_OUT_OF_SCOPE);
  const d = s.applyScan('2026-10-13', [row(1, 45000), row(2, 30000)], scan('001'));
  assert.equal(d.revived.length, 1);
  assert.equal(d.revived[0].goods_no, 1);
  assert.equal(d.added.length, 0);
  assert.equal(d.priceChanged, 0);
  assert.equal(d.drops.length, 0);
  const g = s.getGoods(1);
  assert.equal(g.status, 'ACTIVE');
  assert.equal(g.misses, 0);
  assert.equal(g.sale_price, 45000);
  assert.deepEqual(s.getChanges(1).map((c) => c.event), ['NEW', 'REVIVED']);
});

test('a listing seen under another cat updates in place', () => {
  s.applyScan(D1, [row(1, 50000, '001')], scan('001'));
  const d = s.applyScan(D2, [row(1, 50000, '002')], scan('002'));
  assert.equal(d.added.length, 0);
  assert.equal(s.getGoods(1).cat, '002');
  assert.equal(s.getChanges(1).length, 1);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM goods').get().n, 1);
});

test('applyScan leaves coupon data alone', () => {
  s.applyScan(D1, [row(1, 50000)], scan('001'));
  s.putGoodsCoupons(1, D1, [{ id: 'c1' }], { sale_price: 50000, extra_discount: 0 });
  s.setCouponPrices(new Map([[1, 45000]]));
  s.applyScan(D2, [row(1, 48000)], scan('001'));
  const g = s.getGoods(1);
  assert.equal(g.coupon_price, 45000);
  assert.equal(g.coupon_checked_date, D1);
  assert.deepEqual(JSON.parse(g.coupons_json), [{ id: 'c1' }]);
});

test('logCouponPriceChanges writes only changes and reports coupon-to-coupon drops', () => {
  // day 1: first sighting writes a row, no earlier row means no drop
  let r = s.logCouponPriceChanges(D1, [{ goods_no: 1, sale_price: 50000, coupon_price: 45000 }]);
  assert.equal(r.written, 1);
  assert.deepEqual(r.drops, []);
  // same pair as the day before: nothing written
  r = s.logCouponPriceChanges(D2, [{ goods_no: 1, sale_price: 50000, coupon_price: 45000 }]);
  assert.equal(r.written, 0);
  // coupon price dropped 45000 -> 40000 = 11%
  r = s.logCouponPriceChanges(D3, [{ goods_no: 1, sale_price: 50000, coupon_price: 40000 }]);
  assert.equal(r.written, 1);
  assert.equal(r.drops.length, 1);
  assert.deepEqual(r.drops[0], { goods_no: 1, prevPrice: 45000, currentPrice: 40000, dropRate: 11 });
  // same-day rerun replaces that day's row and reports the same drop
  r = s.logCouponPriceChanges(D3, [{ goods_no: 1, sale_price: 50000, coupon_price: 38000 }]);
  assert.equal(r.written, 1);
  assert.equal(r.drops[0].prevPrice, 45000);
  assert.equal(r.drops[0].currentPrice, 38000);
  const rows = s.db.prepare('SELECT * FROM coupon_price_changes WHERE goods_no = 1 AND date = ?').all(D3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].coupon_price, 38000);
});

test('logCouponPriceChanges: a null previous coupon price is not a drop; a drop below 10% is ignored', () => {
  s.logCouponPriceChanges(D1, [
    { goods_no: 1, sale_price: 50000, coupon_price: null },
    { goods_no: 2, sale_price: 50000, coupon_price: 45000 },
    { goods_no: 3, sale_price: 50000, coupon_price: 45000 },
  ]);
  const r = s.logCouponPriceChanges(D2, [
    { goods_no: 1, sale_price: 50000, coupon_price: 40000 }, // null -> coupon: change, not a coupon-to-coupon drop
    { goods_no: 2, sale_price: 50000, coupon_price: 41000 }, // 8.9% only
    { goods_no: 3, sale_price: 50000, coupon_price: null }, // coupon -> none: change, no drop
    { goods_no: 4, sale_price: null, coupon_price: 100 }, // no sale price: skipped
  ]);
  assert.equal(r.written, 3);
  assert.deepEqual(r.drops, []);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM coupon_price_changes WHERE goods_no = 4').get().n, 0);
});

test('a same-day rerun back to the earlier pair removes that day\'s row', () => {
  s.logCouponPriceChanges(D1, [{ goods_no: 1, sale_price: 50000, coupon_price: 45000 }]);
  s.logCouponPriceChanges(D2, [{ goods_no: 1, sale_price: 50000, coupon_price: 40000 }]);
  const r = s.logCouponPriceChanges(D2, [{ goods_no: 1, sale_price: 50000, coupon_price: 45000 }]);
  assert.equal(r.written, 0);
  assert.deepEqual(r.drops, []);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM coupon_price_changes WHERE goods_no = 1').get().n, 1);
});

test('applyScan clears coupon_price when a goods goes OUT_OF_SCOPE', () => {
  s.applyScan(D1, [row(1, 50000), row(2, 30000)], scan('001'));
  s.setCouponPrices(new Map([[1, 45000], [2, 27000]]));
  s.applyScan(D2, [row(2, 30000)], scan('001'));
  s.applyScan(D3, [row(2, 30000)], scan('001'));
  assert.equal(s.getGoods(1).status, STATUS_OUT_OF_SCOPE);
  assert.equal(s.getGoods(1).coupon_price, null);
  assert.equal(s.getGoods(2).coupon_price, 27000);
});

test('putGoodsCoupons round-trips the coupon list through getActivePriceRows', () => {
  s.applyScan(D1, [row(1, 50000), row(2, 30000)], scan('001'));
  const coupons = [{ id: 7, name: '10% 쿠폰', type: 'RATE', percent: 10, price: null, max: 5000, min: 30000, discount: 5000, until: '2026-10-31' }];
  s.putGoodsCoupons(1, D2, coupons, { sale_price: 50000, extra_discount: 0 });
  const rows = s.getActivePriceRows();
  assert.deepEqual(rows.map((r) => r.goods_no), [1, 2]);
  assert.deepEqual(rows[0], { goods_no: 1, sale_price: 50000, extra_discount: 0, coupon_checked_date: D2, coupons });
  assert.equal(rows[1].coupons, null);
  assert.equal(rows[1].coupon_checked_date, null);
  s.putGoodsCoupons(2, D2, [], { sale_price: 30000, extra_discount: 0 });
  assert.deepEqual(s.getActivePriceRows()[1].coupons, []);
});

test('getActivePriceRows excludes OUT_OF_SCOPE listings', () => {
  s.applyScan(D1, [row(1, 50000), row(2, 30000)], scan('001'));
  s.applyScan(D2, [row(2, 30000)], scan('001'));
  s.applyScan(D3, [row(2, 30000)], scan('001'));
  assert.deepEqual(s.getActivePriceRows().map((r) => r.goods_no), [2]);
});

test('setCouponPrices writes coupon_price, null clears it', () => {
  s.applyScan(D1, [row(1, 50000), row(2, 30000)], scan('001'));
  s.setCouponPrices(new Map([[1, 45000], [2, null]]));
  assert.equal(s.getGoods(1).coupon_price, 45000);
  assert.equal(s.getGoods(2).coupon_price, null);
  s.setCouponPrices(new Map([[1, null]]));
  assert.equal(s.getGoods(1).coupon_price, null);
});

test('recordScanRun upserts per date and keeps coupons_ok sticky', () => {
  const base = { date: D1, categoryCounts: { '001': 10 }, complete: true, changed: 3, added: 2, outOfScope: 1, durationMs: 1000, couponsOk: true, couponChecks: 50 };
  s.recordScanRun(base);
  s.recordScanRun({ ...base, changed: 0, added: 0, outOfScope: 0, couponsOk: false, couponChecks: 20 });
  const r = s.db.prepare('SELECT * FROM scan_runs WHERE date = ?').get(D1);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM scan_runs').get().n, 1);
  assert.deepEqual(JSON.parse(r.category_counts_json), { '001': 10 });
  assert.equal(r.complete, 1);
  assert.equal(r.changed, 0);
  assert.equal(r.coupons_ok, 1);
  assert.equal(r.coupon_checks, 70);
  assert.ok(r.completed_at);
});

test('indexes exist and checkpoint does not throw', () => {
  const names = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((i) => i.name);
  for (const n of ['idx_price_changes_goods_date', 'idx_goods_cat_status', 'idx_goods_status_coupon_checked']) assert.ok(names.includes(n), n);
  s.checkpoint();
});

test('a goods listed twice in one scan is inserted once', () => {
  const d = s.applyScan(D1, [row(1, 50000), row(1, 49000)], scan('001'));
  assert.equal(d.added.length, 1);
  assert.equal(s.getGoods(1).sale_price, 49000);
  assert.equal(s.getChanges(1).length, 1);
});

// --- coupon registry ---

const mc = (id, extra = {}) => ({
  id: String(id), name: `coupon ${id}`, type: 'PERCENT', percent: 10, price: null, max: 5000, min: 30000,
  discount: 0, start: '2026-10-01', until: '2026-12-31', ...extra,
});
const setState = (couponNo, state) => s.db.prepare('UPDATE coupons SET state = ? WHERE coupon_no = ?').run(state, couponNo);
const stateOf = (couponNo) => s.getCoupon(couponNo)?.state;

test('opening a DB with the 2026-10-14 schema adds the new columns and tables and keeps rows', () => {
  const oldPath = path.join(dir, 'old.db');
  const old = new DatabaseSync(oldPath);
  old.exec(`
    CREATE TABLE goods (
      goods_no INTEGER PRIMARY KEY, cat TEXT, brand TEXT, brand_name TEXT, name TEXT NOT NULL, url TEXT NOT NULL, image_url TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE', sale_price INTEGER, normal_price INTEGER, extra_discount INTEGER NOT NULL DEFAULT 0,
      is_sold_out INTEGER NOT NULL DEFAULT 0, coupon_price INTEGER, coupons_json TEXT, coupon_checked_date TEXT,
      coupon_checked_sale_price INTEGER, coupon_checked_extra INTEGER,
      lowest_price INTEGER, lowest_price_date TEXT, first_seen_date TEXT NOT NULL,
      misses INTEGER NOT NULL DEFAULT 0, last_miss_date TEXT
    );
    CREATE TABLE scan_runs (
      date TEXT PRIMARY KEY, category_counts_json TEXT, complete INTEGER, changed INTEGER, added INTEGER, out_of_scope INTEGER,
      duration_ms INTEGER, completed_at TEXT NOT NULL, coupons_ok INTEGER, coupon_checks INTEGER
    );
    INSERT INTO goods (goods_no, name, url, sale_price, first_seen_date) VALUES (1, 'old goods', 'u', 1000, '2026-10-14');
  `);
  old.close();

  const migrated = new MusinsaWideStore(oldPath);
  try {
    assert.equal(migrated.getGoods(1).review_count, null);
    assert.equal(migrated.getGoods(1).name, 'old goods');
    migrated.recordScanRun({ date: D1, categoryCounts: {}, complete: true, changed: 0, added: 0, outOfScope: 0, durationMs: 1, couponMetrics: { a: 1 } });
    assert.deepEqual(JSON.parse(migrated.db.prepare('SELECT coupon_metrics_json AS m FROM scan_runs').get().m), { a: 1 });
    const tables = migrated.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    for (const t of ['coupons', 'coupon_empty_numbers', 'coupon_goods', 'coupon_observations', 'meta']) assert.ok(tables.includes(t), t);
  } finally {
    migrated.close();
  }
});

test('applyScan stores review_count and rewrites a row when only review_count changed', () => {
  s.applyScan(D1, [row(1, 50000, '001', { review_count: 10 })], scan('001'));
  assert.equal(s.getGoods(1).review_count, 10);
  const d = s.applyScan(D2, [row(1, 50000, '001', { review_count: 25 })], scan('001'));
  assert.equal(s.getGoods(1).review_count, 25);
  assert.equal(d.priceChanged, 0);
  assert.equal(s.getChanges(1).length, 1);
  s.applyScan(D3, [row(1, 50000)], scan('001'));
  assert.equal(s.getGoods(1).review_count, null);
});

test('meta round-trips and null deletes', () => {
  assert.equal(s.getMeta('frontier'), null);
  s.setMeta('frontier', '123');
  assert.equal(s.getMeta('frontier'), '123');
  s.setMeta('frontier', '456');
  assert.equal(s.getMeta('frontier'), '456');
  s.setMeta('frontier', null);
  assert.equal(s.getMeta('frontier'), null);
});

test('recordHit puts PENDING with scope goods, OUT_OF_SCOPE without, and only updates last_count when known', () => {
  assert.deepEqual(COUPON_STATE, { USABLE: 'USABLE', OTHER: 'OTHER', PENDING: 'PENDING', OUT_OF_SCOPE: 'OUT_OF_SCOPE', RETIRED: 'RETIRED' });
  assert.equal(s.recordHit(100, D1, 40, { scopeGoods: [7, 8] }), 'new');
  assert.equal(s.recordHit(101, D1, 5), 'new');
  const a = s.getCoupon(100);
  assert.equal(a.state, 'PENDING');
  assert.equal(a.last_count, 40);
  assert.deepEqual(a.scope_goods, [7, 8]);
  assert.equal(a.first_seen_date, D1);
  assert.equal(s.getCoupon(101).state, 'OUT_OF_SCOPE');
  assert.equal(s.getCoupon(101).scope_goods, null);
  assert.equal(s.getCoupon(999), undefined);

  assert.equal(s.recordHit(100, D2, 55, { scopeGoods: [9] }), 'known');
  const b = s.getCoupon(100);
  assert.equal(b.state, 'PENDING');
  assert.equal(b.last_count, 55);
  assert.equal(b.first_seen_date, D1);
  assert.deepEqual(b.scope_goods, [7, 8]);

  s.markClassified([100], D2, 'OTHER');
  assert.equal(s.recordHit(100, D3, 60, { scopeGoods: [9] }), 'known');
  assert.equal(stateOf(100), 'OTHER');
});

test('recordHit clears an empty number; emptyNumbersToRecheck keeps 3 days and excludes today', () => {
  const D = '2026-10-15';
  s.recordEmpty(1, '2026-10-11');
  s.recordEmpty(2, '2026-10-12');
  s.recordEmpty(3, '2026-10-14');
  s.recordEmpty(4, D);
  assert.deepEqual(s.emptyNumbersToRecheck(D), [2, 3]);
  s.recordEmpty(2, D);
  assert.deepEqual(s.emptyNumbersToRecheck(D), [2, 3], 'first-seen date is kept');
  s.recordHit(2, D, 12, { scopeGoods: [5] });
  assert.deepEqual(s.emptyNumbersToRecheck(D), [3]);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM coupon_empty_numbers WHERE coupon_no = 2').get().n, 0);
});

test('upsertMemberCoupons registers USABLE with conditions and reports added and revived', () => {
  const first = s.upsertMemberCoupons(D1, [mc(10), mc(11, { type: 'PRICE', percent: null, price: 3000, max: null, min: 0, until: null, start: null })]);
  assert.deepEqual(first, { added: [10, 11], revived: [] });
  const c10 = s.getCoupon(10);
  assert.equal(c10.coupon_no, 10);
  assert.equal(c10.state, 'USABLE');
  assert.equal(c10.name, 'coupon 10');
  assert.equal(c10.type, 'PERCENT');
  assert.equal(c10.percent, 10);
  assert.equal(c10.price, null);
  assert.equal(c10.max, 5000);
  assert.equal(c10.min, 30000);
  assert.equal(c10.start_date, '2026-10-01');
  assert.equal(c10.until_date, '2026-12-31');
  assert.equal(c10.last_member_seen_date, D1);
  assert.equal(c10.first_seen_date, D1);
  const c11 = s.getCoupon(11);
  assert.equal(c11.price, 3000);
  assert.equal(c11.max, null);
  assert.equal(c11.until_date, null);

  // Known USABLE: neither added nor revived, but conditions and last seen refresh.
  const again = s.upsertMemberCoupons(D2, [mc(10, { max: 7000 })]);
  assert.deepEqual(again, { added: [], revived: [] });
  assert.equal(s.getCoupon(10).max, 7000);
  assert.equal(s.getCoupon(10).last_member_seen_date, D2);
  assert.equal(s.getCoupon(10).first_seen_date, D1);

  s.recordHit(20, D1, 3, { scopeGoods: [1] });
  s.recordHit(21, D1, 3);
  s.recordHit(22, D1, 3, { scopeGoods: [1] });
  s.markClassified([20], D1, 'OTHER');
  setState(22, 'RETIRED');
  const mixed = s.upsertMemberCoupons(D3, [mc(20), mc(21), mc(22), mc(23), mc(10)]);
  assert.deepEqual(mixed, { added: [23], revived: [20, 21, 22] });
  for (const n of [20, 21, 22, 23]) assert.equal(stateOf(n), 'USABLE');
  assert.equal(s.getCoupon(20).first_seen_date, D1);
});

test('markClassified changes only PENDING rows', () => {
  s.recordHit(1, D1, 3, { scopeGoods: [1] });
  s.recordHit(2, D1, 3, { scopeGoods: [1] });
  s.recordHit(3, D1, 3);
  s.upsertMemberCoupons(D1, [mc(4)]);
  assert.deepEqual(s.pendingCoupons().map((c) => c.coupon_no), [1, 2]);
  s.markClassified([1, 3, 4, 99], D2, 'USABLE');
  assert.equal(stateOf(1), 'USABLE');
  assert.equal(s.getCoupon(1).classified_date, D2);
  assert.equal(stateOf(2), 'PENDING');
  assert.equal(stateOf(3), 'OUT_OF_SCOPE');
  assert.equal(s.getCoupon(3).classified_date, null);
  assert.equal(stateOf(4), 'USABLE');
  assert.equal(s.getCoupon(4).classified_date, null);
  s.markClassified([], D2, 'OTHER');
  assert.deepEqual(s.pendingCoupons().map((c) => c.coupon_no), [2]);
});

test('usableCoupons excludes expired and non-USABLE', () => {
  s.upsertMemberCoupons(D2, [
    mc(1, { until: '2026-10-11' }), mc(2, { until: '2026-10-10' }), mc(3, { until: null }), mc(4), mc(5),
  ]);
  setState(5, 'OTHER');
  assert.deepEqual(s.usableCoupons(D2).map((c) => c.coupon_no), [1, 3, 4]);
});

test('seedFromGoodsCoupons registers unexpired stored coupons once', () => {
  s.applyScan(D1, [row(1, 50000), row(2, 40000), row(3, 30000)], scan('001'));
  s.putGoodsCoupons(1, D1, [mc(10), mc(11, { until: '2026-10-09' })], { sale_price: 50000, extra_discount: 0 });
  s.putGoodsCoupons(2, D1, [mc(10), mc(12, { until: null })], { sale_price: 40000, extra_discount: 0 });
  assert.equal(s.seedFromGoodsCoupons(D1), 2);
  assert.deepEqual(s.usableCoupons(D1).map((c) => c.coupon_no), [10, 12]);
  assert.equal(s.getCoupon(11), undefined);
  assert.equal(s.seedFromGoodsCoupons(D1), 2);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM coupons').get().n, 2);
});

test('registryCounts reports usable, pending and coupons that expired yesterday', () => {
  const D = '2026-10-15';
  s.upsertMemberCoupons(D, [mc(1, { until: '2026-10-14' }), mc(2, { until: '2026-10-14' }), mc(3, { until: '2026-10-13' }), mc(4, { until: '2026-10-15' }), mc(5, { until: null })]);
  setState(2, 'OTHER');
  s.recordHit(6, D, 3, { scopeGoods: [1] });
  assert.deepEqual(s.registryCounts(D), { usable: 2, pending: 1, expiredYesterday: 1 });
});

test('maxCouponNo and filterActive', () => {
  assert.equal(s.maxCouponNo(), null);
  s.recordHit(5, D1, 1);
  s.recordHit(50, D1, 1);
  assert.equal(s.maxCouponNo(), 50);
  s.applyScan(D1, [row(1, 1000), row(2, 1000), row(3, 1000)], scan('001'));
  s.applyScan(D2, [row(1, 1000)], scan('001'));
  s.applyScan(D3, [row(1, 1000)], scan('001'));
  assert.deepEqual(s.filterActive([1, 2, 3, 4]), [1]);
  assert.deepEqual(s.filterActive([]), []);
});

test('registry constants and shiftDate', () => {
  assert.deepEqual([LIVENESS_DAYS, LIVENESS_MIN_OBS, REGISTRY_KEEP_DAYS, EMPTY_RECHECK_DAYS], [7, 3, 60, 3]);
  assert.equal(shiftDate('2026-10-15', -6), '2026-10-09');
  assert.equal(shiftDate('2026-10-01', -1), '2026-09-30');
  assert.equal(shiftDate('2026-12-30', 3), '2027-01-02');
});

const goodsOf = (couponNo) => s.db.prepare('SELECT goods_no FROM coupon_goods WHERE coupon_no = ? ORDER BY goods_no').all(couponNo).map((r) => r.goods_no);

test('replaceCouponGoods keeps only ACTIVE goods and replaces that coupon\'s rows only', () => {
  s.applyScan(D1, [row(1, 1000), row(2, 1000), row(3, 1000)], scan('001'));
  s.applyScan(D2, [row(1, 1000), row(2, 1000)], scan('001'));
  s.applyScan(D3, [row(1, 1000), row(2, 1000)], scan('001')); // goods 3 is out of scope now
  s.replaceCouponGoods(10, D3, [1, 2, 3, 99]);
  s.replaceCouponGoods(11, D3, [2]);
  assert.deepEqual(goodsOf(10), [1, 2]);
  assert.equal(s.couponGoodsCount(), 3);
  s.replaceCouponGoods(10, D3, [1, 2, 3, 99]);
  assert.equal(s.couponGoodsCount(), 3);
  s.replaceCouponGoods(10, D3, [1]);
  assert.deepEqual(goodsOf(10), [1]);
  assert.deepEqual(goodsOf(11), [2]);
  assert.equal(s.db.prepare('SELECT date FROM coupon_goods WHERE coupon_no = 10').get().date, D3);
  s.replaceCouponGoods(10, D3, []);
  assert.deepEqual(goodsOf(10), []);
  assert.equal(s.couponGoodsCount(), 1);
});

test('couponsByGoods groups coupons per goods', () => {
  s.applyScan(D1, [row(1, 1000), row(2, 1000)], scan('001'));
  s.replaceCouponGoods(10, D1, [1, 2]);
  s.replaceCouponGoods(11, D1, [2]);
  const m = s.couponsByGoods();
  assert.ok(m instanceof Map);
  assert.deepEqual(m.get(1), [10]);
  assert.deepEqual(m.get(2).sort((a, b) => a - b), [10, 11]);
  assert.equal(m.size, 2);
});

const obs = (couponNo, goodsNo) =>
  s.db.prepare('SELECT date, seen FROM coupon_observations WHERE coupon_no = ? AND goods_no = ? ORDER BY date').all(couponNo, goodsNo).map((r) => ({ ...r }));

test('recordObservations writes seen 1/0 only for USABLE coupons whose list holds the goods; a same-day rerun does not duplicate', () => {
  s.applyScan(D1, [row(1, 1000), row(2, 1000)], scan('001'));
  s.upsertMemberCoupons(D1, [mc(10), mc(11), mc(12)]);
  setState(12, 'OTHER');
  s.replaceCouponGoods(10, D1, [1]);
  s.replaceCouponGoods(11, D1, [1, 2]);
  s.replaceCouponGoods(12, D1, [1]);
  s.replaceCouponGoods(13, D1, [1]); // not in the registry at all
  const n = s.recordObservations(D1, [{ goods_no: 1, couponNos: [10] }, { goods_no: 2, couponNos: [] }]);
  assert.equal(n, 3);
  assert.deepEqual(obs(10, 1), [{ date: D1, seen: 1 }]);
  assert.deepEqual(obs(11, 1), [{ date: D1, seen: 0 }]);
  assert.deepEqual(obs(11, 2), [{ date: D1, seen: 0 }]);
  assert.deepEqual(obs(10, 2), []);
  assert.deepEqual(obs(12, 1), []);
  assert.deepEqual(obs(13, 1), []);
  assert.equal(s.recordObservations(D1, [{ goods_no: 1, couponNos: [10, 11] }]), 2);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM coupon_observations').get().n, 3);
  assert.deepEqual(obs(11, 1), [{ date: D1, seen: 1 }]);
});

test('retireDead retires after 3 unseen observations within 7 days, not with 2, not when one was seen, not with an 8-day-old observation', () => {
  const D = '2026-10-15';
  s.upsertMemberCoupons(D, [mc(1), mc(2), mc(3), mc(4), mc(5)]);
  const put = (c, g, date, seen) =>
    s.db.prepare('INSERT INTO coupon_observations (coupon_no, goods_no, date, seen) VALUES (?, ?, ?, ?)').run(c, g, date, seen);
  for (const g of [1, 2, 3]) put(1, g, D, 0); // dead: 3 unseen
  for (const g of [1, 2]) put(2, g, D, 0); // only 2 observations
  put(3, 1, D, 0); put(3, 2, D, 0); put(3, 3, D, 1); // one seen
  put(4, 1, D, 0); put(4, 2, shiftDate(D, -6), 0); put(4, 3, shiftDate(D, -7), 0); // 8-day-old one is outside the window
  put(5, 1, D, 0); put(5, 2, shiftDate(D, -6), 0); put(5, 3, shiftDate(D, -3), 0); // oldest still inside
  assert.deepEqual(s.retireDead(D), [1, 5]);
  assert.equal(stateOf(1), 'RETIRED');
  assert.equal(stateOf(5), 'RETIRED');
  for (const n of [2, 3, 4]) assert.equal(stateOf(n), 'USABLE');
  assert.deepEqual(s.retireDead(D), []);
});

const seedCats = (perCat, extra = () => ({})) => {
  let n = 1;
  for (const cat of ['001', '002', '003', '004', '005']) {
    s.applyScan(D1, Array.from({ length: perCat }, () => { const g = n++; return row(g, 1000 + g, cat, extra(g)); }), scan(cat, false));
  }
};

test('pickSample is deterministic per date, takes n/5 per category, skips sold-out and today-checked goods', () => {
  seedCats(100, (g) => (g % 10 === 0 ? { is_sold_out: 1 } : {}));
  s.putGoodsCoupons(1, D2, [], { sale_price: 1001, extra_discount: 0 }); // checked today
  const a = s.pickSample(200, D2);
  assert.equal(a.length, 200);
  for (const cat of ['001', '002', '003', '004', '005']) assert.equal(a.filter((r) => r.cat === cat).length, 40);
  assert.deepEqual(Object.keys(a[0]).sort(), ['brand', 'cat', 'extra_discount', 'goods_no', 'sale_price']);
  assert.ok(!a.some((r) => r.goods_no % 10 === 0));
  assert.ok(!a.some((r) => r.goods_no === 1));
  assert.deepEqual(s.pickSample(200, D2), a);
  assert.notDeepEqual(s.pickSample(200, D3).map((r) => r.goods_no), a.map((r) => r.goods_no));
  // a smaller n takes the first n/5 of the same shuffle
  const small = s.pickSample(10, D2);
  assert.equal(small.length, 10);
  assert.deepEqual(small.filter((r) => r.cat === '001').map((r) => r.goods_no), a.filter((r) => r.cat === '001').slice(0, 2).map((r) => r.goods_no));
});

test('pickSample skips goods without price or not ACTIVE and returns fewer when a category runs short', () => {
  s.applyScan(D1, [row(1, 1000, '001'), row(2, 2000, '001'), row(3, 3000, '001')], scan('001'));
  s.applyScan(D2, [row(1, 1000, '001'), row(2, 2000, '001')], scan('001'));
  s.applyScan(D3, [row(1, 1000, '001'), row(2, 2000, '001')], scan('001')); // goods 3 out of scope
  assert.deepEqual(s.pickSample(50, D3).map((r) => r.goods_no).sort(), [1, 2]);
});

test('categoryReviewFloors returns the minimum review_count of ACTIVE goods per category', () => {
  s.applyScan(D1, [row(1, 1000, '001', { review_count: 50 }), row(2, 1000, '001', { review_count: 7 }), row(3, 1000, '001'), row(4, 1000, '001', { review_count: 2 })], scan('001'));
  s.applyScan(D1, [row(5, 1000, '002', { review_count: 0 }), row(6, 1000, '002', { review_count: 9 })], scan('002'));
  s.applyScan(D1, [row(7, 1000, '003')], scan('003'));
  s.applyScan(D2, [row(1, 1000, '001', { review_count: 50 }), row(2, 1000, '001', { review_count: 7 }), row(3, 1000, '001')], scan('001'));
  s.applyScan(D3, [row(1, 1000, '001', { review_count: 50 }), row(2, 1000, '001', { review_count: 7 }), row(3, 1000, '001')], scan('001')); // goods 4 (2 reviews) leaves scope
  assert.deepEqual(s.categoryReviewFloors(), { '001': 7, '002': 0 });
});

test('pruneRegistry removes 60-day-old OTHER/OUT_OF_SCOPE, 3-day-old empties and 7-day-old observations, never USABLE', () => {
  const D = '2026-10-15';
  const old = shiftDate(D, -61);
  const edge = shiftDate(D, -60);
  const ins = (no, state, first) => s.db.prepare('INSERT INTO coupons (coupon_no, state, first_seen_date) VALUES (?, ?, ?)').run(no, state, first);
  ins(1, 'OTHER', old); ins(2, 'OUT_OF_SCOPE', old); ins(3, 'OTHER', edge); ins(4, 'USABLE', old);
  ins(5, 'PENDING', old); ins(6, 'RETIRED', old);
  const empty = (no, first) => s.db.prepare('INSERT INTO coupon_empty_numbers (coupon_no, first_seen_date) VALUES (?, ?)').run(no, first);
  empty(20, shiftDate(D, -4)); empty(21, shiftDate(D, -3));
  const ob = (date) => s.db.prepare('INSERT INTO coupon_observations (coupon_no, goods_no, date, seen) VALUES (4, 1, ?, 0)').run(date);
  ob(shiftDate(D, -7)); ob(shiftDate(D, -6));
  assert.deepEqual(s.pruneRegistry(D), { coupons: 2, empties: 1, observations: 1 });
  const left = s.db.prepare('SELECT coupon_no FROM coupons ORDER BY coupon_no').all().map((r) => r.coupon_no);
  assert.deepEqual(left, [3, 4, 5, 6]);
  assert.deepEqual(s.db.prepare('SELECT coupon_no FROM coupon_empty_numbers').all().map((r) => r.coupon_no), [21]);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM coupon_observations').get().n, 1);
});

test('goodsHasDirectCoupon finds a coupon in stored coupon lists', () => {
  s.applyScan(D1, [row(1, 1000), row(2, 1000)], scan('001'));
  assert.equal(s.goodsHasDirectCoupon(10), false);
  s.putGoodsCoupons(1, D1, [mc(10), mc(11)], { sale_price: 1000, extra_discount: 0 });
  s.putGoodsCoupons(2, D1, [], { sale_price: 1000, extra_discount: 0 });
  assert.equal(s.goodsHasDirectCoupon(10), true);
  assert.equal(s.goodsHasDirectCoupon('11'), true);
  assert.equal(s.goodsHasDirectCoupon(1), false);
  assert.equal(s.goodsHasDirectCoupon(12), false);
});
