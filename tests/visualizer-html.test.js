import './setup-env.js';
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { generateDashboardHtml } from '../src/visualizer.js';
import { Store4910 } from '../src/site4910/store.js';

describe('Visualizer HTML Generation', () => {
  const tempFiles = [];

  afterEach(() => {
    while (tempFiles.length) {
      const p = tempFiles.pop();
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
  });

  function createTestDb() {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE items (
        goods_no INTEGER PRIMARY KEY,
        goods_name TEXT NOT NULL,
        brand_name TEXT,
        url TEXT NOT NULL,
        image_url TEXT,
        status TEXT DEFAULT 'ACTIVE',
        first_seen_at TEXT NOT NULL,
        last_checked_at TEXT
      );
      CREATE TABLE price_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goods_no INTEGER NOT NULL,
        date TEXT NOT NULL,
        normal_price INTEGER,
        sale_price INTEGER,
        my_price INTEGER,
        coupon_name TEXT,
        coupon_discount INTEGER,
        is_sold_out INTEGER DEFAULT 0
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

    db.prepare(`
      INSERT INTO items (goods_no, goods_name, brand_name, url, image_url, status, first_seen_at, last_checked_at)
      VALUES (777, '테스트 모자 $pecial', '테스트 $A$P', 'https://musinsa.com/777', '/img/777.jpg', 'ACTIVE', '2026-09-01T00:00:00Z', '2026-09-03T10:00:00Z')
    `).run();

    db.prepare(`
      INSERT INTO price_logs (goods_no, date, normal_price, sale_price, my_price, coupon_name, coupon_discount, is_sold_out)
      VALUES (777, '2026-09-01', 30000, 25000, 22000, '3000원 쿠폰', 3000, 0)
    `).run();

    return db;
  }

  test('generateDashboardHtml writes valid standalone HTML with injected data and no sample badges', () => {
    const db = createTestDb();
    const tempOutput = path.join(os.tmpdir(), `clot-test-dashboard-${Date.now()}.html`);
    tempFiles.push(tempOutput);

    const res = generateDashboardHtml({
      db,
      outputPath: tempOutput,
      openBrowser: false,
      targetGoodsNo: 777,
    });

    assert.equal(res.outputPath, tempOutput);
    assert.equal(res.targetGoodsNo, 777);
    assert.equal(res.totalItems, 1);
    assert.ok(fs.existsSync(tempOutput), 'Generated HTML file must exist');

    const content = fs.readFileSync(tempOutput, 'utf-8');
    assert.ok(content.includes('<!DOCTYPE html>'));
    assert.ok(content.includes('CLOT PRICE TRACKER'));
    assert.ok(!content.includes('(샘플 데이터)'), 'Must not include sample data text in title');
    assert.ok(!content.includes('<span class="smark"'), 'Must not include SAMPLE badge');
    assert.ok(content.includes('window.__CLOT_DATA__ ='), 'Must inject window.__CLOT_DATA__');
    assert.ok(content.includes('"targetGoodsNo":777'), 'Must inject targetGoodsNo in payload');
    assert.ok(content.includes('"n":777'));
    assert.ok(content.includes('테스트 모자 $pecial'), 'Must safely preserve dollar signs without replace corruption');
  });

  test('generateDashboardHtml throws error when template file does not exist', () => {
    const db = createTestDb();
    const tempOutput = path.join(os.tmpdir(), `clot-test-${Date.now()}.html`);
    tempFiles.push(tempOutput);

    assert.throws(
      () => {
        generateDashboardHtml({
          db,
          outputPath: tempOutput,
          templatePath: '/non/existent/path/template.html',
          openBrowser: false,
        });
      },
      {
        message: /Dashboard template file not found/,
      }
    );
  });

  test('generateDashboardHtml creates nested output directory if missing', () => {
    const db = createTestDb();
    const nestedDir = path.join(os.tmpdir(), `clot-nested-${Date.now()}`);
    const tempOutput = path.join(nestedDir, 'sub', 'dashboard.html');
    tempFiles.push(tempOutput);
    tempFiles.push(path.join(nestedDir, 'sub'));
    tempFiles.push(nestedDir);

    const res = generateDashboardHtml({
      db,
      outputPath: tempOutput,
      openBrowser: false,
      targetGoodsNo: 'goods-777',
    });

    assert.equal(res.targetGoodsNo, 777);
    assert.ok(fs.existsSync(tempOutput));
  });

  test('generateDashboardHtml merges the 4910.db at db4910Path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-html-4910-'));
    tempFiles.push(dir);
    const db4910Path = path.join(dir, '4910.db');
    const store = new Store4910(db4910Path);
    store.syncLiked([{ sno: 71863924, brand: '유니클로', name: '플리스', market_name: 'UNIQLO', url: 'https://4910.kr/goods/71863924', image_url: null }], '2026-10-11');
    store.logLikedPrice({ sno: 71863924, date: '2026-10-11', list_price: 21600, original_price: 51300, coupon_price: 18360, member_price: 19440, is_soldout: 0 });
    store.close();

    const tempOutput = path.join(dir, 'dashboard.html');
    const res = generateDashboardHtml({ db: createTestDb(), outputPath: tempOutput, openBrowser: false, db4910Path });
    assert.equal(res.totalItems, 2);
    const content = fs.readFileSync(tempOutput, 'utf-8');
    assert.ok(content.includes('"k":"4910:71863924"'));
    assert.ok(content.includes('"k":"777"'));
  });

  test('generateDashboardHtml without a 4910.db still renders', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-html-no4910-'));
    tempFiles.push(dir);
    const tempOutput = path.join(dir, 'dashboard.html');
    const res = generateDashboardHtml({ db: createTestDb(), outputPath: tempOutput, openBrowser: false, db4910Path: path.join(dir, 'missing.db') });
    assert.equal(res.totalItems, 1);
    assert.ok(fs.readFileSync(tempOutput, 'utf-8').includes('"src":"musinsa"'));
  });

  test('template has the source chips and the new-member column', () => {
    const tempOutput = path.join(os.tmpdir(), `clot-src-chips-${Date.now()}.html`);
    tempFiles.push(tempOutput);
    generateDashboardHtml({ db: createTestDb(), outputPath: tempOutput, openBrowser: false });
    const content = fs.readFileSync(tempOutput, 'utf-8');
    assert.ok(content.includes('data-src="all"'));
    assert.ok(content.includes('data-src="musinsa"'));
    assert.ok(content.includes('data-src="4910"'));
    assert.ok(content.includes('class="nb-col"'));
    assert.ok(content.includes('4910에서 보기 ↗'));
    assert.ok(content.includes('쿠폰적용가(신규회원 기준)'));
  });

  test('generated dashboard asks search engines not to index it', () => {
    const tempOutput = path.join(os.tmpdir(), `clot-noindex-${Date.now()}.html`);
    tempFiles.push(tempOutput);
    generateDashboardHtml({ db: createTestDb(), outputPath: tempOutput, openBrowser: false });
    assert.match(fs.readFileSync(tempOutput, 'utf-8'), /<meta name="robots" content="noindex, nofollow">/);
  });
});

