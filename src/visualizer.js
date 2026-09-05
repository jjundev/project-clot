/**
 * @fileoverview Visualizer core module for Project-Clot.
 * Extracts price time-series data from SQLite and compiles standalone dashboard HTML.
 */

import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
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
    const defaultDbPath = path.join(DATA_DIR, 'prices.db');
    activeDb = new DatabaseSync(defaultDbPath);
    shouldCloseDb = true;
  }

  const digits = targetGoodsNo != null ? String(targetGoodsNo).replace(/\D/g, '') : '';
  const gNo = digits.length > 0 ? Number(digits) : undefined;
  let payload;
  try {
    payload = buildClotDataPayload(activeDb, { targetGoodsNo: gNo });
  } finally {
    if (shouldCloseDb) {
      activeDb.close();
    }
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
  };
}
