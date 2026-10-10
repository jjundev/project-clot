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

// A listing leaves scope (hidden, no history) when its brand drops out of the ranking or its seller is not qualified.
// It comes back through applyScan as REVIVED; coupon_price is derived data, so applyScan never touches it.
export const STATUS_OUT_OF_SCOPE = 'OUT_OF_SCOPE';

// Row fields copied into goods on every sighting; a row is rewritten only when one of them differs.
const UPDATABLE = ['brand_sno', 'brand', 'name', 'market_sno', 'market_type_sno', 'market_name', 'category', 'url', 'image_url', 'sale_price', 'original_price', 'discount_rate'];

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
        misses INTEGER NOT NULL DEFAULT 0, last_miss_date TEXT,
        market_type_sno INTEGER, coupon_price INTEGER
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
      CREATE TABLE IF NOT EXISTS brands (
        sno INTEGER PRIMARY KEY, name TEXT, rank INTEGER, pinned INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1, first_ranked_date TEXT, last_ranked_date TEXT
      );
      CREATE TABLE IF NOT EXISTS markets (
        sno INTEGER PRIMARY KEY, name TEXT, satisfaction REAL, reviews_count INTEGER, is_official INTEGER,
        checked_date TEXT, qualified INTEGER NOT NULL DEFAULT 0
      );
      -- market_sno is set only for a seller's own coupon; a coupon from the member's wallet leaves it NULL.
      CREATE TABLE IF NOT EXISTS wallet_coupons (
        coupon_sno INTEGER PRIMARY KEY, name TEXT, type TEXT, percent INTEGER, price INTEGER, max INTEGER, min INTEGER,
        finished_at TEXT, market_sno INTEGER, seen_date TEXT
      );
      CREATE TABLE IF NOT EXISTS market_coupons (
        market_sno INTEGER, date TEXT, coupon_sno INTEGER, coupon_name TEXT, checked_price INTEGER,
        coupon_discount INTEGER, mismatch INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (market_sno, date)
      );
    `);
    // CREATE TABLE IF NOT EXISTS leaves a 4910.db from before these columns as it was, so add them in place.
    const goodsCols = new Set(this.db.prepare('PRAGMA table_info(goods)').all().map((c) => c.name));
    for (const col of ['market_type_sno', 'coupon_price']) {
      if (!goodsCols.has(col)) this.db.exec(`ALTER TABLE goods ADD COLUMN ${col} INTEGER`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_goods_market ON goods (market_sno)');
  }

  // LIMIT 1, not COUNT(*): goods runs to ~300k rows.
  isEmpty() {
    return !this.db.prepare('SELECT 1 FROM goods LIMIT 1').get();
  }

  /**
   * Applies one day's scan, called once per brand. Misses count only for brands whose scan was complete, and at
   * most once per date, so a same-day rerun or a half-failed brand never pushes listings toward DROPPED.
   * Only the listings of the scanned brands are loaded; `initial` still means goods was empty before this call.
   */
  applyScan(date, rows, { completeBrands = [] } = {}) {
    const diff = { initial: false, added: [], priceChanged: 0, drops: [], revived: [], dropped: [] };
    this.db.exec('BEGIN');
    try {
      diff.initial = this.isEmpty();
      // Not just brand_sno IN (...): a listing that moved brands is still in goods under its old brand, and
      // missing it here would make the INSERT below collide on the primary key.
      const brandSnos = [...new Set([...rows.map((r) => Number(r.brand_sno)), ...completeBrands.map(Number)])];
      const existing = new Map();
      const loaded = this.db.prepare(`
        SELECT * FROM goods
        WHERE brand_sno IN (SELECT value FROM json_each(?)) OR sno IN (SELECT value FROM json_each(?))
      `).all(JSON.stringify(brandSnos), JSON.stringify(rows.map((r) => r.sno)));
      for (const g of loaded) {
        existing.set(g.sno, g);
      }

      const logChange = this.db.prepare(
        'INSERT INTO price_changes (sno, date, sale_price, original_price, event) VALUES (?, ?, ?, ?, ?)'
      );
      const insert = this.db.prepare(`
        INSERT INTO goods (sno, brand_sno, brand, name, market_sno, market_type_sno, market_name, category, url, image_url,
          sale_price, original_price, discount_rate, lowest_price, lowest_price_date, first_seen_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const update = this.db.prepare(`
        UPDATE goods SET brand_sno = ?, brand = ?, name = ?, market_sno = ?, market_type_sno = ?, market_name = ?, category = ?, url = ?,
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
          insert.run(r.sno, r.brand_sno, r.brand, r.name, r.market_sno, r.market_type_sno ?? null, r.market_name, r.category, r.url, r.image_url,
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
        update.run(r.brand_sno, r.brand, r.name, r.market_sno, r.market_type_sno ?? null, r.market_name, r.category, r.url, r.image_url,
          r.sale_price, r.original_price, r.discount_rate,
          isNewLowest ? r.sale_price : prev.lowest_price, isNewLowest ? date : null, r.sno);

        if (prev.status === 'DROPPED' || prev.status === STATUS_OUT_OF_SCOPE) {
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

  /**
   * Hides ACTIVE listings whose brand left the ranking or whose seller is not qualified. Deliberately no
   * price_changes row: it is a scope change, not something that happened to the listing. Misses stay as they are,
   * and applyScan never counts them for a non-ACTIVE row. A listing with no seller counts as unqualified
   * (SQL `NULL NOT IN (...)` is NULL, not true, so it is spelled out).
   */
  markOutOfScope({ activeBrandSnos, qualifiedMarketSnos }) {
    return Number(
      this.db
        .prepare(`
          UPDATE goods SET status = '${STATUS_OUT_OF_SCOPE}'
          WHERE status = 'ACTIVE'
            AND (brand_sno NOT IN (SELECT value FROM json_each(?))
              OR market_sno IS NULL
              OR market_sno NOT IN (SELECT value FROM json_each(?)))
        `)
        .run(JSON.stringify(activeBrandSnos.map(Number)), JSON.stringify(qualifiedMarketSnos.map(Number))).changes
    );
  }

  /**
   * Records today's brand ranking (rank = position in `ranked`) plus the always-tracked `pinned` brands.
   * A brand in neither list is deactivated but its row stays, so its first_ranked_date survives a later return.
   */
  upsertBrands(date, ranked, pinned) {
    const pinnedSnos = new Set(pinned.map((b) => Number(b.sno)));
    const rankOf = new Map(ranked.map((b, i) => [Number(b.sno), i + 1]));
    this.db.exec('BEGIN');
    try {
      const upsert = this.db.prepare(`
        INSERT INTO brands (sno, name, rank, pinned, active, first_ranked_date, last_ranked_date)
        VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (sno) DO UPDATE SET name = excluded.name, rank = excluded.rank, pinned = excluded.pinned, active = 1,
          first_ranked_date = COALESCE(brands.first_ranked_date, excluded.first_ranked_date),
          last_ranked_date = COALESCE(excluded.last_ranked_date, brands.last_ranked_date)
      `);
      const seen = new Map();
      for (const b of ranked) seen.set(Number(b.sno), b);
      for (const b of pinned) if (!seen.has(Number(b.sno))) seen.set(Number(b.sno), b);
      for (const [sno, b] of seen) {
        const rank = rankOf.get(sno) ?? null;
        upsert.run(sno, b.name ?? null, rank, pinnedSnos.has(sno) ? 1 : 0, rank == null ? null : date, rank == null ? null : date);
      }
      this.db
        .prepare('UPDATE brands SET active = 0, pinned = 0, rank = NULL WHERE sno NOT IN (SELECT value FROM json_each(?))')
        .run(JSON.stringify([...seen.keys()]));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // Pinned brands without a rank sort last.
  getActiveBrands() {
    return this.db
      .prepare('SELECT sno, name, rank, pinned FROM brands WHERE active = 1 ORDER BY rank IS NULL, rank, sno')
      .all()
      .map((b) => ({ ...b, pinned: Boolean(b.pinned) }));
  }

  // `m` is the client's getMarket() shape plus `qualified` (decided by the caller, not recomputed here).
  upsertMarket(date, m) {
    this.db
      .prepare(`
        INSERT INTO markets (sno, name, satisfaction, reviews_count, is_official, checked_date, qualified)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (sno) DO UPDATE SET name = excluded.name, satisfaction = excluded.satisfaction,
          reviews_count = excluded.reviews_count, is_official = excluded.is_official,
          checked_date = excluded.checked_date, qualified = excluded.qualified
      `)
      .run(Number(m.sno), m.name ?? null, m.satisfaction ?? null, m.reviewsCount ?? null, m.isOfficial ? 1 : 0, date, m.qualified ? 1 : 0);
  }

  getMarkets() {
    return new Map(this.db.prepare('SELECT * FROM markets ORDER BY sno').all().map((m) => [m.sno, m]));
  }

  /**
   * Swaps the member's wallet (market_sno IS NULL rows) for the usable ones among `coupons` (the client returns
   * every coupon with a `usable` flag), and reports the coupon names that appeared or vanished since the previous
   * wallet. Seller-only coupons (market_sno set) are left alone.
   */
  replaceWallet(date, allCoupons) {
    const coupons = allCoupons.filter((c) => c.usable !== false);
    this.db.exec('BEGIN');
    try {
      const prev = new Set(this.db.prepare('SELECT name FROM wallet_coupons WHERE market_sno IS NULL').all().map((c) => c.name));
      this.db.prepare('DELETE FROM wallet_coupons WHERE market_sno IS NULL').run();
      for (const c of coupons) this.#putCoupon(c, null, date);
      this.db.exec('COMMIT');
      const next = new Set(coupons.map((c) => c.name));
      return {
        added: [...next].filter((n) => !prev.has(n)),
        removed: [...prev].filter((n) => !next.has(n)),
      };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  addMarketCoupon(date, marketSno, coupon) {
    this.#putCoupon(coupon, Number(marketSno), date);
  }

  // max is NULL for "no cap" (Infinity cannot be stored); getWallet turns it back into null for callers.
  #putCoupon(c, marketSno, date) {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO wallet_coupons (coupon_sno, name, type, percent, price, max, min, finished_at, market_sno, seen_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(c.couponSno, c.name ?? null, c.type ?? null, c.percent ?? null, c.price ?? null,
        Number.isFinite(c.max) ? c.max : null, c.min ?? null, c.finishedAt ?? null, marketSno, date);
  }

  // Rows as stored, except max: null means uncapped.
  getWallet() {
    return this.db.prepare('SELECT * FROM wallet_coupons ORDER BY coupon_sno').all();
  }

  recordMarketCoupon({ market_sno, date, coupon_sno, coupon_name, checked_price, coupon_discount, mismatch }) {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO market_coupons (market_sno, date, coupon_sno, coupon_name, checked_price, coupon_discount, mismatch)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(market_sno, date, coupon_sno ?? null, coupon_name ?? null, checked_price ?? null, coupon_discount ?? null, mismatch ? 1 : 0);
  }

  getMarketCoupons(date) {
    return new Map(this.db.prepare('SELECT * FROM market_coupons WHERE date = ?').all(date).map((r) => [r.market_sno, r]));
  }

  // One transaction: ~16k writes would otherwise each be their own commit.
  setCouponPrices(prices) {
    this.db.exec('BEGIN');
    try {
      const set = this.db.prepare('UPDATE goods SET coupon_price = ? WHERE sno = ?');
      for (const [sno, price] of prices) set.run(price ?? null, Number(sno));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // The cheapest and priciest ACTIVE listing of a seller at or above 10,000 won — cheaper ones may not meet a coupon's minimum.
  getQualifiedSamples(marketSno) {
    const pick = (order) =>
      this.db
        .prepare(`SELECT * FROM goods WHERE market_sno = ? AND status = 'ACTIVE' AND sale_price >= 10000 ORDER BY sale_price ${order}, sno LIMIT 1`)
        .get(Number(marketSno)) ?? null;
    return { low: pick('ASC'), high: pick('DESC') };
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
