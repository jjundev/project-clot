// Musinsa wide listings in their own SQLite file (data/musinsa-wide.db), shipped through a GitHub Release like 4910.db.
// ~30k listings a day over 5 top-level categories, so history is change-only: price_changes gets a row only for
// NEW, PRICE and REVIVED, and a goods row is rewritten only when something in it changed.
// Member coupon checks (pickSample) are a sample; each goods keeps its own coupon list and the date/price it was last
// checked at.
// The coupon registry (coupons, coupon_empty_numbers, coupon_goods, coupon_observations, meta) lists every coupon
// number found by walking the anonymous coupon API, with its state (USABLE, OTHER, PENDING, OUT_OF_SCOPE, RETIRED).
// Old DBs (Release data) gain the new columns through PRAGMA table_info + ALTER TABLE in the constructor.
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

// Coupon registry states.
export const COUPON_STATE = {
  USABLE: 'USABLE', OTHER: 'OTHER', PENDING: 'PENDING', OUT_OF_SCOPE: 'OUT_OF_SCOPE', RETIRED: 'RETIRED',
};

// Empty coupon numbers are asked again for this many days after they were first seen.
export const EMPTY_RECHECK_DAYS = 3;
// A USABLE coupon with at least LIVENESS_MIN_OBS observations in the last LIVENESS_DAYS days, none of them seen, is retired.
export const LIVENESS_DAYS = 7;
export const LIVENESS_MIN_OBS = 3;
// OTHER and OUT_OF_SCOPE coupons are forgotten this many days after they were first seen.
export const REGISTRY_KEEP_DAYS = 60;

// `date` (YYYY-MM-DD) moved by `days` whole days, on UTC midnights like coupons.js dayNumber.
export const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

// Deterministic shuffle so the same date draws the same sample.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a 32-bit over the string's char codes.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// Row fields copied into goods on every sighting; a row is rewritten only when one of them differs.
const UPDATABLE = ['cat', 'brand', 'brand_name', 'name', 'url', 'image_url', 'sale_price', 'normal_price', 'extra_discount', 'is_sold_out', 'review_count'];

// The env var is read per call, not at module load, so tests can set it after import.
export function defaultMusinsaWideDbPath() {
  return process.env.CLOT_MUSINSA_WIDE_DB_PATH || path.join(ROOT_DIR, 'data', 'musinsa-wide.db');
}

