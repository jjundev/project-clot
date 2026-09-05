import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClotDatabase } from '../src/db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('Database Schema Expansion & Discovery Source Helpers', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-test-db-'));
  const testDbPath = path.join(tempDir, 'test-prices.db');
  const db = new ClotDatabase(testDbPath);

  t.after(() => {
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test('idempotently creates schema with discovery columns', () => {
    // Check columns in price_logs
    const priceLogsCols = db.db.prepare("PRAGMA table_info(price_logs)").all().map(c => c.name);
    assert.ok(priceLogsCols.includes('coupon_price'), 'price_logs must contain coupon_price');
    assert.ok(priceLogsCols.includes('estimated_my_price'), 'price_logs must contain estimated_my_price');

    // Check columns in items
    const itemsCols = db.db.prepare("PRAGMA table_info(items)").all().map(c => c.name);
    assert.ok(itemsCols.includes('lowest_estimated_price'), 'items must contain lowest_estimated_price');
  });

  await t.test('filters items by source and gets active VIP and discovered items', () => {
    db.upsertItem({
      goods_no: 1001,
      goods_name: 'VIP Liked Item',
      source: 'like',
      url: 'https://www.musinsa.com/products/1001',
    });

    db.upsertItem({
      goods_no: 2001,
      goods_name: 'Discovered Item 1',
      source: 'discovery',
      url: 'https://www.musinsa.com/products/2001',
    });

    db.upsertItem({
      goods_no: 2002,
      goods_name: 'Discovered Item 2 (Sold Out)',
      source: 'discovery',
      status: 'SOLDOUT',
      url: 'https://www.musinsa.com/products/2002',
    });

    const likeItems = db.getItemsBySource('like');
    assert.equal(likeItems.length, 1);
    assert.equal(likeItems[0].goods_no, 1001);

    const vipItems = db.getActiveVipItems();
    assert.equal(vipItems.length, 1);

    const discoveredItems = db.getItemsBySource('discovery');
    assert.equal(discoveredItems.length, 2);

    const activeDiscovered = db.getDiscoveredActiveItems();
    assert.equal(activeDiscovered.length, 2, 'ACTIVE and SOLDOUT should both be included');
  });

  await t.test('promotes discovered item to like (VIP)', () => {
    db.promoteItemToLike(2001);
    const item = db.getItem(2001);
    assert.equal(item.source, 'like');

    const likeItems = db.getItemsBySource('like');
    assert.equal(likeItems.length, 2);
  });

  await t.test('records price logs idempotently (INSERT then UPDATE on same date) with estimated prices', () => {
    db.recordPriceLog({
      goods_no: 2001,
      date: '2026-09-05',
      normal_price: 100000,
      sale_price: 80000,
      coupon_price: 72000,
      sale_rate: 28,
      my_price: null,
      estimated_my_price: 64944,
      coupon_name: '10% 쿠폰',
      coupon_discount: 8000,
      member_discount: 0,
      point_discount: 0,
      is_sold_out: 0,
    });

    let logs = db.getPriceLogs(2001);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].coupon_price, 72000);
    assert.equal(logs[0].estimated_my_price, 64944);

    // Re-run on same date should update, not create duplicate row
    db.recordPriceLog({
      goods_no: 2001,
      date: '2026-09-05',
      normal_price: 100000,
      sale_price: 75000,
      coupon_price: 67500,
      sale_rate: 32,
      my_price: null,
      estimated_my_price: 60885,
      coupon_name: '10% 쿠폰',
      coupon_discount: 7500,
      member_discount: 0,
      point_discount: 0,
      is_sold_out: 0,
    });

    logs = db.getPriceLogs(2001);
    assert.equal(logs.length, 1, 'Must not create duplicate row on same date');
    assert.equal(logs[0].sale_price, 75000);
    assert.equal(logs[0].estimated_my_price, 60885);

    db.updateLowestEstimatedPrice(2001, 60885, '2026-09-05');
    const updatedItem = db.getItem(2001);
    assert.equal(updatedItem.lowest_estimated_price, 60885);
  });

  await t.test('migrates existing legacy database without new columns', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const legacyDbPath = path.join(tempDir, 'legacy.db');
    const rawDb = new DatabaseSync(legacyDbPath);
    rawDb.exec(`
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
    `);
    rawDb.close();

    const migratedDb = new ClotDatabase(legacyDbPath);
    try {
      const priceLogsCols = migratedDb.db.prepare("PRAGMA table_info(price_logs)").all().map(c => c.name);
      assert.ok(priceLogsCols.includes('coupon_price'));
      assert.ok(priceLogsCols.includes('estimated_my_price'));

      const itemsCols = migratedDb.db.prepare("PRAGMA table_info(items)").all().map(c => c.name);
      assert.ok(itemsCols.includes('lowest_estimated_price'));
    } finally {
      migratedDb.close();
    }
  });
});
