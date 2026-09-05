import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collectPricesForActiveItems, fetchProductPriceInfo } from '../src/collector.js';

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

  test('fetchProductPriceInfo returns myPrice: null for public unauthenticated requests', async () => {
    const mockHtml = `
      <html><body>
        <script id="__NEXT_DATA__" type="application/json">
          {"props":{"pageProps":{"dehydratedState":{"queries":[{"queryKey":["Detail", 999999],"state":{"data":{"data":{"goodsNm":"Item","brand":"Brand","goodsPrice":{"normalPrice":50000,"salePrice":45000,"couponPrice":40000}}}}}]}}}}
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
          {"props":{"pageProps":{"dehydratedState":{"queries":[{"queryKey":["Detail", 888888],"state":{"data":{"data":{"goodsNm":"Item","brand":"Brand","goodsPrice":{"normalPrice":30000,"salePrice":25000}}}}}]}}}}
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
});
