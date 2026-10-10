// 4910 listings in their own SQLite file (data/4910.db), committed alongside prices.db.
// ~16k listings a day, so history is change-only: price_changes gets a row only for NEW, PRICE, DROPPED, REVIVED,
// and a goods row is rewritten only when something in it changed — an unchanged listing keeps its bytes, so the
// daily git commit of this file stays a small delta. (No last_seen_date for that reason: misses track absence.)
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Same threshold as discovery (src/discovery.js DISCOVERY_DROP_AFTER_MISSES).
export const DROP_AFTER_MISSES_4910 = 2;
export const DROP_ALERT_RATE = 0.1;

// Row fields copied into goods on every sighting; a row is rewritten only when one of them differs.
const UPDATABLE = ['brand_sno', 'brand', 'name', 'market_sno', 'market_name', 'category', 'url', 'image_url', 'sale_price', 'original_price', 'discount_rate'];

export class Store4910 {
  // The env var is read here, not at module load, so tests can set it after import.
  constructor(dbPath = process.env.CLOT_4910_DB_PATH || path.join(ROOT_DIR, 'data', '4910.db')) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS goods (
        sno INTEGER PRIMARY KEY, brand_sno INTEGER NOT NULL, brand TEXT, name TEXT NOT NULL,
        market_sno INTEGER, market_name TEXT, category TEXT, url TEXT NOT NULL, image_url TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE', sale_price INTEGER, original_price INTEGER, discount_rate INTEGER,
        lowest_price INTEGER, lowest_price_date TEXT, first_seen_date TEXT NOT NULL,
        misses INTEGER NOT NULL DEFAULT 0, last_miss_date TEXT
      );
      CREATE TABLE IF NOT EXISTS price_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sno INTEGER NOT NULL, date TEXT NOT NULL,
        sale_price INTEGER, original_price INTEGER, event TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_price_changes_sno_date ON price_changes (sno, date);
      CREATE INDEX IF NOT EXISTS idx_goods_brand_status ON goods (brand_sno, status);
      CREATE TABLE IF NOT EXISTS scan_runs (
        date TEXT PRIMARY KEY, brand_counts_json TEXT, complete INTEGER, changed INTEGER,
        added INTEGER, dropped INTEGER, duration_ms INTEGER, completed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS liked_goods (
        sno INTEGER PRIMARY KEY, name TEXT NOT NULL, brand TEXT, market_name TEXT, category TEXT,
        url TEXT NOT NULL, image_url TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE',
        first_liked_date TEXT NOT NULL, last_seen_date TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS liked_price_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sno INTEGER NOT NULL, date TEXT NOT NULL,
        list_price INTEGER, original_price INTEGER, coupon_price INTEGER, member_price INTEGER,
        is_soldout INTEGER NOT NULL DEFAULT 0, UNIQUE (sno, date)
      );
    `);
  }

  /**
   * Applies one day's scan. Misses count only for brands whose scan was complete, and at most once per date,
   * so a same-day rerun or a half-failed brand never pushes listings toward DROPPED.
   */
  applyScan(date, rows, { completeBrands = [] } = {}) {
    const diff = { initial: false, added: [], priceChanged: 0, drops: [], revived: [], dropped: [] };
    this.db.exec('BEGIN');
    try {
      const existing = new Map();
      for (const g of this.db.prepare('SELECT * FROM goods').all()) {
        existing.set(g.sno, g);
      }
      diff.initial = existing.size === 0;

      const logChange = this.db.prepare(
        'INSERT INTO price_changes (sno, date, sale_price, original_price, event) VALUES (?, ?, ?, ?, ?)'
      );
      const insert = this.db.prepare(`
        INSERT INTO goods (sno, brand_sno, brand, name, market_sno, market_name, category, url, image_url,
          sale_price, original_price, discount_rate, lowest_price, lowest_price_date, first_seen_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const update = this.db.prepare(`
        UPDATE goods SET brand_sno = ?, brand = ?, name = ?, market_sno = ?, market_name = ?, category = ?, url = ?,
          image_url = ?, status = 'ACTIVE', sale_price = ?, original_price = ?, discount_rate = ?,
          lowest_price = ?, lowest_price_date = COALESCE(?, lowest_price_date),
          misses = 0, last_miss_date = NULL
        WHERE sno = ?
      `);

      for (const scanned of rows) {
        const prev = existing.get(scanned.sno);
        // A listing shown without a price is still seen (no miss) but keeps its last known price, so it logs nothing.
        const r = scanned.sale_price == null && prev
          ? { ...scanned, sale_price: prev.sale_price, original_price: prev.original_price }
          : scanned;
        if (!prev) {
          insert.run(r.sno, r.brand_sno, r.brand, r.name, r.market_sno, r.market_name, r.category, r.url, r.image_url,
            r.sale_price, r.original_price, r.discount_rate, r.sale_price, r.sale_price == null ? null : date, date);
          logChange.run(r.sno, date, r.sale_price, r.original_price, 'NEW');
          diff.added.push(r);
          continue;
        }

        const isNewLowest = r.sale_price != null && (prev.lowest_price == null || r.sale_price < prev.lowest_price);
        const unchanged =
          prev.status === 'ACTIVE' && prev.misses === 0 && !isNewLowest &&
          UPDATABLE.every((col) => prev[col] === (r[col] ?? null));
        if (unchanged) continue;
        update.run(r.brand_sno, r.brand, r.name, r.market_sno, r.market_name, r.category, r.url, r.image_url,
          r.sale_price, r.original_price, r.discount_rate,
          isNewLowest ? r.sale_price : prev.lowest_price, isNewLowest ? date : null, r.sno);

        if (prev.status === 'DROPPED') {
          logChange.run(r.sno, date, r.sale_price, r.original_price, 'REVIVED');
          diff.revived.push(r);
          continue;
        }
        if (r.sale_price === prev.sale_price && r.original_price === prev.original_price) continue;

        logChange.run(r.sno, date, r.sale_price, r.original_price, 'PRICE');
        diff.priceChanged++;
        const rate = prev.sale_price > 0 ? (prev.sale_price - r.sale_price) / prev.sale_price : 0;
        if (rate >= DROP_ALERT_RATE) {
          diff.drops.push({ row: r, prevPrice: prev.sale_price, currentPrice: r.sale_price, dropRate: Math.round(rate * 100), isNewLowest });
        }
      }
      diff.drops.sort((a, b) => b.dropRate - a.dropRate);

      if (completeBrands.length) {
        this.db
          .prepare(`
            UPDATE goods SET misses = misses + 1, last_miss_date = ?
            WHERE status = 'ACTIVE'
              AND brand_sno IN (SELECT value FROM json_each(?))
              AND sno NOT IN (SELECT value FROM json_each(?))
              AND (last_miss_date IS NULL OR last_miss_date < ?)
          `)
          .run(date, JSON.stringify(completeBrands.map(Number)), JSON.stringify(rows.map((r) => r.sno)), date);
        const toDrop = this.db
          .prepare(`SELECT sno, name, market_name, url, sale_price, original_price FROM goods WHERE status = 'ACTIVE' AND misses >= ?`)
          .all(DROP_AFTER_MISSES_4910);
        const markDropped = this.db.prepare(`UPDATE goods SET status = 'DROPPED' WHERE sno = ?`);
        for (const g of toDrop) {
          markDropped.run(g.sno);
          logChange.run(g.sno, date, g.sale_price, g.original_price, 'DROPPED');
          diff.dropped.push({ sno: g.sno, name: g.name, market_name: g.market_name, url: g.url });
        }
      }

      this.db.exec('COMMIT');
      return diff;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  recordScanRun({ date, brandCounts, complete, changed, added, dropped, durationMs }) {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO scan_runs (date, brand_counts_json, complete, changed, added, dropped, duration_ms, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(date, JSON.stringify(brandCounts), complete ? 1 : 0, changed, added, dropped, durationMs, new Date().toISOString());
  }

  /**
   * Mirrors the member's liked list: every row becomes (or stays) ACTIVE, and ACTIVE rows absent from it become
   * UNLIKED. An empty list unlikes nothing — it is indistinguishable from a failed fetch, so it is never trusted.
   */
  syncLiked(rows, date) {
    this.db.exec('BEGIN');
    try {
      const exists = this.db.prepare('SELECT 1 FROM liked_goods WHERE sno = ?');
      const upsert = this.db.prepare(`
        INSERT INTO liked_goods (sno, name, brand, market_name, category, url, image_url, status, first_liked_date, last_seen_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
        ON CONFLICT (sno) DO UPDATE SET name = excluded.name, brand = excluded.brand, market_name = excluded.market_name,
          category = excluded.category, url = excluded.url, image_url = excluded.image_url,
          status = 'ACTIVE', last_seen_date = excluded.last_seen_date
      `);
      let added = 0;
      for (const r of rows) {
        if (!exists.get(r.sno)) added++;
        upsert.run(r.sno, r.name, r.brand ?? null, r.market_name ?? null, r.category ?? null, r.url, r.image_url ?? null, date, date);
      }
      let unliked = 0;
      if (rows.length) {
        unliked = Number(
          this.db
            .prepare(`
              UPDATE liked_goods SET status = 'UNLIKED'
              WHERE status = 'ACTIVE' AND sno NOT IN (SELECT value FROM json_each(?))
            `)
            .run(JSON.stringify(rows.map((r) => r.sno))).changes
        );
      }
      const active = this.db.prepare(`SELECT COUNT(*) AS n FROM liked_goods WHERE status = 'ACTIVE'`).get().n;
      this.db.exec('COMMIT');
      return { added, unliked, active };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  logLikedPrice({ sno, date, list_price, original_price, coupon_price, member_price, is_soldout }) {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO liked_price_logs (sno, date, list_price, original_price, coupon_price, member_price, is_soldout)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(sno, date, list_price ?? null, original_price ?? null, coupon_price ?? null, member_price ?? null, is_soldout ? 1 : 0);
  }

  getActiveLiked() {
    return this.db.prepare(`SELECT * FROM liked_goods WHERE status = 'ACTIVE' ORDER BY sno`).all();
  }

  getPrevLikedPrice(sno, date) {
    return this.db
      .prepare('SELECT * FROM liked_price_logs WHERE sno = ? AND date < ? ORDER BY date DESC LIMIT 1')
      .get(Number(sno), date);
  }

  getGoods(sno) {
    return this.db.prepare('SELECT * FROM goods WHERE sno = ?').get(Number(sno));
  }

  getChanges(sno) {
    return this.db.prepare('SELECT * FROM price_changes WHERE sno = ? ORDER BY id').all(Number(sno));
  }

  checkpoint() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  close() {
    this.db.close();
  }
}
