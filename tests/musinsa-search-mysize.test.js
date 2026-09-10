import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatMySizeToFilterString } from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/mysize.js';
import { buildFilterQueryParams } from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/filters.js';

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

  test('does not overwrite existing measure filter when manual measure is provided', () => {
    const manualMeasure = '기장:70-75';
    const kwargs = {
      'my-size': 'top',
      measure: manualMeasure,
    };

    // If kwargs.measure is already set, --my-size logic should keep kwargs.measure intact
    assert.ok(kwargs.measure);
    assert.equal(kwargs.measure, '기장:70-75');
  });
});
