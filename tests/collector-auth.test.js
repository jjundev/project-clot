import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collectPricesForActiveItems, collectAuthenticatedPrices } from '../src/collector.js';
import { SessionExpiredError } from '../src/myprice.js';

const items = [
  { goods_no: 1, goods_name: 'A', brand_name: 'B', status: 'ACTIVE', source: 'like' },
  { goods_no: 2, goods_name: 'C', brand_name: 'D', status: 'ACTIVE', source: 'like' },
];

function makeDb() {
  const recorded = { runs: [], logs: [] };
  const db = {
    getActiveItems: () => items,
    getLatestPrice: () => null,
    updateItemDetails: () => {},
    updateItemStatus: () => {},
    updateLowestPrice: () => {},
    recordPriceLog: (row) => recorded.logs.push(row),
    recordDailyRun: (row) => recorded.runs.push(row),
  };
  return { db, recorded };
}

const authInfo = (goodsNo, myPrice) => ({
  goodsNo, goodsName: `Name ${goodsNo}`, brandName: 'Brand', normalPrice: 20000, salePrice: 15000,
  couponPrice: 14000, myPrice, estimatedMyPrice: 12500, couponName: 'c', couponDiscount: 1000,
  isSoldOut: false, discontinued: false, priceSource: 'https-auth',
});

const directFetch = async (goodsNo) => ({
  goodsNo, goodsName: `Name ${goodsNo}`, brandName: 'Brand', normalPrice: 20000, salePrice: 15000,
  myPrice: null, isSoldOut: false, discontinued: false,
});

describe('collectAuthenticatedPrices', () => {
  test('no cookie -> no fetches, empty map', async () => {
    let calls = 0;
    const map = await collectAuthenticatedPrices({
      goodsNos: [1, 2], sessionProvider: async () => null, authFetchFn: async () => { calls++; }, authDelayMs: 0,
    });
    assert.equal(map.size, 0);
    assert.equal(calls, 0);
  });

  test('a throwing sessionProvider is treated as no cookie', async () => {
    const map = await collectAuthenticatedPrices({
      goodsNos: [1], sessionProvider: async () => { throw new Error('boom'); }, authFetchFn: async () => authInfo(1, 1), authDelayMs: 0,
    });
    assert.equal(map.size, 0);
  });

  test('expired session refreshes once and retries the same item', async () => {
    const providerCalls = [];
    const sessionProvider = async ({ refresh }) => { providerCalls.push(refresh); return refresh ? 'app_atk=new' : 'app_atk=old'; };
    const authFetchFn = async (g, { cookie }) => {
      if (cookie === 'app_atk=old') throw new SessionExpiredError();
      return authInfo(g, 13000 + g);
    };
    const map = await collectAuthenticatedPrices({ goodsNos: [1, 2], sessionProvider, authFetchFn, authDelayMs: 0 });
    assert.deepEqual(providerCalls, [false, true]);
    assert.deepEqual([...map.keys()], [1, 2]);
  });

  test('3 consecutive non-session failures stop the stage (systemic block) and leave the rest for fallback', async () => {
    let fetches = 0;
    const map = await collectAuthenticatedPrices({
      goodsNos: [1, 2, 3, 4, 5, 6],
      sessionProvider: async () => 'app_atk=x',
      authFetchFn: async () => { fetches++; throw new Error('Product page unavailable after 4 attempts'); },
      authDelayMs: 0,
    });
    assert.equal(fetches, 3);
    assert.equal(map.size, 0);
  });

  test('a success resets the consecutive-failure count', async () => {
    const outcomes = { 1: 'fail', 2: 'fail', 3: 'ok', 4: 'fail', 5: 'fail', 6: 'ok' };
    const map = await collectAuthenticatedPrices({
      goodsNos: [1, 2, 3, 4, 5, 6],
      sessionProvider: async () => 'app_atk=x',
      authFetchFn: async (g) => { if (outcomes[g] === 'fail') throw new Error('HTTP 500'); return authInfo(g, 1); },
      authDelayMs: 0,
    });
    assert.deepEqual([...map.keys()], [3, 6]);
  });

  test('refresh that still yields an expired session stops the stage (no loop)', async () => {
    let fetches = 0;
    const map = await collectAuthenticatedPrices({
      goodsNos: [1, 2, 3],
      sessionProvider: async () => 'app_atk=x',
      authFetchFn: async () => { fetches++; throw new SessionExpiredError(); },
      authDelayMs: 0,
    });
    assert.equal(map.size, 0);
    assert.equal(fetches, 2); // original + one retry after refresh
  });
});

