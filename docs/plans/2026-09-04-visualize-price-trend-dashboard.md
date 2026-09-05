# Project-Clot 가격 동향 대시보드 (`visualize`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, interactive HTML price trend dashboard and `/visualize` skill for `project-clot`, powered by SQLite price history and styled identically to `data/dashboard-sample.html`.

**Architecture:** A core module `src/visualizer.js` queries `prices.db` for active and soldout items with their filtered `price_logs` time series, packages the data into the exact `window.__CLOT_DATA__` contract (injecting `targetGoodsNo` when targeted), injects it via a safe replacer function into `src/dashboard.template.html`, and writes out `data/dashboard.html`. The CLI (`src/cli.js`) integrates `visualize [goodsNo] [--no-open]` and hooks it into the end of `handleDailyRun()`, while `.agents/skills/visualize/SKILL.md` enables agentic invocation.

**Tech Stack:** Node.js (ESM, `node:sqlite`, `node:test`, `node:assert`, `node:child_process`), HTML5, CSS Variables (Toss Design Tokens / Pretendard), Chart.js (v4 CDN).

## Global Constraints

- Must preserve 100% of the UI, CSS design tokens, and client-side Chart.js/keyboard/modal behavior from `data/dashboard-sample.html`.
- Must generate a single standalone HTML file (`data/dashboard.html`) without external server requirements; browser opening uses macOS `open`.
- Must omit/hide sample badges (`SAMPLE` chip, "(샘플 데이터)" title) in production output.
- Must ignore `data/dashboard.html` in `.gitignore` to safeguard personal coupon/wishlist privacy.
- Must run test suite cleanly with `node --test tests/*.test.js` (`npm test`) without network dependencies.
- No new external npm production dependencies; use Node.js built-ins.

---

## File Structure

- **`src/dashboard.template.html` [NEW]**: Clean HTML dashboard template extracted from `data/dashboard-sample.html`, containing placeholder `/* __CLOT_DATA_PLACEHOLDER__ */ {}` for data injection, removing sample badges, and reading `D.targetGoodsNo` as fallback for deep linking.
- **`src/visualizer.js` [NEW]**: Core visualizer module providing `buildClotDataPayload(dbInstance, { targetGoodsNo })` and `generateDashboardHtml({ db, outputPath, openBrowser, targetGoodsNo, templatePath })`.
- **`tests/visualizer-data.test.js` [NEW]**: Unit tests for `buildClotDataPayload` validating data extraction, sorting, status filtering, and log array mapping.
- **`tests/visualizer-html.test.js` [NEW]**: Unit tests for `generateDashboardHtml` verifying HTML file generation, valid JSON injection, `targetGoodsNo` payload handling, and browser launch logic.
- **`.gitignore` [MODIFY]**: Add `data/dashboard.html` to prevent accidental commits of local price data.
- **`package.json` [MODIFY]**: Add `"visualize": "node src/cli.js visualize"` to npm scripts.
- **`src/cli.js` [MODIFY]**: Register `visualize` subcommand in `main()` and call `generateDashboardHtml({ openBrowser: false })` in `handleDailyRun()`.
- **`tests/cli-visualize.test.js` [NEW]**: Unit tests verifying CLI parsing, targetGoodsNo parameter passing, and integration for `visualize`.
- **`.agents/skills/visualize/SKILL.md` [NEW]**: Antigravity agent skill specification for `/visualize` slash command.

---

## Tasks

### Task 1: Core Visualizer Data Extraction & Payload Shaper

**Files:**
- Create: `src/visualizer.js`
- Test: `tests/visualizer-data.test.js`

**Interfaces:**
- Consumes: `ClotDatabase` or `node:sqlite` `DatabaseSync` instance containing `items`, `price_logs`, and optional `daily_runs`.
- Produces: `buildClotDataPayload(dbInstance, { targetGoodsNo } = {})` returning:
  ```ts
  {
    sample: false,
    generatedAt: string, // ISO 8601
    lastRun: string | null, // ISO 8601
    targetGoodsNo?: number, // optional target goods number
    dates: string[], // distinct dates sorted ASC
    runs: Array<{ date: string, total_tracked: number, price_dropped_count: number, restocked_count: number }>,
    items: Array<{
      n: number, // goods_no
      b: string, // brand_name
      g: string, // goods_name
      u: string, // url
      i: string, // image_url
      s: string, // status ('ACTIVE' | 'SOLDOUT')
      fs: string, // first_seen_at YYYY-MM-DD
      L: Array<[
        string, // date
        number | null, // normal_price
        number | null, // sale_price
        number | null, // my_price
        number, // is_sold_out (0 | 1)
        string, // coupon_name
        number // coupon_discount
      ]>
    }>
  }
  ```

