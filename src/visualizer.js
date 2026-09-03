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
