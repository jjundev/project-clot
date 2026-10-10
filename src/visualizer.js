/**
 * @fileoverview Visualizer core module for Project-Clot.
 * Extracts price time-series data from SQLite and compiles standalone dashboard HTML.
 */

import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { classifyCategory } from './classifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DEFAULT_TEMPLATE = path.join(__dirname, 'dashboard.template.html');
// CLOT_DASHBOARD_PATH keeps test runs from overwriting the real dashboard.
const DEFAULT_OUTPUT = process.env.CLOT_DASHBOARD_PATH || path.join(DATA_DIR, 'dashboard.html');
const DEFAULT_4910_DB = process.env.CLOT_4910_DB_PATH || path.join(DATA_DIR, '4910.db');

/**
 * Reads the ACTIVE liked 4910 items as dashboard items. A DB that predates the
 * liked tables (or lacks either) yields no items rather than an error.
 * @param {import('node:sqlite').DatabaseSync} db4910
 * @returns {object[]}
 */
function buildLikedItems(db4910) {
  const tables = db4910
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('liked_goods','liked_price_logs')")
    .all();
  if (tables.length < 2) return [];

  const goods = db4910.prepare("SELECT * FROM liked_goods WHERE status = 'ACTIVE' ORDER BY sno ASC").all();
  const logs = db4910
    .prepare(`
      SELECT sno, date, list_price, original_price, coupon_price, member_price, is_soldout
      FROM liked_price_logs
      WHERE sno IN (SELECT sno FROM liked_goods WHERE status = 'ACTIVE')
      ORDER BY date ASC, id ASC
    `)
    .all();

  const logsBySno = new Map();
  for (const log of logs) {
    const my = log.member_price ?? log.coupon_price ?? log.list_price ?? null;
    const tuple = [
      log.date,
      log.original_price ?? null,
      log.list_price ?? null,
      my,
      log.is_soldout ? 1 : 0,
      log.member_price != null ? '내 회원가' : '쿠폰적용가(신규회원 기준)',
      log.list_price != null && my != null ? Math.max(log.list_price - my, 0) : 0,
      log.coupon_price ?? null,
    ];
    const arr = logsBySno.get(log.sno);
    if (arr) arr.push(tuple);
    else logsBySno.set(log.sno, [tuple]);
  }

  return goods.map((g) => ({
    n: Number(g.sno),
    k: `4910:${g.sno}`,
    src: '4910',
    b: g.brand || g.market_name || '4910',
    m: g.market_name,
    g: g.name || '상품',
    u: g.url,
    i: g.image_url || '',
    s: 'ACTIVE',
    c: classifyCategory(g.name, g.brand),
    fs: g.first_liked_date || '',
    L: logsBySno.get(g.sno) || [],
  }));
}

const IMG_BASE_4910 = 'https://d3ha2047wt6x28.cloudfront.net/';

/**
 * Packs every ACTIVE scanned 4910 listing into the compact `4910-all.js` payload. Liked ACTIVE listings are left
 * out: the liked items already carry them with member prices under the same `4910:sno` key.
 * @param {import('node:sqlite').DatabaseSync} db4910
 * @returns {{ v: 1, lastScan: string|null, imgBase: string, b: string[], m: string[], r: any[][] }}
 */
