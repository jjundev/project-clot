import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

const liked = (sno) => ({
  sno, brand: '유니클로', name: `liked ${sno}`, market_name: 'seller', category: 'cat',
  url: `https://4910.kr/goods/${sno}`, image_url: null,
  // extra fields from the client's toRow() must be ignored
  brand_sno: 2421, sale_price: 1000, closed: false,
});
const likedRow = (sno) => s.db.prepare('SELECT * FROM liked_goods WHERE sno = ?').get(sno);

test('syncLiked inserts ACTIVE rows with first_liked_date and last_seen_date', () => {
  assert.deepEqual(s.syncLiked([liked(1), liked(2)], '2026-10-11'), { added: 2, unliked: 0, active: 2 });
  const a = likedRow(1);
  assert.equal(a.status, 'ACTIVE');
  assert.equal(a.first_liked_date, '2026-10-11');
  assert.equal(a.last_seen_date, '2026-10-11');
  assert.equal(a.name, 'liked 1');
});

test('a sno missing from the next sync becomes UNLIKED and returns ACTIVE when liked again', () => {
  s.syncLiked([liked(1), liked(2)], '2026-10-11');
  assert.deepEqual(s.syncLiked([liked(1)], '2026-10-12'), { added: 0, unliked: 1, active: 1 });
  assert.equal(likedRow(2).status, 'UNLIKED');
  assert.deepEqual(s.syncLiked([liked(1), liked(2)], '2026-10-13'), { added: 0, unliked: 0, active: 2 });
  const b = likedRow(2);
  assert.equal(b.status, 'ACTIVE');
  assert.equal(b.first_liked_date, '2026-10-11');
  assert.equal(b.last_seen_date, '2026-10-13');
});

test('an empty liked list unlikes nothing', () => {
  s.syncLiked([liked(1), liked(2)], '2026-10-11');
  assert.deepEqual(s.syncLiked([], '2026-10-12'), { added: 0, unliked: 0, active: 2 });
});

test('getActiveLiked returns ACTIVE rows ordered by sno', () => {
  s.syncLiked([liked(3), liked(1), liked(2)], '2026-10-11');
  s.syncLiked([liked(3), liked(1)], '2026-10-12');
  assert.deepEqual(s.getActiveLiked().map((g) => g.sno), [1, 3]);
});

test('logLikedPrice keeps one row per sno and date', () => {
  const base = { sno: 1, date: '2026-10-11', list_price: 5000, original_price: 9000, coupon_price: null, member_price: 4000, is_soldout: 0 };
  s.logLikedPrice(base);
  s.logLikedPrice({ ...base, member_price: 3500 });
  const rows = s.db.prepare('SELECT * FROM liked_price_logs WHERE sno = 1').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].member_price, 3500);
});

test('getPrevLikedPrice returns the latest row before the date', () => {
  const log = (date, member_price) => s.logLikedPrice({ sno: 1, date, list_price: 5000, original_price: 9000, coupon_price: null, member_price, is_soldout: 0 });
  log('2026-10-09', 4500);
  log('2026-10-10', 4000);
  assert.equal(s.getPrevLikedPrice(1, '2026-10-11').date, '2026-10-10');
  assert.equal(s.getPrevLikedPrice(1, '2026-10-09'), undefined);
});

// ---- top-100 sellers: per-brand scans, scope, brands, sellers, coupons ----

test('applyScan loads only the scanned brands; an incomplete other brand keeps its misses', () => {
  s.applyScan('2026-10-10', [row(1, 50000), row(2, 40000), row(9, 7000, 13647), row(10, 8000, 13647)], BOTH);
  s.applyScan('2026-10-11', [row(1, 50000)], { completeBrands: [2421] });
  assert.equal(s.getGoods(2).misses, 1);
  assert.equal(s.getGoods(1).misses, 0);
  assert.equal(s.getGoods(9).misses, 0);
  assert.equal(s.getGoods(10).misses, 0);
});

