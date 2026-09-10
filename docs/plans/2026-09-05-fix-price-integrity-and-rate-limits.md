# Price Integrity & Rate Limit Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate false price drop/increase alerts by strictly segregating personalized member prices from generic public prices, tuning OpenCLI chunks to 2 items with 25s timeouts, and strengthening HTTP 429 rate limit exponential backoff (4 retries) to achieve 0% collection failure.

**Architecture:** Update `src/collector.js` to preserve price integrity: never mask generic public sale prices as member `myPrice`. Separate comparison logic so `myPrice` drops are only computed when both current and previous logs contain authentic personalized prices; otherwise compare `salePrice`. Tune OpenCLI batching to 2-item chunks with 25s timeouts. Strengthen `fetchProductPriceInfo` with exponential backoff ($2^{\text{attempt}-1} \times \text{backoffBaseMs}$) up to 4 attempts (with injectable `backoffBaseMs`), default `concurrency: 3`, and `delayMs: 250`. Fix CLI progress and notifier displays to check `isSoldOut` before formatting `myPrice || salePrice`.

**Tech Stack:** Node.js (v24.17.0, ESM, `node:sqlite`, `node:test`, Native `fetch`), OpenCLI Musinsa adapter. Zero external npm dependencies.

## Global Constraints

- Zero external npm dependencies: rely solely on Node.js native runtime modules.
- Strict data integrity: public sale prices must never be labeled as member `myPrice`. `myPrice` must be `null` unless authenticated personalized pricing is collected.
- Comparison consistency: price drops on `myPrice` must only be calculated between valid personalized price points, preventing false discount alerts caused by browser timeouts.
- Zero collection failure: retry logic must absorb Musinsa HTTP 429 bursts up to 4 attempts with exponential backoff.
- All tests must pass via `npm test` without artificial sleep delays.

---

## File Structure

- **`src/collector.js` [MODIFY]**:
  - In `fetchProductPriceInfo`: return `myPrice: null` for unauthenticated requests; increase `retries = 4` and use exponential backoff (`Math.pow(2, attempt - 1) * backoffBaseMs + jitter`); accept injectable `backoffBaseMs = 2000`; skip sleep on final attempt.
  - In `collectPricesForActiveItems`: set default `concurrency = 3`, `delayMs = 250`, `openCliChunkSize = 2`, `openCliTimeoutMs = 25000`.
  - In price comparison: compare `myPrice` only when both current and previous price points have authentic member prices; compare `salePrice` when either snapshot lacks `myPrice`. Evaluate `isNewLowest` separately per price type.
  - In lowest price tracking: guard `lowestMyPrice` update so `null` never triggers an empty lowest price record.
- **`src/cli.js` [MODIFY]**:
  - Update `parseConcurrency` default to 3.
  - Fix progress reporting formatting to `${priceInfo.isSoldOut ? '품절' : (priceInfo.myPrice || priceInfo.salePrice || 0).toLocaleString() + '원'}`.
  - In `exportDataForGit`: map `lowest_price` from `it.lowest_my_price || it.lowest_sale_price || null`.
- **`src/notifier.js` [MODIFY]**:
  - In restock alerts: format price as `priceInfo.myPrice || priceInfo.salePrice`.
- **`tests/collector-parallel.test.js` [MODIFY]**:
  - Import `fetchProductPriceInfo`.
  - Add unit tests for unauthenticated `myPrice: null`, 429 exponential retry (using `backoffBaseMs: 1`), and transition without false price drops.
  - Update OpenCLI chunk size 2 circuit breaker assertions.
- **`tests/cli-concurrency.test.js` [MODIFY]**: Update all test assertions for default concurrency 3 across undefined, boolean, and string inputs.

---

## Tasks

### Task 1: Strict Price Segregation & 429 Exponential Retry in `src/collector.js` & Tests

**Files:**
- Modify: `src/collector.js`
- Modify: `tests/collector-parallel.test.js`

