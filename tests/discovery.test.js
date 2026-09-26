import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReleasedWithinYears,
  floor10,
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

  await t.test('floor10 truncates values to 10-won unit', () => {
    assert.equal(floor10(1234), 1230);
    assert.equal(floor10(1239), 1230);
    assert.equal(floor10(1230), 1230);
    assert.equal(floor10(9), 0);
  });

  await t.test('estimateMemberPrice calculates exact waterfall member price with 10-won truncation', () => {
    // 100,000 KRW unrestricted:
    // Grade discount: floor10(100,000 * 0.015) = 1,500 -> balance 98,500
    // Point discount: floor10(98,500 * 0.07) = floor10(6,895) = 6,890
    // Final: 98,500 - 6,890 = 91,610
    const price1 = estimateMemberPrice(100000, false);
    assert.equal(price1, 91610);

    // Grade discount restricted (isLimitedDc: true):
    // Grade discount: 0 -> balance 100,000
    // Point discount: floor10(100,000 * 0.07) = 7,000
    // Final: 100,000 - 7,000 = 93,000
    const priceLimited = estimateMemberPrice(100000, false, { isLimitedDc: true });
    assert.equal(priceLimited, 93000);

    // Both points and grade restricted (Outlet item):
    // Both 0 -> 100,000
    const priceOutlet = estimateMemberPrice(100000, true, { isLimitedDc: true });
    assert.equal(priceOutlet, 100000);

    // Restricted points only: isRestrictedUsePoint = true, isLimitedDc = false:
    // Grade discount: 1,500 -> 98,500. Point discount: 0 -> 98,500
    const price2 = estimateMemberPrice(100000, true);
    assert.equal(price2, 98500);

    // Null or invalid input
    assert.equal(estimateMemberPrice(null), null);
    assert.equal(estimateMemberPrice(0), null);
    assert.equal(estimateMemberPrice('invalid'), null);

    // Numeric string coercion
    assert.equal(estimateMemberPrice('100000', false), 91610);
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

  await t.test('fetchLikeCountsBatch handles network and HTTP errors gracefully without throwing', async () => {
    const errorFetch = async () => {
      throw new Error('ECONNRESET');
    };
    const emptyMap1 = await fetchLikeCountsBatch([1001], errorFetch);
    assert.equal(emptyMap1.size, 0);

    const httpFailFetch = async () => ({
      ok: false,
      status: 502,
    });
    const emptyMap2 = await fetchLikeCountsBatch([1001], httpFailFetch);
    assert.equal(emptyMap2.size, 0);
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
    assert.equal(results[0].estimatedMyPrice, 41230);
  });
});
