// Musinsa wide listings in their own SQLite file (data/musinsa-wide.db), shipped through a GitHub Release like 4910.db.
// ~30k listings a day over 5 top-level categories, so history is change-only: price_changes gets a row only for
// NEW, PRICE and REVIVED, and a goods row is rewritten only when something in it changed.
// Coupons are checked per goods on a rotation (pickCouponChecks); each goods keeps its own coupon list and the
// date/price it was last checked at.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Complete scans of the goods' category that must miss it in a row before it leaves scope.
export const OUT_AFTER_MISSES = 2;
export const DROP_ALERT_RATE = 0.1;

// A listing that stopped showing up. No price_changes row (a scope change, not a price event);
// it comes back through applyScan as REVIVED.
export const STATUS_OUT_OF_SCOPE = 'OUT_OF_SCOPE';

// Row fields copied into goods on every sighting; a row is rewritten only when one of them differs.
const UPDATABLE = ['cat', 'brand', 'brand_name', 'name', 'url', 'image_url', 'sale_price', 'normal_price', 'extra_discount', 'is_sold_out'];

// The env var is read per call, not at module load, so tests can set it after import.
export function defaultMusinsaWideDbPath() {
  return process.env.CLOT_MUSINSA_WIDE_DB_PATH || path.join(ROOT_DIR, 'data', 'musinsa-wide.db');
}