**Interfaces:**
- Consumes: `fetch`, `mapConcurrent`, `dbInstance`
- Produces: `fetchProductPriceInfo(goodsNo, cookieHeader = '', retries = 4, backoffBaseMs = 2000): Promise<priceInfo>` with `myPrice: null` without cookies, and exponential backoff on 429.

- [ ] **Step 1: Write failing tests in `tests/collector-parallel.test.js`**

Add import for `fetchProductPriceInfo`:
```javascript
import { collectPricesForActiveItems, fetchProductPriceInfo } from '../src/collector.js';
```

Add tests for (1) `fetchProductPriceInfo` returning `myPrice: null` when unauthenticated, (2) 429 exponential retry with fast `backoffBaseMs: 1`, and (3) preventing false price drops:

```javascript
  test('fetchProductPriceInfo returns myPrice: null for public unauthenticated requests', async () => {
    const mockHtml = `
      <html><body>
        <script id="__NEXT_DATA__" type="application/json">
          {"props":{"pageProps":{"dehydratedState":{"queries":[{"queryKey":["Detail", 999999],"state":{"data":{"data":{"goodsNm":"Item","brand":"Brand","goodsPrice":{"normalPrice":50000,"salePrice":45000,"couponPrice":40000}}}}]}}}}
        </script>
      </body></html>
    `;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => mockHtml,
    });

    try {
      const info = await fetchProductPriceInfo(999999);
      assert.equal(info.salePrice, 45000);
      assert.equal(info.couponPrice, 40000);
      assert.equal(info.myPrice, null, 'Public fetch must NOT set myPrice');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchProductPriceInfo retries on 429 with backoff and succeeds', async () => {
    let callCount = 0;
    const mockHtml = `
      <html><body>
        <script id="__NEXT_DATA__" type="application/json">
          {"props":{"pageProps":{"dehydratedState":{"queries":[{"queryKey":["Detail", 888888],"state":{"data":{"data":{"goodsNm":"Item","brand":"Brand","goodsPrice":{"normalPrice":30000,"salePrice":25000}}}}]}}}}
        </script>
      </body></html>
    `;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount <= 2) {
        return { ok: false, status: 429 };
      }
      return { ok: true, status: 200, text: async () => mockHtml };
    };

    try {
      // Use backoffBaseMs: 1 to avoid test delay
      const info = await fetchProductPriceInfo(888888, '', 4, 1);
      assert.equal(callCount, 3, 'Expected 2 retries on 429 before success');
      assert.equal(info.goodsNo, 888888);
      assert.equal(info.salePrice, 25000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not report false price drop when transitioning between authenticated and unauthenticated snapshots', async () => {
    const mockActiveItems = [
      {
        goods_no: 201,
        goods_name: 'Test Shirt',
        brand_name: 'Brand A',
        status: 'ACTIVE',
        lowest_my_price: 35000,
        lowest_sale_price: 45000,
      },
    ];

    // Day 1 had authenticated member price of 35,000 and salePrice of 45,000
    const mockDb = {
      getActiveItems: () => mockActiveItems,
      getItem: () => mockActiveItems[0],
      getLatestPrice: () => ({
        goods_no: 201,
        date: '2026-09-04',
        sale_price: 45000,
        my_price: 35000,
        is_sold_out: 0,
      }),
      updateItemDetails: () => {},
      updateItemStatus: () => {},
      updateLowestPrice: () => {},
      recordPriceLog: () => {},
      recordDailyRun: () => {},
    };

    const mockExec = () => {
      throw new Error('OpenCLI timeout');
    };

    // Public fetch on Day 2 returns salePrice 45,000, couponPrice 42,000, myPrice null
    const mockFetch = async (goodsNo) => ({
      goodsNo,
      goodsName: 'Test Shirt',
      brandName: 'Brand A',
      normalPrice: 50000,
      salePrice: 45000,
      couponPrice: 42000,
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

    // salePrice stayed at 45,000 and myPrice is null -> no price drop should be emitted
    assert.equal(results.priceDropped.length, 0, 'Must not report price drop when salePrice is unchanged and myPrice is unavailable');
    assert.equal(results.items[0].myPrice, null);
    assert.equal(results.items[0].salePrice, 45000);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/collector-parallel.test.js`
Expected: FAIL (`assert.equal(info.myPrice, null)` fails because current code returns `myPrice: 40000`)

- [ ] **Step 3: Modify `fetchProductPriceInfo` in `src/collector.js`**

1. Increase default retries from 3 to 4, accept `backoffBaseMs = 2000`, skip sleep on last attempt, and implement exponential backoff:
```javascript
export async function fetchProductPriceInfo(goodsNo, cookieHeader = '', retries = 4, backoffBaseMs = 2000) {
  const url = `https://www.musinsa.com/products/${goodsNo}`;
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    Referer: 'https://www.musinsa.com/',
  };
  if (cookieHeader) {
    headers['Cookie'] = cookieHeader;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { headers });

      if (response.status === 404) {
        return { status: 404, discontinued: true };
      }

      if (response.status === 429) {
        if (attempt === retries) {
          throw new Error(`HTTP 429 Rate Limited on goods ${goodsNo} after ${retries} attempts`);
        }
        const waitTime = Math.pow(2, attempt - 1) * backoffBaseMs + Math.floor(Math.random() * 500);
        console.warn(
          `⏳ [RateLimit 429] Waiting ${(waitTime / 1000).toFixed(1)}s before retrying goods ${goodsNo} (attempt ${attempt}/${retries})...`
        );
        await new Promise((r) => setTimeout(r, waitTime));
        continue;
      }
...
```

2. In the return object of `fetchProductPriceInfo`, set `myPrice: null`:
```javascript
      return {
        goodsNo: Number(goodsNo),
        goodsName: detail.goodsNm || '',
        brandName,
        imageUrl: detail.thumbnailImageUrl || detail.goodsImage || '',
        url,
        normalPrice,
        salePrice,
        couponPrice,
        saleRate: finalDiscount,
        myPrice: null, // Public unauthenticated fetch cannot know member discount
        couponName,
        couponDiscount,
        isSoldOut,
        discontinued: false,
      };
```

- [ ] **Step 4: Update price comparison and lowest price tracking in `collectPricesForActiveItems`**

In `src/collector.js`:
```javascript
      // Update lowest price tracking: only update lowest_my_price if authentic myPrice is available
      let lowestMyPrice = item.lowest_my_price;
      let lowestSalePrice = item.lowest_sale_price;

      const hasNewLowestMyPrice = Boolean(priceInfo.myPrice && (!lowestMyPrice || priceInfo.myPrice < lowestMyPrice));
      const hasNewLowestSalePrice = Boolean(priceInfo.salePrice && (!lowestSalePrice || priceInfo.salePrice < lowestSalePrice));

      if (hasNewLowestMyPrice || hasNewLowestSalePrice) {
        if (hasNewLowestMyPrice) {
          lowestMyPrice = priceInfo.myPrice;
        }
        if (hasNewLowestSalePrice) {
          lowestSalePrice = priceInfo.salePrice;
        }
        dbInstance.updateLowestPrice(item.goods_no, lowestMyPrice, lowestSalePrice, today);
      }

      // Check for price drop: compare like-for-like
      if (prevPriceLog) {
        if (priceInfo.myPrice && prevPriceLog.my_price) {
          // Both have authentic personalized prices: compare myPrice
          if (priceInfo.myPrice < prevPriceLog.my_price) {
            const dropAmount = prevPriceLog.my_price - priceInfo.myPrice;
            const dropRate = Math.round((dropAmount / prevPriceLog.my_price) * 100);
            results.priceDropped.push({
              item,
              priceInfo,
              priceType: 'myPrice',
              prevPrice: prevPriceLog.my_price,
              currentPrice: priceInfo.myPrice,
              dropAmount,
              dropRate,
              isNewLowest: Boolean(hasNewLowestMyPrice && item.lowest_my_price),
            });
          }
        } else if (priceInfo.salePrice && prevPriceLog.sale_price) {
          // At least one snapshot lacks authentic myPrice: compare public salePrice
          if (priceInfo.salePrice < prevPriceLog.sale_price) {
            const dropAmount = prevPriceLog.sale_price - priceInfo.salePrice;
            const dropRate = Math.round((dropAmount / prevPriceLog.sale_price) * 100);
            results.priceDropped.push({
              item,
              priceInfo,
              priceType: 'salePrice',
              prevPrice: prevPriceLog.sale_price,
              currentPrice: priceInfo.salePrice,
              dropAmount,
              dropRate,
              isNewLowest: Boolean(hasNewLowestSalePrice && item.lowest_sale_price),
            });
          }
        }
      }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/collector-parallel.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/collector.js tests/collector-parallel.test.js
git commit -m "fix(collector): enforce strict price segregation and harden 429 exponential backoff"
```

---

### Task 2: OpenCLI Chunk Tuning (Chunk Size 2, 25s Timeout) & Test Sync

**Files:**
- Modify: `src/collector.js`
- Modify: `tests/collector-parallel.test.js`

**Interfaces:**
- Consumes: OpenCLI `musinsa my-prices`
- Produces: 2-item chunks with 25s timeout, circuit breaker on 2 consecutive chunk failures.

- [ ] **Step 1: Update chunk size and timeout defaults in `src/collector.js`**

Change signature and parameters:
```javascript
export async function collectPricesForActiveItems({
  concurrency = 3,
  delayMs = 250,
  onProgress = null,
  openCliTimeoutMs = 25000,
  openCliChunkSize = 2,
  dbInstance = db,
  execFn = execSync,
  fetchFn = fetchProductPriceInfo,
} = {}) {
```

Update batch loop chunking:
```javascript
  for (let i = 0; i < goodsNos.length; i += openCliChunkSize) {
    if (consecutiveOpenCliErrors >= 2) {
      console.warn(
        `⚡ [OpenCLI CircuitBreaker] 2 consecutive OpenCLI batch failures/timeouts. Skipping remaining ${goodsNos.length - i} items and proceeding to fast direct parser.`
      );
      break;
    }

    const chunk = goodsNos.slice(i, i + openCliChunkSize).join(',');
```

- [ ] **Step 2: Update existing tests in `tests/collector-parallel.test.js` to align with chunk size 2**

In Test 1 (`preserves exact order in results.items and executes fallback when OpenCLI fails`), pass `openCliChunkSize: 4` explicitly:
```javascript
    const results = await collectPricesForActiveItems({
      concurrency: 2,
      delayMs: 0,
      openCliChunkSize: 4,
      openCliTimeoutMs: 1000,
      dbInstance: mockDb,
      execFn: mockExec,
      fetchFn: mockFetch,
      onProgress: (p) => progressReports.push(p.current),
    });
```

In Test 2 (`circuit breaker aborts subsequent OpenCLI chunks after 2 consecutive failures`), test with 8 items and default `openCliChunkSize = 2`:
```javascript
  test('circuit breaker aborts subsequent OpenCLI chunks after 2 consecutive failures', async () => {
    const mockActiveItems = Array.from({ length: 8 }, (_, i) => ({
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
      concurrency: 2,
      delayMs: 0,
      dbInstance: mockDb,
      execFn: mockExec,
      fetchFn: mockFetch,
    });

    // 8 items / 2 chunk size = 4 chunks. Circuit breaker aborts after 2 consecutive failures.
    assert.equal(openCliAttempts, 2, `Expected OpenCLI attempts to be capped at 2, got ${openCliAttempts}`);
    assert.equal(results.success, 8);
  });
```

- [ ] **Step 3: Run test suite to verify pass**

Run: `node --test tests/collector-parallel.test.js`
Expected: PASS (5/5 tests pass)

- [ ] **Step 4: Commit**

```bash
git add src/collector.js tests/collector-parallel.test.js
git commit -m "perf(collector): tune OpenCLI chunk size to 2 and timeout to 25s"
```

---

### Task 3: CLI / Notifier Enhancements & Concurrency 3 Alignment

**Files:**
- Modify: `src/cli.js`
- Modify: `src/notifier.js`
- Modify: `tests/cli-concurrency.test.js`

**Interfaces:**
- Consumes: CLI args, Notification payloads
- Produces: `parseConcurrency` defaulting to 3, safe progress display for unauthenticated items, robust lowest_price mapping.

- [ ] **Step 1: Write failing test updates in `tests/cli-concurrency.test.js`**

Update all tests in `tests/cli-concurrency.test.js` to expect default 3:
```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseConcurrency } from '../src/cli.js';

describe('CLI Concurrency Parser', () => {
  test('returns default 3 when undefined or null', () => {
    assert.equal(parseConcurrency(undefined), 3);
    assert.equal(parseConcurrency(null), 3);
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
    assert.equal(parseConcurrency(true), 3);
    assert.equal(parseConcurrency('fast'), 3);
    assert.equal(parseConcurrency(''), 3);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test tests/cli-concurrency.test.js`
Expected: FAIL (`assert.equal(parseConcurrency(undefined), 3)` fails because default is currently 4)

- [ ] **Step 3: Update `src/cli.js` and `src/notifier.js`**

1. Change default in `parseConcurrency(val, defaultVal = 3)` in `src/cli.js`:
```javascript
export function parseConcurrency(val, defaultVal = 3) {
  if (typeof val === 'boolean' || val === undefined || val === null || val === '') {
    return defaultVal;
  }
  const parsed = Number(val);
  if (!Number.isFinite(parsed) || isNaN(parsed)) {
    return defaultVal;
  }
  return Math.max(1, Math.min(Math.floor(parsed), 5));
}
```

2. Update `handleDailyRun` and `case 'track'` calls in `src/cli.js`:
```javascript
  const concurrency = parseConcurrency(flags.concurrency, 3);
```

3. Update progress formatting in both `handleDailyRun` and `case 'track'` in `src/cli.js`:
```javascript
        onProgress: ({ current, total, item, priceInfo }) => {
          const displayPrice = priceInfo.isSoldOut
            ? '품절'
            : `${(priceInfo.myPrice || priceInfo.salePrice || 0).toLocaleString()}원`;
          process.stdout.write(
            `\r  [${current}/${total}] ${(item.brand_name || '-').slice(0, 15)} - ${displayPrice}`.padEnd(65)
          );
        },
```

4. In `src/cli.js` `exportDataForGit`:
```javascript
        current_price: latest?.my_price || latest?.sale_price || null,
        lowest_price: it.lowest_my_price || it.lowest_sale_price || null,
```

5. In `src/notifier.js` line 104 (restock alert):
```javascript
  const priceStr = (r.priceInfo.myPrice || r.priceInfo.salePrice)?.toLocaleString() || '-';
```

6. Update CLI help text:
```text
  daily [--force] [--concurrency=1-5] Run daily sync & price tracking (default concurrency: 3)
  track [--concurrency=1-5]           Fetch latest prices for all active tracked items
```

- [ ] **Step 4: Run test to verify pass**

Run: `node --test tests/cli-concurrency.test.js`
Expected: PASS

- [ ] **Step 5: Run full project test suite**

Run: `npm test`
Expected: PASS (all 31 tests pass across 10 suites)

- [ ] **Step 6: Commit**

```bash
git add src/cli.js src/notifier.js tests/cli-concurrency.test.js
git commit -m "feat(cli,notifier): align default concurrency to 3, fix progress display and lowest price fallback"
```

---

## Verification Plan

### Automated Tests
- Run `npm test` to verify all 31 tests pass cleanly across 10 suites.
- Verify that `tests/collector-parallel.test.js` confirms:
  - `fetchProductPriceInfo` returns `myPrice: null` when unauthenticated.
  - 429 exponential backoff retries and succeeds without delay.
  - No false price drops on authentication boundary changes.
  - OpenCLI chunk size 2 circuit breaker aborts after 2 consecutive errors.
- Verify `tests/cli-concurrency.test.js` confirms default concurrency 3.

### Manual Verification
- Run `node src/cli.js track --concurrency=3`.
- Confirm 0 failed items (0% failure rate).
- Confirm no spurious price drop alerts.
