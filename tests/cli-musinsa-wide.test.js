import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, runMusinsaWideStep, runMusinsaDb } from '../src/cli.js';
import { CATEGORIES_MUSINSA, DEPTH_PAGES } from '../src/musinsaWide/client.js';

const TODAY = '2026-10-14';

function fakeStore() {
  const store = { calls: [], closed: false };
  store.checkpoint = () => store.calls.push('checkpoint');
  store.close = () => {
    store.calls.push('close');
    store.closed = true;
  };
  store.getGoods = () => undefined;
  return store;
}
function spyFn() {
  const fn = async (...args) => {
    fn.calls.push(args);
    return true;
  };
  fn.calls = [];
  return fn;
}
function logSpy() {
  const fn = (...args) => fn.lines.push(args.join(' '));
  fn.lines = [];
  return fn;
}

const RESULT = {
  date: TODAY,
  categoryCounts: [{ cat: '001', scanned: 180, pages: 3, complete: true, problems: [] }],
  diff: { initial: false, added: [{}, {}], priceChanged: 7, drops: [], revived: [], outOfScope: 1 },
  coupons: { memberStatus: 'ok', checked: 10, failed: 0, priced: 5, stale: 2, drops: [] },
  durationMs: 1,
};

function trackSpy(result = RESULT) {
  const fn = async (args) => {
    fn.args = args;
    return args.dryRun ? { ...result, diff: null, coupons: null } : result;
  };
  return fn;
}

function common(over = {}) {
  return { today: TODAY, dbExists: () => true, openStore: fakeStore, makeClient: () => ({}), makeProvider: () => 'PROVIDER', trackFn: trackSpy(), notify: spyFn(), log: logSpy(), ...over };
}

test('parseArgs treats --init as a boolean and passes --category/--depth values', () => {
  assert.deepEqual(parseArgs(['track-musinsa', '--init', 'x']).flags, { init: true });
  assert.deepEqual(parseArgs(['track-musinsa', '--category', '001,002', '--depth', '3']).flags, { category: '001,002', depth: '3' });
});

test('track-musinsa refuses to write without a DB unless --init', async () => {
  let opened = false;
  const trackFn = trackSpy();
  const notify = spyFn();
  const log = logSpy();
  const res = await runMusinsaWideStep(common({
    dbExists: () => false, openStore: () => { opened = true; return fakeStore(); }, trackFn, notify, log,
    makeProvider: () => { throw new Error('provider must not be made'); },
  }));
  assert.equal(res.ran, false);
  assert.equal(res.ok, false);
  assert.match(res.error, /musinsa-wide\.db 없음/);
  assert.match(log.lines.join('\n'), /⚠️ \[무신사\] musinsa-wide\.db 없음 — 먼저 `node src\/cli\.js musinsa-db pull`/);
  assert.equal(opened, false);
  assert.equal(trackFn.args, undefined);
  assert.equal(notify.calls.length, 0);

  const store = fakeStore();
  const init = await runMusinsaWideStep(common({ dbExists: () => false, flags: { init: true }, openStore: () => store, trackFn: trackSpy(), notify: spyFn() }));
  assert.equal(init.ok, true);
  assert.deepEqual(store.calls, ['checkpoint', 'close']);

  const dry = await runMusinsaWideStep(common({ dbExists: () => false, flags: { 'dry-run': true } }));
  assert.equal(dry.ok, true, 'a dry run never needs the DB');
});

test('--category and --depth pass through and mark the run partial', async () => {
  const full = trackSpy();
  await runMusinsaWideStep(common({ trackFn: full }));
  assert.deepEqual(full.args.categories, CATEGORIES_MUSINSA);
  assert.equal(full.args.depthPages, DEPTH_PAGES);
  assert.equal(full.args.partial, false);
  assert.equal(full.args.date, TODAY);
  assert.equal(full.args.concurrency, 3);
  assert.equal(full.args.sessionProvider, 'PROVIDER');
  assert.equal(typeof full.args.makeClient, 'function');

  const cat = trackSpy();
  await runMusinsaWideStep(common({ trackFn: cat, flags: { category: '001,103' } }));
  assert.deepEqual(cat.args.categories, ['001', '103']);
  assert.equal(cat.args.depthPages, DEPTH_PAGES);
  assert.equal(cat.args.partial, true);

  const depth = trackSpy();
  await runMusinsaWideStep(common({ trackFn: depth, flags: { depth: '3' } }));
  assert.deepEqual(depth.args.categories, CATEGORIES_MUSINSA);
  assert.equal(depth.args.depthPages, 3);
  assert.equal(depth.args.partial, true);
});

test('an unknown --category or a bad --depth fails without running', async () => {
  const cases = [{ category: '999' }, { category: '001,xyz' }, { category: true }, { depth: '0' }, { depth: '101' }, { depth: '2.5' }, { depth: 'abc' }, { depth: true }];
  for (const flags of cases) {
    const trackFn = trackSpy();
    const log = logSpy();
    let opened = false;
    const res = await runMusinsaWideStep(common({ flags, trackFn, log, openStore: () => { opened = true; return fakeStore(); } }));
    assert.equal(res.ran, false, JSON.stringify(flags));
    assert.equal(res.ok, false, JSON.stringify(flags));
    assert.ok(res.error);
    assert.match(log.lines.join('\n'), /⚠️ \[무신사\]/);
    assert.equal(trackFn.args, undefined);
    assert.equal(opened, false);
  }
  const edge = trackSpy();
  const res = await runMusinsaWideStep(common({ trackFn: edge, flags: { depth: '100' } }));
  assert.equal(res.ok, true);
  assert.equal(edge.args.depthPages, 100);
});

