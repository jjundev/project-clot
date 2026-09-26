import './setup-env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { prewarmMusinsaSession, collectPricesForActiveItems } from '../src/collector.js';
import { notifySessionWarning } from '../src/notifier.js';

describe('Session Pre-warm & Healing Mechanism', () => {
  test('prewarmMusinsaSession returns false on non-darwin platforms', async () => {
    let called = false;
    const res = await prewarmMusinsaSession({
      platform: 'linux',
      execFn: () => {
        called = true;
      },
    });
    assert.strictEqual(res, false);
    assert.strictEqual(called, false);
  });

  test('prewarmMusinsaSession executes open command on darwin', async () => {
    let executedCmd = '';
    const res = await prewarmMusinsaSession({
      platform: 'darwin',
      waitMs: 1,
      execFn: (cmd) => {
        executedCmd = cmd;
      },
    });
    assert.strictEqual(res, true);
    assert.ok(executedCmd.includes('Google Chrome'), 'should target Google Chrome');
    assert.ok(executedCmd.includes('https://www.musinsa.com'), 'should target musinsa');
    assert.ok(executedCmd.includes('-g'), 'should open in background');
  });

  test('prewarmMusinsaSession catches errors gracefully without throwing', async () => {
    const res = await prewarmMusinsaSession({
      platform: 'darwin',
      waitMs: 1,
      execFn: () => {
        throw new Error('Command failed: Chrome not found');
      },
    });
    assert.strictEqual(res, false);
  });

  test('collectPricesForActiveItems invokes prewarmFn for VIP items', async () => {
    let prewarmCount = 0;
    const mockDb = {
      recordPriceLog: () => {},
      recordDailyRun: () => {},
      updateItemStatus: () => {},
      getLatestPrice: () => null,
      updateLowestPrice: () => {},
    };

    await collectPricesForActiveItems({
      items: [{ goods_no: 999999, source: 'like', status: 'ACTIVE' }],
      dbInstance: mockDb,
      execFn: () => JSON.stringify([{ goodsNo: 999999, myPrice: '50,000원' }]),
      prewarmFn: async () => {
        prewarmCount++;
        return true;
      },
    });

    assert.ok(prewarmCount >= 1, 'prewarmFn should have been called at least once');
  });

  test('collectPricesForActiveItems attempts self-healing prewarm on initial OpenCLI failure', async () => {
    let prewarmCalls = 0;
    let openCliCalls = 0;
    const mockDb = {
      recordPriceLog: () => {},
      recordDailyRun: () => {},
      updateItemStatus: () => {},
      getLatestPrice: () => null,
      updateLowestPrice: () => {},
    };

    const results = await collectPricesForActiveItems({
      items: [{ goods_no: 777777, source: 'like', status: 'ACTIVE' }],
      dbInstance: mockDb,
      enableSelfHealing: true,
      execFn: () => {
        openCliCalls++;
        if (openCliCalls === 1) {
          throw new Error('ETIMEDOUT');
        }
        return JSON.stringify([{ goodsNo: 777777, myPrice: '45,000원' }]);
      },
      prewarmFn: async () => {
        prewarmCalls++;
        return true;
      },
    });

    assert.ok(prewarmCalls >= 2, 'should invoke prewarmFn initially and on self-healing retry');
    assert.strictEqual(results.success, 1);
  });

  test('collectPricesForActiveItems triggers onSessionWarning when circuit breaker trips', async () => {
    let warningPayload = null;
    const mockDb = {
      recordPriceLog: () => {},
      recordDailyRun: () => {},
      updateItemStatus: () => {},
      getLatestPrice: () => null,
      updateLowestPrice: () => {},
    };

    const results = await collectPricesForActiveItems({
      items: [
        { goods_no: 111111, source: 'like', status: 'ACTIVE' },
        { goods_no: 222222, source: 'like', status: 'ACTIVE' },
        { goods_no: 333333, source: 'like', status: 'ACTIVE' },
      ],
      openCliChunkSize: 1,
      dbInstance: mockDb,
      execFn: () => {
        throw new Error('ETIMEDOUT');
      },
      fetchFn: async (goodsNo) => ({
        goodsNo,
        salePrice: 50000,
        myPrice: null,
      }),
      prewarmFn: async () => true,
      onSessionWarning: async (data) => {
        warningPayload = data;
      },
    });

    assert.strictEqual(results.sessionWarningTriggered, true);
    assert.ok(warningPayload !== null, 'onSessionWarning should be invoked');
    assert.ok(warningPayload.reason.includes('서킷 브레이커'));
  });

  test('notifySessionWarning executes without crashing', async () => {
    const res = await notifySessionWarning({ reason: 'Test warning' });
    assert.strictEqual(typeof res, 'boolean');
  });
});
