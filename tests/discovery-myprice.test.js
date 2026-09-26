import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClotDatabase } from '../src/db.js';
import {
  DEFAULT_DISCOVERY_AUTH_LIMIT,
  parseAuthLimit,
  selectDiscoveryAuthTargets,
  summarizeMyPriceGap,
} from '../src/discovery.js';

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-disc-myprice-'));
  const db = new ClotDatabase(path.join(dir, 'test.db'));
  t.after(() => {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir };
}

// upsertItem binds `url` without a default, so every fixture needs one.
const itemRow = (goods_no, extra = {}) => ({
  goods_no, goods_name: `G${goods_no}`, source: 'discovery', url: `https://www.musinsa.com/products/${goods_no}`, ...extra,
});

test('db: getLastMyPriceDates returns latest date with a real my_price only', (t) => {
  const { db } = tempDb(t);
  for (const g of [1, 2, 3]) db.upsertItem(itemRow(g));
  db.recordPriceLog({ goods_no: 1, date: '2026-09-20', my_price: 1000, estimated_my_price: 1100 });
  db.recordPriceLog({ goods_no: 1, date: '2026-09-25', my_price: 900, estimated_my_price: 1000 });
  db.recordPriceLog({ goods_no: 1, date: '2026-09-26', my_price: null, estimated_my_price: 1000 });
  db.recordPriceLog({ goods_no: 2, date: '2026-09-26', my_price: null, estimated_my_price: 500 });

  const map = db.getLastMyPriceDates([1, 2, 3]);
  assert.equal(map.get(1), '2026-09-25');
  assert.equal(map.has(2), false);
  assert.equal(map.has(3), false);
  assert.equal(db.getLastMyPriceDates([]).size, 0);
});

test('db: estimated lowest update keeps the real lowest date once lowest_my_price exists', (t) => {
  const { db } = tempDb(t);
  db.upsertItem(itemRow(10));
  db.upsertItem(itemRow(11));
  db.updateLowestPrice(10, 1000, null, '2026-09-20');

  db.updateLowestEstimatedPrice(10, 900, '2026-09-26');
  db.updateLowestEstimatedPrice(11, 800, '2026-09-26');

  assert.equal(db.getItem(10).lowest_estimated_price, 900);
  assert.equal(db.getItem(10).lowest_price_date, '2026-09-20');
  assert.equal(db.getItem(11).lowest_estimated_price, 800);
  assert.equal(db.getItem(11).lowest_price_date, '2026-09-26');
});

test('parseAuthLimit: default, zero, bad values', () => {
  assert.equal(DEFAULT_DISCOVERY_AUTH_LIMIT, 120);
  assert.equal(parseAuthLimit(undefined), 120);
  assert.equal(parseAuthLimit(''), 120);
  assert.equal(parseAuthLimit(true), 120);
  assert.equal(parseAuthLimit('abc'), 120);
  assert.equal(parseAuthLimit('-5'), 120);
  assert.equal(parseAuthLimit('0'), 0);
  assert.equal(parseAuthLimit('50'), 50);
  assert.equal(parseAuthLimit(7.9), 7);
});

test('selectDiscoveryAuthTargets: never-priced first, then oldest, skips sold out and duplicates', () => {
  const items = [
    { goodsNo: 5, isSoldOut: false },
    { goodsNo: 3, isSoldOut: false },
    { goodsNo: 4, isSoldOut: true },
    { goodsNo: 2, isSoldOut: false },
    { goodsNo: 1, isSoldOut: false },
    { goodsNo: 3, isSoldOut: false },
  ];
  const last = new Map([[5, '2026-09-20'], [2, '2026-09-10'], [1, '2026-09-20']]);

  const all = selectDiscoveryAuthTargets(items, last, 10);
  assert.deepEqual(all.goodsNos, [3, 2, 1, 5]);
  assert.equal(all.eligible, 4);

  const capped = selectDiscoveryAuthTargets(items, last, 2);
  assert.deepEqual(capped.goodsNos, [3, 2]);
  assert.equal(capped.eligible, 4);

  assert.deepEqual(selectDiscoveryAuthTargets(items, last, 0).goodsNos, []);
});

test('summarizeMyPriceGap: median of myPrice - estimate and count below estimate', () => {
  assert.deepEqual(summarizeMyPriceGap([]), { n: 0, medianDiff: null, belowEstimate: 0 });
  assert.deepEqual(
    summarizeMyPriceGap([
      { myPrice: 900, estimatedMyPrice: 1000 },
      { myPrice: 1000, estimatedMyPrice: 1000 },
      { myPrice: 700, estimatedMyPrice: 1000 },
    ]),
    { n: 3, medianDiff: -100, belowEstimate: 2 }
  );
  assert.deepEqual(
    summarizeMyPriceGap([
      { myPrice: 900, estimatedMyPrice: 1000 },
      { myPrice: 750, estimatedMyPrice: 1000 },
    ]),
    { n: 2, medianDiff: -175, belowEstimate: 2 }
  );
});
