import './setup-env.js';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClotDatabase } from '../src/db.js';
import { syncLikedItemsFromMusinsa } from '../src/sync.js';
import { SessionExpiredError } from '../src/myprice.js';
import { LikesIncompleteError } from '../src/likes-https.js';

let tempDir;
let dbi;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-sync-https-'));
  dbi = new ClotDatabase(path.join(tempDir, 'prices.db'));
});
afterEach(() => {
  dbi.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const remote = (...nos) =>
  nos.map((n) => ({ goodsNo: n, goodsName: `Goods ${n}`, brandName: `Brand ${n}`, url: `https://www.musinsa.com/products/${n}`, status: '판매중' }));
const seedLikes = (...nos) =>
  nos.forEach((n) =>
    dbi.upsertItem({ goods_no: n, goods_name: `Goods ${n}`, brand_name: `Brand ${n}`, url: `https://www.musinsa.com/products/${n}`, source: 'like', status: 'ACTIVE' })
  );
const statusOf = (n) => dbi.getItem(n)?.status;

/** Returns cookies[i] on the i-th call (last one repeats). */
function provider(cookies = ['old']) {
  const calls = [];
  const absorbed = [];
  const p = async (o = {}) => {
    calls.push(o);
    return cookies[Math.min(calls.length - 1, cookies.length - 1)];
  };
  p.absorb = (h) => { absorbed.push(h); return { cookie: null, revoked: false }; };
  p.calls = calls;
  p.absorbed = absorbed;
  return p;
}
const counter = () => { const c = { n: 0 }; c.fn = async () => { c.n++; }; return c; };
const noExec = () => { throw new Error('OpenCLI must not run'); };
const execReturning = (items) => { const e = () => JSON.stringify(items); return e; };
const base = (extra) => ({ dbInstance: dbi, httpsDelayMs: 0, ...extra });

describe('syncLikedItemsFromMusinsa over HTTPS', () => {
  test('HTTPS success: no OpenCLI, no prewarm, applies adds and unlikes, source=https', async () => {
    seedLikes(1, 2);
    const prewarm = counter();
    const seen = [];
    const res = await syncLikedItemsFromMusinsa(base({
      sessionProvider: provider(),
      httpsFetchFn: async (cookie, o) => { seen.push({ cookie, delayMs: o.delayMs }); return remote(1, 3); },
      execFn: noExec,
      prewarmFn: prewarm.fn,
    }));
    assert.equal(res.source, 'https');
    assert.deepEqual(seen, [{ cookie: 'old', delayMs: 0 }]);
    assert.equal(prewarm.n, 0);
    assert.deepEqual(res.newItems.map((i) => i.goodsNo), [3]);
    assert.deepEqual(res.unlikedItems.map((i) => i.goods_no), [2]);
    assert.equal(statusOf(2), 'UNLIKED');
    assert.equal(res.totalRemote, 2);
  });

  test('incomplete HTTPS list -> falls back to OpenCLI (with prewarm), nothing from HTTPS applied', async () => {
    seedLikes(1, 2);
    const prewarm = counter();
    const res = await syncLikedItemsFromMusinsa(base({
      sessionProvider: provider(),
      httpsFetchFn: async () => { throw new LikesIncompleteError('received 1 of 2 liked goods'); },
      execFn: execReturning(remote(1, 2)),
      prewarmFn: prewarm.fn,
    }));
    assert.equal(res.source, 'opencli');
    assert.equal(prewarm.n, 1);
    assert.equal(res.unlikedItems.length, 0);
    assert.equal(statusOf(1), 'ACTIVE');
    assert.equal(statusOf(2), 'ACTIVE');
  });

  test('refresh restarts from scratch: first SessionExpired -> refresh(failedCookie) -> full retry', async () => {
    const p = provider(['old', 'new']);
    const cookies = [];
    const res = await syncLikedItemsFromMusinsa(base({
      sessionProvider: p,
      httpsFetchFn: async (cookie) => {
        cookies.push(cookie);
        if (cookie === 'old') throw new SessionExpiredError();
        return remote(1);
      },
      execFn: noExec,
    }));
    assert.equal(res.source, 'https');
    assert.deepEqual(cookies, ['old', 'new']);
    assert.deepEqual(p.calls, [{ refresh: false }, { refresh: true, failedCookie: 'old' }]);
  });

  test('SessionExpired twice -> OpenCLI fallback', async () => {
    const res = await syncLikedItemsFromMusinsa(base({
      sessionProvider: provider(['old', 'new']),
      httpsFetchFn: async () => { throw new SessionExpiredError(); },
      execFn: execReturning(remote(1)),
    }));
    assert.equal(res.source, 'opencli');
  });

  test('provider returns null or throws -> HTTPS not attempted, OpenCLI fallback', async () => {
    for (const sessionProvider of [async () => null, async () => { throw new Error('bridge down'); }]) {
      let httpsCalls = 0;
      const res = await syncLikedItemsFromMusinsa(base({
        sessionProvider,
        httpsFetchFn: async () => { httpsCalls++; return remote(1); },
        execFn: execReturning(remote(1)),
      }));
      assert.equal(httpsCalls, 0);
      assert.equal(res.source, 'opencli');
    }
  });

  test('allowOpenCli=false: HTTPS failure throws, no exec, no prewarm, DB untouched', async () => {
    seedLikes(1, 2);
    const prewarm = counter();
    await assert.rejects(
      syncLikedItemsFromMusinsa(base({
        sessionProvider: provider(),
        httpsFetchFn: async () => { throw new Error('HTTP 500 for /api2/like/like-page/v1/tab/goods'); },
        execFn: noExec,
        prewarmFn: prewarm.fn,
        allowOpenCli: false,
      })),
      /unavailable via HTTPS/
    );
    assert.equal(prewarm.n, 0);
    assert.equal(statusOf(1), 'ACTIVE');
    assert.equal(statusOf(2), 'ACTIVE');
  });

  test('safety guardrail still applies to the HTTPS path', async () => {
    seedLikes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
    const res = await syncLikedItemsFromMusinsa(base({
      sessionProvider: provider(),
      httpsFetchFn: async () => remote(1, 2, 3),
      execFn: noExec,
    }));
    assert.equal(res.unlikedItems.length, 0);
    assert.equal(statusOf(10), 'ACTIVE');
  });

  test('onSetCookie is wired to provider.absorb', async () => {
    const p = provider();
    await syncLikedItemsFromMusinsa(base({
      sessionProvider: p,
      httpsFetchFn: async (_c, o) => { o.onSetCookie(['__cf_bm=x']); return remote(1); },
      execFn: noExec,
    }));
    assert.deepEqual(p.absorbed, [['__cf_bm=x']]);
  });

  test('no sessionProvider: OpenCLI path as before, source=opencli', async () => {
    const res = await syncLikedItemsFromMusinsa(base({ execFn: execReturning(remote(7)) }));
    assert.equal(res.source, 'opencli');
    assert.deepEqual(res.newItems.map((i) => i.goodsNo), [7]);
  });
});
