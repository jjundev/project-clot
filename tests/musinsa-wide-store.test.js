import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MusinsaWideStore, defaultMusinsaWideDbPath, OUT_AFTER_MISSES, DROP_ALERT_RATE, STATUS_OUT_OF_SCOPE,
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

test('pickCouponChecks orders never-checked, then price-changed since check, then oldest; skips sold-out and today-checked', () => {
  s.applyScan(D1, [
    row(10, 10000), // never checked
    row(11, 10000), // never checked
    row(20, 20000), // checked, price will change
    row(21, 20000, '001', { extra_discount: 0 }), // checked, extra will change
    row(30, 30000), // checked long ago
    row(31, 30000), // checked more recently
    row(32, 30000), // checked today
    row(40, 40000, '001', { is_sold_out: 1 }), // sold out, never checked
    row(41, null), // no price at insert
  ], scan('001'));
  const ok = (no, date, price, extra = 0) => s.putGoodsCoupons(no, date, [], { sale_price: price, extra_discount: extra });
  ok(20, '2026-10-05', 20000);
  ok(21, '2026-10-06', 20000);
  ok(30, '2026-10-01', 30000);
  ok(31, '2026-10-04', 30000);
  ok(32, D2, 30000);
  s.applyScan(D2, [
    row(10, 10000), row(11, 10000), row(30, 30000), row(31, 30000), row(32, 30000),
    row(20, 19000), row(21, 20000, '001', { extra_discount: 2000 }),
    row(40, 40000, '001', { is_sold_out: 1 }), row(41, null),
  ], scan('001'));
  const picked = s.pickCouponChecks(100, D2);
  assert.deepEqual(picked.map((p) => p.goods_no), [10, 11, 20, 21, 30, 31]);
  assert.deepEqual(picked[2], { goods_no: 20, brand: 'nike', sale_price: 19000, extra_discount: 0 });
  assert.deepEqual(s.pickCouponChecks(3, D2).map((p) => p.goods_no), [10, 11, 20]);
  // next day, today-checked 32 is eligible again (oldest-first after the others)
  assert.equal(s.pickCouponChecks(100, D3).map((p) => p.goods_no).includes(32), true);
});

test('pickCouponChecks puts goods with an expired stored coupon right after never-checked', () => {
  s.applyScan(D1, [row(1, 10000), row(2, 20000), row(3, 30000), row(4, 40000), row(5, 50000)], scan('001'));
  const info = (price) => ({ sale_price: price, extra_discount: 0 });
  const coupon = (id, until) => ({ id, name: 'c', type: 'PERCENT', percent: 10, price: null, max: null, min: 0, discount: 0, until });
  s.putGoodsCoupons(1, '2026-10-01', [coupon('a', '2026-12-31')], info(10000)); // still valid: oldest tier
  s.putGoodsCoupons(2, '2026-10-05', [coupon('b', '2026-10-31')], info(20000)); // expired on D2... see date below
  s.putGoodsCoupons(3, '2026-10-02', [], info(30000)); // price will change
  s.putGoodsCoupons(4, '2026-10-06', [coupon('c', null), coupon('d', '2026-10-31')], info(40000)); // no-expiry + expired
  // goods 5 never checked
  s.applyScan(D2, [row(1, 10000), row(2, 20000), row(3, 29000), row(4, 40000), row(5, 50000)], scan('001'));
  assert.deepEqual(s.pickCouponChecks(10, '2026-10-31').map((p) => p.goods_no), [5, 3, 1, 2, 4]); // nothing expired yet on the 31st
  assert.deepEqual(s.pickCouponChecks(10, '2026-11-01').map((p) => p.goods_no), [5, 2, 4, 3, 1]);
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

test('pickCouponChecks ignores OUT_OF_SCOPE listings', () => {
  s.applyScan(D1, [row(1, 50000), row(2, 30000)], scan('001'));
  s.applyScan(D2, [row(2, 30000)], scan('001'));
  s.applyScan(D3, [row(2, 30000)], scan('001'));
  assert.deepEqual(s.pickCouponChecks(10, D3).map((p) => p.goods_no), [2]);
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
