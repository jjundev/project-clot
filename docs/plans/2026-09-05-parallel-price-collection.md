# Parallel Price Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accelerate daily price tracking from 50–70 minutes down to ~10–15 seconds by implementing a zero-dependency concurrency pool, an OpenCLI circuit breaker to prevent timeout deadlocks, and SQLite WAL optimization.

**Architecture:** Create a standalone concurrency utility (`src/pool.js`) providing bounded concurrent execution (`mapConcurrent`). Upgrade `src/collector.js` to process active items using this pool (concurrency = 4), add a circuit breaker for `opencli musinsa my-prices` batch calls (fail-fast after 2 consecutive timeouts or parse errors), and configure SQLite (`src/db.js`) with `WAL` journal mode and a busy timeout. Enforce strict rate-limit clamping (1–5, default 4) in CLI arguments.

**Tech Stack:** Node.js (v24.17.0, ESM, `node:sqlite`, `node:test`, Native `fetch`). Zero external npm dependencies.

## Global Constraints

- Zero external npm dependencies: use only Node.js native standard libraries (`node:sqlite`, `node:child_process`, `node:test`, `fetch`).
- Strict rate limit protection: default concurrency must be bounded between 1 and 5 (default 4) to avoid triggering Musinsa WAF/bot defenses or HTTP 429. Validate and clamp all CLI inputs.
- Preserve result order and data integrity: the returned `results.items` list in `collectPricesForActiveItems` must strictly maintain index correlation with `activeItems`.
- Maintain existing database schema and API contracts (`recordPriceLog`, `recordDailyRun`, `updateItemStatus`, `updateLowestPrice`).
- All tests must pass via `npm test` (`node --test 'tests/*.test.js'`).

---

## File Structure

- **`src/pool.js` [NEW]**: Lightweight zero-dependency concurrency helper `mapConcurrent(items, limit, fn)`. Runs tasks with bounded parallel workers, supports `(items, fn)` shorthand, preserves input order, sanitizes concurrency inputs, and retains the root error.
- **`tests/pool.test.js` [NEW]**: Unit tests for `mapConcurrent`, verifying concurrency ceiling, preservation of order, rejection handling, empty list behavior, and NaN/invalid concurrency protection.
- **`src/db.js` [MODIFY]**: Enable `PRAGMA journal_mode = WAL;` and `PRAGMA busy_timeout = 5000;` in `initSchema()`.
- **`tests/db-pragma.test.js` [NEW]**: Unit tests validating that `ClotDatabase` sets `WAL` journal mode and `busy_timeout = 5000`.
- **`src/collector.js` [MODIFY]**: 
  - Integrate `mapConcurrent` into `collectPricesForActiveItems` with concurrency 4 and index-correlated `results.items`.
  - Implement Circuit Breaker for `opencli musinsa my-prices` (reduce chunk timeout from 45s to 15s; count timeouts and unparseable outputs as failures; abort subsequent OpenCLI chunks after 2 consecutive failures).
  - Update `onProgress` reporting to handle out-of-order completion safely with an atomic completed counter.
- **`tests/collector-parallel.test.js` [NEW]**: Integration test validating parallel collection logic, result order preservation, circuit breaker abort mechanism, and fallback behavior.
- **`src/cli.js` [MODIFY]**: Add `parseConcurrency` helper (clamped between 1 and 5, default 4), wire to `clot daily` and `clot track` with progress reporting, preserving `case 'update'` and `exportDataForGit()`.
- **`tests/cli-concurrency.test.js` [NEW]**: Unit tests for `parseConcurrency` validating clamping, default fallback, and CLI flag handling.

---

## Tasks

### Task 1: Zero-Dependency Concurrency Pool (`src/pool.js`) & Tests

**Files:**
- Create: `src/pool.js`
- Test: `tests/pool.test.js`

**Interfaces:**
- Consumes: Native ES2024 JavaScript Promises & Arrays
- Produces: `mapConcurrent<T, R>(items: T[], concurrency: number, iteratorFn: (item: T, index: number) => Promise<R>): Promise<R[]>`

