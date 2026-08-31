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

const DB_PATH = path.join(DATA_DIR, 'prices.db');

export class ClotDatabase {
  constructor(dbPath = DB_PATH) {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
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

      CREATE TABLE IF NOT EXISTS price_logs (
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

  upsertItem({
    goods_no,
    goods_name,
    brand_name = '',
    url,
    image_url = '',
    source = 'like',
    status = 'ACTIVE',
  }) {
    const now = new Date().toISOString();
    const existing = this.getItem(goods_no);

    const cleanBrand = brand_name && brand_name !== '-' ? brand_name : null;
    const cleanName = goods_name && goods_name !== '-' ? goods_name : null;

    if (!existing) {
      const stmt = this.db.prepare(`
        INSERT INTO items (
          goods_no, goods_name, brand_name, url, image_url, source, status, first_seen_at, last_checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        Number(goods_no),
        cleanName || '상품',
        cleanBrand || '-',
        url,
        image_url,
        source,
        status,
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
          status = ?,
          last_checked_at = ?
        WHERE goods_no = ?
      `);
      stmt.run(
        cleanName,
        cleanBrand,
        url || '',
        image_url || '',
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

  recordPriceLog({
    goods_no,
    date,
    normal_price = null,
    sale_price = null,
    sale_rate = null,
    my_price = null,
    coupon_name = null,
    coupon_discount = 0,
    member_discount = 0,
    point_discount = 0,
    is_sold_out = 0,
  }) {
    const now = new Date().toISOString();
    const checkStmt = this.db.prepare('SELECT id FROM price_logs WHERE goods_no = ? AND date = ?');
    const existing = checkStmt.get(Number(goods_no), date);

    if (existing) {
      const updateStmt = this.db.prepare(`
        UPDATE price_logs SET
          normal_price = ?,
          sale_price = ?,
          sale_rate = ?,
          my_price = ?,
          coupon_name = ?,
          coupon_discount = ?,
          member_discount = ?,
          point_discount = ?,
          is_sold_out = ?,
          created_at = ?
        WHERE id = ?
      `);
      updateStmt.run(
        normal_price,
        sale_price,
        sale_rate,
        my_price,
        coupon_name,
        coupon_discount,
        member_discount,
        point_discount,
        is_sold_out ? 1 : 0,
        now,
        existing.id
      );
      return existing.id;
    } else {
      const insertStmt = this.db.prepare(`
        INSERT INTO price_logs (
          goods_no, date, normal_price, sale_price, sale_rate, my_price,
          coupon_name, coupon_discount, member_discount, point_discount, is_sold_out, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const res = insertStmt.run(
        Number(goods_no),
        date,
        normal_price,
        sale_price,
        sale_rate,
        my_price,
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
    const stmt = this.db.prepare('SELECT * FROM daily_runs WHERE date = ?');
    return Boolean(stmt.get(dateStr));
  }

  recordDailyRun({
    date,
    total_tracked,
    price_dropped_count = 0,
    restocked_count = 0,
    duration_ms = 0,
  }) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO daily_runs (
        date, total_tracked, price_dropped_count, restocked_count, duration_ms, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      date,
      total_tracked,
      price_dropped_count,
      restocked_count,
      duration_ms,
      now
    );
  }

  close() {
    this.db.close();
  }
}

export const db = new ClotDatabase();
