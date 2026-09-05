# Catalog Discovery & Estimated MyPrice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand price tracking to automatically discover popular Musinsa products matching dynamic criteria ("released within 2 years" AND "likes $\ge$ 1,000") across major categories, and track them daily using a high-speed mathematical member price estimation model (`estimated_my_price`) without headless browser overhead.

**Architecture:** 
- A 2-Tier hybrid model: Tier 1 VIP items (`source='like'`) maintain full OpenCLI browser authentication for true personal member prices and instant price drop alerts. Tier 2 catalog items (`source='discovery'`) are discovered via HMAC-chained category PLP pagination, filtered at high speed via thumbnail CDN dates and batch like APIs, and monitored using lightweight HTTP requests with a deterministic estimation formula (`couponPrice * (1 - 0.03) * (1 - 0.07)` when points are unrestricted).
- `collectPricesForActiveItems` strictly isolates OpenCLI batching to Tier 1 items (`source='like'`). Discovered items (`source='discovery'`) completely bypass headless browser subprocesses, executing only the fast native HTTP parser.
- The SQLite database schema safely segregates verified `my_price` from mathematical `estimated_my_price` to preserve data integrity and avoid false alerts.
- A new CLI command `clot discover` performs batch catalog ingestion with category and limit controls, while `clot track <goodsNo>` seamlessly promotes discovered items to VIP tracking.

**Tech Stack:** Node.js (v24 native ESM), `node:sqlite` (DatabaseSync with WAL), native `fetch`, native `node:test`. Zero external npm dependencies.

## Global Constraints

- Zero external npm dependencies: rely solely on Node.js native standard libraries (`node:sqlite`, `node:child_process`, `node:test`, `fetch`).
- Strict price segregation: public sale/coupon prices and estimated member prices must never be labeled as authenticated `my_price`. `my_price` is strictly populated from authenticated OpenCLI runs.
- Comparison consistency: price drop detection for `estimated_my_price` must only compare like-for-like against previous `lowest_estimated_price` snapshots.
- OpenCLI browser isolation: OpenCLI subprocess execution must never be invoked for catalog items (`source='discovery'`); it is exclusively reserved for Tier 1 VIP items (`source='like'`).
- Rate limit & WAF protection: PLP category pagination requests must have bounded intervals (minimum 300ms delay) to prevent Musinsa WAF/Cloudflare IP blocks.
- Preserve backward compatibility: existing 84 VIP items, daily cron execution, CLI options, and tests must continue to function without regressions.
- All tests must pass via `npm test` (`node --test 'tests/*.test.js'`).

---

### Task 1: Database Schema Expansion (`src/db.js`) & Tests

**Files:**
- Modify: `src/db.js`
- Test: `tests/db-discovery.test.js`

**Interfaces:**
- Consumes: `ClotDatabase` class in `src/db.js`.
- Produces:
  - `ClotDatabase.prototype.getItemsBySource(source: string): Array<Item>`
  - `ClotDatabase.prototype.getDiscoveredActiveItems(): Array<Item>`
  - `ClotDatabase.prototype.getActiveVipItems(): Array<Item>`
  - `ClotDatabase.prototype.promoteItemToLike(goodsNo: number): void`
  - `ClotDatabase.prototype.updateLowestEstimatedPrice(goodsNo: number, price: number, date: string): void`
  - Updated `initSchema()` with idempotent `ALTER TABLE` migrations for `coupon_price`, `estimated_my_price` on `price_logs` and `lowest_estimated_price` on `items`.
  - Idempotent `recordPriceLog` with `UPDATE` when row already exists for `(goods_no, date)` and `INSERT` when new.