- [ ] **Step 1: Write failing test in `tests/pool.test.js`**

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mapConcurrent } from '../src/pool.js';

describe('Concurrency Pool (mapConcurrent)', () => {
  test('processes all items and preserves original input ordering', async () => {
    const items = [100, 20, 50, 10]; // delays in ms
    const results = await mapConcurrent(items, 2, async (delay, index) => {
      await new Promise((r) => setTimeout(r, delay));
      return { index, delay };
    });

    assert.equal(results.length, 4);
    assert.deepEqual(results, [
      { index: 0, delay: 100 },
      { index: 1, delay: 20 },
      { index: 2, delay: 50 },
      { index: 3, delay: 10 },
    ]);
  });

  test('supports (items, iteratorFn) shorthand with default concurrency 4', async () => {
    const items = [1, 2, 3];
    const results = await mapConcurrent(items, async (x) => x * 10);
    assert.deepEqual(results, [10, 20, 30]);
  });

  test('enforces concurrency limit strictly', async () => {
    let activeWorkers = 0;
    let maxActiveWorkers = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapConcurrent(items, 3, async () => {
      activeWorkers++;
      maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
      await new Promise((r) => setTimeout(r, 20));
      activeWorkers--;
    });

    assert.ok(maxActiveWorkers <= 3, `Expected max concurrency <= 3, got ${maxActiveWorkers}`);
    assert.ok(maxActiveWorkers >= 2, `Expected concurrency to reach pool capacity, got ${maxActiveWorkers}`);
  });

  test('handles empty arrays without error', async () => {
    const results = await mapConcurrent([], 4, async () => 1);
    assert.deepEqual(results, []);
  });

  test('guards against NaN or invalid concurrency input with a safe fallback', async () => {
    const items = [1, 2];
    const results = await mapConcurrent(items, 'invalid', async (x) => x * 2);
    assert.deepEqual(results, [2, 4]);
  });

  test('propagates first rejection and preserves root cause', async () => {
    const items = [1, 2, 3];
    await assert.rejects(
      async () => {
        await mapConcurrent(items, 2, async (x) => {
          if (x === 2) throw new Error('Worker failure');
          if (x === 3) throw new Error('Secondary failure');
          return x;
        });
      },
      { message: 'Worker failure' }
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pool.test.js`
Expected: FAIL with `Cannot find module '../src/pool.js'`

- [ ] **Step 3: Implement `src/pool.js`**

```javascript
/**
 * Concurrently maps an array of items using an asynchronous function with a bounded concurrency limit.
 * Preserves the original array order of results.
 *
 * @template T, R
 * @param {T[]} items - Array of items to process
 * @param {number|((item: T, index: number) => Promise<R>)} concurrency - Max concurrent tasks, or iteratorFn shorthand
 * @param {(item: T, index: number) => Promise<R>} [iteratorFn] - Async function to run for each item
 * @returns {Promise<R[]>} - Resolves with array of results in the original order
 */
export async function mapConcurrent(items, concurrency = 4, iteratorFn) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  let fn = iteratorFn;
  let maxConcurrency = concurrency;

  if (typeof concurrency === 'function') {
    fn = concurrency;
    maxConcurrency = 4;
  }

  if (typeof fn !== 'function') {
    throw new TypeError('iteratorFn must be a function');
  }

  const parsedConcurrency = Number(maxConcurrency);
  const safeConcurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : 4;
  const limit = Math.max(1, Math.min(Math.floor(safeConcurrency), items.length));

  const results = new Array(items.length);
  let currentIndex = 0;
  let hasError = false;
  let firstError = null;

  const workers = Array.from({ length: limit }, async () => {
    while (currentIndex < items.length) {
      if (hasError) break;
      const idx = currentIndex++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        if (!hasError) {
          hasError = true;
          firstError = err;
        }
        break;
      }
    }
  });

  await Promise.all(workers);

  if (hasError) {
    throw firstError;
  }

  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/pool.test.js`
Expected: PASS (6/6 tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/pool.js tests/pool.test.js
git commit -m "feat(pool): add zero-dependency bounded concurrency helper mapConcurrent"
```

---

### Task 2: SQLite WAL Mode & Busy Timeout Configuration (`src/db.js`) & Tests

**Files:**
- Modify: `src/db.js:23-26`
- Create: `tests/db-pragma.test.js`

**Interfaces:**
- Consumes: `DatabaseSync.exec()`
- Produces: SQLite WAL mode journal and 5000ms busy timeout for concurrent read/write transactions

- [ ] **Step 1: Write failing test in `tests/db-pragma.test.js`**

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ClotDatabase } from '../src/db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('SQLite Database Pragmas', () => {
  test('initializes schema with WAL journal_mode and busy_timeout', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-test-db-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    let testDb;

    try {
      testDb = new ClotDatabase(testDbPath);
      const journalMode = testDb.db.prepare('PRAGMA journal_mode;').get();
      const busyTimeout = testDb.db.prepare('PRAGMA busy_timeout;').get();

      assert.equal(journalMode.journal_mode.toLowerCase(), 'wal');
      assert.equal(busyTimeout.timeout, 5000);
    } finally {
      if (testDb) {
        try { testDb.close(); } catch {}
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/db-pragma.test.js`
Expected: FAIL (`journal_mode` is `delete`, not `wal`)

- [ ] **Step 3: Add PRAGMA configurations to `src/db.js`**

Modify `src/db.js` inside `initSchema()` right at the top of the `this.db.exec()` block:

```javascript
  initSchema() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS items (
        goods_no INTEGER PRIMARY KEY,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/db-pragma.test.js`
Expected: PASS

- [ ] **Step 5: Run existing test suite to verify no regressions**

Run: `npm test`
Expected: PASS (all tests pass)

- [ ] **Step 6: Commit**

```bash
git add src/db.js tests/db-pragma.test.js
git commit -m "perf(db): enable SQLite WAL mode and busy timeout for concurrent operations"
```

---

### Task 3: OpenCLI Circuit Breaker & Parallel Collector (`src/collector.js`) & Tests

**Files:**
- Modify: `src/collector.js`
- Create: `tests/collector-parallel.test.js`

**Interfaces:**
- Consumes: `mapConcurrent` from `./pool.js`, `db` from `./db.js`, `getExecOptions` from `./env.js`
- Produces: `collectPricesForActiveItems({ concurrency = 4, delayMs = 100, onProgress = null, openCliTimeoutMs = 15000, dbInstance = db, execFn = execSync, fetchFn = fetchProductPriceInfo } = {}): Promise<results>`

- [ ] **Step 1: Write failing test in `tests/collector-parallel.test.js`**

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collectPricesForActiveItems } from '../src/collector.js';

describe('Parallel Collector & Circuit Breaker', () => {
  test('preserves exact order in results.items and executes fallback when OpenCLI fails', async () => {
    const mockActiveItems = [
      { goods_no: 101, goods_name: 'Product A', brand_name: 'Brand 1', status: 'ACTIVE' },
      { goods_no: 102, goods_name: 'Product B', brand_name: 'Brand 2', status: 'ACTIVE' },
      { goods_no: 103, goods_name: 'Product C', brand_name: 'Brand 3', status: 'ACTIVE' },
      { goods_no: 104, goods_name: 'Product D', brand_name: 'Brand 4', status: 'ACTIVE' },
    ];

    const mockDb = {
      getActiveItems: () => mockActiveItems,
      getItem: (id) => mockActiveItems.find((it) => it.goods_no === id),
      getLatestPrice: () => null,
      updateItemDetails: () => {},
      updateItemStatus: () => {},
      updateLowestPrice: () => {},
      recordPriceLog: () => {},
      recordDailyRun: () => {},
    };

    let execCallCount = 0;
    const mockExec = () => {
      execCallCount++;
      throw new Error('Simulated OpenCLI timeout (ETIMEDOUT)');
    };

    // Item 101 takes longer (40ms) than Item 104 (5ms) to thoroughly test order preservation
    const mockFetch = async (goodsNo) => {
      const delay = goodsNo === 101 ? 40 : 5;
      await new Promise((r) => setTimeout(r, delay));
      return {
        goodsNo,
        goodsName: `Name ${goodsNo}`,
        brandName: 'Brand',
        normalPrice: 20000,
        salePrice: 15000,
        myPrice: 15000,
        isSoldOut: false,
        discontinued: false,
      };
    };

    const progressReports = [];
    const results = await collectPricesForActiveItems({
      concurrency: 2,
      delayMs: 0,
      openCliTimeoutMs: 1000,
      dbInstance: mockDb,
      execFn: mockExec,
      fetchFn: mockFetch,
      onProgress: (p) => progressReports.push(p.current),
    });

    // 1. Verify OpenCLI was attempted once for this 4-item chunk and gracefully failed
    assert.equal(execCallCount, 1);

    // 2. Verify result order strictly matches input order [101, 102, 103, 104]
    assert.equal(results.items.length, 4);
    assert.equal(results.items[0].goodsNo, 101);
    assert.equal(results.items[1].goodsNo, 102);
    assert.equal(results.items[2].goodsNo, 103);
    assert.equal(results.items[3].goodsNo, 104);

    assert.equal(results.success, 4);
    assert.equal(results.failed, 0);

    // 3. Verify progress reports incremented atomically up to 4
    assert.equal(progressReports.length, 4);
    assert.equal(progressReports[progressReports.length - 1], 4);
  });

  test('circuit breaker aborts subsequent OpenCLI chunks after 2 consecutive failures', async () => {
    const mockActiveItems = Array.from({ length: 16 }, (_, i) => ({
      goods_no: 1000 + i,
      goods_name: `Item ${i}`,
      brand_name: 'Brand',
      status: 'ACTIVE',
    }));

    const mockDb = {
      getActiveItems: () => mockActiveItems,
      getLatestPrice: () => null,
      updateItemDetails: () => {},
      updateItemStatus: () => {},
      updateLowestPrice: () => {},
      recordPriceLog: () => {},
      recordDailyRun: () => {},
    };

    let openCliAttempts = 0;
    const mockExec = () => {
      openCliAttempts++;
      throw new Error('Timeout');
    };

    const mockFetch = async (goodsNo) => ({
      goodsNo,
      goodsName: `Name ${goodsNo}`,
      brandName: 'Brand',
      normalPrice: 10000,
      salePrice: 9000,
      myPrice: 9000,
      isSoldOut: false,
      discontinued: false,
    });

    const results = await collectPricesForActiveItems({
      concurrency: 4,
      delayMs: 0,
      dbInstance: mockDb,
      execFn: mockExec,
      fetchFn: mockFetch,
    });

    // 16 items / 4 chunk size = 4 chunks.
    // Circuit breaker must abort after exactly 2 consecutive failures.
    assert.equal(openCliAttempts, 2, `Expected OpenCLI attempts to be capped at 2, got ${openCliAttempts}`);
    assert.equal(results.success, 16);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/collector-parallel.test.js`
Expected: FAIL because `collectPricesForActiveItems` does not yet accept DI parameters or have circuit breaker.

- [ ] **Step 3: Update `src/collector.js`**

1. Import `mapConcurrent`:
```javascript
import { mapConcurrent } from './pool.js';
```

2. Refactor `collectPricesForActiveItems` implementation:
```javascript
export async function collectPricesForActiveItems({
  concurrency = 4,
  delayMs = 100,
  onProgress = null,
  openCliTimeoutMs = 15000,
  dbInstance = db,
  execFn = execSync,
  fetchFn = fetchProductPriceInfo,
} = {}) {
  const activeItems = dbInstance.getActiveItems();
  const today = new Date().toISOString().split('T')[0];

  const results = {
    date: today,
    total: activeItems.length,
    success: 0,
    failed: 0,
    priceDropped: [],
    restocked: [],
    newlySoldOut: [],
    discontinued: [],
    items: [],
  };

  const startTime = Date.now();

  // Try batching via OpenCLI my-prices first with Circuit Breaker
  let openCliPriceMap = new Map();
  const goodsNos = activeItems.map((it) => it.goods_no);
  let consecutiveOpenCliErrors = 0;

  for (let i = 0; i < goodsNos.length; i += 4) {
    if (consecutiveOpenCliErrors >= 2) {
      console.warn(
        `⚡ [OpenCLI CircuitBreaker] 2 consecutive OpenCLI batch failures/timeouts. Skipping remaining ${goodsNos.length - i} items and proceeding to fast direct parser.`
      );
      break;
    }

    const chunk = goodsNos.slice(i, i + 4).join(',');
    try {
      const raw = execFn(
        `opencli musinsa my-prices "${chunk}" -f json`,
        getExecOptions({
          encoding: 'utf-8',
          timeout: openCliTimeoutMs,
        })
      );
      const jsonStart = raw ? raw.indexOf('[') : -1;
      if (jsonStart !== -1) {
        const list = JSON.parse(raw.slice(jsonStart));
        for (const it of list) {
          openCliPriceMap.set(Number(it.goodsNo), {
            normalPrice: Number(String(it.normalPrice).replace(/[^0-9]/g, '')) || null,
            salePrice: Number(String(it.salePrice).replace(/[^0-9]/g, '')) || null,
            couponPrice: Number(String(it.couponPrice).replace(/[^0-9]/g, '')) || null,
            myPrice: Number(String(it.myPrice).replace(/[^0-9]/g, '')) || null,
            isSoldOut: it.status === '품절',
          });
        }
        consecutiveOpenCliErrors = 0; // reset on success
      } else {
        consecutiveOpenCliErrors++;
        console.warn(`[OpenCLI Notice] Browser bridge returned non-JSON output (${consecutiveOpenCliErrors}/2).`);
      }
    } catch (err) {
      consecutiveOpenCliErrors++;
      console.warn(`[OpenCLI Notice] Browser bridge batch error (${consecutiveOpenCliErrors}/2): ${err.message}`);
    }
  }

  let completedCount = 0;
  const orderedItems = new Array(activeItems.length);

  await mapConcurrent(activeItems, concurrency, async (item, itemIndex) => {
    try {
      let priceInfo;
      const liveData = openCliPriceMap.get(item.goods_no);

      if (liveData && liveData.myPrice) {
        priceInfo = {
          goodsNo: item.goods_no,
          goodsName: item.goods_name,
          brandName: item.brand_name,
          normalPrice: liveData.normalPrice,
          salePrice: liveData.salePrice,
          couponPrice: liveData.couponPrice,
          myPrice: liveData.myPrice,
          couponName: '나의 할인가',
          couponDiscount: liveData.couponPrice && liveData.salePrice ? liveData.salePrice - liveData.couponPrice : 0,
          isSoldOut: liveData.isSoldOut,
          discontinued: false,
        };
      } else {
        priceInfo = await fetchFn(item.goods_no);
      }

      if (priceInfo.discontinued) {
        dbInstance.updateItemStatus(item.goods_no, 'DISCONTINUED');
        results.discontinued.push(item);
        completedCount++;
        if (onProgress) {
          onProgress({ current: completedCount, total: activeItems.length, item, priceInfo });
        }
        return;
      }

      if (priceInfo.goodsName) {
        dbInstance.updateItemDetails(item.goods_no, priceInfo.goodsName, priceInfo.brandName, priceInfo.imageUrl || item.image_url);
      }

      // Check status changes (Restock / Soldout)
      const prevPriceLog = dbInstance.getLatestPrice(item.goods_no);
      const wasSoldOut = prevPriceLog ? Boolean(prevPriceLog.is_sold_out) : item.status === 'SOLDOUT';

      if (wasSoldOut && !priceInfo.isSoldOut) {
        dbInstance.updateItemStatus(item.goods_no, 'ACTIVE');
        results.restocked.push({ item, priceInfo });
      } else if (!wasSoldOut && priceInfo.isSoldOut) {
        dbInstance.updateItemStatus(item.goods_no, 'SOLDOUT');
        results.newlySoldOut.push({ item, priceInfo });
      }

      // Update lowest price tracking
      let lowestMyPrice = item.lowest_my_price;
      let lowestSalePrice = item.lowest_sale_price;
      let isNewLowest = false;

      if (!lowestMyPrice || (priceInfo.myPrice && priceInfo.myPrice < lowestMyPrice)) {
        lowestMyPrice = priceInfo.myPrice;
        lowestSalePrice = priceInfo.salePrice;
        isNewLowest = Boolean(item.lowest_my_price);
        dbInstance.updateLowestPrice(item.goods_no, lowestMyPrice, lowestSalePrice, today);
      }

      // Check for price drop compared to previous log
      if (prevPriceLog && priceInfo.myPrice && prevPriceLog.my_price) {
        if (priceInfo.myPrice < prevPriceLog.my_price) {
          const dropAmount = prevPriceLog.my_price - priceInfo.myPrice;
          const dropRate = Math.round((dropAmount / prevPriceLog.my_price) * 100);
          results.priceDropped.push({
            item,
            priceInfo,
            prevPrice: prevPriceLog.my_price,
            currentPrice: priceInfo.myPrice,
            dropAmount,
            dropRate,
            isNewLowest,
          });
        }
      }

      // Record in price_logs
      dbInstance.recordPriceLog({
        goods_no: item.goods_no,
        date: today,
        normal_price: priceInfo.normalPrice,
        sale_price: priceInfo.salePrice,
        sale_rate: priceInfo.saleRate || 0,
        my_price: priceInfo.myPrice,
        coupon_name: priceInfo.couponName,
        coupon_discount: priceInfo.couponDiscount,
        member_discount: 0,
        is_sold_out: priceInfo.isSoldOut,
      });

      results.success++;
      orderedItems[itemIndex] = priceInfo;

      completedCount++;
      if (onProgress) {
        onProgress({
          current: completedCount,
          total: activeItems.length,
          item,
          priceInfo,
        });
      }

      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    } catch (err) {
      results.failed++;
      completedCount++;
      console.error(`\n[Error] Failed to collect price for ${item.goods_no} (${item.goods_name}):`, err.message);
    }
  });

  // Preserve index correlation in results.items
  results.items = orderedItems.filter(Boolean);

  const durationMs = Date.now() - startTime;
  results.durationMs = durationMs;

  dbInstance.recordDailyRun({
    date: today,
    total_tracked: results.success,
    price_dropped_count: results.priceDropped.length,
    restocked_count: results.restocked.length,
    duration_ms: durationMs,
  });

  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/collector-parallel.test.js`
Expected: PASS (2/2 tests pass)

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: PASS (all tests pass)

- [ ] **Step 6: Commit**

```bash
git add src/collector.js tests/collector-parallel.test.js
git commit -m "perf(collector): implement bounded parallel price collection and OpenCLI circuit breaker"
```

---

### Task 4: CLI Flag Sanitization & Concurrency Tuning (`src/cli.js`) & Tests

**Files:**
- Modify: `src/cli.js:130-138, 419-424, 464-467`
- Create: `tests/cli-concurrency.test.js`

**Interfaces:**
- Consumes: CLI args from `process.argv`
- Produces: `parseConcurrency(val: any, defaultVal?: number): number` clamped to [1, 5] and wired into `daily` and `track`

- [ ] **Step 1: Write failing test in `tests/cli-concurrency.test.js`**

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseConcurrency } from '../src/cli.js';

describe('CLI Concurrency Parser', () => {
  test('returns default 4 when undefined or null', () => {
    assert.equal(parseConcurrency(undefined), 4);
    assert.equal(parseConcurrency(null), 4);
  });

  test('clamps inputs strictly between 1 and 5 to prevent rate-limiting abuse', () => {
    assert.equal(parseConcurrency(10), 5);
    assert.equal(parseConcurrency(50), 5);
    assert.equal(parseConcurrency(0), 1);
    assert.equal(parseConcurrency(-5), 1);
    assert.equal(parseConcurrency(3), 3);
    assert.equal(parseConcurrency('4'), 4);
  });

  test('guards against boolean flags and NaN strings', () => {
    assert.equal(parseConcurrency(true), 4);
    assert.equal(parseConcurrency('fast'), 4);
    assert.equal(parseConcurrency(''), 4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cli-concurrency.test.js`
Expected: FAIL (`parseConcurrency is not a function`)

- [ ] **Step 3: Implement `parseConcurrency` and update `src/cli.js`**

In `src/cli.js`:
```javascript
export function parseConcurrency(val, defaultVal = 4) {
  if (typeof val === 'boolean' || val === undefined || val === null || val === '') {
    return defaultVal;
  }
  const parsed = Number(val);
  if (!Number.isFinite(parsed) || isNaN(parsed)) {
    return defaultVal;
  }
  // Clamp strictly between 1 and 5 for rate limit safety
  return Math.max(1, Math.min(Math.floor(parsed), 5));
}
```

In `handleDailyRun(flags)`:
```javascript
  const concurrency = parseConcurrency(flags.concurrency, 4);
  console.log(`\n🔍 Fetching latest prices & discounts (concurrency: ${concurrency})...`);
  const results = await collectPricesForActiveItems({
    concurrency,
    onProgress: ({ current, total, item, priceInfo }) => {
      process.stdout.write(
        `\r  [${current}/${total}] ${(item.brand_name || '-').slice(0, 15)} - ${priceInfo.myPrice ? priceInfo.myPrice.toLocaleString() + '원' : '품절'}`.padEnd(65)
      );
    },
  });
```

In `case 'track': case 'update':`:
```javascript
    case 'track':
    case 'update': {
      const concurrency = parseConcurrency(flags.concurrency, 4);
      console.log(`🔍 Fetching latest prices (concurrency: ${concurrency})...`);
      await collectPricesForActiveItems({
        concurrency,
        onProgress: ({ current, total, item, priceInfo }) => {
          process.stdout.write(
            `\r  [${current}/${total}] ${(item.brand_name || '-').slice(0, 15)} - ${priceInfo.myPrice ? priceInfo.myPrice.toLocaleString() + '원' : '품절'}`.padEnd(65)
          );
        },
      });
      console.log('\n');
      exportDataForGit();
      break;
    }
```

Update help text in default case:
```text
  daily [--force] [--concurrency=1-5] Run daily sync & price tracking (default concurrency: 4)
  track [--concurrency=1-5]           Fetch latest prices for all active tracked items
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cli-concurrency.test.js`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: PASS (all tests pass cleanly)

- [ ] **Step 6: Commit**

```bash
git add src/cli.js tests/cli-concurrency.test.js
git commit -m "feat(cli): add safe clamped parseConcurrency and wire to daily and track commands"
```

---

## Verification Plan

### Automated Tests
- Run `npm test` to verify all unit & integration tests pass (`node:test`):
  ```bash
  npm test
  ```
- Verify `tests/pool.test.js` tests bounded concurrency, order preservation, and error propagation.
- Verify `tests/db-pragma.test.js` tests SQLite WAL mode and busy timeout.
- Verify `tests/collector-parallel.test.js` tests OpenCLI circuit breaker and index-correlated results.
- Verify `tests/cli-concurrency.test.js` tests concurrency clamping and sanitization.

### Manual Verification
- Execute `node src/cli.js help` to confirm `--concurrency=1-5` is documented.
- Run `node src/cli.js track --concurrency=4` to observe fast concurrent collection with thread-safe progress output.