- [ ] **Step 1: Write the failing test for data extraction**

Create `tests/visualizer-data.test.js`:

```javascript
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
    assert.equal(item1.fs, '2026-08-01');
    assert.equal(item1.L.length, 2);
    assert.deepEqual(item1.L[0], ['2026-08-01', 50000, 45000, 40000, 0, '5% 쿠폰', 5000]);
    assert.deepEqual(item1.L[1], ['2026-08-02', 50000, 45000, 38000, 0, '10% 쿠폰', 7000]);

    const item2 = payload.items.find((it) => it.n === 1002);
    assert.ok(item2);
    assert.equal(item2.s, 'SOLDOUT');
    assert.equal(item2.L.length, 1);
    assert.deepEqual(item2.L[0], ['2026-08-02', 80000, 70000, 70000, 1, '나의 할인가', 0]);

    // Ensure UNLIKED item 1003 is excluded
    assert.equal(payload.items.some((it) => it.n === 1003), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --test tests/visualizer-data.test.js
```
Expected output: FAIL with `Cannot find module '../src/visualizer.js'` or `buildClotDataPayload is not a function`.

- [ ] **Step 3: Write minimal implementation in `src/visualizer.js`**

Create `src/visualizer.js`:

```javascript
/**
 * @fileoverview Visualizer core module for Project-Clot.
 * Extracts price time-series data from SQLite and compiles standalone dashboard HTML.
 */

import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DEFAULT_TEMPLATE = path.join(__dirname, 'dashboard.template.html');
const DEFAULT_OUTPUT = path.join(DATA_DIR, 'dashboard.html');

/**
 * Extracts raw data from SQLite and builds the dashboard data contract.
 * @param {import('node:sqlite').DatabaseSync | { db: import('node:sqlite').DatabaseSync }} dbOrWrapper
 * @param {object} [options]
 * @param {number|string} [options.targetGoodsNo]
 * @returns {object} Dashboard data payload
 */
export function buildClotDataPayload(dbOrWrapper, { targetGoodsNo } = {}) {
  const rawDb = dbOrWrapper?.db ? dbOrWrapper.db : dbOrWrapper;
  if (!rawDb || typeof rawDb.prepare !== 'function') {
    throw new Error('A valid DatabaseSync instance is required to build clot data payload');
  }

  // 1. Fetch active and soldout items
  const itemsStmt = rawDb.prepare(`
    SELECT goods_no, goods_name, brand_name, url, image_url, status, first_seen_at, last_checked_at
    FROM items
    WHERE status IN ('ACTIVE', 'SOLDOUT')
    ORDER BY goods_no ASC
  `);
  const rawItems = itemsStmt.all();

  // 2. Fetch price logs scoped only to active and soldout items
  const logsStmt = rawDb.prepare(`
    SELECT goods_no, date, normal_price, sale_price, my_price, is_sold_out, coupon_name, coupon_discount
    FROM price_logs
    WHERE goods_no IN (SELECT goods_no FROM items WHERE status IN ('ACTIVE', 'SOLDOUT'))
    ORDER BY date ASC, id ASC
  `);
  const allLogs = logsStmt.all();

  // Map logs by goods_no
  const logsByGoods = new Map();
  const dateSet = new Set();
  for (const log of allLogs) {
    dateSet.add(log.date);
    let arr = logsByGoods.get(log.goods_no);
    if (!arr) {
      arr = [];
      logsByGoods.set(log.goods_no, arr);
    }
    const defaultCouponName = log.coupon_discount > 0 ? '쿠폰 적용가' : '나의 할인가';
    arr.push([
      log.date,
      log.normal_price ?? null,
      log.sale_price ?? null,
      log.my_price ?? null,
      log.is_sold_out ? 1 : 0,
      log.coupon_name || defaultCouponName,
      log.coupon_discount || 0,
    ]);
  }

  // 3. Fetch latest run metadata
  let lastRun = null;
  try {
    const runStmt = rawDb.prepare(`
      SELECT completed_at FROM daily_runs ORDER BY date DESC, completed_at DESC LIMIT 1
    `);
    const lastRunRow = runStmt.get();
    if (lastRunRow?.completed_at) {
      lastRun = lastRunRow.completed_at;
    }
  } catch {}

  if (!lastRun && rawItems.length > 0) {
    const maxChecked = rawItems.reduce((acc, it) => (it.last_checked_at > acc ? it.last_checked_at : acc), '');
    if (maxChecked) lastRun = maxChecked;
  }

  // 4. Fetch daily runs
  let runs = [];
  try {
    const runsStmt = rawDb.prepare(`
      SELECT date, total_tracked, price_dropped_count, restocked_count, duration_ms, completed_at
      FROM daily_runs
      ORDER BY date ASC
    `);
    runs = runsStmt.all();
  } catch {}

  // 5. Structure items array
  const items = rawItems.map((it) => ({
    n: Number(it.goods_no),
    b: it.brand_name || '-',
    g: it.goods_name || '상품',
    u: it.url || `https://www.musinsa.com/products/${it.goods_no}`,
    i: it.image_url || '',
    s: it.status || 'ACTIVE',
    fs: it.first_seen_at ? it.first_seen_at.slice(0, 10) : '',
    L: logsByGoods.get(it.goods_no) || [],
  }));

  const sortedDates = Array.from(dateSet).sort();
  const gNo = targetGoodsNo ? Number(targetGoodsNo) : undefined;

  return {
    sample: false,
    generatedAt: new Date().toISOString(),
    lastRun,
    targetGoodsNo: gNo,
    dates: sortedDates,
    runs,
    items,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --test tests/visualizer-data.test.js
```
Expected output: PASS (all tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/visualizer.js tests/visualizer-data.test.js
git commit -m "feat(visualizer): implement core clot data extraction and payload shaping"
```

---

### Task 2: Dashboard Template & Standalone HTML Generator

**Files:**
- Create: `src/dashboard.template.html`
- Modify: `src/visualizer.js`
- Modify: `.gitignore`
- Test: `tests/visualizer-html.test.js`

**Interfaces:**
- Consumes: `buildClotDataPayload(db, { targetGoodsNo })`, `src/dashboard.template.html`
- Produces: `generateDashboardHtml({ db, outputPath, openBrowser, targetGoodsNo, templatePath })` returning:
  `{ outputPath: string, targetGoodsNo?: number, totalItems: number }`

- [ ] **Step 1: Write the failing test for HTML generation**

Create `tests/visualizer-html.test.js`:

```javascript
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { generateDashboardHtml } from '../src/visualizer.js';

describe('Visualizer HTML Generation', () => {
  const tempFiles = [];

  afterEach(() => {
    while (tempFiles.length) {
      const p = tempFiles.pop();
      if (fs.existsSync(p)) fs.unlinkSync(p);
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --test tests/visualizer-html.test.js
```
Expected output: FAIL with `generateDashboardHtml is not a function`.

- [ ] **Step 3: Create `src/dashboard.template.html` and implement `generateDashboardHtml`**

1. Create `src/dashboard.template.html` by copying `data/dashboard-sample.html`, applying three targeted adjustments:
   - Line 6 title: Change to `<title>CLOT PRICE TRACKER — 관심 상품 가격 동향</title>`
   - Line 446: Remove `<span class="smark" title="가격 이력은 UI 시연용으로 생성된 값입니다">SAMPLE</span>`
   - Line 593: Replace data assignment with:
     ```javascript
     /* __CLOT_DATA_PLACEHOLDER__ */ window.__CLOT_DATA__ = {};
     ```
   - Line 1095: Update the initialization hook to read `D.targetGoodsNo` as fallback:
     ```javascript
     render();
     var dl = new URLSearchParams(location.search).get('goods') || (D.targetGoodsNo ? String(D.targetGoodsNo) : null);
     if (dl) openModal(Number(dl));
     ```

2. Add `generateDashboardHtml` to `src/visualizer.js`:

```javascript
/**
 * Generates the standalone dashboard HTML file and optionally opens it in the browser.
 * @param {object} [options]
 * @param {import('node:sqlite').DatabaseSync | { db: import('node:sqlite').DatabaseSync }} [options.db]
 * @param {string} [options.outputPath]
 * @param {string} [options.templatePath]
 * @param {boolean} [options.openBrowser=true]
 * @param {number|string} [options.targetGoodsNo]
 * @returns {{ outputPath: string, targetGoodsNo?: number, totalItems: number }}
 */
export function generateDashboardHtml({
  db,
  outputPath = DEFAULT_OUTPUT,
  templatePath = DEFAULT_TEMPLATE,
  openBrowser = true,
  targetGoodsNo,
} = {}) {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Dashboard template file not found at: ${templatePath}`);
  }

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Fallback to default DB path if not explicitly provided
  let activeDb = db;
  let shouldCloseDb = false;
  if (!activeDb) {
    const { DatabaseSync } = await import('node:sqlite');
    const defaultDbPath = path.join(DATA_DIR, 'prices.db');
    activeDb = new DatabaseSync(defaultDbPath);
    shouldCloseDb = true;
  }

  const digits = targetGoodsNo != null ? String(targetGoodsNo).replace(/\D/g, '') : '';
  const gNo = digits.length > 0 ? Number(digits) : undefined;
  const payload = buildClotDataPayload(activeDb, { targetGoodsNo: gNo });
  if (shouldCloseDb) {
    activeDb.close();
  }
  const templateContent = fs.readFileSync(templatePath, 'utf-8');

  // Replace data placeholder using a function replacer to prevent '$' corruption (CRLF tolerant)
  const placeholderRegex = /\/\*\s*__CLOT_DATA_PLACEHOLDER__\s*\*\/[\s\S]*?;\s*[\r\n]*/;
  let rendered;
  if (placeholderRegex.test(templateContent)) {
    rendered = templateContent.replace(
      placeholderRegex,
      () => `window.__CLOT_DATA__ = ${JSON.stringify(payload)};\n`
    );
  } else {
    rendered = templateContent.replace(
      /window\.__CLOT_DATA__\s*=\s*[\s\S]*?;\s*[\r\n]*/,
      () => `window.__CLOT_DATA__ = ${JSON.stringify(payload)};\n`
    );
  }

  fs.writeFileSync(outputPath, rendered, 'utf-8');

  if (openBrowser) {
    try {
      // Launch clean POSIX path without query string; targetGoodsNo is read from inlined D.targetGoodsNo
      const targetArg = `"${outputPath}"`;
      if (process.platform === 'darwin') {
        exec(`open ${targetArg}`, () => {});
      } else if (process.platform === 'win32') {
        exec(`start "" ${targetArg}`, () => {});
      } else {
        exec(`xdg-open ${targetArg}`, () => {});
      }
    } catch {}
  }

  return {
    outputPath,
    targetGoodsNo: gNo || undefined,
    totalItems: payload.items.length,
  };
}
```

3. Modify `.gitignore` to append `data/dashboard.html`:
```text
node_modules/
.env
logs/
*.log
.DS_Store
data/dashboard.html
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --test tests/visualizer-html.test.js
```
Expected output: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.template.html src/visualizer.js tests/visualizer-html.test.js .gitignore
git commit -m "feat(visualizer): add standalone HTML dashboard template and generator"
```

