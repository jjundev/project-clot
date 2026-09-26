import './setup-env.js';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getMusinsaOptions } from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/options.js';

describe('Musinsa Product Options & Inventory Formatter', () => {
  test('correlates option items with inventory status correctly', () => {
    const rawOptions = {
      basic: [
        {
          name: '사이즈',
          optionValues: [
            { no: 101, name: 'M' },
            { no: 102, name: 'L' },
          ],
        },
      ],
      optionItems: [
        { no: 201, optionValueNos: [101], price: 0 },
        { no: 202, optionValueNos: [102], price: 3000 },
      ],
    };

    const rawInventory = [
      {
        productVariantId: 201,
        outOfStock: false,
        remainQuantity: 5,
        domesticDelivery: { guideWillReleaseAtText: '내일(금) 발송 예정' },
      },
      {
        productVariantId: 202,
        outOfStock: true,
        remainQuantity: 0,
      },
    ];

    const invMap = new Map(rawInventory.map((i) => [i.productVariantId, i]));

    const rows = rawOptions.optionItems.map((item) => {
      const inv = invMap.get(item.no);
      const valName = rawOptions.basic[0].optionValues.find((v) => v.no === item.optionValueNos[0])?.name;
      return {
        size: valName,
        priceAdd: item.price > 0 ? `+${item.price.toLocaleString()}원` : '0원',
        status: inv?.outOfStock ? '품절' : '판매중',
        remain: inv?.remainQuantity != null ? `${inv.remainQuantity}개` : '-',
        delivery: inv?.domesticDelivery?.guideWillReleaseAtText || '-',
      };
    });

    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      size: 'M',
      priceAdd: '0원',
      status: '판매중',
      remain: '5개',
      delivery: '내일(금) 발송 예정',
    });
    assert.deepEqual(rows[1], {
      size: 'L',
      priceAdd: '+3,000원',
      status: '품절',
      remain: '0개',
      delivery: '-',
    });
  });
});

describe('getMusinsaOptions Unit Tests', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('throws ArgumentError on missing or invalid goodsNo', async () => {
    await assert.rejects(
      async () => await getMusinsaOptions(''),
      (err) => {
        assert.equal(err.name, 'ArgumentError');
        return true;
      }
    );

    await assert.rejects(
      async () => await getMusinsaOptions('invalid-product-id'),
      (err) => {
        assert.equal(err.name, 'ArgumentError');
        return true;
      }
    );
  });

  test('successfully fetches and correlates options with prioritized inventories', async () => {
    const mockOptionsData = {
      basic: [
        {
          name: '컬러',
          optionValues: [
            { no: 1, name: '블랙' },
            { no: 2, name: '화이트' },
          ],
        },
        {
          name: '사이즈',
          optionValues: [
            { no: 10, name: 'M' },
            { no: 20, name: 'L' },
          ],
        },
      ],
      optionItems: [
        { no: 1001, optionValueNos: [1, 10], price: 0, activated: true },
        { no: 1002, optionValueNos: [1, 20], price: 2000, activated: true },
        { no: 1003, optionValueNos: [2, 10], price: 0, activated: false },
      ],
    };

    const mockInventoryData = [
      {
        productVariantId: 1001,
        outOfStock: false,
        remainQuantity: 12,
        domesticDelivery: { guideWillReleaseAtText: '오늘(목) 출발 예정' },
      },
      {
        productVariantId: 1002,
        outOfStock: true,
        remainQuantity: 0,
      },
    ];

    let headersSent = null;

    globalThis.fetch = async (url, opts) => {
      headersSent = opts?.headers;
      if (url.includes('/options/v2/prioritized-inventories')) {
        return {
          ok: true,
          json: async () => ({ data: mockInventoryData }),
        };
      }
      if (url.includes('/options')) {
        return {
          ok: true,
          json: async () => ({ data: mockOptionsData }),
        };
      }
      return { ok: false, status: 404 };
    };

    const result = await getMusinsaOptions(7035474, 'test_cookie=123');

    assert.equal(result.length, 3);
    assert.deepEqual(result[0], {
      goodsNo: 7035474,
      size: '블랙 / M',
      status: '판매중',
      priceExtra: '0원',
      remain: '12개',
      delivery: '오늘(목) 출발 예정',
    });
    assert.deepEqual(result[1], {
      goodsNo: 7035474,
      size: '블랙 / L',
      status: '품절',
      priceExtra: '+2,000원',
      remain: '0개',
      delivery: '-',
    });
    // 1003 was not in inventory response, so fallback to !item.activated -> outOfStock: true ('품절')
    assert.deepEqual(result[2], {
      goodsNo: 7035474,
      size: '화이트 / M',
      status: '품절',
      priceExtra: '0원',
      remain: '-',
      delivery: '-',
    });
    assert.equal(headersSent['Cookie'], 'test_cookie=123');
  });

  test('throws EmptyResultError when optionItems is empty', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: { basic: [], optionItems: [] } }),
    });

    await assert.rejects(
      async () => await getMusinsaOptions('https://www.musinsa.com/products/999999'),
      (err) => {
        assert.equal(err.name, 'EmptyResultError');
        return true;
      }
    );
  });

  test('handles inventory network failure gracefully and falls back to activated flag', async () => {
    const mockOptionsData = {
      basic: [{ name: '사이즈', optionValues: [{ no: 1, name: 'FREE' }] }],
      optionItems: [{ no: 501, optionValueNos: [1], price: 0, activated: true }],
    };

    globalThis.fetch = async (url) => {
      if (url.includes('/options/v2/prioritized-inventories')) {
        throw new Error('Network error');
      }
      return {
        ok: true,
        json: async () => ({ data: mockOptionsData }),
      };
    };

    const result = await getMusinsaOptions(500123);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      goodsNo: 500123,
      size: 'FREE',
      status: '판매중',
      priceExtra: '0원',
      remain: '-',
      delivery: '-',
    });
  });
});