test('--concurrency is clamped to 1-4 and defaults to 3', async () => {
  const seen = [];
  for (const concurrency of [undefined, '2', '5', '99', '0', 'fast', true]) {
    const trackFn = trackSpy();
    await runMusinsaWideStep(common({ flags: { concurrency }, trackFn }));
    seen.push(trackFn.args.concurrency);
  }
  assert.deepEqual(seen, [3, 2, 4, 4, 1, 3, 3]);
});

test('a dry run never notifies; a write run notifies once', async () => {
  const dryNotify = spyFn();
  const dryLog = logSpy();
  const dryTrack = trackSpy();
  let made = 0;
  let opened = false;
  const dry = await runMusinsaWideStep(common({
    flags: { 'dry-run': true }, notify: dryNotify, log: dryLog, trackFn: dryTrack,
    makeProvider: () => { made++; return 'P'; }, openStore: () => { opened = true; return fakeStore(); },
  }));
  assert.equal(dry.ok, true);
  assert.equal(dryNotify.calls.length, 0);
  assert.equal(dryTrack.args.dryRun, true);
  assert.equal(dryTrack.args.store, null);
  assert.equal(dryTrack.args.sessionProvider, null);
  assert.equal(made, 0, 'a dry run needs no cookie');
  assert.equal(opened, false);
  assert.match(dryLog.lines.join('\n'), /무신사 와이드 리포트/);

  const store = fakeStore();
  const notify = spyFn();
  const log = logSpy();
  const trackFn = trackSpy();
  const res = await runMusinsaWideStep(common({ openStore: () => store, notify, log, trackFn }));
  assert.equal(res.ok, true);
  assert.equal(res.result, RESULT);
  assert.equal(trackFn.args.store, store);
  assert.equal(notify.calls.length, 1);
  assert.match(notify.calls[0][0], /무신사 와이드 리포트 \(2026-10-14\)/);
  assert.deepEqual(store.calls, ['checkpoint', 'close']);
  assert.match(log.lines.join('\n'), /\[무신사\].*신규 2.*가격변동 7/);
});

test('the digest looks up goods through the store', async () => {
  const store = fakeStore();
  store.getGoods = (no) => (no === 5 ? { brand_name: 'B', name: 'Shirt', url: 'https://u/5' } : undefined);
  const result = { ...RESULT, coupons: { ...RESULT.coupons, drops: [{ goods_no: 5, prevPrice: 1000, currentPrice: 800, dropRate: 20 }] } };
  const notify = spyFn();
  await runMusinsaWideStep(common({ openStore: () => store, trackFn: trackSpy(result), notify }));
  assert.match(notify.calls[0][0], /Shirt/);
});

test('a failing track returns ok:false and still closes the store', async () => {
  const store = fakeStore();
  const notify = spyFn();
  const log = logSpy();
  const res = await runMusinsaWideStep(common({
    openStore: () => store, notify, log, trackFn: async () => { throw new Error('HTTP 403'); },
  }));
  assert.equal(res.ran, true);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'HTTP 403');
  assert.equal(notify.calls.length, 0);
  assert.deepEqual(store.calls, ['checkpoint', 'close']);
  assert.match(log.lines.join('\n'), /⚠️ \[무신사\] 수집 실패 \(HTTP 403\)/);

  const openFail = logSpy();
  const res2 = await runMusinsaWideStep(common({ openStore: () => { throw new Error('disk I/O error'); }, log: openFail }));
  assert.equal(res2.ok, false);
  assert.match(openFail.lines.join('\n'), /⚠️ \[무신사\] 수집 실패 \(disk I\/O error\)/);
});

test('musinsa-db rejects an unknown subcommand and reports pull/push', () => {
  const log = logSpy();
  const calls = [];
  for (const sub of [undefined, 'sync']) {
    const res = runMusinsaDb({ sub, dbPath: '/x/m.db', pullFn: () => calls.push('pull'), pushFn: () => calls.push('push'), log });
    assert.equal(res.ok, false);
  }
  assert.deepEqual(calls, []);
  assert.match(log.lines[0], /Usage: .*musinsa-db pull\|push/);

  const seen = [];
  const out = logSpy();
  const pull = runMusinsaDb({ sub: 'pull', dbPath: '/x/m.db', pullFn: (a) => (seen.push(['pull', a]), { bytes: 1234567 }), log: out });
  const push = runMusinsaDb({ sub: 'push', allowFresh: true, dbPath: '/x/m.db', pushFn: (a) => (seen.push(['push', a]), { bytes: 42 }), log: out });
  assert.deepEqual(seen, [['pull', { dest: '/x/m.db' }], ['push', { src: '/x/m.db', allowFresh: true }]]);
  assert.deepEqual([pull, push], [{ ok: true, bytes: 1234567 }, { ok: true, bytes: 42 }]);
  assert.match(out.lines[0], /\[musinsa-db\] pulled 1,234,567 bytes/);
  assert.match(out.lines[1], /\[musinsa-db\] pushed 42 gzipped bytes/);

  const prev = logSpy();
  runMusinsaDb({ sub: 'pull', dbPath: '/x/m.db', pullFn: () => ({ bytes: 1, source: 'prev' }), log: prev });
  assert.match(prev.lines[1], /^⚠️ \[musinsa-db\] .*prev/);

  const fail = logSpy();
  const bad = runMusinsaDb({ sub: 'push', dbPath: '/x/m.db', pushFn: () => { throw new Error('HTTP 502'); }, log: fail });
  assert.equal(bad.ok, false);
  assert.match(fail.lines[0], /^⚠️ \[musinsa-db\] push failed: HTTP 502/);
});
