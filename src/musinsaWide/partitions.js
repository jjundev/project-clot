import { anonCall, toListingRow } from './client.js';
import { mapConcurrent } from '../pool.js';

export const DAILY_GOODS_TARGET = 300_000;

// A worker takes one page, then puts its cursor at the back of the shared queue.
// Row insertion is synchronous after each await, so concurrent responses cannot overfill the target.
export async function scanPartitions({ withClient, categories, targetGoods, concurrency = 3, deadline = Infinity, now = Date.now, log = () => {} }) {
  if (!Number.isInteger(targetGoods) || targetGoods <= 0) throw new Error('targetGoods must be a positive integer');
  const scans = [...new Set(categories)].map(cat => ({ cat, rows: new Map(), pages: 0, complete: false, problems: [] }));
  const queue = [];
  const selectedIds = new Set();
  let stop = null;
  const checkStop = () => {
    if (now() >= deadline) stop ??= 'deadline';
    if (stop || selectedIds.size >= targetGoods) throw new Error(stop ?? 'target reached');
  };
  const call = async (fn) => withClient(client => anonCall(() => fn(client), { sleep: client.sleep, beforeAttempt: checkStop }));

  // Finish discovery before selection: reaching the target cannot hide a missing root.
  await mapConcurrent(scans, concurrency, async scan => {
    try {
      const parts = await call(client => client.getCategoryPartitions(scan.cat));
      if (!Array.isArray(parts) || !parts.length || parts.some(p => !p.code || p.root !== scan.cat) || new Set(parts.map(p => p.code)).size !== parts.length) {
        throw new Error('invalid category partitions');
      }
      scan.partitions = parts;
    } catch (err) {
      if (err.status === 429) stop ??= 'throttled';
      scan.problems.push(`${scan.cat}: discovery failed: ${err.message}`);
    }
  });
  // Interleave roots as well as children, preserving the official root order.
  for (let i = 0; scans.some(s => s.partitions?.[i]); i++) {
    for (const scan of scans) if (scan.partitions?.[i]) queue.push({ scan, code: scan.partitions[i].code, url: null, visited: new Set() });
  }
  for (const scan of scans) delete scan.partitions;

  await mapConcurrent(Array.from({ length: Math.max(1, concurrency) }), concurrency, async () => {
    while (queue.length && !stop && selectedIds.size < targetGoods) {
      const task = queue.shift();
      const { scan, code, url, visited } = task;
      try {
        const page = await call(async client => {
          const value = await client.getCategoryPage(code, url);
          if (!Array.isArray(value?.items) || (!value.items.length && (!url || value.nextPageUrl))) throw new Error('empty or malformed category page');
          return value;
        });
        scan.pages++;
        if (now() >= deadline) stop ??= 'deadline';
        for (const item of page.items) {
          if (selectedIds.size >= targetGoods) break;
          const row = toListingRow(item, scan.cat);
          if (row && !selectedIds.has(row.goods_no)) {
            selectedIds.add(row.goods_no);
            scan.rows.set(row.goods_no, row);
          }
        }
        if (page.nextPageUrl) {
          if (visited.has(page.nextPageUrl)) throw new Error('repeated category cursor');
          visited.add(page.nextPageUrl);
          queue.push({ ...task, url: page.nextPageUrl });
        }
      } catch (err) {
        if (err.status === 429) stop ??= 'throttled';
        scan.problems.push(`${scan.cat}/${code}: page failed: ${err.message}`);
      }
    }
  });
  const targetReached = selectedIds.size === targetGoods;
  const failed = scans.some(s => s.problems.length) || Boolean(stop) || !targetReached;
  for (const scan of scans) {
    if (stop) scan.problems.push(`${scan.cat}: ${stop}`);
    if (!targetReached) scan.problems.push(`${scan.cat}: target unmet (${selectedIds.size}/${targetGoods})`);
    // Every root must inhibit misses when any part of the daily selection failed.
    scan.complete = !failed;
    log(`${scan.cat}: ${scan.rows.size} selected in ${scan.pages} pages${scan.complete ? '' : ' (incomplete)'}`);
  }
  return { scans, selected: selectedIds.size, targetReached };
}
