import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildClotDataPayload } from '../src/visualizer.js';

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

  test('buildClotDataPayload throws on invalid db input', () => {
    assert.throws(() => buildClotDataPayload(null), /valid DatabaseSync instance is required/);
    assert.throws(() => buildClotDataPayload({}), /valid DatabaseSync instance is required/);
  });
});