test('a listing that moved brands is found by sno instead of colliding on insert', () => {
  s.applyScan('2026-10-10', [row(1, 50000, 2421)], BOTH);
  const d = s.applyScan('2026-10-11', [{ ...row(1, 50000, 13647) }], { completeBrands: [13647] });
  assert.deepEqual(d.added, []);
  assert.equal(s.getGoods(1).brand_sno, 13647);
  assert.deepEqual(s.getChanges(1).map((c) => c.event), ['NEW']);
});

test('market_type_sno is stored on insert and update, and changing it alone logs nothing', () => {
  s.applyScan('2026-10-10', [{ ...row(1, 50000), market_type_sno: 1 }], BOTH);
  assert.equal(s.getGoods(1).market_type_sno, 1);
  const d = s.applyScan('2026-10-11', [{ ...row(1, 50000), market_type_sno: 2 }], BOTH);
  assert.equal(s.getGoods(1).market_type_sno, 2);
  assert.equal(d.priceChanged, 0);
  assert.equal(s.getChanges(1).length, 1);
});

test('a scan with no listings of an unseen brand is still initial only when goods is empty', () => {
  assert.equal(s.isEmpty(), true);
  const d1 = s.applyScan('2026-10-10', [row(1, 50000)], { completeBrands: [2421] });
  assert.equal(d1.initial, true);
  assert.equal(s.isEmpty(), false);
  const d2 = s.applyScan('2026-10-10', [row(9, 7000, 13647)], { completeBrands: [13647] });
  assert.equal(d2.initial, false);
});

test('markOutOfScope hides rows of dropped brands and unqualified sellers without history', () => {
  const at = (sno, brand_sno, market_sno) => ({ ...row(sno, 10000 + sno, brand_sno), market_sno });
  s.applyScan('2026-10-10', [
    at(1, 2421, 10), // stays
    at(2, 13647, 10), // brand dropped
    at(3, 2421, 11), // seller unqualified
    at(4, 2421, null), // no seller known
  ], BOTH);
  const before = [1, 2, 3, 4].map((n) => s.getChanges(n).length);
  const n = s.markOutOfScope({ activeBrandSnos: [2421], qualifiedMarketSnos: [10] });
  assert.equal(n, 3);
  assert.deepEqual([1, 2, 3, 4].map((x) => s.getGoods(x).status), ['ACTIVE', 'OUT_OF_SCOPE', 'OUT_OF_SCOPE', 'OUT_OF_SCOPE']);
  assert.deepEqual([1, 2, 3, 4].map((x) => s.getChanges(x).length), before);
  // already out of scope rows are not counted again
  assert.equal(s.markOutOfScope({ activeBrandSnos: [2421], qualifiedMarketSnos: [10] }), 0);
});

test('an OUT_OF_SCOPE listing seen again is REVIVED', () => {
  s.applyScan('2026-10-10', [row(1, 50000)], BOTH);
  s.markOutOfScope({ activeBrandSnos: [], qualifiedMarketSnos: [] });
  const d = s.applyScan('2026-10-11', [row(1, 50000)], BOTH);
  assert.deepEqual(d.revived.map((r) => r.sno), [1]);
  assert.equal(s.getGoods(1).status, 'ACTIVE');
  assert.deepEqual(s.getChanges(1).map((c) => c.event), ['NEW', 'REVIVED']);
});

test('OUT_OF_SCOPE rows take no misses', () => {
  s.applyScan('2026-10-10', [row(1, 50000), row(2, 1000)], BOTH);
  s.markOutOfScope({ activeBrandSnos: [], qualifiedMarketSnos: [] });
  s.applyScan('2026-10-11', [], { completeBrands: [2421] });
  assert.equal(s.getGoods(1).misses, 0);
  assert.equal(s.getGoods(1).status, 'OUT_OF_SCOPE');
});