export function buildScan4910Payload(db4910) {
  const hasLiked = db4910
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = 'liked_goods'")
    .get();
  const likedFilter = hasLiked ? "AND sno NOT IN (SELECT sno FROM liked_goods WHERE status = 'ACTIVE')" : '';
  const goods = db4910
    .prepare(`SELECT sno, brand, market_name, name, image_url, first_seen_date FROM goods WHERE status = 'ACTIVE' ${likedFilter} ORDER BY sno ASC`)
    .all();
  const changes = db4910
    .prepare(`
      SELECT sno, date, original_price, sale_price FROM price_changes
      WHERE sno IN (SELECT sno FROM goods WHERE status = 'ACTIVE' ${likedFilter})
      ORDER BY date ASC, id ASC
    `)
    .all();

  const histBySno = new Map();
  for (const c of changes) {
    const h = [c.date, c.original_price ?? null, c.sale_price ?? null];
    const arr = histBySno.get(c.sno);
    if (arr) arr.push(h);
    else histBySno.set(c.sno, [h]);
  }

  const b = [];
  const m = [];
  const bIdx = new Map();
  const mIdx = new Map();
  const indexOf = (arr, idx, v) => {
    if (!idx.has(v)) {
      idx.set(v, arr.length);
      arr.push(v);
    }
    return idx.get(v);
  };

  const r = goods.map((g) => {
    const img = g.image_url || '';
    return [
      Number(g.sno),
      indexOf(b, bIdx, g.brand || g.market_name || '4910'),
      indexOf(m, mIdx, g.market_name || ''),
      g.name || '상품',
      img.startsWith(IMG_BASE_4910) ? img.slice(IMG_BASE_4910.length) : img,
      g.first_seen_date || '',
      classifyCategory(g.name, g.brand),
      histBySno.get(g.sno) || [],
    ];
  });

  // Any run counts, complete or not: a listing unchanged on the latest scan day must not keep yesterday's drop.
  const lastScan = db4910.prepare('SELECT MAX(date) AS d FROM scan_runs').get()?.d ?? null;
  return { v: 1, lastScan, imgBase: IMG_BASE_4910, b, m, r };
}

/**
 * Extracts raw data from SQLite and builds the dashboard data contract.
 * @param {import('node:sqlite').DatabaseSync | { db: import('node:sqlite').DatabaseSync }} dbOrWrapper
 * @param {object} [options]
 * @param {number|string} [options.targetGoodsNo]
 * @param {import('node:sqlite').DatabaseSync | null} [options.db4910] Optional 4910 DB whose liked items are merged in.
 * @returns {object} Dashboard data payload
 */
export function buildClotDataPayload(dbOrWrapper, { targetGoodsNo, db4910 = null } = {}) {
  const rawDb = dbOrWrapper?.db ? dbOrWrapper.db : dbOrWrapper;
  if (!rawDb || typeof rawDb.prepare !== 'function') {
    throw new Error('A valid DatabaseSync instance is required to build clot data payload');
  }

  // 1. Fetch active and soldout items
  const itemCols = rawDb.prepare("PRAGMA table_info(items)").all().map((c) => c.name);
  const hasCat = itemCols.includes('category');
  const catCol = hasCat ? ', category' : '';
  const itemsStmt = rawDb.prepare(`
    SELECT goods_no, goods_name, brand_name, url, image_url, status, first_seen_at, last_checked_at ${catCol}
    FROM items
    WHERE status IN ('ACTIVE', 'SOLDOUT')
    ORDER BY goods_no ASC
  `);
  const rawItems = itemsStmt.all();

  // 2. Fetch price logs scoped only to active and soldout items
  const cols = rawDb.prepare("PRAGMA table_info(price_logs)").all().map((c) => c.name);
  const hasEst = cols.includes('estimated_my_price');
  const estCol = hasEst ? ', estimated_my_price' : '';
  const logsStmt = rawDb.prepare(`
    SELECT goods_no, date, normal_price, sale_price, my_price ${estCol}, is_sold_out, coupon_name, coupon_discount
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
    const effectiveMyPrice = log.my_price ?? (hasEst ? log.estimated_my_price : null) ?? null;
    arr.push([
      log.date,
      log.normal_price ?? null,
      log.sale_price ?? null,
      effectiveMyPrice,
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
    k: String(it.goods_no),
    src: 'musinsa',
    b: it.brand_name || '-',
    g: it.goods_name || '상품',
    u: it.url || `https://www.musinsa.com/products/${it.goods_no}`,
    i: it.image_url || '',
    s: it.status || 'ACTIVE',
    c: it.category || classifyCategory(it.goods_name, it.brand_name),
    fs: it.first_seen_at ? it.first_seen_at.slice(0, 10) : '',
    L: logsByGoods.get(it.goods_no) || [],
  }));

  if (db4910) {
    for (const item of buildLikedItems(db4910)) {
      for (const tuple of item.L) dateSet.add(tuple[0]);
      items.push(item);
    }
  }

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

