import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mapConcurrent } from '../src/pool.js';

describe('Concurrency Pool (mapConcurrent)', () => {
  test('processes all items and preserves original input ordering', async () => {
    const items = [100, 20, 50, 10]; // delays in ms
    const results = await mapConcurrent(items, 2, async (delay, index) => {
      await new Promise((r) => setTimeout(r, delay));
      return { index, delay };
    });

    assert.equal(results.length, 4);
    assert.deepEqual(results, [
      { index: 0, delay: 100 },
      { index: 1, delay: 20 },
      { index: 2, delay: 50 },
      { index: 3, delay: 10 },
    ]);
  });

  test('supports (items, iteratorFn) shorthand with default concurrency 4', async () => {
    const items = [1, 2, 3];
    const results = await mapConcurrent(items, async (x) => x * 10);
    assert.deepEqual(results, [10, 20, 30]);
  });

  test('enforces concurrency limit strictly', async () => {
    let activeWorkers = 0;
    let maxActiveWorkers = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapConcurrent(items, 3, async () => {
      activeWorkers++;
      maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
      await new Promise((r) => setTimeout(r, 20));
      activeWorkers--;
    });

    assert.ok(maxActiveWorkers <= 3, `Expected max concurrency <= 3, got ${maxActiveWorkers}`);
    assert.ok(maxActiveWorkers >= 2, `Expected concurrency to reach pool capacity, got ${maxActiveWorkers}`);
  });

  test('handles empty arrays without error', async () => {
    const results = await mapConcurrent([], 4, async () => 1);
    assert.deepEqual(results, []);
  });

  test('guards against NaN or invalid concurrency input with a safe fallback', async () => {
    const items = [1, 2];
    const results = await mapConcurrent(items, 'invalid', async (x) => x * 2);
    assert.deepEqual(results, [2, 4]);
  });

  test('propagates first rejection and preserves root cause', async () => {
    const items = [1, 2, 3];
    await assert.rejects(
      async () => {
        await mapConcurrent(items, 2, async (x) => {
          if (x === 2) throw new Error('Worker failure');
          if (x === 3) throw new Error('Secondary failure');
          return x;
        });
      },
      { message: 'Worker failure' }
    );
  });
});
