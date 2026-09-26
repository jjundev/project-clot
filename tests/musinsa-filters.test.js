import './setup-env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStandardSize,
  normalizeShoeSize,
  parseMeasurementInput,
  buildFilterQueryParams,
} from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/filters.js';

describe('Musinsa Filter Normalization Engine', () => {
  test('normalizeStandardSize handles single and comma-separated sizes and maps 2XL/3XL', () => {
    assert.equal(normalizeStandardSize('m'), 'M');
    assert.equal(normalizeStandardSize('M, L, xl'), 'M,L,XL');
    assert.equal(normalizeStandardSize('2XL'), 'XXL');
    assert.equal(normalizeStandardSize('xxl'), 'XXL');
    assert.equal(normalizeStandardSize('3XL'), 'XXL');
    assert.equal(normalizeStandardSize(''), null);
    assert.equal(normalizeStandardSize(null), null);
  });

  test('normalizeShoeSize strips mm and validates shoe sizes', () => {
    assert.equal(normalizeShoeSize('270'), '270');
    assert.equal(normalizeShoeSize('270mm'), '270');
    assert.equal(normalizeShoeSize(265), '265');
    assert.equal(normalizeShoeSize('270, 275'), '270,275');
    assert.equal(normalizeShoeSize('invalid'), null);
  });

  test('parseMeasurementInput converts Korean aliases and range formats into caret syntax', () => {
    // Range with hyphen
    assert.equal(parseMeasurementInput('총장:70-75'), '총장^70^75');
    // Range with tilde
    assert.equal(parseMeasurementInput('기장:70~75'), '총장^70^75');
    // Multiple measurements with Korean aliases
    assert.equal(
      parseMeasurementInput('기장:70-75, 가슴:55-60, 허리:38-40'),
      '총장^70^75,가슴단면^55^60,허리단면^38^40'
    );
    // Min only (e.g. 75+)
    assert.equal(parseMeasurementInput('총장:75+'), '총장^75^150');
    assert.equal(parseMeasurementInput('총장:75~'), '총장^75^150');
    // Max only (e.g. ~75)
    assert.equal(parseMeasurementInput('총장:~75'), '총장^0^75');
    assert.equal(parseMeasurementInput('총장:-75'), '총장^0^75');
  });

  test('buildFilterQueryParams auto-routes options into clean query params', () => {
    // Standard clothing size
    assert.deepEqual(buildFilterQueryParams({ size: 'M,L' }), {
      standardSize: 'M,L',
    });

    // Auto-detect shoe size passed to --size
    assert.deepEqual(buildFilterQueryParams({ size: '270' }), {
      shoeSizeOption: '270',
    });

    // Explicit shoe size and measurement
    assert.deepEqual(
      buildFilterQueryParams({
        size: 'L',
        measure: '기장:72-76, 어깨:50-54',
      }),
      {
        standardSize: 'L',
        measurement: '총장^72^76,어깨너비^50^54',
      }
    );
  });
});
