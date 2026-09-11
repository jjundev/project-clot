import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collectPricesForActiveItems } from '../src/collector.js';

const items = [
  { goods_no: 1, goods_name: 'A', brand_name: 'B', status: 'ACTIVE', source: 'like' },
  { goods_no: 2, goods_name: 'C', brand_name: 'D', status: 'ACTIVE', source: 'like' },
];

function makeDb(overrides = {}) {
  const recorded = { runs: [], logs: [] };
  const db = {
    getActiveItems: () => items,
    getLatestPrice: () => null,
    updateItemDetails: () => {},
    updateItemStatus: () => {},
    updateLowestPrice: () => {},
    recordPriceLog: (row) => recorded.logs.push(row),
    recordDailyRun: (row) => recorded.runs.push(row),
    ...overrides,
  };
  return { db, recorded };
}

const directFetch = async (goodsNo) => ({
  goodsNo,
  goodsName: `Name ${goodsNo}`,
  brandName: 'Brand',
  normalPrice: 20000,
  salePrice: 15000,
  myPrice: null,
  isSoldOut: false,
  discontinued: false,
});

describe('Deferred (sleep-aware) collection mode', () => {
  test('skipOpenCli never spawns OpenCLI, never pre-warms, never warns, and records mode=deferred', async () => {
    const { db, recorded } = makeDb();
    let execCalls = 0;
    let prewarmCalls = 0;
    let warnings = 0;

    const results = await collectPricesForActiveItems({
      dbInstance: db,
      execFn: () => { execCalls++; throw new Error('should not be called'); },
      prewarmFn: async () => { prewarmCalls++; },
      fetchFn: directFetch,
      skipOpenCli: true,
      enableSelfHealing: true,
      onSessionWarning: async () => { warnings++; },
      delayMs: 0,
    });

    assert.equal(execCalls, 0);
    assert.equal(prewarmCalls, 0);
    assert.equal(warnings, 0);
    assert.equal(results.sessionWarningTriggered, false);
    assert.equal(results.mode, 'deferred');
    assert.equal(results.success, 2);
    assert.equal(recorded.runs.length, 1);
    assert.equal(recorded.runs[0].mode, 'deferred');
  });

  test('mode=full when OpenCLI answers, mode=degraded when the circuit breaker trips', async () => {
    const okExec = () =>
      JSON.stringify([
        { goodsNo: 1, normalPrice: '20,000', salePrice: '15,000', couponPrice: '14,000', myPrice: '13,000', status: '판매중' },
        { goodsNo: 2, normalPrice: '20,000', salePrice: '15,000', couponPrice: '14,000', myPrice: '13,000', status: '판매중' },
      ]);
    const full = makeDb();
    const fullRes = await collectPricesForActiveItems({
      dbInstance: full.db, execFn: okExec, fetchFn: directFetch, openCliChunkSize: 2, delayMs: 0,
    });
    assert.equal(fullRes.mode, 'full');
    assert.equal(full.recorded.runs[0].mode, 'full');

    const degraded = makeDb();
    const degradedRes = await collectPricesForActiveItems({
      dbInstance: degraded.db,
      execFn: () => { throw new Error('spawnSync /bin/sh ETIMEDOUT'); },
      fetchFn: directFetch,
      openCliChunkSize: 1,
      delayMs: 0,
    });
    assert.equal(degradedRes.mode, 'degraded');
    assert.equal(degraded.recorded.runs[0].mode, 'degraded');
  });

  test('price drops are measured against the pre-today baseline, not this morning\'s deferred row', async () => {
    const today = new Date().toISOString().split('T')[0];
    const { db } = makeDb({
      // "latest" is today's deferred snapshot (public sale price only)
      getLatestPrice: () => ({ date: today, sale_price: 15000, my_price: null, is_sold_out: 0 }),
      // baseline is yesterday's authenticated snapshot
      getLatestPriceBefore: (goodsNo, date) => {
        assert.equal(date, today);
        return { date: '2000-01-01', sale_price: 15000, my_price: 14000, is_sold_out: 0 };
      },
    });
    const okExec = () =>
      JSON.stringify([
        { goodsNo: 1, normalPrice: '20,000', salePrice: '15,000', couponPrice: '13,000', myPrice: '12,000', status: '판매중' },
        { goodsNo: 2, normalPrice: '20,000', salePrice: '15,000', couponPrice: '15,000', myPrice: '14,000', status: '판매중' },
      ]);
    const results = await collectPricesForActiveItems({
      dbInstance: db, execFn: okExec, fetchFn: directFetch, openCliChunkSize: 2, delayMs: 0,
    });
    assert.equal(results.mode, 'full');
    assert.equal(results.priceDropped.length, 1);
    assert.equal(results.priceDropped[0].priceType, 'myPrice');
    assert.equal(results.priceDropped[0].prevPrice, 14000);
    assert.equal(results.priceDropped[0].currentPrice, 12000);
  });
});
