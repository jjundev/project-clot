import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatMySizeToFilterString } from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/mysize.js';
import { buildFilterQueryParams } from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/filters.js';
import { resolveMySizeFilter } from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/search.js';

describe('Search MySize Bridge', () => {
  test('converts my-size row measurements into search query parameters', () => {
    const mySizeRow = {
      length: '74cm',
      chest: '58cm',
    };

    const measureStr = formatMySizeToFilterString(mySizeRow, 2);
    assert.equal(measureStr, '총장:72-76,가슴:56-60');

    const filterParams = buildFilterQueryParams({ measure: measureStr });
    assert.equal(filterParams.measurement, '총장^72^76,가슴단면^56^60');
  });

  test('converts pants my-size row measurements into search query parameters', () => {
    const mySizePants = {
      length: '102cm',
      waist: '40cm',
      thigh: '32cm',
    };

    const measureStr = formatMySizeToFilterString(mySizePants, 2);
    assert.equal(measureStr, '총장:100-104,허리:38-42,허벅지:30-34');

    const filterParams = buildFilterQueryParams({ measure: measureStr });
    assert.equal(filterParams.measurement, '총장^100^104,허리단면^38^42,허벅지단면^30^34');
  });

  test('resolveMySizeFilter preserves existing manual measure and does not call getMySizeFn', async () => {
    let called = false;
    const mockGetMySize = async () => {
      called = true;
      return [{ length: '80cm', chest: '65cm' }];
    };

    const kwargs = {
      'my-size': 'top',
      measure: '기장:70-75,가슴:55-60',
    };

    await resolveMySizeFilter(kwargs, 'cookie=123', mockGetMySize);
    assert.equal(called, false);
    assert.equal(kwargs.measure, '기장:70-75,가슴:55-60');
  });

  test('resolveMySizeFilter resolves past measurements into kwargs.measure when only my-size is provided', async () => {
    let passedOptions = null;
    let passedCookie = null;
    const mockGetMySize = async (opts, cookie) => {
      passedOptions = opts;
      passedCookie = cookie;
      return [{ length: '74cm', chest: '58cm' }];
    };

    const kwargs = {
      'my-size': 'top',
    };

    await resolveMySizeFilter(kwargs, 'test_cookie=abc', mockGetMySize);
    assert.deepEqual(passedOptions, { type: 'top', limit: 1, tolerance: 2 });
    assert.equal(passedCookie, 'test_cookie=abc');
    assert.equal(kwargs.measure, '총장:72-76,가슴:56-60');
  });

  test('resolveMySizeFilter handles custom tolerance correctly', async () => {
    const mockGetMySize = async () => {
      return [{ length: '74cm', chest: '58cm' }];
    };

    const kwargs = {
      'my-size': 'top',
      tolerance: 3,
    };

    await resolveMySizeFilter(kwargs, '', mockGetMySize);
    assert.equal(kwargs.measure, '총장:71-77,가슴:55-61');
  });

  test('resolveMySizeFilter warns on error without blocking or crashing', async () => {
    const origWarn = console.warn;
    const warnings = [];
    console.warn = (msg) => warnings.push(msg);

    try {
      const mockFailingGetMySize = async () => {
        throw new Error('로그인이 필요합니다.');
      };

      const kwargs = {
        'my-size': 'top',
      };

      await resolveMySizeFilter(kwargs, '', mockFailingGetMySize);
      assert.equal(kwargs.measure, undefined);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes('[musinsa search] my-size warning: 로그인이 필요합니다.'));
    } finally {
      console.warn = origWarn;
    }
  });
});
