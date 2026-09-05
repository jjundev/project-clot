/**
 * Concurrently maps an array of items using an asynchronous function with a bounded concurrency limit.
 * Preserves the original array order of results.
 *
 * @template T, R
 * @param {T[]} items - Array of items to process
 * @param {number|((item: T, index: number) => Promise<R>)} concurrency - Max concurrent tasks, or iteratorFn shorthand
 * @param {(item: T, index: number) => Promise<R>} [iteratorFn] - Async function to run for each item
 * @returns {Promise<R[]>} - Resolves with array of results in the original order
 */
export async function mapConcurrent(items, concurrency = 4, iteratorFn) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  let fn = iteratorFn;
  let maxConcurrency = concurrency;

  if (typeof concurrency === 'function') {
    fn = concurrency;
    maxConcurrency = 4;
  }

  if (typeof fn !== 'function') {
    throw new TypeError('iteratorFn must be a function');
  }

  const parsedConcurrency = Number(maxConcurrency);
  const safeConcurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : 4;
  const limit = Math.max(1, Math.min(Math.floor(safeConcurrency), items.length));

  const results = new Array(items.length);
  let currentIndex = 0;
  let hasError = false;
  let firstError = null;

  const workers = Array.from({ length: limit }, async () => {
    while (currentIndex < items.length) {
      if (hasError) break;
      const idx = currentIndex++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        if (!hasError) {
          hasError = true;
          firstError = err;
        }
        break;
      }
    }
  });

  await Promise.all(workers);

  if (hasError) {
    throw firstError;
  }

  return results;
}