/**
 * Generates the standalone dashboard HTML file and optionally opens it in the browser.
 * @param {object} [options]
 * @param {import('node:sqlite').DatabaseSync | { db: import('node:sqlite').DatabaseSync }} [options.db]
 * @param {string} [options.outputPath]
 * @param {string} [options.templatePath]
 * @param {boolean} [options.openBrowser=true]
 * @param {number|string} [options.targetGoodsNo]
 * @param {string} [options.db4910Path] 4910.db to merge when the file exists.
 * @returns {{ outputPath: string, targetGoodsNo?: number, totalItems: number, total4910All: number }}
 */
export function generateDashboardHtml({
  db,
  outputPath = DEFAULT_OUTPUT,
  templatePath = DEFAULT_TEMPLATE,
  openBrowser = true,
  targetGoodsNo,
  db4910Path = DEFAULT_4910_DB,
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
    const defaultDbPath = path.join(DATA_DIR, 'prices.db');
    activeDb = new DatabaseSync(defaultDbPath);
    shouldCloseDb = true;
  }

  const digits = targetGoodsNo != null ? String(targetGoodsNo).replace(/\D/g, '') : '';
  const gNo = digits.length > 0 ? Number(digits) : undefined;
  let payload;
  let scan = null;
  try {
    // A broken 4910.db (corrupt, locked, schema drift) must never block the Musinsa dashboard.
    if (db4910Path && fs.existsSync(db4910Path)) {
      let db4910 = null;
      try {
        db4910 = new DatabaseSync(db4910Path, { readOnly: true });
        payload = buildClotDataPayload(activeDb, { targetGoodsNo: gNo, db4910 });
        // The scan listings fail on their own: the liked items above stay on the dashboard.
        try {
          scan = buildScan4910Payload(db4910);
        } catch (err) {
          console.warn(`⚠️ [4910] 대시보드에서 4910 전체 목록 제외: ${err.message}`);
        }
      } catch (err) {
        console.warn(`⚠️ [4910] 대시보드에서 4910 항목 제외: ${err.message}`);
        payload = undefined;
        scan = null;
      } finally {
        if (db4910) db4910.close();
      }
    }
    if (!payload) payload = buildClotDataPayload(activeDb, { targetGoodsNo: gNo });
  } finally {
    if (shouldCloseDb) {
      activeDb.close();
    }
  }
  payload.has4910All = scan != null;
  payload.total4910All = scan ? scan.r.length : 0;

  // Every scanned listing ships beside the HTML and loads only when the 4910 전체 chip asks for it. A build without
  // one removes yesterday's file so the page never serves stale listings.
  const scanPath = path.join(outDir, '4910-all.js');
  if (scan) {
    const scanJson = JSON.stringify(scan).replace(/<\/script/gi, '<\\/script');
    fs.writeFileSync(scanPath, `window.__CLOT_4910_ALL__ = ${scanJson};\n`, 'utf-8');
  } else {
    fs.rmSync(scanPath, { force: true });
  }

  const templateContent = fs.readFileSync(templatePath, 'utf-8');

  // Replace data placeholder using a function replacer to prevent '$' corruption (CRLF tolerant)
  const jsonString = JSON.stringify(payload).replace(/<\/script/gi, '<\\/script');
  const placeholderRegex = /\/\*\s*__CLOT_DATA_PLACEHOLDER__\s*\*\/[\s\S]*?;\s*[\r\n]*/;
  let rendered;
  if (placeholderRegex.test(templateContent)) {
    rendered = templateContent.replace(
      placeholderRegex,
      () => `window.__CLOT_DATA__ = ${jsonString};\n`
    );
  } else {
    rendered = templateContent.replace(
      /window\.__CLOT_DATA__\s*=\s*[\s\S]*?;\s*[\r\n]*/,
      () => `window.__CLOT_DATA__ = ${jsonString};\n`
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
    targetGoodsNo: gNo !== undefined ? gNo : undefined,
    totalItems: payload.items.length,
    total4910All: payload.total4910All,
  };
}