test('opening an old 4910.db adds market_type_sno and coupon_price', () => {
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE goods (
      sno INTEGER PRIMARY KEY, brand_sno INTEGER NOT NULL, brand TEXT, name TEXT NOT NULL,
      market_sno INTEGER, market_name TEXT, category TEXT, url TEXT NOT NULL, image_url TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE', sale_price INTEGER, original_price INTEGER, discount_rate INTEGER,
      lowest_price INTEGER, lowest_price_date TEXT, first_seen_date TEXT NOT NULL,
      misses INTEGER NOT NULL DEFAULT 0, last_miss_date TEXT
    );
    INSERT INTO goods (sno, brand_sno, name, url, first_seen_date) VALUES (1, 2421, 'old', 'u', '2026-10-01');
  `);
  old.close();
  const reopened = new Store4910(file);
  try {
    const cols = reopened.db.prepare('PRAGMA table_info(goods)').all().map((c) => c.name);
    assert.ok(cols.includes('market_type_sno'));
    assert.ok(cols.includes('coupon_price'));
    assert.equal(reopened.getGoods(1).name, 'old');
    assert.equal(reopened.getGoods(1).coupon_price, null);
  } finally {
    reopened.close();
  }
  // a second open must not try to add the columns again
  new Store4910(file).close();
});

test('upsertBrands deactivates brands that left the ranking but keeps pinned ones', () => {
  s.upsertBrands('2026-10-10', [{ sno: 1, name: 'A' }, { sno: 2, name: 'B' }], [{ sno: 9, name: 'P' }]);
  assert.deepEqual(s.getActiveBrands().map((b) => [b.sno, b.rank, Boolean(b.pinned)]), [[1, 1, false], [2, 2, false], [9, null, true]]);

  s.upsertBrands('2026-10-11', [{ sno: 2, name: 'B' }, { sno: 3, name: 'C' }], [{ sno: 9, name: 'P' }]);
  assert.deepEqual(s.getActiveBrands().map((b) => [b.sno, b.rank]), [[2, 1], [3, 2], [9, null]]);
  const a = s.db.prepare('SELECT * FROM brands WHERE sno = 1').get();
  assert.equal(a.active, 0);
  assert.equal(a.first_ranked_date, '2026-10-10');
  assert.equal(a.last_ranked_date, '2026-10-10');
  assert.equal(s.db.prepare('SELECT first_ranked_date FROM brands WHERE sno = 2').get().first_ranked_date, '2026-10-10');
  assert.equal(s.db.prepare('SELECT last_ranked_date FROM brands WHERE sno = 2').get().last_ranked_date, '2026-10-11');

  // a pinned brand that also ranks keeps its rank and pinned flag
  s.upsertBrands('2026-10-12', [{ sno: 9, name: 'P' }], [{ sno: 9, name: 'P' }]);
  assert.deepEqual(s.getActiveBrands().map((b) => [b.sno, b.rank, Boolean(b.pinned)]), [[9, 1, true]]);
});

test('upsertMarket stores the seller profile and getMarkets keys it by sno', () => {
  s.upsertMarket('2026-10-10', { sno: 10, name: 'seller', satisfaction: 97.5, reviewsCount: 1200, isOfficial: true, qualified: true });
  s.upsertMarket('2026-10-10', { sno: 11, name: 'shaky', satisfaction: 80, reviewsCount: null, isOfficial: false, qualified: false });
  const m = s.getMarkets();
  assert.deepEqual([...m.keys()], [10, 11]);
  assert.equal(m.get(10).qualified, 1);
  assert.equal(m.get(10).is_official, 1);
  assert.equal(m.get(10).satisfaction, 97.5);
  assert.equal(m.get(10).checked_date, '2026-10-10');
  assert.equal(m.get(11).reviews_count, null);
  assert.equal(m.get(11).qualified, 0);
  s.upsertMarket('2026-10-11', { sno: 11, name: 'shaky', satisfaction: 95, reviewsCount: 300, isOfficial: false, qualified: true });
  assert.equal(s.getMarkets().get(11).qualified, 1);
  assert.equal(s.getMarkets().get(11).checked_date, '2026-10-11');
});

const coupon = (couponSno, name, extra = {}) => ({
  couponSno, name, type: 'PERCENT', percent: 10, price: null, max: 5000, min: 10000, finishedAt: '2026-12-31', ...extra,
});

test('replaceWallet reports added and removed coupon names', () => {
  assert.deepEqual(s.replaceWallet('2026-10-10', [coupon(1, 'A'), coupon(2, 'B')]), { added: ['A', 'B'], removed: [] });
  assert.deepEqual(s.replaceWallet('2026-10-11', [coupon(2, 'B'), coupon(3, 'C')]), { added: ['C'], removed: ['A'] });
  assert.deepEqual(s.getWallet().map((c) => c.name).sort(), ['B', 'C']);
  assert.equal(s.getWallet().find((c) => c.name === 'B').seen_date, '2026-10-11');
});

test('wallet max Infinity is stored as NULL and read back as null; seller-only coupons survive replaceWallet', () => {
  s.replaceWallet('2026-10-10', [coupon(1, 'A', { max: Infinity }), coupon(2, 'B', { price: 3000, type: 'PRICE', percent: null })]);
  s.addMarketCoupon('2026-10-10', 10, coupon(50, 'seller only', { finishedAt: undefined }));
  assert.equal(s.db.prepare('SELECT max FROM wallet_coupons WHERE coupon_sno = 1').get().max, null);
  const wallet = s.getWallet();
  assert.equal(wallet.find((c) => c.coupon_sno === 1).max, null);
  assert.equal(wallet.find((c) => c.coupon_sno === 2).max, 5000);

  const r = s.replaceWallet('2026-10-11', [coupon(3, 'C')]);
  assert.deepEqual(r, { added: ['C'], removed: ['A', 'B'] });
  const sellerRow = s.db.prepare('SELECT * FROM wallet_coupons WHERE coupon_sno = 50').get();
  assert.equal(sellerRow.market_sno, 10);
  assert.equal(sellerRow.seen_date, '2026-10-10');
  assert.equal(sellerRow.finished_at, null);
  assert.deepEqual(s.getWallet().map((c) => c.coupon_sno), [3, 50]);
});

test('addMarketCoupon upserts by coupon_sno', () => {
  s.addMarketCoupon('2026-10-10', 10, coupon(50, 'old name'));
  s.addMarketCoupon('2026-10-11', 10, coupon(50, 'new name'));
  const rows = s.db.prepare('SELECT * FROM wallet_coupons').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'new name');
  assert.equal(rows[0].seen_date, '2026-10-11');
});

test('recordMarketCoupon keeps one row per market and date; getMarketCoupons keys by market', () => {
  const base = { market_sno: 10, date: '2026-10-11', coupon_sno: 7, coupon_name: 'A', checked_price: 30000, coupon_discount: 3000, mismatch: false };
  s.recordMarketCoupon(base);
  s.recordMarketCoupon({ ...base, coupon_discount: 2500, mismatch: true });
  s.recordMarketCoupon({ ...base, market_sno: 11, date: '2026-10-10' });
  const m = s.getMarketCoupons('2026-10-11');
  assert.deepEqual([...m.keys()], [10]);
  assert.equal(m.get(10).coupon_discount, 2500);
  assert.equal(m.get(10).mismatch, 1);
});

test('setCouponPrices writes in one transaction and accepts null', () => {
  s.applyScan('2026-10-10', [row(1, 50000), row(2, 30000)], BOTH);
  s.setCouponPrices(new Map([[1, 45000], [2, null]]));
  assert.equal(s.getGoods(1).coupon_price, 45000);
  assert.equal(s.getGoods(2).coupon_price, null);

  s.setCouponPrices(new Map([[1, null], [2, 28000]]));
  assert.equal(s.getGoods(1).coupon_price, null);
  assert.equal(s.getGoods(2).coupon_price, 28000);

  // a bad value rolls the whole batch back
  assert.throws(() => s.setCouponPrices(new Map([[1, 1000], [2, Symbol('bad')]])));
  assert.equal(s.getGoods(1).coupon_price, null);
  assert.equal(s.getGoods(2).coupon_price, 28000);
});

test('getQualifiedSamples ignores listings under 10,000 won', () => {
  s.applyScan('2026-10-10', [row(1, 5000), row(2, 20000), row(3, 90000), row(4, 10000), row(5, 150000)], BOTH);
  s.db.prepare(`UPDATE goods SET status = 'DROPPED' WHERE sno = 5`).run();
  const { low, high } = s.getQualifiedSamples(10);
  assert.equal(low.sno, 4);
  assert.equal(high.sno, 3);
  assert.deepEqual(s.getQualifiedSamples(99), { low: null, high: null });
});
