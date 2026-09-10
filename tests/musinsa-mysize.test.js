import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatMySizeToFilterString, normalizeMySizeRows, getMusinsaMySize } from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/mysize.js';

describe('Musinsa MySize Data Formatter & Filter Converter', () => {
  test('normalizes raw purchased garment measurements into clean rows', () => {
    const rawApiList = [
      {
        goodsNo: 501234,
        goodsName: '릴렉스드 옥스포드 셔츠',
        brandName: '포터리',
        sizeName: '3',
        sizeType: 'TOP',
        measurements: [
          { name: '총장', value: 75.5 },
          { name: '가슴단면', value: 59.0 },
          { name: '어깨너비', value: 51.5 },
          { name: '소매길이', value: 63.0 },
        ],
      },
    ];

    const rows = normalizeMySizeRows(rawApiList);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      goodsNo: 501234,
      brand: '포터리',
      goodsName: '릴렉스드 옥스포드 셔츠',
      size: '3',
      category: '상의',
      length: '75.5cm',
      chest: '59cm',
      waist: '-',
      shoulder: '51.5cm',
      sleeve: '63cm',
      thigh: '-',
      filterArgs: '-',
    });
  });

  test('formats MySize measurement rows into --measure filter string with tolerance', () => {
    const row = {
      length: '75cm',
      chest: '59cm',
      shoulder: '51cm',
    };

    // Default tolerance ±2cm
    const filterStr = formatMySizeToFilterString(row, 2);
    assert.equal(filterStr, '총장:73-77,가슴:57-61,어깨:49-53');
  });

  test('normalizes pants measurements with waist and thigh', () => {
    const rawApiList = [
      {
        goodsNo: 601234,
        goodsName: '와이드 데님 팬츠',
        brandName: '무신사 스탠다드',
        sizeName: '32',
        sizeType: 'PANTS',
        measurements: [
          { name: '총장', value: 104.0 },
          { name: '허리단면', value: 41.5 },
          { name: '허벅지단면', value: 33.0 },
        ],
      },
    ];

    const rows = normalizeMySizeRows(rawApiList);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      goodsNo: 601234,
      brand: '무신사 스탠다드',
      goodsName: '와이드 데님 팬츠',
      size: '32',
      category: '하의',
      length: '104cm',
      chest: '-',
      waist: '41.5cm',
      shoulder: '-',
      sleeve: '-',
      thigh: '33cm',
      filterArgs: '-',
    });
  });

  test('handles alternative property names and missing measurements gracefully', () => {
    const rawApiList = [
      {
        productId: 701234,
        productName: '기본 니트',
        brand: '유니폼브릿지',
        optionName: 'L',
        sizeType: 'OUTER',
        measurementList: [
          { title: '총장', sizeValue: 70 },
          { displayText: '가슴단면', val: 56.5 },
        ],
      },
      {
        goodsNo: 801234,
      },
    ];

    const rows = normalizeMySizeRows(rawApiList);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].goodsNo, 701234);
    assert.equal(rows[0].brand, '유니폼브릿지');
    assert.equal(rows[0].goodsName, '기본 니트');
    assert.equal(rows[0].size, 'L');
    assert.equal(rows[0].category, '아우터');
    assert.equal(rows[0].length, '70cm');
    assert.equal(rows[0].chest, '56.5cm');

    assert.equal(rows[1].goodsNo, 801234);
    assert.equal(rows[1].brand, '-');
    assert.equal(rows[1].category, '상의');
    assert.equal(rows[1].length, '-');
  });

  test('handles empty input in normalizeMySizeRows', () => {
    assert.deepEqual(normalizeMySizeRows(), []);
    assert.deepEqual(normalizeMySizeRows([]), []);
  });

  test('formats filter string with custom tolerance and ignores dashes or empty values', () => {
    const row = {
      length: '104cm',
      waist: '41.5cm',
      chest: '-',
      thigh: '33cm',
      shoulder: null,
    };

    // Tolerance ±3cm
    // 104 -> 101-107
    // 41.5 -> Math.round(41.5 - 3) = 39, Math.round(41.5 + 3) = 45 -> 39-45
    // 33 -> 30-36
    const filterStr = formatMySizeToFilterString(row, 3);
    assert.equal(filterStr, '총장:101-107,허리:39-45,허벅지:30-36');
  });

  test('handles empty or blank row in formatMySizeToFilterString', () => {
    assert.equal(formatMySizeToFilterString({}), '');
    assert.equal(formatMySizeToFilterString(null), '');
  });

  test('as-filter mode populates filterArgs and preserves all standard columns', async () => {
    const origFetch = global.fetch;
    try {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            list: [
              {
                goodsNo: 501234,
                goodsName: '릴렉스드 옥스포드 셔츠',
                brandName: '포터리',
                sizeName: '3',
                sizeType: 'TOP',
                measurements: [
                  { name: '총장', value: 75.5 },
                  { name: '가슴단면', value: 59.0 },
                  { name: '어깨너비', value: 51.5 },
                  { name: '소매길이', value: 63.0 },
                ],
              },
            ],
          },
        }),
      });

      const rows = await getMusinsaMySize({ 'as-filter': true, tolerance: 2 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].goodsNo, 501234);
      assert.equal(rows[0].brand, '포터리');
      assert.equal(rows[0].goodsName, '릴렉스드 옥스포드 셔츠');
      assert.equal(rows[0].size, '3');
      assert.equal(rows[0].category, '상의');
      assert.equal(rows[0].length, '75.5cm');
      assert.equal(rows[0].chest, '59cm');
      assert.equal(rows[0].waist, '-');
      assert.equal(rows[0].shoulder, '51.5cm');
      assert.equal(rows[0].sleeve, '63cm');
      assert.equal(rows[0].thigh, '-');
      assert.equal(rows[0].filterArgs, '--measure "총장:74-78,가슴:57-61,어깨:50-54,소매:61-65"');

      // Also verify options.asFilter camelCase works
      const rowsCamel = await getMusinsaMySize({ asFilter: true, tolerance: 2 });
      assert.equal(rowsCamel[0].filterArgs, '--measure "총장:74-78,가슴:57-61,어깨:50-54,소매:61-65"');
    } finally {
      global.fetch = origFetch;
    }
  });
});
