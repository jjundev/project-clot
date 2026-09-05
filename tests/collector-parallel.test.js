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
      openCliChunkSize: 4,
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

  test('collectPricesForActiveItems detects like-for-like estimated price drop and updates lowest estimated price', async () => {
    const discoveryItem = {
      goods_no: 301,
      goods_name: 'Discovered Pants',
      source: 'discovery',
      status: 'ACTIVE',
      lowest_estimated_price: 50000,
    };

    const lowestEstUpdates = [];
    const recordedLogs = [];

    const mockDb = {
      getActiveItems: () => [discoveryItem],
      getItem: () => discoveryItem,
      getLatestPrice: () => ({
        goods_no: 301,
        date: '2026-09-04',
        sale_price: 60000,
        coupon_price: 55000,
        estimated_my_price: 49616,
        is_sold_out: 0,
      }),
      updateItemDetails: () => {},
      updateItemStatus: () => {},
      updateLowestPrice: () => {},
      updateLowestEstimatedPrice: (id, price, date) => {
        lowestEstUpdates.push({ id, price, date });
      },
      recordPriceLog: (log) => {
        recordedLogs.push(log);
      },
      recordDailyRun: () => {},
    };

    const mockFetch = async (goodsNo) => ({
      goodsNo,
      goodsName: 'Discovered Pants',
      brandName: 'Brand',
      normalPrice: 70000,
      salePrice: 50000,
      couponPrice: 45000,
      estimatedMyPrice: 40595, // 45000 * 0.9021 = 40595
      myPrice: null,
      isSoldOut: false,
      discontinued: false,
    });

    const results = await collectPricesForActiveItems({
      concurrency: 1,
      delayMs: 0,
      dbInstance: mockDb,
      fetchFn: mockFetch,
    });

    assert.equal(results.priceDropped.length, 1);
    const drop = results.priceDropped[0];
    assert.equal(drop.priceType, 'estimated');
    assert.equal(drop.prevPrice, 49616);
    assert.equal(drop.currentPrice, 40595);
    assert.equal(drop.dropAmount, 49616 - 40595);
    assert.equal(drop.dropRate, Math.round(((49616 - 40595) / 49616) * 100));
    assert.equal(drop.isNewLowest, true);

    assert.equal(lowestEstUpdates.length, 1);
    assert.equal(lowestEstUpdates[0].id, 301);
    assert.equal(lowestEstUpdates[0].price, 40595);

    assert.equal(recordedLogs.length, 1);
    assert.equal(recordedLogs[0].coupon_price, 45000);
    assert.equal(recordedLogs[0].estimated_my_price, 40595);
  });

  test('collectPricesForActiveItems respects source and items filtering options', async () => {
    const vipItem = { goods_no: 101, goods_name: 'VIP', source: 'like', status: 'ACTIVE' };
    const discItem = { goods_no: 201, goods_name: 'Disc', source: 'discovery', status: 'ACTIVE' };

    const mockDb = {
      getActiveItems: () => [vipItem, discItem],
      getActiveVipItems: () => [vipItem],
      getDiscoveredActiveItems: () => [discItem],
      getItem: (id) => (id === 101 ? vipItem : discItem),
      getLatestPrice: () => null,
      updateItemDetails: () => {},
      updateItemStatus: () => {},
      updateLowestPrice: () => {},
      updateLowestEstimatedPrice: () => {},
      recordPriceLog: () => {},
      recordDailyRun: () => {},
    };

    const mockFetch = async (goodsNo) => ({
      goodsNo,
      goodsName: 'Product',
      salePrice: 10000,
      couponPrice: 9000,
      estimatedMyPrice: 8119,
      myPrice: null,
      isSoldOut: false,
      discontinued: false,
    });

    const mockExec = () => '[]';

    // 1. source: 'discovery'
    const discResults = await collectPricesForActiveItems({
      concurrency: 1,
      delayMs: 0,
      source: 'discovery',
      dbInstance: mockDb,
      execFn: mockExec,
      fetchFn: mockFetch,
    });
    assert.equal(discResults.items.length, 1);
    assert.equal(discResults.items[0].goodsNo, 201);

    // 2. source: 'like'
    const likeResults = await collectPricesForActiveItems({
      concurrency: 1,
      delayMs: 0,
      source: 'like',
      dbInstance: mockDb,
      execFn: mockExec,
      fetchFn: mockFetch,
    });
    assert.equal(likeResults.items.length, 1);
    assert.equal(likeResults.items[0].goodsNo, 101);

    // 3. items array passed directly
    const directResults = await collectPricesForActiveItems({
      concurrency: 1,
      delayMs: 0,
      items: [discItem],
      dbInstance: mockDb,
      execFn: mockExec,
      fetchFn: mockFetch,
    });
    assert.equal(directResults.items.length, 1);
    assert.equal(directResults.items[0].goodsNo, 201);
  });
});
