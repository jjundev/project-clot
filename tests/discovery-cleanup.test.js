import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISCOVERY_DROP_AFTER_MISSES,
  DISCOVERY_MIN_CATEGORY_FILL,
  isDefaultDiscoveryScan,
  isCompleteDiscoveryScan,
} from '../src/discovery.js';

const okStats = (counts) => counts.map((count, i) => ({ cat: `c${i}`, ok: true, count }));

test('cleanup constants match the confirmed design', () => {
  assert.equal(DISCOVERY_DROP_AFTER_MISSES, 2);
  assert.equal(DISCOVERY_MIN_CATEGORY_FILL, 0.5);
});

test('isDefaultDiscoveryScan: only the four scope flags make a scan non-default', () => {
  assert.equal(isDefaultDiscoveryScan({}), true);
  assert.equal(isDefaultDiscoveryScan(), true);
  // daily --with-discovery forwards its own flags; none of them narrow the scope
  assert.equal(
    isDefaultDiscoveryScan({ 'with-discovery': true, force: true, concurrency: '4', 'auth-limit': '50' }),
    true
  );
  assert.equal(isDefaultDiscoveryScan({ category: '001' }), false);
  assert.equal(isDefaultDiscoveryScan({ limit: '50' }), false);
  assert.equal(isDefaultDiscoveryScan({ limit: true }), false); // bare `--limit`
  assert.equal(isDefaultDiscoveryScan({ 'min-likes': '500' }), false);
  assert.equal(isDefaultDiscoveryScan({ years: '3' }), false);
});

test('isCompleteDiscoveryScan: default flags, all ok, each category >= 50% of limit', () => {
  assert.equal(isCompleteDiscoveryScan({}, okStats([100, 100, 100, 100, 100]), 100), true);
  assert.equal(isCompleteDiscoveryScan({}, okStats([100, 100, 100, 100, 50]), 100), true); // boundary
  assert.equal(isCompleteDiscoveryScan({}, okStats([100, 100, 100, 100, 49]), 100), false);
  assert.equal(
    isCompleteDiscoveryScan({}, [...okStats([100, 100]), { cat: '003', ok: false, count: 0 }], 100),
    false
  );
  assert.equal(isCompleteDiscoveryScan({ category: '001' }, okStats([100]), 100), false);
  assert.equal(isCompleteDiscoveryScan({}, [], 100), false); // nothing scanned is never complete
});