---

### Task 3: CLI Subcommand Integration & Daily Batch Hook

**Files:**
- Modify: `package.json:10-19`
- Modify: `src/cli.js:364-440`
- Modify: `src/cli.js:105-152`
- Test: `tests/cli-visualize.test.js`

**Interfaces:**
- Consumes: `generateDashboardHtml` from `src/visualizer.js`, `db` from `src/db.js`
- Produces:
  - Command: `node src/cli.js visualize [goodsNo] [--no-open]`
  - Script: `npm run visualize`
  - Automatic dashboard refresh after `daily` run completion

- [ ] **Step 1: Write failing test for CLI visualize subcommand**

Create `tests/cli-visualize.test.js`:

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const CLI_PATH = path.join(ROOT_DIR, 'src/cli.js');

describe('CLI Visualize Integration', () => {
  test('clot visualize --no-open successfully builds dashboard without error', () => {
    const output = execSync(`node "${CLI_PATH}" visualize --no-open`, {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
    });

    assert.ok(output.includes('대시보드가 생성되었습니다'));
    assert.ok(output.includes('--no-open'));
  });

  test('clot visualize <goodsNo> --no-open passes target goodsNo successfully', () => {
    const output = execSync(`node "${CLI_PATH}" visualize 6084885 --no-open`, {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
    });

    assert.ok(output.includes('대시보드가 생성되었습니다'));
    assert.ok(output.includes('6084885'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --test tests/cli-visualize.test.js
```
Expected output: FAIL or prints default help text because `visualize` is not registered yet.

- [ ] **Step 3: Modify `src/cli.js` and `package.json`**

In `package.json`, add `"visualize": "node src/cli.js visualize"`:

```json
  "scripts": {
    "start": "node src/cli.js daily",
    "test": "node --test 'tests/*.test.js'",
    "sync": "node src/cli.js sync",
    "track": "node src/cli.js track",
    "list": "node src/cli.js list",
    "report": "node src/cli.js report",
    "visualize": "node src/cli.js visualize",
    "daemon:install": "node src/cli.js daemon-install",
    "daemon:uninstall": "node src/cli.js daemon-uninstall"
  }
```

In `src/cli.js`:
Import `generateDashboardHtml` from `./visualizer.js`:
```javascript
import { generateDashboardHtml } from './visualizer.js';
```

Add `handleVisualize` function:
```javascript
function handleVisualize(flags, positional) {
  const digits = positional[0] ? String(positional[0]).replace(/\D/g, '') : '';
  const targetGoodsNo = digits.length > 0 ? Number(digits) : undefined;
  const noOpen = Boolean(flags['no-open'] || flags.noOpen);

  console.log('🎨 Generating price trend dashboard...');
  const res = generateDashboardHtml({
    db,
    openBrowser: !noOpen,
    targetGoodsNo,
  });

  console.log(`✅ 대시보드가 생성되었습니다: ${res.outputPath}`);
  console.log(`   총 ${res.totalItems}개 상품 시계열 반영 완료.`);
  if (res.targetGoodsNo) {
    console.log(`   🎯 타겟 상품 번호: ${res.targetGoodsNo}`);
  }
  if (noOpen) {
    console.log('   (브라우저 열기 생략: --no-open)');
  } else {
    console.log('   🚀 기본 브라우저로 대시보드를 띄웠습니다.');
  }
}
```

Add `case 'visualize':` and `case 'dashboard':` to `switch (command)`:
```javascript
    case 'visualize':
    case 'dashboard':
      handleVisualize(flags, positional);
      break;
```

In `handleDailyRun(flags)` right after `exportDataForGit(); tryGitAutoCommit();`:
```javascript
  // 5. Refresh static dashboard in background
  try {
    generateDashboardHtml({ db, openBrowser: false });
    console.log('📊 Static dashboard refreshed (data/dashboard.html).');
  } catch (dashErr) {
    console.warn('⚠️ Warning: Dashboard regeneration failed:', dashErr.message);
  }
```

Update help text in `src/cli.js`:
```text
  visualize [goodsNo]    Generate and launch interactive price trend dashboard
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --test tests/cli-visualize.test.js
```
Expected output: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json src/cli.js tests/cli-visualize.test.js
git commit -m "feat(cli): add visualize command and auto-refresh in daily batch"
```

---

### Task 4: Agent Skill Registration & End-to-End Verification

**Files:**
- Create: `.agents/skills/visualize/SKILL.md`

**Interfaces:**
- Consumes: `node src/cli.js visualize [goodsNo]`
- Produces: Antigravity / Claude Code agent skill `/visualize`

- [ ] **Step 1: Create `.agents/skills/visualize/SKILL.md`**

Create `.agents/skills/visualize/SKILL.md`:

```markdown
---
name: visualize
description: >
  MUST USE when the user asks to see price trend charts, view the price tracking dashboard,
  or inspect visual pricing history — e.g. "/visualize", "가격 그래프 보여줘",
  "대시보드 띄워줘", "가격 동향 보고 싶어", "차트 열어줘", "/visualize <goodsNo>".
---

# /visualize — 무신사 가격 동향 대시보드 시각화 스킬

Project-Clot의 SQLite 데이터베이스(`prices.db`)에 누적된 상품별 가격 및 쿠폰 할인 이력을 무신사 감성의 독립형 인터랙티브 HTML 대시보드(`data/dashboard.html`)로 빌드하고 macOS 기본 브라우저에 띄웁니다.

## 워크플로우

1. **대시보드 생성 및 브라우저 오픈**:
   - 상품 번호 인자가 있으면:
     ```bash
     node src/cli.js visualize <goodsNo>
     ```
   - 전체 대시보드 열람 시:
     ```bash
     node src/cli.js visualize
     ```
2. **요약 브리핑**:
   `data/latest_prices.json` 또는 직전 실행 출력을 참조하여 현재 추적 중인 전체 상품 수, 역대 최저가 도달 상품 2~3개의 상품명과 현재 실구매가를 사용자에게 간결히 안내합니다.
```

- [ ] **Step 2: Run all tests in the project**

Run:
```bash
npm test
```
Expected output: All test suites (`daemon-plist`, `env`, `sync-env`, `visualizer-data`, `visualizer-html`, `cli-visualize`) PASS with 0 failures.

- [ ] **Step 3: Run end-to-end dry run**

Run:
```bash
node src/cli.js visualize --no-open
```
Expected output: `data/dashboard.html` is generated successfully with real data from `data/prices.db`.

- [ ] **Step 4: Commit**

```bash
git add .agents/skills/visualize/SKILL.md
git commit -m "feat(skill): register visualize agent skill"
```
