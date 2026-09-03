import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { syncLikedItemsFromMusinsa } from '../src/sync.js';
import { collectPricesForActiveItems, fetchProductPriceInfo } from '../src/collector.js';
import { getExecOptions, getExtendedPath } from '../src/env.js';

describe('Sync & Collector Integration', () => {
  test('sync and collector modules export expected functions cleanly', () => {
    assert.equal(typeof syncLikedItemsFromMusinsa, 'function');
    assert.equal(typeof collectPricesForActiveItems, 'function');
    assert.equal(typeof fetchProductPriceInfo, 'function');
  });

  test('getExecOptions passes augmented PATH to child process options', () => {
    const opts = getExecOptions({ stdio: ['pipe', 'pipe', 'pipe'] });
    assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(opts.env.PATH, getExtendedPath());
  });
});
