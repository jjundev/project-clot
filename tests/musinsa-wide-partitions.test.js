import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanPartitions } from '../src/musinsaWide/partitions.js';
const goods = (...ids) => ids.map(goodsNo => ({ goodsNo, price: 100 }));
const setup = (parts, page) => ({ withClient: fn => fn({ sleep: async () => {}, getCategoryPartitions: async root => parts[root].map(code => ({ code, root })), getCategoryPage: page }), categories: Object.keys(parts), targetGoods: 5 });
test('round robin follows each cursor, globally dedups, and retains root ownership', async () => {
  const calls = [];
  const result = await scanPartitions({ ...setup({ '001': ['a', 'b'], '002': ['c'] }, async (code, url) => {
    calls.push([code, url]);
    return { items: goods(...({ a: url ? [5] : [1, 2], b: [2, 3], c: [1, 4] }[code])), nextPageUrl: code === 'a' && !url ? 'signed' : null };
  }), concurrency: 1 });
  assert.deepEqual(calls, [['a', null], ['c', null], ['b', null], ['a', 'signed']]);
  assert.equal(result.selected, 5);
  assert.equal(result.targetReached, true);
  assert.ok(result.scans.every(s => s.complete));
  assert.deepEqual([...result.scans[0].rows.keys()], [1, 2, 3, 5]);
  assert.deepEqual([...result.scans[1].rows.keys()], [4]);
  assert.ok(result.scans.every(s => [...s.rows.values()].every(r => r.cat === s.cat)));
});
test('inflight pages cannot exceed exact target', async () => {
  const result = await scanPartitions({ ...setup({ '001': ['a', 'b', 'c'] }, async () => {
    await new Promise(resolve => setImmediate(resolve));
    return { items: goods(1, 2, 3, 4, 5, 6, 7), nextPageUrl: 'more' };
  }), concurrency: 3, targetGoods: 4 });
  assert.equal(result.selected, 4);
  assert.equal(result.scans[0].rows.size, 4);
});
test('exhaustion below target makes every scan incomplete', async () => {
  const r = await scanPartitions(setup({ '001': ['a'] }, async () => ({ items: goods(1), nextPageUrl: null })));
  assert.equal(r.targetReached, false);
  assert.equal(r.scans[0].complete, false);
  assert.match(r.scans[0].problems.join(), /target/);
});
test('empty promised page retries same cursor and inhibits completeness even if siblings reach target', async () => {
  const calls = [];
  const r = await scanPartitions({ ...setup({ '001': ['a', 'b'] }, async (code, url) => {
    calls.push([code, url]);
    return code === 'a' ? { items: [], nextPageUrl: 'bad' } : { items: goods(1, 2, 3, 4, 5), nextPageUrl: null };
  }), concurrency: 1 });
  assert.equal(calls.filter(([c]) => c === 'a').length, 3);
  assert.equal(r.targetReached, true);
  assert.equal(r.scans[0].complete, false);
});
test('discovery failure, deadline, and 429 never report complete', async () => {
  const base = setup({ '001': ['a'] }, async () => { throw Object.assign(new Error('limited'), { status: 429 }); });
  const throttle = await scanPartitions(base);
  assert.equal(throttle.scans[0].complete, false);
  const deadline = await scanPartitions({ ...base, deadline: 1, now: () => 2 });
  assert.match(deadline.scans[0].problems.join(), /deadline/);
  const failure = await scanPartitions({ ...base, withClient: fn => fn({ sleep: async () => {}, getCategoryPartitions: async () => { throw new Error('taxonomy'); } }) });
  assert.match(failure.scans[0].problems.join(), /taxonomy/);
});
test('exact 300000 global rows with overlapping inflight responses', async () => {
  const r = await scanPartitions({ ...setup({ '001': ['a', 'b', 'c'] }, async code => ({
    items: Array.from({ length: 150001 }, (_, i) => ({ goodsNo: i + 1 + ({ a: 0, b: 100000, c: 200000 }[code]) })), nextPageUrl: null,
  })), targetGoods: 300000, concurrency: 3 });
  assert.equal(r.selected, 300000);
  assert.equal(r.scans[0].rows.size, 300000);
  assert.equal(r.scans[0].complete, true);
});
test('retry retains signed cursor and deadline is checked after backoff', async () => {
  const urls = [];
  let fail = true;
  const r = await scanPartitions({ ...setup({ '001': ['a'] }, async (code, url) => {
    urls.push(url);
    if (url && fail) { fail = false; throw new Error('503'); }
    return { items: goods(url ? 2 : 1), nextPageUrl: url ? null : 'signed-token' };
  }), targetGoods: 2 });
  assert.deepEqual(urls, [null, 'signed-token', 'signed-token']);
  assert.equal(r.scans[0].complete, true);
  let time = 0;
  let calls = 0;
  const stopped = await scanPartitions({ categories: ['001'], targetGoods: 1, deadline: 10, now: () => time,
    withClient: fn => fn({ getCategoryPartitions: async () => [{ code: 'a', root: '001' }],
      sleep: async () => { time = 10; }, getCategoryPage: async () => { calls++; throw new Error('503'); } }) });
  assert.equal(calls, 1);
  assert.match(stopped.scans[0].problems.join(), /deadline/);
});
test('429 stops siblings before new work or retries', async () => {
  const calls = [];
  const r = await scanPartitions({ ...setup({ '001': ['a', 'b', 'c'] }, async code => {
    calls.push(code);
    throw Object.assign(new Error('429'), { status: 429 });
  }), concurrency: 1 });
  assert.deepEqual(calls, ['a']);
  assert.match(r.scans[0].problems.join(), /throttled/);
});
