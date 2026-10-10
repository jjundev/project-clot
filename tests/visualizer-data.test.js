import './setup-env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildClotDataPayload, buildScan4910Payload } from '../src/visualizer.js';
import { Store4910 } from '../src/site4910/store.js';

describe('Visualizer Data Extraction', () => {
  function setupTestDb() {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE items (
        goods_no INTEGER PRIMARY KEY,
        goods_name TEXT NOT NULL,
        brand_name TEXT,
        url TEXT NOT NULL,
        image_url TEXT,
        source TEXT DEFAULT 'like',
        status TEXT DEFAULT 'ACTIVE',
        first_seen_at TEXT NOT NULL,
        last_checked_at TEXT,
        lowest_my_price INTEGER,
        lowest_sale_price INTEGER,
        lowest_price_date TEXT
      );

      CREATE TABLE price_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goods_no INTEGER NOT NULL,
        date TEXT NOT NULL,
        normal_price INTEGER,
        sale_price INTEGER,
        sale_rate INTEGER,
        my_price INTEGER,
        coupon_name TEXT,
        coupon_discount INTEGER,
        member_discount INTEGER,
        point_discount INTEGER,
        is_sold_out INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE daily_runs (
        date TEXT PRIMARY KEY,
        total_tracked INTEGER,
        price_dropped_count INTEGER,
        restocked_count INTEGER,
        duration_ms INTEGER,
        completed_at TEXT NOT NULL
      );
    `);

    // Insert active item
    db.prepare(`
      INSERT INTO items (goods_no, goods_name, brand_name, url, image_url, status, first_seen_at, last_checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1001, '테스트 셔츠', '테스트 브랜드', 'https://musinsa.com/1001', '/img/1001.jpg', 'ACTIVE', '2026-08-01T00:00:00Z', '2026-08-03T10:00:00Z');

    // Insert sold out item
    db.prepare(`
      INSERT INTO items (goods_no, goods_name, brand_name, url, image_url, status, first_seen_at, last_checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1002, '품절 니트', '품절 브랜드', 'https://musinsa.com/1002', '/img/1002.jpg', 'SOLDOUT', '2026-08-01T00:00:00Z', '2026-08-03T10:00:00Z');

    // Insert unliked item (should be excluded)
    db.prepare(`
      INSERT INTO items (goods_no, goods_name, brand_name, url, image_url, status, first_seen_at, last_checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1003, '취소된 팬츠', '취소 브랜드', 'https://musinsa.com/1003', '/img/1003.jpg', 'UNLIKED', '2026-08-01T00:00:00Z', '2026-08-03T10:00:00Z');

    // Insert logs for 1001
    const insertLog = db.prepare(`
      INSERT INTO price_logs (goods_no, date, normal_price, sale_price, sale_rate, my_price, coupon_name, coupon_discount, is_sold_out, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertLog.run(1001, '2026-08-01', 50000, 45000, 10, 40000, '5% 쿠폰', 5000, 0, '2026-08-01T10:00:00Z');
    insertLog.run(1001, '2026-08-02', 50000, 45000, 10, 38000, '10% 쿠폰', 7000, 0, '2026-08-02T10:00:00Z');

    // Insert log for 1002
    insertLog.run(1002, '2026-08-02', 80000, 70000, 12, 70000, null, 0, 1, '2026-08-02T10:00:00Z');

    // Insert log for unliked 1003 (must not leak into dates)
    insertLog.run(1003, '2026-07-20', 30000, 25000, 15, 25000, null, 0, 0, '2026-07-20T10:00:00Z');

    // Insert daily run
    db.prepare(`
      INSERT INTO daily_runs (date, total_tracked, price_dropped_count, restocked_count, duration_ms, completed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('2026-08-02', 2, 1, 0, 1200, '2026-08-02T09:31:00.000Z');

    return db;
  }

  test('buildClotDataPayload returns structured payload matching dashboard contract', () => {
    const db = setupTestDb();
    const payload = buildClotDataPayload(db, { targetGoodsNo: 1001 });

    assert.equal(payload.sample, false);
    assert.equal(payload.targetGoodsNo, 1001);
    assert.ok(typeof payload.generatedAt === 'string');
    assert.equal(payload.lastRun, '2026-08-02T09:31:00.000Z');
    // 2026-07-20 from unliked item 1003 should be excluded
    assert.deepEqual(payload.dates, ['2026-08-01', '2026-08-02']);
    assert.equal(payload.items.length, 2);

    const item1 = payload.items.find((it) => it.n === 1001);
    assert.ok(item1);
    assert.equal(item1.b, '테스트 브랜드');
    assert.equal(item1.g, '테스트 셔츠');
    assert.equal(item1.s, 'ACTIVE');
    assert.equal(item1.c, 'top');
    assert.equal(item1.fs, '2026-08-01');
    assert.equal(item1.L.length, 2);
    assert.deepEqual(item1.L[0], ['2026-08-01', 50000, 45000, 40000, 0, '5% 쿠폰', 5000]);
    assert.deepEqual(item1.L[1], ['2026-08-02', 50000, 45000, 38000, 0, '10% 쿠폰', 7000]);

    const item2 = payload.items.find((it) => it.n === 1002);
    assert.ok(item2);
    assert.equal(item2.s, 'SOLDOUT');
    assert.equal(item2.c, 'top');
    assert.equal(item2.L.length, 1);
    assert.deepEqual(item2.L[0], ['2026-08-02', 80000, 70000, 70000, 1, '나의 할인가', 0]);

    // Ensure UNLIKED item 1003 is excluded
    assert.equal(payload.items.some((it) => it.n === 1003), false);
  });

  test('buildClotDataPayload works with db wrapper object', () => {
    const db = setupTestDb();
    const payload = buildClotDataPayload({ db });
    assert.equal(payload.sample, false);
    assert.equal(payload.items.length, 2);
  });

  test('buildClotDataPayload handles empty database gracefully', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE items (goods_no INTEGER PRIMARY KEY, goods_name TEXT, brand_name TEXT, url TEXT, image_url TEXT, status TEXT, first_seen_at TEXT, last_checked_at TEXT);
      CREATE TABLE price_logs (id INTEGER PRIMARY KEY, goods_no INTEGER, date TEXT, normal_price INTEGER, sale_price INTEGER, my_price INTEGER, is_sold_out INTEGER, coupon_name TEXT, coupon_discount INTEGER);
    `);
    const payload = buildClotDataPayload(db);
    assert.equal(payload.sample, false);
    assert.deepEqual(payload.dates, []);
    assert.deepEqual(payload.items, []);
    assert.deepEqual(payload.runs, []);
    assert.equal(payload.lastRun, null);
  });

  test('buildClotDataPayload uses estimated_my_price when my_price is null', () => {
    const db = setupTestDb();
    db.exec(`
      ALTER TABLE price_logs ADD COLUMN estimated_my_price INTEGER;
    `);
    const insertLog = db.prepare(`
      INSERT INTO price_logs (goods_no, date, normal_price, sale_price, my_price, estimated_my_price, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertLog.run(1001, '2026-08-03', 50000, 45000, null, 36000, '2026-08-03T10:00:00Z');

    const payload = buildClotDataPayload(db);
    const item1 = payload.items.find((it) => it.n === 1001);
    assert.ok(item1);
    const log3 = item1.L.find((entry) => entry[0] === '2026-08-03');
    assert.ok(log3);
    assert.equal(log3[3], 36000);
  });

  describe('liked 4910 items', () => {
    function likedRow(sno, overrides = {}) {
      return { sno, brand: '유니클로', name: '플리스 집업', market_name: 'UNIQLO', category: null, url: `https://4910.kr/goods/${sno}`, image_url: `/img/${sno}.jpg`, ...overrides };
    }

    test('without a 4910 DB, Musinsa items only gain k and src', () => {
      const payload = buildClotDataPayload(setupTestDb());
      assert.equal(payload.items[0].k, '1001');
      assert.equal(payload.items[0].src, 'musinsa');
      assert.equal(payload.items.some((it) => it.src === '4910'), false);
      assert.deepEqual(payload.items[0].L[0], ['2026-08-01', 50000, 45000, 40000, 0, '5% 쿠폰', 5000]);
    });

    test('liked 4910 items join with 8-slot tuples', () => {
      const store = new Store4910(':memory:');
      store.syncLiked([likedRow(71863924)], '2026-10-11');
      store.logLikedPrice({ sno: 71863924, date: '2026-10-11', list_price: 21600, original_price: 51300, coupon_price: 18360, member_price: 19440, is_soldout: 0 });
      store.logLikedPrice({ sno: 71863924, date: '2026-10-12', list_price: 21600, original_price: 51300, coupon_price: 18360, member_price: null, is_soldout: 0 });

      const payload = buildClotDataPayload(setupTestDb(), { db4910: store.db });
      const item = payload.items.find((it) => it.src === '4910');
      assert.ok(item);
      assert.equal(item.n, 71863924);
      assert.equal(item.k, '4910:71863924');
      assert.equal(item.b, '유니클로');
      assert.equal(item.m, 'UNIQLO');
      assert.equal(item.g, '플리스 집업');
      assert.equal(item.u, 'https://4910.kr/goods/71863924');
      assert.equal(item.i, '/img/71863924.jpg');
      assert.equal(item.s, 'ACTIVE');
      assert.equal(item.fs, '2026-10-11');
      assert.equal(typeof item.c, 'string');
      assert.deepEqual(item.L[0], ['2026-10-11', 51300, 21600, 19440, 0, '내 회원가', 2160, 18360]);
      assert.deepEqual(item.L[1], ['2026-10-12', 51300, 21600, 18360, 0, '쿠폰적용가(신규회원 기준)', 3240, 18360]);
      assert.deepEqual(payload.dates, ['2026-08-01', '2026-08-02', '2026-10-11', '2026-10-12']);
      store.close();
    });

    test('brand falls back to market_name then 4910', () => {
      const store = new Store4910(':memory:');
      store.syncLiked([likedRow(1, { brand: null }), likedRow(2, { brand: null, market_name: null })], '2026-10-11');
      const payload = buildClotDataPayload(setupTestDb(), { db4910: store.db });
      assert.equal(payload.items.find((it) => it.k === '4910:1').b, 'UNIQLO');
      assert.equal(payload.items.find((it) => it.k === '4910:2').b, '4910');
      store.close();
    });

    test('UNLIKED 4910 items are left out', () => {
      const store = new Store4910(':memory:');
      store.syncLiked([likedRow(10), likedRow(11)], '2026-10-11');
      store.logLikedPrice({ sno: 10, date: '2026-10-11', list_price: 1000, original_price: 1000, coupon_price: null, member_price: null, is_soldout: 0 });
      store.logLikedPrice({ sno: 11, date: '2026-09-01', list_price: 1000, original_price: 1000, coupon_price: null, member_price: null, is_soldout: 0 });
      store.db.prepare("UPDATE liked_goods SET status = 'UNLIKED' WHERE sno = 11").run();

      const payload = buildClotDataPayload(setupTestDb(), { db4910: store.db });
      assert.deepEqual(payload.items.filter((it) => it.src === '4910').map((it) => it.n), [10]);
      assert.equal(payload.dates.includes('2026-09-01'), false);
      store.close();
    });

    test('a 4910.db without liked tables is skipped', () => {
      const old4910 = new DatabaseSync(':memory:');
      old4910.exec('CREATE TABLE goods (sno INTEGER PRIMARY KEY, name TEXT)');
      const payload = buildClotDataPayload(setupTestDb(), { db4910: old4910 });
      assert.equal(payload.items.some((it) => it.src === '4910'), false);
      assert.equal(payload.items.length, 2);
    });

    test('a Musinsa goods_no equal to a 4910 sno keeps distinct keys', () => {
      const db = setupTestDb();
      db.prepare(`INSERT INTO items (goods_no, goods_name, brand_name, url, status, first_seen_at) VALUES (71863924, '무신사 상품', 'B', 'https://musinsa.com/71863924', 'ACTIVE', '2026-08-01T00:00:00Z')`).run();
      const store = new Store4910(':memory:');
      store.syncLiked([likedRow(71863924)], '2026-10-11');
      const payload = buildClotDataPayload(db, { db4910: store.db });
      const keys = payload.items.filter((it) => it.n === 71863924).map((it) => it.k).sort();
      assert.deepEqual(keys, ['4910:71863924', '71863924']);
      store.close();
    });
  });

  describe('buildScan4910Payload', () => {
    const scanRow = (sno, price, brand_sno = 2421, image_url = null) => ({
      sno, brand_sno, brand: brand_sno === 2421 ? '유니클로' : 'GU', name: `listing ${sno}`,
      market_sno: 10, market_name: 'seller', category: 'cat', sale_price: price, original_price: price * 2,
      discount_rate: 50, image_url, url: `https://4910.kr/goods/${sno}`, closed: false,
    });
    const BOTH = { completeBrands: [2421, 13647] };
    const run = (date, complete) => ({ date, brandCounts: {}, complete, changed: 0, added: 0, dropped: 0, durationMs: 1 });

    function fixture() {
      const store = new Store4910(':memory:');
      const img1 = 'https://d3ha2047wt6x28.cloudfront.net/x/1.jpg';
      const img2 = 'https://other.cdn/2.jpg';
      store.applyScan('2026-10-10', [scanRow(1, 50000, 2421, img1), scanRow(2, 30000, 13647, img2), scanRow(3, 1000)], BOTH);
      store.recordScanRun(run('2026-10-10', true));
      store.applyScan('2026-10-11', [scanRow(1, 45000, 2421, img1), scanRow(2, 30000, 13647, img2), scanRow(3, 1000)], BOTH);
      store.recordScanRun(run('2026-10-11', false));
      store.db.prepare("UPDATE goods SET status = 'DROPPED' WHERE sno = 3").run();
      store.syncLiked([{ sno: 2, name: 'listing 2', url: 'https://4910.kr/goods/2' }], '2026-10-11');
      return store;
    }

    test('emits compact ACTIVE listings', () => {
      const store = fixture();
      const p = buildScan4910Payload(store.db);
      assert.equal(p.v, 1);
      assert.equal(p.imgBase, 'https://d3ha2047wt6x28.cloudfront.net/');
      assert.equal(p.lastScan, '2026-10-11');           // an incomplete run still counts
      assert.deepEqual(p.r.map((r) => r[0]), [1]);
      const [, bIdx, mIdx, name, img, fs, cat, H] = p.r[0];
      assert.equal(p.b[bIdx], '유니클로');
      assert.equal(p.m[mIdx], 'seller');
      assert.equal(name, 'listing 1');
      assert.equal(img, 'x/1.jpg');
      assert.equal(fs, '2026-10-10');
      assert.equal(typeof cat, 'string');
      assert.deepEqual(H, [['2026-10-10', 100000, 50000], ['2026-10-11', 90000, 45000]]);
      store.close();
    });

    test('liked ACTIVE listings are excluded but UNLIKED ones are not', () => {
      const store = fixture();
      store.db.prepare("UPDATE liked_goods SET status = 'UNLIKED' WHERE sno = 2").run();
      const p = buildScan4910Payload(store.db);
      assert.deepEqual(p.r.map((r) => r[0]), [1, 2]);
      const r2 = p.r[1];
      assert.equal(p.b[r2[1]], 'GU');
      assert.equal(r2[2], p.r[0][2]);
      assert.equal(r2[4], 'https://other.cdn/2.jpg');
      store.close();
    });

    test('works on a 4910.db without liked tables', () => {
      const store = fixture();
      store.db.exec('DROP TABLE liked_goods');
      const p = buildScan4910Payload(store.db);
      assert.deepEqual(p.r.map((r) => r[0]), [1, 2]);
      store.close();
    });

    test('no scan_runs gives lastScan null', () => {
      const store = new Store4910(':memory:');
      store.applyScan('2026-10-10', [scanRow(1, 50000)], BOTH);
      const p = buildScan4910Payload(store.db);
      assert.equal(p.lastScan, null);
      assert.equal(p.r[0][4], '');
      store.close();
    });
  });

  test('buildClotDataPayload throws on invalid db input', () => {
    assert.throws(() => buildClotDataPayload(null), /valid DatabaseSync instance is required/);
    assert.throws(() => buildClotDataPayload({}), /valid DatabaseSync instance is required/);
  });
});