- [ ] **Step 1: Write the failing tests in `tests/db-discovery.test.js`**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClotDatabase } from '../src/db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('Database Schema Expansion & Discovery Source Helpers', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-test-db-'));
  const testDbPath = path.join(tempDir, 'test-prices.db');
  const db = new ClotDatabase(testDbPath);

  t.after(() => {
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test('idempotently creates schema with discovery columns', () => {
    // Check columns in price_logs
    const priceLogsCols = db.db.prepare("PRAGMA table_info(price_logs)").all().map(c => c.name);
    assert.ok(priceLogsCols.includes('coupon_price'), 'price_logs must contain coupon_price');
    assert.ok(priceLogsCols.includes('estimated_my_price'), 'price_logs must contain estimated_my_price');

    // Check columns in items
    const itemsCols = db.db.prepare("PRAGMA table_info(items)").all().map(c => c.name);
    assert.ok(itemsCols.includes('lowest_estimated_price'), 'items must contain lowest_estimated_price');
  });

  await t.test('filters items by source and gets active VIP and discovered items', () => {
    db.upsertItem({
      goods_no: 1001,
      goods_name: 'VIP Liked Item',
      source: 'like',
      url: 'https://www.musinsa.com/products/1001',
    });

    db.upsertItem({
      goods_no: 2001,
      goods_name: 'Discovered Item 1',
      source: 'discovery',
      url: 'https://www.musinsa.com/products/2001',
    });

    db.upsertItem({
      goods_no: 2002,
      goods_name: 'Discovered Item 2 (Sold Out)',
      source: 'discovery',
      status: 'SOLDOUT',
      url: 'https://www.musinsa.com/products/2002',
    });

    const likeItems = db.getItemsBySource('like');
    assert.equal(likeItems.length, 1);
    assert.equal(likeItems[0].goods_no, 1001);

    const vipItems = db.getActiveVipItems();
    assert.equal(vipItems.length, 1);

    const discoveredItems = db.getItemsBySource('discovery');
    assert.equal(discoveredItems.length, 2);

    const activeDiscovered = db.getDiscoveredActiveItems();
    assert.equal(activeDiscovered.length, 2, 'ACTIVE and SOLDOUT should both be included');
  });

  await t.test('promotes discovered item to like (VIP)', () => {
    db.promoteItemToLike(2001);
    const item = db.getItem(2001);
    assert.equal(item.source, 'like');

    const likeItems = db.getItemsBySource('like');
    assert.equal(likeItems.length, 2);
  });

  await t.test('records price logs idempotently (INSERT then UPDATE on same date) with estimated prices', () => {
    db.recordPriceLog({
      goods_no: 2001,
      date: '2026-09-05',
      normal_price: 100000,
      sale_price: 80000,
      coupon_price: 72000,
      sale_rate: 28,
      my_price: null,
      estimated_my_price: 64944,
      coupon_name: '10% 쿠폰',
      coupon_discount: 8000,
      member_discount: 0,
      point_discount: 0,
      is_sold_out: 0,
    });

    let logs = db.getPriceLogs(2001);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].coupon_price, 72000);
    assert.equal(logs[0].estimated_my_price, 64944);

    // Re-run on same date should update, not create duplicate row
    db.recordPriceLog({
      goods_no: 2001,
      date: '2026-09-05',
      normal_price: 100000,
      sale_price: 75000,
      coupon_price: 67500,
      sale_rate: 32,
      my_price: null,
      estimated_my_price: 60885,
      coupon_name: '10% 쿠폰',
      coupon_discount: 7500,
      member_discount: 0,
      point_discount: 0,
      is_sold_out: 0,
    });

    logs = db.getPriceLogs(2001);
    assert.equal(logs.length, 1, 'Must not create duplicate row on same date');
    assert.equal(logs[0].sale_price, 75000);
    assert.equal(logs[0].estimated_my_price, 60885);

    db.updateLowestEstimatedPrice(2001, 60885, '2026-09-05');
    const updatedItem = db.getItem(2001);
    assert.equal(updatedItem.lowest_estimated_price, 60885);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/db-discovery.test.js`
Expected: FAIL with missing columns or methods (`getItemsBySource is not a function`).

- [ ] **Step 3: Implement database schema migration and helper methods in `src/db.js`**

Modify `src/db.js`:
1. Include `coupon_price INTEGER` and `estimated_my_price INTEGER` in `CREATE TABLE IF NOT EXISTS price_logs`.
2. Include `lowest_estimated_price INTEGER` in `CREATE TABLE IF NOT EXISTS items`.
3. Add idempotent `ALTER TABLE` checks inside `initSchema()`:
```javascript
// Migration check for existing databases
const priceLogsCols = this.db.prepare("PRAGMA table_info(price_logs)").all().map((c) => c.name);
if (!priceLogsCols.includes('coupon_price')) {
  this.db.exec("ALTER TABLE price_logs ADD COLUMN coupon_price INTEGER;");
}
if (!priceLogsCols.includes('estimated_my_price')) {
  this.db.exec("ALTER TABLE price_logs ADD COLUMN estimated_my_price INTEGER;");
}

const itemsCols = this.db.prepare("PRAGMA table_info(items)").all().map((c) => c.name);
if (!itemsCols.includes('lowest_estimated_price')) {
  this.db.exec("ALTER TABLE items ADD COLUMN lowest_estimated_price INTEGER;");
}
```
4. Preserve idempotent update logic in `recordPriceLog`:
```javascript
  recordPriceLog({
    goods_no,
    date,
    normal_price,
    sale_price,
    coupon_price = null,
    sale_rate,
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
          my_price = ?,
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
```
5. Add discovery query helpers:
```javascript
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
    const stmt = this.db.prepare("UPDATE items SET source = 'like' WHERE goods_no = ?");
    stmt.run(Number(goodsNo));
  }

  updateLowestEstimatedPrice(goodsNo, price, date) {
    const stmt = this.db.prepare(`
      UPDATE items
      SET lowest_estimated_price = ?, lowest_price_date = ?
      WHERE goods_no = ?
    `);
    stmt.run(price, date, Number(goodsNo));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/db-discovery.test.js`
Expected: PASS (all 4 subtests pass).
Run: `npm test`
Expected: PASS (all existing 31 tests + 1 new suite = 32 passing suites).

- [ ] **Step 5: Commit**

```bash
git add src/db.js tests/db-discovery.test.js
git commit -m "feat(db): expand schema with coupon_price, estimated_my_price and discovery helpers"
```

---

### Task 2: Discovery Engine & Estimation Model (`src/discovery.js`) & Tests

**Files:**
- Create: `src/discovery.js`
- Test: `tests/discovery.test.js`

**Interfaces:**
- Consumes: None (pure standalone engine with native fetch).
- Produces:
  - `isReleasedWithinYears(imageUrl: string, years?: number, now?: Date): boolean`
  - `estimateMemberPrice(couponPrice: number, isRestrictedUsePoint?: boolean, options?: { gradeDiscountRate?: number, pointRate?: number }): number | null`
  - `fetchLikeCountsBatch(goodsNos: Array<number|string>, fetchFn?: Function): Promise<Map<number, number>>`
  - `fetchCategoryGoodsPage(categoryCode: string, pageUrl?: string, fetchFn?: Function): Promise<{ items: Array<object>, pagination: object }>`
  - `discoverCategoryGoods(options: { categoryCode: string, limit?: number, minLikes?: number, years?: number, fetchFn?: Function, delayMs?: number }): Promise<Array<object>>`

- [ ] **Step 1: Write the failing tests in `tests/discovery.test.js`**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReleasedWithinYears,
  estimateMemberPrice,
  fetchLikeCountsBatch,
  fetchCategoryGoodsPage,
  discoverCategoryGoods,
} from '../src/discovery.js';

test('Catalog Discovery Engine & Member Price Estimation', async (t) => {
  await t.test('isReleasedWithinYears accurately parses image URL dates', () => {
    const fixedNow = new Date('2026-09-05T00:00:00Z');

    // 1 month old -> true
    assert.equal(
      isReleasedWithinYears('https://image.msscdn.net/images/goods_img/20260810/7035474/7035474_1_500.jpg', 2, fixedNow),
      true
    );

    // 1.5 years old (March 2025) -> true
    assert.equal(
      isReleasedWithinYears('https://image.msscdn.net/images/goods_img/20250315/5500000/5500000_1_500.jpg', 2, fixedNow),
      true
    );

    // 2.5 years old (January 2024) -> false
    assert.equal(
      isReleasedWithinYears('https://image.msscdn.net/images/goods_img/20240104/3774989/3774989_1_500.jpg', 2, fixedNow),
      false
    );

    // 9 years old (2017) -> false
    assert.equal(
      isReleasedWithinYears('https://image.msscdn.net/images/goods_img/20170728/595039/595039_5_500.jpg', 2, fixedNow),
      false
    );

    // Invalid / empty URL -> false
    assert.equal(isReleasedWithinYears('', 2, fixedNow), false);
    assert.equal(isReleasedWithinYears(null, 2, fixedNow), false);
  });

  await t.test('estimateMemberPrice calculates mathematical member price with Silver grade and points', () => {
    // General case: 100,000 KRW with unrestricted points
    // 100,000 * (1 - 0.03) * (1 - 0.07) = 100,000 * 0.97 * 0.93 = 90,210
    const price1 = estimateMemberPrice(100000, false);
    assert.equal(price1, 90210);

    // Restricted points case: isRestrictedUsePoint = true
    // When points are restricted, price is unchanged from coupon price
    const price2 = estimateMemberPrice(50000, true);
    assert.equal(price2, 50000);

    // Null or invalid input
    assert.equal(estimateMemberPrice(null), null);
    assert.equal(estimateMemberPrice(0), null);
  });

  await t.test('fetchLikeCountsBatch queries Musinsa batch like API', async () => {
    const mockFetch = async (url, options) => {
      assert.equal(url, 'https://like.musinsa.com/like/api/v2/liketypes/goods/counts');
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      assert.deepEqual(body.relationIds, ['1001', '1002']);

      return {
        ok: true,
        json: async () => ({
          data: {
            success: true,
            contents: {
              items: [
                { relationId: '1001', count: 2450 },
                { relationId: '1002', count: 420 },
              ],
            },
          },
        }),
      };
    };

    const likesMap = await fetchLikeCountsBatch([1001, 1002], mockFetch);
    assert.equal(likesMap.get(1001), 2450);
    assert.equal(likesMap.get(1002), 420);
  });

  await t.test('fetchCategoryGoodsPage resolves relative nextPageUrl without throwing', async () => {
    const mockFetch = async (url) => {
      assert.ok(url.startsWith('https://'), `URL must be absolute: ${url}`);
      return {
        ok: true,
        json: async () => ({
          data: {
            list: [{ goodsNo: 9001, goodsName: 'Relative Item', price: 20000 }],
            pagination: { hasNext: false },
          },
        }),
      };
    };

    // Passing relative URL
    const res = await fetchCategoryGoodsPage('001', '/api2/dp/v2/plp/goods?page=2', mockFetch);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].goodsNo, 9001);
  });

  await t.test('discoverCategoryGoods integrates pagination, date filter, likes filter, and estimation', async () => {
    const mockFetch = async (url, options) => {
      if (url.includes('like.musinsa.com')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              contents: {
                items: [
                  { relationId: '7001', count: 1500 }, // Passed (>= 1000)
                  { relationId: '7002', count: 300 },  // Rejected (< 1000)
                ],
              },
            },
          }),
        };
      }

      // PLP Initial Category HTML response with NextData
      const nextData = {
        props: {
          pageProps: {
            dehydratedState: {
              queries: [
                {
                  queryKey: ['001'],
                  state: {
                    data: {
                      pages: [
                        {
                          data: {
                            list: [
                              {
                                goodsNo: 7001,
                                goodsName: 'Fresh Trendy Pants',
                                brandName: 'Brand A',
                                thumbnail: 'https://image.msscdn.net/images/goods_img/20260701/7001/7001_1_500.jpg', // Recent
                                price: 50000,
                                finalPrice: 45000,
                                isSoldOut: false,
                              },
                              {
                                goodsNo: 7002,
                                goodsName: 'Low Like Item',
                                brandName: 'Brand B',
                                thumbnail: 'https://image.msscdn.net/images/goods_img/20260601/7002/7002_1_500.jpg', // Recent
                                price: 60000,
                                finalPrice: 55000,
                                isSoldOut: false,
                              },
                              {
                                goodsNo: 1003,
                                goodsName: 'Old 2020 Item',
                                brandName: 'Brand C',
                                thumbnail: 'https://image.msscdn.net/images/goods_img/20200101/1003/1003_1_500.jpg', // Too old
                                price: 40000,
                                finalPrice: 40000,
                                isSoldOut: false,
                              },
                            ],
                            pagination: { hasNext: false },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      };

      return {
        ok: true,
        text: async () => `<script id="__NEXT_DATA__">${JSON.stringify(nextData)}</script>`,
      };
    };

    const results = await discoverCategoryGoods({
      categoryCode: '001',
      limit: 10,
      minLikes: 1000,
      years: 2,
      fetchFn: mockFetch,
      delayMs: 0,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].goodsNo, 7001);
    assert.equal(results[0].goodsName, 'Fresh Trendy Pants');
    assert.equal(results[0].likeCount, 1500);
    assert.equal(results[0].estimatedMyPrice, 40595); // 45,000 * 0.9021 = 40,594.5 -> 40,595
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/discovery.test.js`
Expected: FAIL with "Cannot find module '../src/discovery.js'".

- [ ] **Step 3: Implement `src/discovery.js`**

Create `src/discovery.js` with zero external dependencies:
```javascript
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export function isReleasedWithinYears(imageUrl, years = 2, now = new Date()) {
  if (!imageUrl || typeof imageUrl !== 'string') return false;
  const match = imageUrl.match(/\/images\/goods_img\/(\d{8})\//);
  if (!match) return false;

  const dateStr = match[1];
  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(4, 6), 10) - 1;
  const day = parseInt(dateStr.slice(6, 8), 10);

  const releaseDate = new Date(Date.UTC(year, month, day));
  if (isNaN(releaseDate.getTime())) return false;

  const msInYear = 365.25 * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(now.getTime() - years * msInYear);

  return releaseDate >= cutoffDate;
}

export function estimateMemberPrice(couponPrice, isRestrictedUsePoint = false, options = {}) {
  if (!couponPrice || typeof couponPrice !== 'number' || couponPrice <= 0) return null;
  if (isRestrictedUsePoint) return couponPrice;

  const gradeDiscountRate = options.gradeDiscountRate ?? 0.03; // Silver member 3%
  const pointRate = options.pointRate ?? 0.07; // Points 7%

  return Math.round(couponPrice * (1 - gradeDiscountRate) * (1 - pointRate));
}

export async function fetchLikeCountsBatch(goodsNos, fetchFn = fetch) {
  if (!goodsNos || goodsNos.length === 0) return new Map();

  const ids = goodsNos.map(String);
  const response = await fetchFn('https://like.musinsa.com/like/api/v2/liketypes/goods/counts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      Referer: 'https://www.musinsa.com/',
    },
    body: JSON.stringify({ relationIds: ids }),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch batch like counts: HTTP ${response.status}`);
  }

  const json = await response.json();
  const items = json?.data?.contents?.items || [];
  const map = new Map();
  for (const item of items) {
    map.set(Number(item.relationId), item.count ?? 0);
  }
  return map;
}

export async function fetchCategoryGoodsPage(categoryCode, pageUrl = null, fetchFn = fetch) {
  let targetUrl = pageUrl || `https://www.musinsa.com/categories/item/${categoryCode}?gf=A&sortCode=POPULAR`;
  if (targetUrl.startsWith('/')) {
    targetUrl = `https://api.musinsa.com${targetUrl}`;
  }

  const response = await fetchFn(targetUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Referer: 'https://www.musinsa.com/',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch category ${categoryCode}: HTTP ${response.status}`);
  }

  // If pageUrl was the PLP v2 JSON API
  if (targetUrl.includes('/api2/dp/v2/plp/goods')) {
    const json = await response.json();
    return {
      items: json?.data?.list || [],
      pagination: json?.data?.pagination || { hasNext: false },
    };
  }

  // Initial HTML page with NextData
  const html = await response.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error(`Could not find __NEXT_DATA__ on category page ${categoryCode}`);
  }

  const nextData = JSON.parse(match[1]);
  const queries = nextData.props?.pageProps?.dehydratedState?.queries || [];
  const itemsQ = queries.find(
    (q) =>
      (Array.isArray(q.queryKey) && (q.queryKey[0] === categoryCode || q.queryKey.includes(categoryCode))) ||
      Boolean(q.state?.data?.pages?.[0]?.data?.list)
  );

  const pageData = itemsQ?.state?.data?.pages?.[0]?.data;
  return {
    items: pageData?.list || [],
    pagination: pageData?.pagination || { hasNext: false },
  };
}

export async function discoverCategoryGoods({
  categoryCode,
  limit = 100,
  minLikes = 1000,
  years = 2,
  fetchFn = fetch,
  delayMs = 300,
}) {
  const discovered = [];
  let currentUrl = null;
  let pageCount = 0;
  const maxPages = 15; // Safeguard

  while (discovered.length < limit && pageCount < maxPages) {
    pageCount++;
    const { items, pagination } = await fetchCategoryGoodsPage(categoryCode, currentUrl, fetchFn);
    if (!items || items.length === 0) break;

    // Step 1: High-speed date filtering using image CDN URL
    const recentCandidates = items.filter((item) =>
      isReleasedWithinYears(item.thumbnail || item.thumbnailImageUrl, years)
    );

    if (recentCandidates.length > 0) {
      // Step 2: Batch like count query
      const ids = recentCandidates.map((it) => it.goodsNo);
      const likesMap = await fetchLikeCountsBatch(ids, fetchFn);

      for (const item of recentCandidates) {
        const likeCount = likesMap.get(item.goodsNo) ?? 0;
        if (likeCount >= minLikes) {
          const couponPrice = item.finalPrice ?? item.couponPrice ?? item.price ?? item.normalPrice;
          const normalPrice = item.normalPrice ?? item.price ?? couponPrice;
          const salePrice = item.price ?? couponPrice;
          const isRestrictedUsePoint = Boolean(item.isRestrictedUsePoint ?? item.isRestictedUsePoint);

          discovered.push({
            goodsNo: Number(item.goodsNo),
            goodsName: item.goodsName || '',
            brandName: item.brandName || item.brand || '',
            url: item.goodsLinkUrl || `https://www.musinsa.com/products/${item.goodsNo}`,
            imageUrl: item.thumbnail || item.thumbnailImageUrl || '',
            normalPrice,
            salePrice,
            couponPrice,
            estimatedMyPrice: estimateMemberPrice(couponPrice, isRestrictedUsePoint),
            likeCount,
            isSoldOut: Boolean(item.isSoldOut),
            source: 'discovery',
          });

          if (discovered.length >= limit) break;
        }
      }
    }

    if (!pagination?.hasNext || !pagination?.nextPageUrl) {
      break;
    }

    currentUrl = pagination.nextPageUrl;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return discovered;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/discovery.test.js`
Expected: PASS (all 5 subtests pass).
Run: `npm test`
Expected: PASS (all 32 tests across 11 suites pass).

- [ ] **Step 5: Commit**

```bash
git add src/discovery.js tests/discovery.test.js
git commit -m "feat(discovery): add catalog discovery engine and member price estimation model"
```

---

### Task 3: Collector Integration & Estimated Price Tracking (`src/collector.js`)

**Files:**
- Modify: `src/collector.js`
- Test: `tests/collector-parallel.test.js`

**Interfaces:**
- Consumes:
  - `estimateMemberPrice` from `./discovery.js`
  - `recordPriceLog`, `updateLowestEstimatedPrice` from `./db.js`
- Produces:
  - `fetchProductPriceInfo` returns `{ ..., estimatedMyPrice, couponPrice, isRestrictedUsePoint }`
  - `collectPricesForActiveItems` accepts `{ items, source, ... }` option.
  - OpenCLI batching is strictly filtered to `activeItems.filter(it => it.source === 'like')`.
  - Discovered items (`source === 'discovery'`) bypass OpenCLI and evaluate like-for-like price drop on `estimatedMyPrice` against `prevPriceLog.estimated_my_price`.

- [ ] **Step 1: Add unit test in `tests/collector-parallel.test.js`**

Add within the `describe('Parallel Collector & Circuit Breaker', () => { ... })` block in `tests/collector-parallel.test.js`:
```javascript
  test('fetchProductPriceInfo returns estimatedMyPrice based on couponPrice and points rule without live network', async () => {
    const mockNextData = {
      props: {
        pageProps: {
          dehydratedState: {
            queries: [
              {
                queryKey: ['Detail', 999999],
                state: {
                  data: {
                    data: {
                      goodsNm: 'Test Jacket',
                      brand: 'Test Brand',
                      isRestictedUsePoint: false,
                      goodsPrice: {
                        normalPrice: 100000,
                        salePrice: 80000,
                        couponPrice: 70000,
                        finalPrice: 70000,
                        finalDiscount: 30,
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => `<script id="__NEXT_DATA__">${JSON.stringify(mockNextData)}</script>`,
    });

    try {
      const info = await fetchProductPriceInfo(999999);
      assert.equal(info.couponPrice, 70000);
      assert.equal(info.estimatedMyPrice, 63147); // 70,000 * 0.9021 = 63,147
      assert.equal(info.myPrice, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('collectPricesForActiveItems strictly restricts OpenCLI batching to VIP items (source="like")', async () => {
    const mixedItems = [
      { goods_no: 101, goods_name: 'VIP Item', source: 'like', status: 'ACTIVE' },
      { goods_no: 201, goods_name: 'Discovered Item', source: 'discovery', status: 'ACTIVE' },
    ];

    const mockDb = {
      getActiveItems: () => mixedItems,
      getItem: (id) => mixedItems.find((it) => it.goods_no === id),
      getLatestPrice: () => null,
      updateItemDetails: () => {},
      updateItemStatus: () => {},
      updateLowestPrice: () => {},
      updateLowestEstimatedPrice: () => {},
      recordPriceLog: () => {},
      recordDailyRun: () => {},
    };

    const executedCommands = [];
    const mockExec = (cmd) => {
      executedCommands.push(cmd);
      return JSON.stringify([{ goodsNo: 101, myPrice: 18000 }]);
    };

    const mockFetch = async (goodsNo) => ({
      goodsNo,
      goodsName: 'Product',
      brandName: 'Brand',
      normalPrice: 20000,
      salePrice: 20000,
      couponPrice: 20000,
      estimatedMyPrice: 18042,
      myPrice: null,
      isSoldOut: false,
      discontinued: false,
    });

    const results = await collectPricesForActiveItems({
      concurrency: 1,
      delayMs: 0,
      dbInstance: mockDb,
      execFn: mockExec,
      fetchFn: mockFetch,
    });

    assert.equal(results.items.length, 2);
    // OpenCLI command must ONLY contain VIP goodsNo 101, NOT 201!
    assert.equal(executedCommands.length, 1);
    assert.ok(executedCommands[0].includes('101'));
    assert.ok(!executedCommands[0].includes('201'), 'Discovery items must not be passed to OpenCLI');
  });
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test tests/collector-parallel.test.js`
Expected: FAIL until `collector.js` is updated.

- [ ] **Step 3: Update `src/collector.js`**

1. Import `estimateMemberPrice` from `./discovery.js`.
2. In `fetchProductPriceInfo`:
   - Extract `isRestrictedUsePoint = Boolean(detail.isRestrictedUsePoint ?? detail.isRestictedUsePoint);`
   - Calculate `estimatedMyPrice = estimateMemberPrice(couponPrice, isRestrictedUsePoint);`
   - Return `{ ..., couponPrice, estimatedMyPrice, isRestrictedUsePoint }`.
3. In `collectPricesForActiveItems({ concurrency = 3, delayMs = 250, onProgress = null, openCliTimeoutMs = 25000, openCliChunkSize = 2, dbInstance = db, execFn = execSync, fetchFn = fetchProductPriceInfo, items = null, source = null })`:
   - Determine `activeItems`:
     ```javascript
     let activeItems;
     if (items) {
       activeItems = items;
     } else if (source === 'discovery') {
       activeItems = dbInstance.getDiscoveredActiveItems ? dbInstance.getDiscoveredActiveItems() : [];
     } else if (source === 'like') {
       activeItems = dbInstance.getActiveVipItems ? dbInstance.getActiveVipItems() : [];
     } else {
       activeItems = dbInstance.getActiveItems();
     }
     ```
   - Filter OpenCLI chunking exclusively to VIP items (`source !== 'discovery'`):
     ```javascript
     const vipItems = activeItems.filter((it) => it.source !== 'discovery');
     const vipGoodsNos = vipItems.map((it) => it.goods_no);

     if (vipGoodsNos.length > 0 && !circuitBreakerTriggered) {
       // Chunk only vipGoodsNos
       for (let i = 0; i < vipGoodsNos.length; i += openCliChunkSize) {
         ...
       }
     }
     ```
   - Lowest price tracking for both VIP and discovery catalog items (executed BEFORE price drop check):
     ```javascript
     const hasNewLowestMyPrice =
       priceInfo.myPrice &&
       (!item.lowest_my_price || priceInfo.myPrice < item.lowest_my_price);
     const hasNewLowestSalePrice =
       !priceInfo.myPrice &&
       priceInfo.salePrice &&
       (!item.lowest_sale_price || priceInfo.salePrice < item.lowest_sale_price);
     const hasNewLowestEstimated =
       item.source === 'discovery' &&
       priceInfo.estimatedMyPrice &&
       (!item.lowest_estimated_price || priceInfo.estimatedMyPrice < item.lowest_estimated_price);

     if (hasNewLowestMyPrice) {
       dbInstance.updateLowestPrice(item.goods_no, priceInfo.myPrice, 'my');
     } else if (hasNewLowestSalePrice) {
       dbInstance.updateLowestPrice(item.goods_no, priceInfo.salePrice, 'sale');
     }
     if (hasNewLowestEstimated && dbInstance.updateLowestEstimatedPrice) {
       dbInstance.updateLowestEstimatedPrice(item.goods_no, priceInfo.estimatedMyPrice, today);
     }
     ```
   - In worker iteration, detect price drops like-for-like:
     ```javascript
     if (prevPriceLog) {
       if (item.source === 'discovery') {
         // Like-for-like comparison for estimated prices
         const prevEst = prevPriceLog.estimated_my_price;
         if (prevEst && priceInfo.estimatedMyPrice && priceInfo.estimatedMyPrice < prevEst) {
           const dropAmount = prevEst - priceInfo.estimatedMyPrice;
           const dropRate = Math.round((dropAmount / prevEst) * 100);
           results.priceDropped.push({
             item,
             priceType: 'estimated',
             prevPrice: prevEst,
             currentPrice: priceInfo.estimatedMyPrice,
             dropAmount,
             dropRate,
             isNewLowest: Boolean(hasNewLowestEstimated && item.lowest_estimated_price),
           });
         }
       } else if (priceInfo.myPrice !== null) {
         // Authenticated myPrice comparison (existing VIP logic)
         ...
       } else if (priceInfo.salePrice !== null) {
         // Public salePrice fallback for VIP items (existing logic)
         ...
       }
     }
     ```
   - Record in `price_logs`:
     ```javascript
     dbInstance.recordPriceLog({
       goods_no: item.goods_no,
       date: today,
       normal_price: priceInfo.normalPrice,
       sale_price: priceInfo.salePrice,
       coupon_price: priceInfo.couponPrice,
       sale_rate: priceInfo.saleRate || 0,
       my_price: priceInfo.myPrice,
       estimated_my_price: priceInfo.estimatedMyPrice,
       coupon_name: priceInfo.couponName,
       coupon_discount: priceInfo.couponDiscount,
       member_discount: 0,
       point_discount: 0,
       is_sold_out: priceInfo.isSoldOut,
     });
     ```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/collector-parallel.test.js`
Expected: PASS.
Run: `npm test`
Expected: PASS (all tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/collector.js tests/collector-parallel.test.js
git commit -m "feat(collector): isolate OpenCLI to VIP items and add estimated price drop detection"
```

---

### Task 4: CLI Commands, VIP Promotion & Hot Deals Summary (`src/cli.js`, `src/notifier.js`, `src/sync.js`)

**Files:**
- Modify: `src/cli.js`
- Modify: `src/notifier.js`
- Modify: `src/sync.js`
- Test: `tests/cli-discovery.test.js`

**Interfaces:**
- Consumes:
  - `discoverCategoryGoods` from `./discovery.js`
  - `promoteItemToLike` from `./db.js`
- Produces:
  - CLI command: `clot discover [--category <codes>] [--limit <n>] [--min-likes <n>]`
  - CLI option: `clot daily --with-discovery`
  - CLI behavior: `clot track` (batch) preserved; `clot track <goodsNo>` auto-promotes `source='discovery'` to `source='like'`
  - Status/List display: items show `[VIP]` vs `[탐색]` and display `lowest_estimated_price`
  - Sync behavior: `src/sync.js` promotes remote liked discovery items to `'like'`
  - Notifier: `formatHotDealsSummary(items)` for Top 5 discovery deals.

- [ ] **Step 1: Write tests in `tests/cli-discovery.test.js`**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClotDatabase } from '../src/db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('CLI Discovery Integration & VIP Promotion', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-cli-disc-'));
  const testDbPath = path.join(tempDir, 'test.db');
  const db = new ClotDatabase(testDbPath);

  t.after(() => {
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test('track command promotes discovery item to like', () => {
    db.upsertItem({
      goods_no: 5555,
      goods_name: 'Trendy Trench Coat',
      source: 'discovery',
      url: 'https://www.musinsa.com/products/5555',
    });

    const before = db.getItem(5555);
    assert.equal(before.source, 'discovery');

    // Simulate promotion
    db.promoteItemToLike(5555);

    const after = db.getItem(5555);
    assert.equal(after.source, 'like');
  });

  await t.test('discovered item price logging records initial estimated prices during ingestion', () => {
    db.upsertItem({
      goods_no: 7777,
      goods_name: 'Fresh Shirt',
      source: 'discovery',
      url: 'https://www.musinsa.com/products/7777',
    });

    db.recordPriceLog({
      goods_no: 7777,
      date: '2026-09-05',
      normal_price: 50000,
      sale_price: 45000,
      coupon_price: 40000,
      sale_rate: 20,
      my_price: null,
      estimated_my_price: 36084,
      is_sold_out: 0,
    });
    db.updateLowestEstimatedPrice(7777, 36084, '2026-09-05');

    const item = db.getItem(7777);
    assert.equal(item.lowest_estimated_price, 36084);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/cli-discovery.test.js`
Expected: PASS.

- [ ] **Step 3: Implement CLI commands in `src/cli.js`, Notifier hot deals in `src/notifier.js`, and promotion in `src/sync.js`**

1. In `src/cli.js`:
   - Add `case 'discover':`
     - Parse `--category` (default `'001,002,003,007,008'`: 상의, 아우터, 바지, 신발, 가방).
     - Parse `--limit` (default `100` per category, total 500 max).
     - Parse `--min-likes` (default `1000`).
     - Calls `discoverCategoryGoods` for each category.
     - Upserts items to DB with `source: 'discovery'`, records initial `price_logs` with `coupon_price` and `estimated_my_price`, and initializes `lowest_estimated_price`.
     - Prints summary table showing count of newly discovered items, average discount, and estimated price ranges.
   - In `case 'track': case 'update':`:
      - Distinguish single promotion from batch tracking without calling undefined functions:
        ```javascript
        const singleTarget = positional[0] ? Number(positional[0].replace(/\D/g, '')) : null;
        if (singleTarget) {
          const existing = db.getItem(singleTarget);
          if (existing && existing.source === 'discovery') {
            db.promoteItemToLike(singleTarget);
            console.log(`✨ [VIP 승격] 탐색 카탈로그 상품 ${singleTarget}이(가) VIP 관심 상품으로 승격되었습니다.`);
            exportDataForGit();
            break;
          } else if (!existing) {
            console.log(`상품 ${singleTarget}을(를) 추적 목록에 추가합니다.`);
            await handleWatch([String(singleTarget)]);
            break;
          }
        }
        // If no single target or item is already VIP, proceed to batch price collection across active items
        const concurrency = parseConcurrency(flags.concurrency, 3);
        console.log(`🔍 Fetching latest prices (concurrency: ${concurrency})...`);
        const results = await collectPricesForActiveItems({
          concurrency,
          onProgress: ({ current, total, item, priceInfo }) => {
            const displayPrice = priceInfo.isSoldOut
              ? '품절'
              : `${(priceInfo.myPrice || priceInfo.salePrice || 0).toLocaleString()}원`;
            process.stdout.write(
              `\r  [${current}/${total}] ${(item.brand_name || '-').slice(0, 15)} - ${displayPrice}`.padEnd(65)
            );
          },
        });
        console.log('\n');
        console.log(`✅ Collection complete in ${(results.durationMs / 1000).toFixed(1)}s.`);
        console.log(`  • Success: ${results.success} / Failed: ${results.failed}`);
        console.log(`  • Price Drops: ${results.priceDropped.length}`);
        console.log(`  • Restocks: ${results.restocked.length}`);
        exportDataForGit();
        break;
        ```
   - In `handleDailyRun`:
     - Run VIP items first via `collectPricesForActiveItems({ source: 'like' })`.
     - If `flags['with-discovery']` is truthy, run `handleDiscover()` or collect prices for `db.getDiscoveredActiveItems()`.
   - Update `case 'status': case 'list':` and `exportDataForGit`:
     - Prefix items with `[VIP]` or `[탐색]`.
     - Show `lowest_my_price || lowest_estimated_price || lowest_sale_price`.
   - Update `showHelp()` text to include `clot discover` and `--with-discovery`.

2. In `src/notifier.js`:
   - Add `formatHotDealsSummary(discoveryItems)`:
     - Sorts discovered items by discount percentage descending.
     - Formats top 5 items into Telegram HTML format:
       `<b>🔥 오늘의 탐색 핫딜 Top 5 (발매 2년 이내 & 좋아요 1,000+)</b>`
       `1. <b>[브랜드]</b> 상품명 - 정가 대비 <b>XX%</b> 할인 (추정회원가: <b>XX,XXX원</b>)`
       `   • <a href="https://www.musinsa.com/products/...">상품 바로가기</a>`

3. In `src/sync.js`:
   - When remote liked items are processed:
     ```javascript
     if (existing) {
       if (existing.source === 'discovery') {
         db.promoteItemToLike(goodsNo);
         summary.promotedItems = summary.promotedItems || [];
         summary.promotedItems.push(existing);
       }
       ...
     }
     ```

- [ ] **Step 4: Run test suite to verify all tests pass**

Run: `node --test tests/cli-discovery.test.js`
Run: `npm test`
Expected: All suites PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js src/notifier.js src/sync.js tests/cli-discovery.test.js
git commit -m "feat(cli): add clot discover command, VIP promotion, and hot deals reporting"
```

---

## Plan Review Checklist
- [x] Zero external npm dependencies
- [x] Strict price segregation (`my_price` vs `estimated_my_price`)
- [x] OpenCLI browser isolation (strictly limited to `source='like'`)
- [x] Like-for-like price drop comparison for estimated prices
- [x] Relative URL resolution in fetch pagination
- [x] Idempotent price log recording (UPDATE on existing date)
- [x] Preserved batch `clot track` behavior alongside `clot track <goodsNo>` promotion
- [x] Date filtering from CDN URL (`YYYYMMDD`)
- [x] Batch like query endpoint (`/like/api/v2/liketypes/goods/counts`)
- [x] Bounded Capping (5 categories x 100 items = 500 items max)
- [x] All test commands exact with expected outcomes