describe('collectPricesForActiveItems with sessionProvider', () => {
  test('all VIP items priced over HTTPS with the bridge usable: mode=full and OpenCLI never spawned', async () => {
    const { db, recorded } = makeDb();
    let execCalls = 0;
    const results = await collectPricesForActiveItems({
      dbInstance: db,
      execFn: () => { execCalls++; throw new Error('should not be called'); },
      fetchFn: directFetch,
      sessionProvider: async () => 'app_atk=x',
      authFetchFn: async (g) => authInfo(g, 13000 + g),
      authDelayMs: 0,
      delayMs: 0,
    });
    assert.equal(execCalls, 0);
    assert.equal(results.mode, 'full');
    assert.equal(recorded.runs[0].mode, 'full');
  });

  test('all VIP items priced over HTTPS while asleep: no OpenCLI, no direct fetch, but mode stays deferred so the awake upgrade run still syncs likes', async () => {
    const { db, recorded } = makeDb();
    let execCalls = 0;
    let directCalls = 0;
    const results = await collectPricesForActiveItems({
      dbInstance: db,
      execFn: () => { execCalls++; throw new Error('should not be called'); },
      fetchFn: async (g) => { directCalls++; return directFetch(g); },
      sessionProvider: async () => 'app_atk=x',
      authFetchFn: async (g) => authInfo(g, 13000 + g),
      authDelayMs: 0,
      skipOpenCli: true,
      delayMs: 0,
    });
    assert.equal(execCalls, 0);
    assert.equal(directCalls, 0);
    assert.equal(results.mode, 'deferred');
    assert.equal(results.authPriced, 2);
    assert.equal(recorded.runs[0].mode, 'deferred');
    assert.deepEqual(recorded.logs.map((l) => l.my_price).sort(), [13001, 13002]);
  });

  test('items that fail over HTTPS fall back to OpenCLI for just those items', async () => {
    const { db, recorded } = makeDb();
    const execCmds = [];
    const results = await collectPricesForActiveItems({
      dbInstance: db,
      execFn: (cmd) => {
        execCmds.push(cmd);
        return JSON.stringify([{ goodsNo: 2, normalPrice: '20,000', salePrice: '15,000', couponPrice: '14,000', myPrice: '12,000', status: '판매중' }]);
      },
      fetchFn: directFetch,
      sessionProvider: async () => 'app_atk=x',
      authFetchFn: async (g) => { if (g === 2) throw new Error('HTTP 500'); return authInfo(g, 13001); },
      authDelayMs: 0,
      openCliChunkSize: 2,
      delayMs: 0,
    });
    assert.equal(execCmds.length, 1);
    assert.match(execCmds[0], /my-prices "2"/);
    assert.equal(results.mode, 'full');
    const byGoods = Object.fromEntries(recorded.logs.map((l) => [l.goods_no, l.my_price]));
    assert.deepEqual(byGoods, { 1: 13001, 2: 12000 });
  });

  test('session unavailable while asleep: existing deferred path for all items', async () => {
    const { db, recorded } = makeDb();
    let directCalls = 0;
    const results = await collectPricesForActiveItems({
      dbInstance: db,
      execFn: () => { throw new Error('should not be called'); },
      fetchFn: async (g) => { directCalls++; return directFetch(g); },
      sessionProvider: async () => null,
      authFetchFn: async () => { throw new Error('should not be called'); },
      authDelayMs: 0,
      skipOpenCli: true,
      delayMs: 0,
    });
    assert.equal(directCalls, 2);
    assert.equal(results.mode, 'deferred');
    assert.equal(results.authPriced, 0);
    assert.equal(recorded.runs[0].mode, 'deferred');
  });
});
