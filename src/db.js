import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// CLOT_DB_PATH lets tests point the module-level singleton at a throwaway DB.
const DB_PATH = process.env.CLOT_DB_PATH || path.join(DATA_DIR, 'prices.db');

export class ClotDatabase {
  constructor(dbPath = DB_PATH) {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS items (
        goods_no INTEGER PRIMARY KEY,
        goods_name TEXT NOT NULL,
        brand_name TEXT,
        url TEXT NOT NULL,
        image_url TEXT,
        source TEXT DEFAULT 'like',
        status TEXT DEFAULT 'ACTIVE',
        category TEXT,
        first_seen_at TEXT NOT NULL,
        last_checked_at TEXT,
        lowest_my_price INTEGER,
        lowest_sale_price INTEGER,
        lowest_estimated_price INTEGER,
        lowest_price_date TEXT,
        discovery_misses INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS price_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goods_no INTEGER NOT NULL,
        date TEXT NOT NULL,
        normal_price INTEGER,
        sale_price INTEGER,
        coupon_price INTEGER,
        sale_rate INTEGER,
        my_price INTEGER,
        estimated_my_price INTEGER,
        coupon_name TEXT,
        coupon_discount INTEGER,
        member_discount INTEGER,
        point_discount INTEGER,
        is_sold_out INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (goods_no) REFERENCES items (goods_no)
      );

      CREATE INDEX IF NOT EXISTS idx_price_logs_goods_date ON price_logs (goods_no, date);
      CREATE INDEX IF NOT EXISTS idx_items_status ON items (status);

      CREATE TABLE IF NOT EXISTS daily_runs (
        date TEXT PRIMARY KEY,
        total_tracked INTEGER,
        price_dropped_count INTEGER,
        restocked_count INTEGER,
        duration_ms INTEGER,
        completed_at TEXT NOT NULL
      );
    `);

    // Migration check for existing databases
    const priceLogsCols = this.db.prepare("PRAGMA table_info(price_logs)").all().map((c) => c.name);
    if (!priceLogsCols.includes('coupon_price')) {
      try {
        this.db.exec("ALTER TABLE price_logs ADD COLUMN coupon_price INTEGER;");
      } catch (e) {
        if (!e.message.includes('duplicate column name')) throw e;
      }
    }
    if (!priceLogsCols.includes('estimated_my_price')) {
      try {
        this.db.exec("ALTER TABLE price_logs ADD COLUMN estimated_my_price INTEGER;");
      } catch (e) {
        if (!e.message.includes('duplicate column name')) throw e;
      }
    }

    const itemsCols = this.db.prepare("PRAGMA table_info(items)").all().map((c) => c.name);
    if (!itemsCols.includes('lowest_estimated_price')) {
      try {
        this.db.exec("ALTER TABLE items ADD COLUMN lowest_estimated_price INTEGER;");
      } catch (e) {
        if (!e.message.includes('duplicate column name')) throw e;
      }
    }
    if (!itemsCols.includes('category')) {
      try {
        this.db.exec("ALTER TABLE items ADD COLUMN category TEXT;");
      } catch (e) {
        if (!e.message.includes('duplicate column name')) throw e;
      }
    }
    // Consecutive complete discovery scans that did not list this goods; drives DROPPED.
    if (!itemsCols.includes('discovery_misses')) {
      try {
        this.db.exec("ALTER TABLE items ADD COLUMN discovery_misses INTEGER DEFAULT 0;");
      } catch (e) {
        if (!e.message.includes('duplicate column name')) throw e;
      }
    }

    // daily_runs.mode: 'full' (OpenCLI authenticated prices), 'deferred' (Mac asleep/DarkWake,
    // OpenCLI skipped on purpose), 'degraded' (OpenCLI attempted but failed -> direct parser).
    const dailyRunCols = this.db.prepare("PRAGMA table_info(daily_runs)").all().map((c) => c.name);
    if (!dailyRunCols.includes('mode')) {
      try {
        this.db.exec("ALTER TABLE daily_runs ADD COLUMN mode TEXT DEFAULT 'full';");
      } catch (e) {
        if (!e.message.includes('duplicate column name')) throw e;
      }
    }
  }

  getItem(goodsNo) {
    const stmt = this.db.prepare('SELECT * FROM items WHERE goods_no = ?');
    return stmt.get(Number(goodsNo));
  }

  getAllItems() {
    const stmt = this.db.prepare('SELECT * FROM items ORDER BY last_checked_at DESC, goods_no DESC');
    return stmt.all();
  }

  getActiveItems() {
    const stmt = this.db.prepare("SELECT * FROM items WHERE status IN ('ACTIVE', 'SOLDOUT') ORDER BY goods_no ASC");
    return stmt.all();
  }

  getItemsBySource(source = 'like') {
    const stmt = this.db.prepare("SELECT * FROM items WHERE source = ? ORDER BY goods_no ASC");
    return stmt.all(source);
  }

  getDiscoveredActiveItems() {
    const stmt = this.db.prepare("SELECT * FROM items WHERE source = 'discovery' AND status IN ('ACTIVE', 'SOLDOUT') ORDER BY goods_no ASC");
    return stmt.all();
  }

  getActiveVipItems() {
    const stmt = this.db.prepare("SELECT * FROM items WHERE source != 'discovery' AND status IN ('ACTIVE', 'SOLDOUT') ORDER BY goods_no ASC");
    return stmt.all();
  }

  promoteItemToLike(goodsNo) {
    this.claimDiscoveryItem(goodsNo, 'like');
  }

  /** Hands a discovery goods to the user (like/manual); it must be tracked again even if discovery had dropped it. */
  claimDiscoveryItem(goodsNo, source) {
    const stmt = this.db.prepare(`
      UPDATE items SET
        source = ?,
        status = CASE WHEN status = 'DROPPED' THEN 'ACTIVE' ELSE status END,
        discovery_misses = 0
      WHERE goods_no = ?
    `);
    stmt.run(source, Number(goodsNo));
  }

  markDiscoverySeen(goodsNos = []) {
    if (goodsNos.length === 0) return;
    this.db
      .prepare('UPDATE items SET discovery_misses = 0 WHERE goods_no IN (SELECT value FROM json_each(?))')
      .run(JSON.stringify(goodsNos.map(Number)));
  }

  /** Counts a miss for every tracked discovery goods not in the list, then drops those at the threshold. */
  markDiscoveryUnseen(seenGoodsNos = [], threshold) {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(`
          UPDATE items SET discovery_misses = COALESCE(discovery_misses, 0) + 1
          WHERE source = 'discovery' AND status IN ('ACTIVE', 'SOLDOUT')
            AND goods_no NOT IN (SELECT value FROM json_each(?))
        `)
        .run(JSON.stringify(seenGoodsNos.map(Number)));
      const res = this.db
        .prepare(`
          UPDATE items SET status = 'DROPPED'
          WHERE source = 'discovery' AND status IN ('ACTIVE', 'SOLDOUT') AND discovery_misses >= ?
        `)
        .run(threshold);
      this.db.exec('COMMIT');
      return { dropped: Number(res.changes) };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  upsertItem({
    goods_no,
    goods_name,
    brand_name = '',
    url,
    image_url = '',
    source = 'like',
    status = 'ACTIVE',
    category = null,
  }) {
    const now = new Date().toISOString();
    const existing = this.getItem(goods_no);

    const cleanBrand = brand_name && brand_name !== '-' ? brand_name : null;
    const cleanName = goods_name && goods_name !== '-' ? goods_name : null;

    if (!existing) {
      const stmt = this.db.prepare(`
        INSERT INTO items (
          goods_no, goods_name, brand_name, url, image_url, source, status, category, first_seen_at, last_checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        Number(goods_no),
        cleanName || '상품',
        cleanBrand || '-',
        url,
        image_url,
        source,
        status,
        category,
        now,
        now
      );
      return { created: true, goods_no };
    } else {
      const newStatus = existing.status === 'UNLIKED' && status === 'ACTIVE' ? 'ACTIVE' : existing.status;
      const stmt = this.db.prepare(`
        UPDATE items SET
          goods_name = COALESCE(?, goods_name),
          brand_name = COALESCE(?, goods_name, brand_name),
          url = COALESCE(NULLIF(?, ''), url),
          image_url = COALESCE(NULLIF(?, ''), image_url),
          category = COALESCE(?, category),
          status = ?,
          last_checked_at = ?
        WHERE goods_no = ?
      `);
      stmt.run(
        cleanName,
        cleanBrand,
        url || '',
        image_url || '',
        category,
        newStatus,
        now,
        Number(goods_no)
      );
      return { updated: true, goods_no };
    }
  }

  updateItemDetails(goodsNo, goodsName, brandName, imageUrl) {
    const stmt = this.db.prepare(`
      UPDATE items SET
        goods_name = COALESCE(NULLIF(?, ''), goods_name),
        brand_name = COALESCE(NULLIF(?, ''), brand_name),
        image_url = COALESCE(NULLIF(?, ''), image_url),
        last_checked_at = ?
      WHERE goods_no = ?
    `);
    stmt.run(goodsName, brandName, imageUrl, new Date().toISOString(), Number(goodsNo));
  }

  updateItemStatus(goodsNo, status) {
    const stmt = this.db.prepare('UPDATE items SET status = ?, last_checked_at = ? WHERE goods_no = ?');
    stmt.run(status, new Date().toISOString(), Number(goodsNo));
  }

  updateLowestPrice(goodsNo, lowestMyPrice, lowestSalePrice, dateStr) {
    const stmt = this.db.prepare(`
      UPDATE items SET
        lowest_my_price = ?,
        lowest_sale_price = ?,
        lowest_price_date = ?
      WHERE goods_no = ?
    `);
    stmt.run(lowestMyPrice, lowestSalePrice, dateStr, Number(goodsNo));
  }

  updateLowestEstimatedPrice(goodsNo, price, date) {
    // The date column is shared: once a real lowest exists, an estimate must not overwrite its date.
    const stmt = this.db.prepare(`
      UPDATE items
      SET lowest_estimated_price = ?,
          lowest_price_date = CASE WHEN lowest_my_price IS NULL THEN ? ELSE lowest_price_date END
      WHERE goods_no = ?
    `);
    stmt.run(price, date, Number(goodsNo));
  }

  /** Latest price log with a real my_price strictly before the date: the like-for-like drop baseline. */
  getLatestMyPriceBefore(goodsNo, dateStr) {
    return this.db
      .prepare(
        `SELECT * FROM price_logs WHERE goods_no = ? AND date < ? AND my_price IS NOT NULL
         ORDER BY date DESC, id DESC LIMIT 1`
      )
      .get(Number(goodsNo), dateStr);
  }

  /** Latest date with a real (authenticated) my_price per goods. Goods with none are absent. */
  getLastMyPriceDates(goodsNos = []) {
    const map = new Map();
    if (goodsNos.length === 0) return map;
    const placeholders = goodsNos.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT goods_no, MAX(date) AS last_date FROM price_logs
         WHERE my_price IS NOT NULL AND goods_no IN (${placeholders})
         GROUP BY goods_no`
      )
      .all(...goodsNos.map(Number));
    for (const r of rows) map.set(Number(r.goods_no), r.last_date);
    return map;
  }

  recordPriceLog({
    goods_no,
    date,
    normal_price = null,
    sale_price = null,
    coupon_price = null,
    sale_rate = null,
    my_price = null,
    estimated_my_price = null,
    coupon_name = null,
    coupon_discount = 0,
    member_discount = 0,
    point_discount = 0,
    is_sold_out = 0,
  }) {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT id FROM price_logs WHERE goods_no = ? AND date = ?')
      .get(Number(goods_no), date);

    if (existing) {
      const updateStmt = this.db.prepare(`
        UPDATE price_logs SET
          normal_price = ?,
          sale_price = ?,
          coupon_price = ?,
          sale_rate = ?,
          my_price = COALESCE(?, my_price),
          estimated_my_price = ?,
          coupon_name = ?,
          coupon_discount = ?,
          member_discount = ?,
          point_discount = ?,
          is_sold_out = ?
        WHERE id = ?
      `);
      updateStmt.run(
        normal_price,
        sale_price,
        coupon_price,
        sale_rate,
        my_price,
        estimated_my_price,
        coupon_name,
        coupon_discount,
        member_discount,
        point_discount,
        is_sold_out ? 1 : 0,
        existing.id
      );
      return existing.id;
    } else {
      const insertStmt = this.db.prepare(`
        INSERT INTO price_logs (
          goods_no, date, normal_price, sale_price, coupon_price, sale_rate,
          my_price, estimated_my_price, coupon_name, coupon_discount,
          member_discount, point_discount, is_sold_out, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const res = insertStmt.run(
        Number(goods_no),
        date,
        normal_price,
        sale_price,
        coupon_price,
        sale_rate,
        my_price,
        estimated_my_price,
        coupon_name,
        coupon_discount,
        member_discount,
        point_discount,
        is_sold_out ? 1 : 0,
        now
      );
      return res.lastInsertRowid;
    }
  }

  getLatestPrice(goodsNo) {
    const stmt = this.db.prepare(`
      SELECT * FROM price_logs 
      WHERE goods_no = ? 
      ORDER BY date DESC, id DESC 
      LIMIT 1
    `);
    return stmt.get(Number(goodsNo));
  }

  /**
   * Latest price log strictly before the given date (YYYY-MM-DD).
   * Used as the price-drop baseline so that re-running the same day (e.g. a deferred
   * run being upgraded once the Mac is awake) compares against yesterday, not itself.
   */
  getLatestPriceBefore(goodsNo, dateStr) {
    const stmt = this.db.prepare(`
      SELECT * FROM price_logs
      WHERE goods_no = ? AND date < ?
      ORDER BY date DESC, id DESC
      LIMIT 1
    `);
    return stmt.get(Number(goodsNo), dateStr);
  }

  getPriceLogs(goodsNo) {
    const stmt = this.db.prepare('SELECT * FROM price_logs WHERE goods_no = ? ORDER BY date ASC');
    return stmt.all(Number(goodsNo));
  }

  getPriceHistory(goodsNo, limit = 30) {
    const stmt = this.db.prepare(`
      SELECT * FROM price_logs 
      WHERE goods_no = ? 
      ORDER BY date ASC 
      LIMIT ?
    `);
    return stmt.all(Number(goodsNo), limit);
  }

  hasRunToday(dateStr) {
    return Boolean(this.getDailyRun(dateStr));
  }

  getDailyRun(dateStr) {
    const stmt = this.db.prepare('SELECT * FROM daily_runs WHERE date = ?');
    return stmt.get(dateStr) || null;
  }

  recordDailyRun({
    date,
    total_tracked,
    price_dropped_count = 0,
    restocked_count = 0,
    duration_ms = 0,
    mode = 'full',
  }) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO daily_runs (
        date, total_tracked, price_dropped_count, restocked_count, duration_ms, completed_at, mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      date,
      total_tracked,
      price_dropped_count,
      restocked_count,
      duration_ms,
      now,
      mode
    );
  }

  skipDailyRun(dateStr) {
    const existing = this.getDailyRun(dateStr);
    const now = new Date().toISOString();
    if (existing) {
      const stmt = this.db.prepare(`
        UPDATE daily_runs
        SET mode = 'skipped', completed_at = ?
        WHERE date = ?
      `);
      stmt.run(now, dateStr);
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO daily_runs (
          date, total_tracked, price_dropped_count, restocked_count, duration_ms, completed_at, mode
        ) VALUES (?, 0, 0, 0, 0, ?, 'skipped')
      `);
      stmt.run(dateStr, now);
    }
    return this.getDailyRun(dateStr);
  }

  getDailyAuditReport(dateStr) {
    const dailyRun = this.getDailyRun(dateStr);
    const catalogCountStmt = this.db.prepare(
      "SELECT count(*) as count FROM items WHERE source != 'discovery' AND status IN ('ACTIVE', 'SOLDOUT')"
    );
    const catalogCount = catalogCountStmt.get()?.count || 0;

    const logSummaryStmt = this.db.prepare(`
      SELECT 
        count(*) as total_logs,
        count(DISTINCT goods_no) as distinct_items,
        count(my_price) as my_price_count,
        count(sale_price) as sale_price_count,
        sum(case when is_sold_out = 1 then 1 else 0 end) as sold_out_count
      FROM price_logs
      WHERE date = ?
    `);
    const logSummary = logSummaryStmt.get(dateStr) || {
      total_logs: 0,
      distinct_items: 0,
      my_price_count: 0,
      sale_price_count: 0,
      sold_out_count: 0,
    };

    const priceDropsStmt = this.db.prepare(`
      SELECT p1.goods_no, i.brand_name, i.goods_name,
             CASE 
               WHEN p1.my_price IS NOT NULL AND p2.my_price IS NOT NULL THEN p1.my_price
               ELSE p1.sale_price 
             END as current_price,
             CASE 
               WHEN p1.my_price IS NOT NULL AND p2.my_price IS NOT NULL THEN p2.my_price
               ELSE p2.sale_price 
             END as prev_price,
             (
               CASE 
                 WHEN p1.my_price IS NOT NULL AND p2.my_price IS NOT NULL THEN (p2.my_price - p1.my_price)
                 ELSE (p2.sale_price - p1.sale_price)
               END
             ) as drop_amount,
             round(
               (
                 CASE 
                   WHEN p1.my_price IS NOT NULL AND p2.my_price IS NOT NULL THEN (p2.my_price - p1.my_price) * 100.0 / p2.my_price
                   ELSE (p2.sale_price - p1.sale_price) * 100.0 / p2.sale_price
                 END
               )
             ) as drop_rate,
             (p1.my_price IS NOT NULL AND p2.my_price IS NOT NULL) as is_authenticated
      FROM price_logs p1
      JOIN items i ON p1.goods_no = i.goods_no
      LEFT JOIN price_logs p2 ON p1.goods_no = p2.goods_no
        AND p2.date = (SELECT MAX(date) FROM price_logs WHERE goods_no = p1.goods_no AND date < ?)
      WHERE p1.date = ?
        AND (
          (p1.my_price IS NOT NULL AND p2.my_price IS NOT NULL AND p1.my_price < p2.my_price)
          OR
          ((p1.my_price IS NULL OR p2.my_price IS NULL) AND p1.sale_price IS NOT NULL AND p2.sale_price IS NOT NULL AND p1.sale_price < p2.sale_price)
        )
      ORDER BY drop_amount DESC
    `);
    const priceDrops = priceDropsStmt.all(dateStr, dateStr);

    return {
      date: dateStr,
      dailyRun,
      catalogCount,
      totalLogs: logSummary.total_logs || 0,
      distinctItems: logSummary.distinct_items || 0,
      myPriceCount: logSummary.my_price_count || 0,
      salePriceCount: logSummary.sale_price_count || 0,
      soldOutCount: logSummary.sold_out_count || 0,
      priceDrops,
    };
  }

  /** Folds the WAL into prices.db: git commits the main file only (the -wal side file is ignored). */
  checkpoint() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  close() {
    this.db.close();
  }
}

export const db = new ClotDatabase();