function toRegistryCoupon({ scope_goods_json, ...r }) {
  return { ...r, scope_goods: scope_goods_json == null ? null : JSON.parse(scope_goods_json) };
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
        is_sold_out INTEGER NOT NULL DEFAULT 0, review_count INTEGER, coupon_price INTEGER, coupons_json TEXT, coupon_checked_date TEXT,
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
        duration_ms INTEGER, completed_at TEXT NOT NULL, coupons_ok INTEGER, coupon_checks INTEGER, coupon_metrics_json TEXT
      );
      CREATE TABLE IF NOT EXISTS coupons (
        coupon_no INTEGER PRIMARY KEY, state TEXT NOT NULL, name TEXT, type TEXT, percent REAL, price INTEGER, max INTEGER, min INTEGER,
        start_date TEXT, until_date TEXT, last_count INTEGER, scope_goods_json TEXT,
        first_seen_date TEXT NOT NULL, last_member_seen_date TEXT, classified_date TEXT
      );
      CREATE TABLE IF NOT EXISTS coupon_empty_numbers (coupon_no INTEGER PRIMARY KEY, first_seen_date TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coupon_goods (
        coupon_no INTEGER NOT NULL, goods_no INTEGER NOT NULL, date TEXT, PRIMARY KEY (coupon_no, goods_no)
      );
      CREATE TABLE IF NOT EXISTS coupon_observations (
        coupon_no INTEGER NOT NULL, goods_no INTEGER NOT NULL, date TEXT NOT NULL, seen INTEGER NOT NULL,
        PRIMARY KEY (coupon_no, goods_no, date)
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_price_changes_goods_date ON price_changes (goods_no, date);
      CREATE INDEX IF NOT EXISTS idx_goods_cat_status ON goods (cat, status);
      CREATE INDEX IF NOT EXISTS idx_goods_status_coupon_checked ON goods (status, coupon_checked_date);
      CREATE INDEX IF NOT EXISTS idx_coupons_state ON coupons (state);
    `);
    this.#addMissingColumns('goods', [['review_count', 'INTEGER']]);
    this.#addMissingColumns('scan_runs', [['coupon_metrics_json', 'TEXT']]);
    this.#addMissingColumns('coupon_goods', [['date', 'TEXT']]);
  }

  // DBs created before a column existed (the Release copy) get it by ALTER TABLE; CREATE TABLE IF NOT EXISTS leaves them as is.
  #addMissingColumns(table, columns) {
    const have = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of columns) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }

  // LIMIT 1, not COUNT(*): goods runs to ~30k+ rows.
  isEmpty() {
    return !this.db.prepare('SELECT 1 FROM goods LIMIT 1').get();
  }

  /**
   * Applies one day's scan of one top-level category (`cat`). A miss counts only when `complete` (the whole category was
   * read), only for that category's ACTIVE rows, and at most once per date, so a same-day rerun or a half-failed
   * category never pushes listings toward OUT_OF_SCOPE. The coupon columns are never touched here, except that a goods
   * leaving scope drops its coupon_price (the published DB must not keep a price nothing refreshes).
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
          is_sold_out, review_count, lowest_price, lowest_price_date, first_seen_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const update = this.db.prepare(`
        UPDATE goods SET cat = ?, brand = ?, brand_name = ?, name = ?, url = ?, image_url = ?, status = 'ACTIVE',
          sale_price = ?, normal_price = ?, extra_discount = ?, is_sold_out = ?, review_count = ?,
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
            r.sale_price ?? null, r.normal_price ?? null, extra, soldOut, r.review_count ?? null, r.sale_price ?? null, r.sale_price == null ? null : date, date);
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
          next.sale_price ?? null, next.normal_price ?? null, extra, soldOut, next.review_count ?? null,
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
            .prepare(`UPDATE goods SET status = '${STATUS_OUT_OF_SCOPE}', coupon_price = NULL WHERE status = 'ACTIVE' AND cat = ? AND misses >= ?`)
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
  // coupon_checks adds up (pickSample never re-picks a goods checked that day, so nothing is counted twice).
  recordScanRun({ date, categoryCounts, complete, changed, added, outOfScope, durationMs, couponsOk = false, couponChecks = 0, couponMetrics = null }) {
    this.db
      .prepare(`
        INSERT INTO scan_runs (date, category_counts_json, complete, changed, added, out_of_scope, duration_ms, completed_at, coupons_ok, coupon_checks, coupon_metrics_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (date) DO UPDATE SET category_counts_json = excluded.category_counts_json, complete = excluded.complete,
          changed = excluded.changed, added = excluded.added, out_of_scope = excluded.out_of_scope, duration_ms = excluded.duration_ms,
          completed_at = excluded.completed_at, coupons_ok = MAX(COALESCE(scan_runs.coupons_ok, 0), excluded.coupons_ok),
          coupon_checks = COALESCE(scan_runs.coupon_checks, 0) + excluded.coupon_checks,
          coupon_metrics_json = excluded.coupon_metrics_json
      `)
      .run(date, JSON.stringify(categoryCounts), complete ? 1 : 0, changed, added, outOfScope, durationMs, new Date().toISOString(),
        couponsOk ? 1 : 0, couponChecks, couponMetrics == null ? null : JSON.stringify(couponMetrics));
  }

  // --- coupon registry ---

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  }

  // null deletes the key.
  setMeta(key, value) {
    if (value == null) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  getCoupon(couponNo) {
    const r = this.db.prepare('SELECT * FROM coupons WHERE coupon_no = ?').get(Number(couponNo));
    return r && toRegistryCoupon(r);
  }

  maxCouponNo() {
    return this.db.prepare('SELECT MAX(coupon_no) AS n FROM coupons').get().n ?? null;
  }

  // The ACTIVE ones of `goodsNos`, in the order given.
  filterActive(goodsNos) {
    const active = new Set(
      this.db
        .prepare("SELECT goods_no FROM goods WHERE status = 'ACTIVE' AND goods_no IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify(goodsNos.map(Number)))
        .map((r) => r.goods_no)
    );
    return goodsNos.map(Number).filter((n) => active.has(n));
  }

  // What the classify plan needs of each goods it knows: goods_no -> { review_count, is_sold_out, status }.
  goodsInfo(goodsNos) {
    const rows = this.db
      .prepare('SELECT goods_no, review_count, is_sold_out, status FROM goods WHERE goods_no IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(goodsNos.map(Number)));
    return new Map(rows.map(({ goods_no, ...info }) => [goods_no, info]));
  }

  /**
   * A coupon number the walk found goods for. New: PENDING when `scopeGoods` (the in-scope goods of its first page) is
   * non-empty, else OUT_OF_SCOPE. Known: only last_count moves. The number leaves coupon_empty_numbers either way.
   */
  recordHit(couponNo, date, count, { scopeGoods = null } = {}) {
    const no = Number(couponNo);
    const known = this.db.prepare('SELECT 1 FROM coupons WHERE coupon_no = ?').get(no);
    if (known) {
      this.db.prepare('UPDATE coupons SET last_count = ? WHERE coupon_no = ?').run(count, no);
    } else {
      const inScope = scopeGoods && scopeGoods.length > 0;
      this.db
        .prepare('INSERT INTO coupons (coupon_no, state, last_count, scope_goods_json, first_seen_date) VALUES (?, ?, ?, ?, ?)')
        .run(no, inScope ? COUPON_STATE.PENDING : COUPON_STATE.OUT_OF_SCOPE, count, inScope ? JSON.stringify(scopeGoods) : null, date);
    }
    this.db.prepare('DELETE FROM coupon_empty_numbers WHERE coupon_no = ?').run(no);
    return known ? 'known' : 'new';
  }

  // The first-seen date of an empty number is kept, so the recheck window runs from the first sighting.
  recordEmpty(couponNo, date) {
    this.db.prepare('INSERT OR IGNORE INTO coupon_empty_numbers (coupon_no, first_seen_date) VALUES (?, ?)').run(Number(couponNo), date);
  }

  // Empty numbers first seen within the last EMPTY_RECHECK_DAYS days, not today.
  emptyNumbersToRecheck(date) {
    return this.db
      .prepare('SELECT coupon_no FROM coupon_empty_numbers WHERE first_seen_date >= ? AND first_seen_date < ? ORDER BY coupon_no')
      .all(shiftDate(date, -EMPTY_RECHECK_DAYS), date)
      .map((r) => r.coupon_no);
  }

  pendingCoupons() {
    return this.db
      .prepare('SELECT * FROM coupons WHERE state = ? ORDER BY coupon_no')
      .all(COUPON_STATE.PENDING)
      .map(toRegistryCoupon);
  }

  /**
   * Coupons a member call returned (parseCoupon results, string ids) are USABLE by definition. `added` were not in the
   * registry, `revived` were in it in another state.
   */
  upsertMemberCoupons(date, coupons) {
    const added = [];
    const revived = [];
    this.db.exec('BEGIN');
    try {
      const prev = this.db.prepare('SELECT state FROM coupons WHERE coupon_no = ?');
      const insert = this.db.prepare(`
        INSERT INTO coupons (coupon_no, state, name, type, percent, price, max, min, start_date, until_date, first_seen_date, last_member_seen_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const update = this.db.prepare(`
        UPDATE coupons SET state = ?, name = ?, type = ?, percent = ?, price = ?, max = ?, min = ?, start_date = ?, until_date = ?,
          last_member_seen_date = ?
        WHERE coupon_no = ?
      `);
      for (const c of coupons) {
        const no = Number(c.id);
        const cond = [c.name ?? null, c.type ?? null, c.percent ?? null, c.price ?? null, c.max ?? null, c.min ?? null, c.start ?? null, c.until ?? null];
        const old = prev.get(no);
        if (!old) {
          insert.run(no, COUPON_STATE.USABLE, ...cond, date, date);
          added.push(no);
          continue;
        }
        if (old.state !== COUPON_STATE.USABLE) revived.push(no);
        update.run(COUPON_STATE.USABLE, ...cond, date, no);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { added, revived };
  }

  // Only PENDING rows move; a coupon a member call already made USABLE (or anything else) is left alone.
  markClassified(couponNos, date, state) {
    this.db
      .prepare(`
        UPDATE coupons SET state = ?, classified_date = ?
        WHERE state = '${COUPON_STATE.PENDING}' AND coupon_no IN (SELECT value FROM json_each(?))
      `)
      .run(state, date, JSON.stringify(couponNos.map(Number)));
  }

  // USABLE and not expired on `date` (until_date is the last day it works).
  usableCoupons(date) {
    return this.db
      .prepare(`SELECT * FROM coupons WHERE state = '${COUPON_STATE.USABLE}' AND (until_date IS NULL OR until_date >= ?) ORDER BY coupon_no`)
      .all(date)
      .map(toRegistryCoupon);
  }

  // Registers the unexpired coupons already stored in goods.coupons_json (the old per-goods rotation) as USABLE.
  seedFromGoodsCoupons(date) {
    const byId = new Map();
    for (const { coupons_json } of this.db.prepare('SELECT coupons_json FROM goods WHERE coupons_json IS NOT NULL').all()) {
      for (const c of JSON.parse(coupons_json)) {
        if (c.until == null || c.until >= date) byId.set(String(c.id), c);
      }
    }
    this.upsertMemberCoupons(date, [...byId.values()]);
    return byId.size;
  }

  // usable counts only coupons that still work on `date`; expiredYesterday are USABLE rows whose last day was yesterday.
  registryCounts(date) {
    const count = (where, ...args) => this.db.prepare(`SELECT COUNT(*) AS n FROM coupons WHERE ${where}`).get(...args).n;
    return {
      usable: count(`state = '${COUPON_STATE.USABLE}' AND (until_date IS NULL OR until_date >= ?)`, date),
      pending: count(`state = '${COUPON_STATE.PENDING}'`),
      expiredYesterday: count(`state = '${COUPON_STATE.USABLE}' AND until_date = ?`, shiftDate(date, -1)),
    };
  }

  // --- coupon goods, observations, sample ---

  // One transaction: the coupon's rows are replaced by its ACTIVE goods, stamped with `date`.
  replaceCouponGoods(couponNo, date, goodsNos) {
    const no = Number(couponNo);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM coupon_goods WHERE coupon_no = ?').run(no);
      const insert = this.db.prepare('INSERT OR IGNORE INTO coupon_goods (coupon_no, goods_no, date) VALUES (?, ?, ?)');
      for (const g of this.filterActive(goodsNos)) insert.run(no, g, date);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  couponGoodsCount() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM coupon_goods').get().n;
  }

  // goods_no -> coupon numbers whose list holds it.
  couponsByGoods() {
    const m = new Map();
    for (const { goods_no, coupon_no } of this.db.prepare('SELECT goods_no, coupon_no FROM coupon_goods ORDER BY goods_no, coupon_no').all()) {
      const list = m.get(goods_no);
      if (list) list.push(coupon_no);
      else m.set(goods_no, [coupon_no]);
    }
    return m;
  }

  // Does any goods' stored (member-checked) coupon list hold this coupon? Stored ids are strings.
  goodsHasDirectCoupon(couponNo) {
    return !!this.db
      .prepare("SELECT 1 FROM goods WHERE coupons_json IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(goods.coupons_json) WHERE CAST(json_extract(value, '$.id') AS TEXT) = ?) LIMIT 1")
      .get(String(couponNo));
  }

  /**
   * One member check per goods: every USABLE coupon whose list holds that goods gets seen = 1 when the check returned it,
   * else 0. INSERT OR REPLACE, so a same-day rerun leaves one row per (coupon, goods, date). Returns the rows written.
   */
  recordObservations(date, checks) {
    const listed = this.db.prepare(`
      SELECT cg.coupon_no FROM coupon_goods cg JOIN coupons c ON c.coupon_no = cg.coupon_no
      WHERE cg.goods_no = ? AND c.state = '${COUPON_STATE.USABLE}'
    `);
    const put = this.db.prepare('INSERT OR REPLACE INTO coupon_observations (coupon_no, goods_no, date, seen) VALUES (?, ?, ?, ?)');
    let written = 0;
    this.db.exec('BEGIN');
    try {
      for (const { goods_no, couponNos } of checks) {
        const returned = new Set((couponNos ?? []).map(Number));
        for (const { coupon_no } of listed.all(Number(goods_no))) {
          put.run(coupon_no, Number(goods_no), date, returned.has(coupon_no) ? 1 : 0);
          written++;
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return written;
  }

  // USABLE coupons with LIVENESS_MIN_OBS+ observations in the last LIVENESS_DAYS days (date included), none seen, become RETIRED.
  retireDead(date) {
    const dead = this.db
      .prepare(`
        SELECT o.coupon_no FROM coupon_observations o JOIN coupons c ON c.coupon_no = o.coupon_no
        WHERE c.state = '${COUPON_STATE.USABLE}' AND o.date >= ? AND o.date <= ?
        GROUP BY o.coupon_no HAVING COUNT(*) >= ? AND SUM(o.seen) = 0
        ORDER BY o.coupon_no
      `)
      .all(shiftDate(date, -(LIVENESS_DAYS - 1)), date, LIVENESS_MIN_OBS)
      .map((r) => r.coupon_no);
    if (dead.length) {
      this.db
        .prepare(`UPDATE coupons SET state = '${COUPON_STATE.RETIRED}' WHERE coupon_no IN (SELECT value FROM json_each(?))`)
        .run(JSON.stringify(dead));
    }
    return dead;
  }

  /**
   * The day's member-check sample: floor(n / 5) goods per top-level category, from ACTIVE, in-stock, priced goods not yet
   * checked on `date`. Candidates go in goods_no order and are shuffled with a generator seeded from the date, so the same
   * date draws the same sample.
   */
  pickSample(n, date) {
    const perCat = Math.floor(n / 5);
    const byCat = new Map();
    const candidates = this.db
      .prepare(`
        SELECT goods_no, cat, brand, sale_price, extra_discount FROM goods
        WHERE status = 'ACTIVE' AND is_sold_out = 0 AND sale_price IS NOT NULL
          AND (coupon_checked_date IS NULL OR coupon_checked_date <> ?)
        ORDER BY goods_no
      `)
      .all(date);
    for (const r of candidates) {
      const list = byCat.get(r.cat);
      if (list) list.push({ ...r });
      else byCat.set(r.cat, [{ ...r }]);
    }
    const picked = [];
    for (const cat of [...byCat.keys()].sort()) {
      const list = byCat.get(cat);
      const rnd = mulberry32(fnv1a(date));
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      picked.push(...list.slice(0, perCat));
    }
    return picked;
  }

  // Per top-level category, the smallest review_count among ACTIVE goods that have one.
  categoryReviewFloors() {
    const floors = {};
    for (const r of this.db
      .prepare("SELECT cat, MIN(review_count) AS floor FROM goods WHERE status = 'ACTIVE' AND review_count IS NOT NULL GROUP BY cat")
      .all()) floors[r.cat] = r.floor;
    return floors;
  }

  /**
   * Drops what is no longer useful: OTHER and OUT_OF_SCOPE coupons first seen over REGISTRY_KEEP_DAYS ago, empty numbers
   * past their recheck window, and observations older than the liveness window. USABLE, PENDING and RETIRED rows stay.
   */
  pruneRegistry(date) {
    const run = (sql, ...args) => Number(this.db.prepare(sql).run(...args).changes);
    return {
      coupons: run(`DELETE FROM coupons WHERE state IN ('${COUPON_STATE.OTHER}', '${COUPON_STATE.OUT_OF_SCOPE}') AND first_seen_date < ?`, shiftDate(date, -REGISTRY_KEEP_DAYS)),
      empties: run('DELETE FROM coupon_empty_numbers WHERE first_seen_date < ?', shiftDate(date, -EMPTY_RECHECK_DAYS)),
      observations: run('DELETE FROM coupon_observations WHERE date < ?', shiftDate(date, -(LIVENESS_DAYS - 1))),
    };
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