export class MusinsaWideStore {
  constructor(dbPath = defaultMusinsaWideDbPath()) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS goods (
        goods_no INTEGER PRIMARY KEY, cat TEXT, brand TEXT, brand_name TEXT, name TEXT NOT NULL, url TEXT NOT NULL, image_url TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE', sale_price INTEGER, normal_price INTEGER, extra_discount INTEGER NOT NULL DEFAULT 0,
        is_sold_out INTEGER NOT NULL DEFAULT 0, coupon_price INTEGER, coupons_json TEXT, coupon_checked_date TEXT,
        coupon_checked_sale_price INTEGER, coupon_checked_extra INTEGER,
        lowest_price INTEGER, lowest_price_date TEXT, first_seen_date TEXT NOT NULL,
        misses INTEGER NOT NULL DEFAULT 0, last_miss_date TEXT
      );
      CREATE TABLE IF NOT EXISTS price_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, goods_no INTEGER NOT NULL, date TEXT NOT NULL,
        sale_price INTEGER, normal_price INTEGER, event TEXT NOT NULL
      );
      -- Change-only history of a goods' (sale_price, coupon_price); coupon_price NULL = no coupon applied.
      CREATE TABLE IF NOT EXISTS coupon_price_changes (
        goods_no INTEGER NOT NULL, date TEXT NOT NULL, sale_price INTEGER NOT NULL, coupon_price INTEGER,
        PRIMARY KEY (goods_no, date)
      );
      CREATE TABLE IF NOT EXISTS scan_runs (
        date TEXT PRIMARY KEY, category_counts_json TEXT, complete INTEGER, changed INTEGER, added INTEGER, out_of_scope INTEGER,
        duration_ms INTEGER, completed_at TEXT NOT NULL, coupons_ok INTEGER, coupon_checks INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_price_changes_goods_date ON price_changes (goods_no, date);
      CREATE INDEX IF NOT EXISTS idx_goods_cat_status ON goods (cat, status);
      CREATE INDEX IF NOT EXISTS idx_goods_status_coupon_checked ON goods (status, coupon_checked_date);
    `);
  }

  // LIMIT 1, not COUNT(*): goods runs to ~30k+ rows.
  isEmpty() {
    return !this.db.prepare('SELECT 1 FROM goods LIMIT 1').get();
  }

  /**
   * Applies one day's scan of one top-level category (`cat`). A miss counts only when `complete` (the whole category was
   * read), only for that category's ACTIVE rows, and at most once per date, so a same-day rerun or a half-failed
   * category never pushes listings toward OUT_OF_SCOPE. coupon_price and the coupon columns are never touched here.
   */
  applyScan(date, scanRows, { cat, complete = false } = {}) {
    // The listing can show a goods twice (it moves between pages while paging); the last sighting wins.
    const rows = [...new Map(scanRows.map((r) => [r.goods_no, r])).values()];
    const diff = { added: [], priceChanged: 0, drops: [], revived: [], outOfScope: 0 };
    this.db.exec('BEGIN');
    try {
      // Not just cat = ?: a listing that moved categories is still in goods under its old cat, and missing it
      // here would make the INSERT below collide on the primary key.
      const existing = new Map();
      const loaded = this.db.prepare(`
        SELECT * FROM goods
        WHERE cat = ? OR goods_no IN (SELECT value FROM json_each(?))
      `).all(cat, JSON.stringify(rows.map((r) => r.goods_no)));
      for (const g of loaded) existing.set(g.goods_no, g);

      const logChange = this.db.prepare(
        'INSERT INTO price_changes (goods_no, date, sale_price, normal_price, event) VALUES (?, ?, ?, ?, ?)'
      );
      const insert = this.db.prepare(`
        INSERT INTO goods (goods_no, cat, brand, brand_name, name, url, image_url, sale_price, normal_price, extra_discount,
          is_sold_out, lowest_price, lowest_price_date, first_seen_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const update = this.db.prepare(`
        UPDATE goods SET cat = ?, brand = ?, brand_name = ?, name = ?, url = ?, image_url = ?, status = 'ACTIVE',
          sale_price = ?, normal_price = ?, extra_discount = ?, is_sold_out = ?,
          lowest_price = ?, lowest_price_date = COALESCE(?, lowest_price_date),
          misses = 0, last_miss_date = NULL
        WHERE goods_no = ?
      `);

      for (const scanned of rows) {
        const prev = existing.get(scanned.goods_no);
        // A listing shown without a price is still seen (no miss) but keeps its last known price, so it logs nothing.
        const r = scanned.sale_price == null && prev
          ? { ...scanned, sale_price: prev.sale_price, normal_price: prev.normal_price }
          : scanned;
        const extra = r.extra_discount ?? 0;
        const soldOut = r.is_sold_out ? 1 : 0;
        if (!prev) {
          insert.run(r.goods_no, r.cat ?? cat, r.brand ?? null, r.brand_name ?? null, r.name, r.url, r.image_url ?? null,
            r.sale_price ?? null, r.normal_price ?? null, extra, soldOut, r.sale_price ?? null, r.sale_price == null ? null : date, date);
          logChange.run(r.goods_no, date, r.sale_price ?? null, r.normal_price ?? null, 'NEW');
          diff.added.push(r);
          continue;
        }

        const next = { ...r, cat: r.cat ?? cat, extra_discount: extra, is_sold_out: soldOut };
        const isNewLowest = r.sale_price != null && (prev.lowest_price == null || r.sale_price < prev.lowest_price);
        const unchanged =
          prev.status === 'ACTIVE' && prev.misses === 0 && !isNewLowest &&
          UPDATABLE.every((col) => prev[col] === (next[col] ?? null));
        if (unchanged) continue;
        update.run(next.cat, next.brand ?? null, next.brand_name ?? null, next.name, next.url, next.image_url ?? null,
          next.sale_price ?? null, next.normal_price ?? null, extra, soldOut,
          isNewLowest ? r.sale_price : prev.lowest_price, isNewLowest ? date : null, r.goods_no);

        if (prev.status === STATUS_OUT_OF_SCOPE) {
          logChange.run(r.goods_no, date, r.sale_price ?? null, r.normal_price ?? null, 'REVIVED');
          diff.revived.push(r);
          continue;
        }
        if (r.sale_price === prev.sale_price && r.normal_price === prev.normal_price) continue;

        logChange.run(r.goods_no, date, r.sale_price ?? null, r.normal_price ?? null, 'PRICE');
        diff.priceChanged++;
        const rate = prev.sale_price > 0 ? (prev.sale_price - r.sale_price) / prev.sale_price : 0;
        if (rate >= DROP_ALERT_RATE) {
          diff.drops.push({ row: r, prevPrice: prev.sale_price, currentPrice: r.sale_price, dropRate: Math.round(rate * 100) });
        }
      }
      diff.drops.sort((a, b) => b.dropRate - a.dropRate);

      if (complete) {
        this.db
          .prepare(`
            UPDATE goods SET misses = misses + 1, last_miss_date = ?
            WHERE status = 'ACTIVE'
              AND cat = ?
              AND goods_no NOT IN (SELECT value FROM json_each(?))
              AND (last_miss_date IS NULL OR last_miss_date < ?)
          `)
          .run(date, cat, JSON.stringify(rows.map((r) => r.goods_no)), date);
        diff.outOfScope = Number(
          this.db
            .prepare(`UPDATE goods SET status = '${STATUS_OUT_OF_SCOPE}' WHERE status = 'ACTIVE' AND cat = ? AND misses >= ?`)
            .run(cat, OUT_AFTER_MISSES).changes
        );
      }

      this.db.exec('COMMIT');
      return diff;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * The next `n` goods whose coupons should be checked on `date`: never checked first, then those whose sale_price or
   * extra_discount changed since their check, then the longest-unchecked; ties by goods_no. Only ACTIVE, in-stock,
   * priced listings, and never one already checked on `date`.
   */
  pickCouponChecks(n, date) {
    return this.db
      .prepare(`
        SELECT goods_no, brand, sale_price, extra_discount FROM goods
        WHERE status = 'ACTIVE' AND is_sold_out = 0 AND sale_price IS NOT NULL
          AND (coupon_checked_date IS NULL OR coupon_checked_date <> ?)
        ORDER BY
          CASE
            WHEN coupon_checked_date IS NULL THEN 0
            WHEN sale_price IS NOT coupon_checked_sale_price OR extra_discount IS NOT coupon_checked_extra THEN 1
            ELSE 2
          END,
          coupon_checked_date, goods_no
        LIMIT ?
      `)
      .all(date, n)
      .map((r) => ({ ...r }));
  }

  // `coupons` is stored as opaque JSON; sale_price/extra_discount are the values the check was made at.
  putGoodsCoupons(goodsNo, date, coupons, { sale_price, extra_discount }) {
    this.db
      .prepare(`
        UPDATE goods SET coupons_json = ?, coupon_checked_date = ?, coupon_checked_sale_price = ?, coupon_checked_extra = ?
        WHERE goods_no = ?
      `)
      .run(JSON.stringify(coupons ?? []), date, sale_price ?? null, extra_discount ?? 0, Number(goodsNo));
  }

  // Only the columns the coupon price needs. coupons is null for a goods never checked.
  getActivePriceRows() {
    return this.db
      .prepare(`SELECT goods_no, sale_price, extra_discount, coupon_checked_date, coupons_json FROM goods WHERE status = 'ACTIVE' ORDER BY goods_no`)
      .all()
      .map(({ coupons_json, ...r }) => ({ ...r, coupons: coupons_json == null ? null : JSON.parse(coupons_json) }));
  }

  // One transaction: ~30k writes would otherwise each be their own commit.
  setCouponPrices(prices) {
    this.db.exec('BEGIN');
    try {
      const set = this.db.prepare('UPDATE goods SET coupon_price = ? WHERE goods_no = ?');
      for (const [goodsNo, price] of prices) set.run(price ?? null, Number(goodsNo));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Logs each goods' (sale_price, coupon_price) pair on date only when it differs from the last row before date;
   * a same-day rerun replaces date's row, or removes it when the pair is back to the earlier one. Rows without a sale
   * price are skipped. A drop is coupon-to-coupon only (both prices non-null) and at least DROP_ALERT_RATE.
   */
  logCouponPriceChanges(date, rows) {
    this.db.exec('BEGIN');
    try {
      const prev = this.db.prepare('SELECT sale_price, coupon_price FROM coupon_price_changes WHERE goods_no = ? AND date < ? ORDER BY date DESC LIMIT 1');
      const del = this.db.prepare('DELETE FROM coupon_price_changes WHERE goods_no = ? AND date = ?');
      const put = this.db.prepare('INSERT OR REPLACE INTO coupon_price_changes (goods_no, date, sale_price, coupon_price) VALUES (?, ?, ?, ?)');
      let written = 0;
      const drops = [];
      for (const { goods_no, sale_price, coupon_price } of rows) {
        if (sale_price == null) continue;
        const cp = coupon_price ?? null;
        const p = prev.get(Number(goods_no), date);
        if (p && p.sale_price === sale_price && p.coupon_price === cp) {
          del.run(Number(goods_no), date);
          continue;
        }
        put.run(Number(goods_no), date, sale_price, cp);
        written++;
        if (p && p.coupon_price != null && cp != null && p.coupon_price > 0) {
          const rate = (p.coupon_price - cp) / p.coupon_price;
          if (rate >= DROP_ALERT_RATE) {
            drops.push({ goods_no: Number(goods_no), prevPrice: p.coupon_price, currentPrice: cp, dropRate: Math.round(rate * 100) });
          }
        }
      }
      drops.sort((a, b) => b.dropRate - a.dropRate);
      this.db.exec('COMMIT');
      return { written, drops };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // coupons_ok sticks across same-day reruns (a later non-ok rerun leaves the refreshed prices alone), and
  // coupon_checks adds up (pickCouponChecks never re-picks a goods checked that day, so nothing is counted twice).
  recordScanRun({ date, categoryCounts, complete, changed, added, outOfScope, durationMs, couponsOk = false, couponChecks = 0 }) {
    this.db
      .prepare(`
        INSERT INTO scan_runs (date, category_counts_json, complete, changed, added, out_of_scope, duration_ms, completed_at, coupons_ok, coupon_checks)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (date) DO UPDATE SET category_counts_json = excluded.category_counts_json, complete = excluded.complete,
          changed = excluded.changed, added = excluded.added, out_of_scope = excluded.out_of_scope, duration_ms = excluded.duration_ms,
          completed_at = excluded.completed_at, coupons_ok = MAX(COALESCE(scan_runs.coupons_ok, 0), excluded.coupons_ok),
          coupon_checks = COALESCE(scan_runs.coupon_checks, 0) + excluded.coupon_checks
      `)
      .run(date, JSON.stringify(categoryCounts), complete ? 1 : 0, changed, added, outOfScope, durationMs, new Date().toISOString(),
        couponsOk ? 1 : 0, couponChecks);
  }

  getGoods(goodsNo) {
    return this.db.prepare('SELECT * FROM goods WHERE goods_no = ?').get(Number(goodsNo));
  }

  getChanges(goodsNo) {
    return this.db.prepare('SELECT * FROM price_changes WHERE goods_no = ? ORDER BY id').all(Number(goodsNo));
  }

  checkpoint() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  close() {
    this.db.close();
  }
}
