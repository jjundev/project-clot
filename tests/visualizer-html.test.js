import './setup-env.js';
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
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

  // Each build empties <outDir>/4910, so contract builds get their own directory rather than os.tmpdir() itself.
  function buildInTempDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempFiles.push(dir);
    const out = path.join(dir, 'dashboard.html');
    generateDashboardHtml({ db: createTestDb(), outputPath: out, openBrowser: false });
    return fs.readFileSync(out, 'utf-8');
  }

  test('generateDashboardHtml writes valid standalone HTML with injected data and no sample badges', () => {
    const db = createTestDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-test-dashboard-'));
    tempFiles.push(dir);
    const tempOutput = path.join(dir, 'dashboard.html');

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
    assert.ok(content.includes('"k":"musinsa:777"'));
  });

  test('generateDashboardHtml without a 4910.db still renders', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-html-no4910-'));
    tempFiles.push(dir);
    const tempOutput = path.join(dir, 'dashboard.html');
    const res = generateDashboardHtml({ db: createTestDb(), outputPath: tempOutput, openBrowser: false, db4910Path: path.join(dir, 'missing.db') });
    assert.equal(res.totalItems, 1);
    assert.ok(fs.readFileSync(tempOutput, 'utf-8').includes('"src":"musinsa"'));
  });

  test('a corrupt 4910.db still renders the Musinsa dashboard', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-html-corrupt4910-'));
    tempFiles.push(dir);
    const db4910Path = path.join(dir, '4910.db');
    fs.writeFileSync(db4910Path, 'this is definitely not a sqlite database '.repeat(200));
    const tempOutput = path.join(dir, 'dashboard.html');
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
    let res;
    try {
      res = generateDashboardHtml({ db: createTestDb(), outputPath: tempOutput, openBrowser: false, db4910Path });
    } finally {
      console.warn = origWarn;
    }
    assert.equal(res.totalItems, 1);
    const content = fs.readFileSync(tempOutput, 'utf-8');
    assert.ok(content.includes('"src":"musinsa"'));
    assert.ok(!content.includes('"src":"4910"'));
    assert.equal(warns.length, 1);
  });

  const scanListing = (sno, brand_sno, brand, sale_price = 21600) => ({
    sno, brand_sno, brand, name: `listing ${sno}`, market_sno: 1, market_name: 'UNIQLO', category: null,
    sale_price, original_price: 51300, discount_rate: 57, image_url: null, url: `https://4910.kr/goods/${sno}`, closed: false,
  });

  function scanDb(dir, rows) {
    const db4910Path = path.join(dir, '4910.db');
    const store = new Store4910(db4910Path);
    store.applyScan('2026-10-10', rows, { completeBrands: [...new Set(rows.map((r) => r.brand_sno))] });
    store.recordScanRun({ date: '2026-10-10', brandCounts: {}, complete: true, changed: 0, added: rows.length, dropped: 0, durationMs: 1 });
    return { store, db4910Path };
  }

  // Runs a generated data script the way the page does and returns its window.
  function runScript(file, win = {}) {
    vm.runInNewContext(fs.readFileSync(file, 'utf-8'), { window: win });
    return win;
  }
  // Values from another vm realm fail deepStrictEqual on prototypes alone.
  const plain = (v) => JSON.parse(JSON.stringify(v));

  test('generateDashboardHtml writes bounded V2 assets and removes legacy scan files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-html-4910brands-'));
    tempFiles.push(dir);
    fs.writeFileSync(path.join(dir, '4910-all.js'), 'stale');
    const { store, db4910Path } = scanDb(dir, [
      scanListing(71863924, 2421, '유니클로'), scanListing(71863925, 2421, '유니클로'), scanListing(80000001, 13647, 'GU'),
    ]);
    store.logCouponPriceChanges('2026-10-10', [{ sno: 71863924, sale_price: 21600, coupon_price: 18000 }]);
    store.putPriceValidation({kind:'scan',sno:71863924,date:'2026-10-10',status:'verified',reason:'fixture'});
    store.close();

    const tempOutput = path.join(dir, 'index.html');
    const res = generateDashboardHtml({ db: createTestDb(), outputPath: tempOutput, openBrowser: false, db4910Path });
    assert.equal(fs.existsSync(path.join(dir, '4910-all.js')), false);
    const htmlData=JSON.parse(fs.readFileSync(tempOutput,'utf8').match(/window\.__CLOT_DATA__ = ([^\n]+);/)[1]);
    assert.equal(htmlData.catalog.v,2);assert.ok(fs.existsSync(path.join(dir,'assets')));
    assert.equal(htmlData.catalog.bootstrap.items.find(x=>x.n===71863924).my,18000);
    assert.equal(htmlData.catalog.bootstrap.items.find(x=>x.n===71863925).my,null);
    assert.equal(res.total4910All, 3);
    const html = fs.readFileSync(tempOutput, 'utf-8');
    assert.ok(html.includes('"has4910All":true'));
    assert.ok(html.includes('"total4910All":3'));
    assert.ok(!html.includes('"src":"4910all"'));
  });

  test('a rebuild removes brand files that no longer exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-html-4910rebuild-'));
    tempFiles.push(dir);
    fs.mkdirSync(path.join(dir, '4910'));
    fs.writeFileSync(path.join(dir, '4910', 'b999.js'), 'stale');
    const { store, db4910Path } = scanDb(dir, [scanListing(71863924, 2421, '유니클로')]);
    store.close();
    generateDashboardHtml({ db: createTestDb(), outputPath: path.join(dir, 'index.html'), openBrowser: false, db4910Path });
    assert.equal(fs.existsSync(path.join(dir,'4910','b999.js')),false);assert.ok(fs.readdirSync(path.join(dir,'assets')).length>0);
  });

  test('without a 4910.db the dashboard reports has4910All false and writes no 4910 files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-html-no4910all-'));
    tempFiles.push(dir);
    const tempOutput = path.join(dir, 'index.html');
    const res = generateDashboardHtml({ db: createTestDb(), outputPath: tempOutput, openBrowser: false, db4910Path: path.join(dir, 'missing.db') });
    assert.equal(res.total4910All, 0);
    assert.equal(fs.existsSync(path.join(dir, '4910')), false);
    assert.equal(fs.existsSync(path.join(dir, '4910-all.js')), false);
    const html = fs.readFileSync(tempOutput, 'utf-8');
    assert.ok(html.includes('"has4910All":false'));
    assert.ok(html.includes('"total4910All":0'));
  });

  test('a broken scan table drops only 4910 전체; liked items stay', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-html-scanfail-'));
    tempFiles.push(dir);
    const db4910Path = path.join(dir, '4910.db');
    const store = new Store4910(db4910Path);
    store.syncLiked([{ sno: 71863924, brand: '유니클로', name: '플리스', market_name: 'UNIQLO', url: 'https://4910.kr/goods/71863924', image_url: null }], '2026-10-11');
    store.db.exec('DROP TABLE scan_runs');
    store.close();
    const tempOutput = path.join(dir, 'index.html');
    const origWarn = console.warn;
    console.warn = () => {};
    let res;
    try {
      res = generateDashboardHtml({ db: createTestDb(), outputPath: tempOutput, openBrowser: false, db4910Path });
    } finally {
      console.warn = origWarn;
    }
    assert.equal(res.total4910All, 0);
    assert.equal(fs.existsSync(path.join(dir, '4910')), false);
    const html = fs.readFileSync(tempOutput, 'utf-8');
    assert.ok(html.includes('"k":"4910:71863924"'));
    assert.ok(html.includes('"has4910All":false'));
  });

  test('a failing 4910 build removes stale 4910 files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-html-stale4910all-'));
    tempFiles.push(dir);
    const stale = path.join(dir, '4910-all.js');
    fs.writeFileSync(stale, 'stale');
    fs.mkdirSync(path.join(dir, '4910'));
    fs.writeFileSync(path.join(dir, '4910', 'index.js'), 'stale');
    const db4910Path = path.join(dir, '4910.db');
    fs.writeFileSync(db4910Path, 'this is definitely not a sqlite database '.repeat(200));
    const tempOutput = path.join(dir, 'index.html');
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      generateDashboardHtml({ db: createTestDb(), outputPath: tempOutput, openBrowser: false, db4910Path });
    } finally {
      console.warn = origWarn;
    }
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(path.join(dir, '4910')), false);
    const html = fs.readFileSync(tempOutput, 'utf-8');
    assert.ok(html.includes('"has4910All":false'));
    assert.ok(html.includes('"src":"musinsa"'));
  });

  test('generated inline model derives prices and resolves legacy keys', () => {
    const html=buildInTempDir('clot-model-contract-');
    const start=html.indexOf('window.__CLOT_MODEL__ = (');
    const end=html.indexOf('/* ── 헤더',start);
    const win={};
    vm.runInNewContext(html.slice(start,end),{window:win});
    assert.equal(win.__CLOT_MODEL__.resolveKey('777'),'musinsa:777');
    assert.equal(win.__CLOT_MODEL__.summarize({n:1,src:'4910all',L:[['d',100,80,80,0,'표시가',0]]}).isLow,false);
    assert.equal(typeof win.__CLOT_RUNTIME_FACTORY__,'function');
  });

  test('generated dashboard asks search engines not to index it', () => {
    assert.match(buildInTempDir('clot-noindex-'), /<meta name="robots" content="noindex, nofollow">/);
  });
});

