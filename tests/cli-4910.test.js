import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, run4910Step, run4910Db } from '../src/cli.js';
import { createClient } from '../src/site4910/client.js';
import { Store4910 } from '../src/site4910/store.js';

const TODAY = '2026-10-10';

function fakeStore() {
  const store = { calls: [], closed: false };
  store.checkpoint = () => store.calls.push('checkpoint');
  store.close = () => {
    store.calls.push('close');
    store.closed = true;
  };
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
  brandCounts: [
    { sno: 2421, name: '유니클로', total: 10529, scanned: 10520, complete: true, problems: [] },
    { sno: 13647, name: 'GU', total: 5359, scanned: 5359, complete: true, problems: [] },
  ],
  diff: { initial: false, added: [{}, {}], priceChanged: 7, drops: [], revived: [], dropped: [{}] },
  durationMs: 1,
};

// Records the arguments track4910 would get and returns a canned result.
function trackSpy(result = RESULT) {
  const fn = async (args) => {
    fn.args = args;
    return args.dryRun ? { ...result, diff: null } : result;
  };
  return fn;
}

test('parseArgs treats --skip-4910 and --dry-run as booleans', () => {
  assert.deepEqual(parseArgs(['track-4910', '--dry-run', 'x']).flags, { 'dry-run': true });
  assert.deepEqual(parseArgs(['daily', '--skip-4910', 'x']).flags, { 'skip-4910': true });
  assert.deepEqual(parseArgs(['track-4910', '--brand', 'gu']).flags, { brand: 'gu' });
});

test('run4910Step skips with --skip-4910', async () => {
  let opened = false;
  const res = await run4910Step({ dbExists: () => true, flags: { 'skip-4910': true }, today: TODAY, openStore: () => { opened = true; } });
  assert.deepEqual(res, { ran: false, ok: true });
  assert.equal(opened, false);
});

test('run4910Step refuses to run without a DB file, before opening the store', async () => {
  let opened = false;
  const trackFn = trackSpy();
  const notify = spyFn();
  const log = logSpy();
  const res = await run4910Step({
    today: TODAY, dbExists: () => false, openStore: () => { opened = true; return fakeStore(); }, makeClient: () => ({}), trackFn, notify, log,
    readToken: () => { throw new Error('token must not be read'); },
  });
  assert.equal(res.ran, false);
  assert.equal(res.ok, false);
  assert.match(res.error, /4910\.db 없음/);
  assert.match(log.lines.join('\n'), /⚠️ \[4910\] 4910\.db 없음 — 먼저 `node src\/cli\.js 4910-db pull`/);
  assert.equal(opened, false);
  assert.equal(trackFn.args, undefined);
  assert.equal(notify.calls.length, 0);
});

test('a dry run does not need the DB file', async () => {
  const trackFn = trackSpy();
  const res = await run4910Step({ flags: { 'dry-run': true }, today: TODAY, dbExists: () => false, makeClient: () => ({}), trackFn, notify: spyFn(), log: logSpy() });
  assert.equal(res.ok, true);
  assert.equal(trackFn.args.store, null);
});

test('run4910Step swallows a client failure', async () => {
  const store = fakeStore();
  const notify = spyFn();
  const log = logSpy();
  const res = await run4910Step({ dbExists: () => true,
    today: TODAY,
    openStore: () => store,
    makeClient: () => ({}),
    trackFn: async () => {
      throw Object.assign(new Error('HTTP 403'), { status: 403 });
    },
    notify,
    log,
  });
  assert.equal(res.ran, true);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'HTTP 403');
  assert.equal(notify.calls.length, 0);
  assert.equal(store.closed, true);
  assert.match(log.lines.join('\n'), /⚠️ \[4910\] 수집 실패 \(HTTP 403\)/);
});

test('run4910Step swallows a store that fails to open', async () => {
  const log = logSpy();
  const res = await run4910Step({ dbExists: () => true, today: TODAY, openStore: () => { throw new Error('disk I/O error'); }, notify: spyFn(), log });
  assert.equal(res.ok, false);
  assert.match(log.lines.join('\n'), /⚠️ \[4910\] 수집 실패 \(disk I\/O error\)/);
});

test('run4910Step notifies once and checkpoints on success', async () => {
  const store = fakeStore();
  const notify = spyFn();
  const log = logSpy();
  const trackFn = trackSpy();
  const res = await run4910Step({ dbExists: () => true, today: TODAY, openStore: () => store, makeClient: () => ({ id: 'c' }), trackFn, notify, log });

  assert.equal(res.ok, true);
  assert.equal(res.result, RESULT);
  assert.equal(trackFn.args.store, store);
  assert.equal(trackFn.args.date, TODAY);
  assert.equal(typeof trackFn.args.makeClient, 'function');
  assert.equal(trackFn.args.brands, null, 'no --brand: track4910 resolves the top brands itself');
  assert.equal(trackFn.args.concurrency, 3);
  assert.equal(trackFn.args.memberToken, null);
  assert.equal(notify.calls.length, 1);
  assert.match(notify.calls[0][0], /4910 리포트 \(2026-10-10\)/);
  assert.deepEqual(store.calls, ['checkpoint', 'close']);
  assert.match(log.lines.join('\n'), /🇯🇵 \[4910\] 유니클로 10520 \/ GU 5359 스캔 — 가격변동 7, 신규 2, 종료 1/);
});

test('run4910Step --brand gu passes only GU', async () => {
  const trackFn = trackSpy();
  await run4910Step({ dbExists: () => true, flags: { brand: 'gu' }, today: TODAY, openStore: fakeStore, makeClient: () => ({}), trackFn, notify: spyFn(), log: logSpy() });
  assert.deepEqual(trackFn.args.brands.map((b) => b.sno), [13647]);
});

test('--brand 2421 scans only that brand; --brand nike is rejected', async () => {
  const trackFn = trackSpy();
  const common = { today: TODAY, openStore: fakeStore, makeClient: () => ({}), trackFn, notify: spyFn(), log: logSpy() };
  await run4910Step({ dbExists: () => true, ...common, flags: { brand: '2421' } });
  assert.deepEqual(trackFn.args.brands, [{ sno: 2421, name: 'brand 2421' }]);
  await run4910Step({ dbExists: () => true, ...common, flags: { brand: 'uniqlo' } });
  assert.deepEqual(trackFn.args.brands, [{ sno: 2421, name: '유니클로' }]);

  for (const bad of ['nike', 'constructor', '12ab', true]) {
    const spy = trackSpy();
    const log = logSpy();
    const res = await run4910Step({ dbExists: () => true, ...common, trackFn: spy, log, flags: { brand: bad } });
    assert.equal(res.ran, false);
    assert.equal(res.ok, false);
    assert.match(res.error, /unknown brand/);
    assert.equal(spy.args, undefined, `${bad} must not start a scan`);
    assert.match(log.lines.join('\n'), /⚠️ \[4910\] unknown brand/);
  }
});

test('--concurrency is clamped to 1-4 and defaults to 3', async () => {
  const seen = [];
  for (const concurrency of [undefined, '2', '5', '99', '0', 'fast', true]) {
    const trackFn = trackSpy();
    await run4910Step({ dbExists: () => true,
      flags: { concurrency }, today: TODAY, openStore: fakeStore, makeClient: () => ({}), trackFn, notify: spyFn(), log: logSpy(),
    });
    seen.push(trackFn.args.concurrency);
  }
  assert.deepEqual(seen, [3, 2, 4, 4, 1, 3, 3]);
});

test('the member token is read once and shared by the scan and the liked sync, which has its own client', async () => {
  const store = fakeStore();
  let reads = 0;
  const clients = [];
  const trackFn = trackSpy();
  const syncLikedFn = likedSpy();
  await run4910Step({ dbExists: () => true,
    today: TODAY, openStore: () => store, makeClient: () => { const c = { n: clients.length }; clients.push(c); return c; },
    trackFn, notify: spyFn(), log: logSpy(), syncLikedFn, readToken: () => { reads++; return 'T'; },
  });
  assert.equal(reads, 1);
  assert.equal(trackFn.args.memberToken, 'T');
  assert.equal(syncLikedFn.calls[0].memberToken, 'T');
  assert.equal(syncLikedFn.calls[0].client, clients[0]);
});

test('daily no longer runs the 4910 step', () => {
  const src = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function handleDailyRun');
  const end = src.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /run4910Step|4910/);
  assert.doesNotMatch(src.slice(src.indexOf('Commands:')), /daily[^\n]*4910|unless --skip-4910/);
});

test('run4910Db rejects an unknown subcommand without touching the release', () => {
  const log = logSpy();
  const calls = [];
  for (const sub of [undefined, 'sync']) {
    const res = run4910Db({ sub, dbPath: '/x/4910.db', pullFn: () => calls.push('pull'), pushFn: () => calls.push('push'), log });
    assert.equal(res.ok, false);
  }
  assert.deepEqual(calls, []);
  assert.match(log.lines[0], /Usage: .*4910-db pull\|push/);
});

test('run4910Db passes the DB path through and reports the byte count', () => {
  const log = logSpy();
  const seen = [];
  const pull = run4910Db({ sub: 'pull', dbPath: '/x/4910.db', pullFn: (a) => (seen.push(['pull', a]), { bytes: 1234567 }), log });
  const push = run4910Db({ sub: 'push', dbPath: '/x/4910.db', pushFn: (a) => (seen.push(['push', a]), { bytes: 42 }), log });
  const fresh = run4910Db({ sub: 'push', allowFresh: true, dbPath: '/x/4910.db', pushFn: (a) => (seen.push(['push', a]), { bytes: 1 }), log });
  assert.equal(fresh.ok, true);
  assert.deepEqual(seen, [
    ['pull', { dest: '/x/4910.db' }], ['push', { src: '/x/4910.db', allowFresh: false }], ['push', { src: '/x/4910.db', allowFresh: true }],
  ]);
  assert.deepEqual([pull, push], [{ ok: true, bytes: 1234567 }, { ok: true, bytes: 42 }]);
  assert.match(log.lines[0], /pulled 1,234,567 bytes/);
  assert.match(log.lines[1], /pushed 42 gzipped bytes/);
  assert.deepEqual(parseArgs(['4910-db', 'push', '--allow-fresh']), { command: '4910-db', flags: { 'allow-fresh': true }, positional: ['push'] });
});

test('run4910Db turns a failure into a warning, not a throw', () => {
  const log = logSpy();
  const res = run4910Db({ sub: 'push', dbPath: '/x/4910.db', pushFn: () => { throw new Error('gh release upload failed (exit 1): HTTP 502'); }, log });
  assert.equal(res.ok, false);
  assert.match(log.lines[0], /^⚠️ \[4910-db\] push failed: gh release upload failed.*HTTP 502/);
});

test('run4910Step --dry-run does not notify or open a store', async () => {
  let opened = false;
  const notify = spyFn();
  const log = logSpy();
  const trackFn = trackSpy();
  const res = await run4910Step({ dbExists: () => true,
    flags: { 'dry-run': true }, today: TODAY, openStore: () => { opened = true; }, makeClient: () => ({}), trackFn, notify, log,
  });
  assert.equal(res.ok, true);
  assert.equal(trackFn.args.dryRun, true);
  assert.equal(trackFn.args.store, null);
  assert.equal(opened, false);
  assert.equal(notify.calls.length, 0);
  assert.match(log.lines.join('\n'), /브랜드 2개 스캔 \(불완전 0\) · 판매글 15,879/);
});

test('a runner blocked by Cloudflare logs 수집 실패 and sends no digest (real client and store)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-4910-cli-'));
  let store;
  try {
    const notify = spyFn();
    const log = logSpy();
    const res = await run4910Step({ dbExists: () => true,
      today: TODAY,
      openStore: () => (store = new Store4910(path.join(dir, '4910.db'))),
      makeClient: () => createClient({ fetchFn: async () => new Response('<html>blocked</html>', { status: 403 }), delayMs: 0, retryBaseMs: 0 }),
      notify,
      log,
    });
    assert.equal(res.ok, false);
    assert.match(log.lines.join('\n'), /⚠️ \[4910\] 수집 실패 \(.*403/);
    assert.equal(notify.calls.length, 0);
    const check = new Store4910(path.join(dir, '4910.db'));
    assert.equal(check.db.prepare('SELECT COUNT(*) AS n FROM goods').get().n, 0);
    check.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const LIKED = { memberStatus: 'ok', liked: 3, logged: 3, drops: [] };

function likedSpy(result = LIKED) {
  const fn = async (args) => {
    fn.calls.push(args);
    return result;
  };
  fn.calls = [];
  return fn;
}

test('run4910Step runs the liked sync after the scan and passes it to the digest', async () => {
  const store = fakeStore();
  const notify = spyFn();
  const log = logSpy();
  const client = { id: 'c' };
  const syncLikedFn = likedSpy();
  const res = await run4910Step({ dbExists: () => true,
    today: TODAY, openStore: () => store, makeClient: () => client, trackFn: trackSpy(), notify, log, readToken: () => 'T', syncLikedFn,
  });
  assert.equal(res.ok, true);
  assert.equal(syncLikedFn.calls.length, 1);
  assert.deepEqual(syncLikedFn.calls[0], { client, store, date: TODAY, memberToken: 'T', log });
  assert.equal(notify.calls.length, 1);
  assert.match(notify.calls[0][0], /찜 3개 · 가격 기록 3개/);
  assert.equal(res.liked, LIKED);
  assert.match(log.lines.join('\n'), /💜 \[4910\] 찜 3개 · 가격 기록 3개 \(ok\)/);
  assert.doesNotMatch(log.lines.join('\n'), /\bT\b.*token/i);
  assert.deepEqual(store.calls, ['checkpoint', 'close']);
});

test('run4910Step without a token skips the liked sync', async () => {
  const notify = spyFn();
  const log = logSpy();
  const syncLikedFn = likedSpy();
  const res = await run4910Step({ dbExists: () => true,
    today: TODAY, openStore: fakeStore, makeClient: () => ({}), trackFn: trackSpy(), notify, log, readToken: () => null, syncLikedFn,
  });
  assert.equal(res.ok, true);
  assert.equal(res.liked, null);
  assert.equal(syncLikedFn.calls.length, 0);
  assert.match(log.lines.join('\n'), /ABLY_JWT_TOKEN 없음/);
  assert.equal(notify.calls.length, 1);
  assert.doesNotMatch(notify.calls[0][0], /찜|로그인 만료/);
});

test('a liked sync failure still sends the scan digest', async () => {
  const store = fakeStore();
  const notify = spyFn();
  const log = logSpy();
  const res = await run4910Step({ dbExists: () => true,
    today: TODAY, openStore: () => store, makeClient: () => ({}), trackFn: trackSpy(), notify, log, readToken: () => 'T',
    syncLikedFn: async () => {
      throw new Error('HTTP 500');
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.liked.memberStatus, 'error');
  assert.equal(notify.calls.length, 1);
  assert.match(notify.calls[0][0], /⚠️ 4910 찜 가격 기록 실패 — Actions 로그 확인/);
  assert.match(log.lines.join('\n'), /⚠️ \[4910\] 찜 가격 기록 실패 \(HTTP 500\)/);
  assert.deepEqual(store.calls, ['checkpoint', 'close']);
});

test('a failed scan still runs the liked sync but sends no digest', async () => {
  const notify = spyFn();
  const log = logSpy();
  const syncLikedFn = likedSpy();
  const res = await run4910Step({ dbExists: () => true,
    today: TODAY, openStore: fakeStore, makeClient: () => ({}), notify, log, readToken: () => 'T', syncLikedFn,
    trackFn: async () => {
      throw new Error('HTTP 403');
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'HTTP 403');
  assert.equal(syncLikedFn.calls.length, 1);
  assert.equal(notify.calls.length, 0);
  assert.match(log.lines.join('\n'), /⚠️ \[4910\] 수집 실패 \(HTTP 403\)/);
});

test('--dry-run never runs the liked sync', async () => {
  const syncLikedFn = likedSpy();
  const res = await run4910Step({ dbExists: () => true,
    flags: { 'dry-run': true }, today: TODAY, openStore: fakeStore, makeClient: () => ({}), trackFn: trackSpy(), notify: spyFn(), log: logSpy(),
    readToken: () => 'T', syncLikedFn,
  });
  assert.equal(res.ok, true);
  assert.equal(syncLikedFn.calls.length, 0);
});

test('a throwing readToken still sends the scan digest', async () => {
  const notify = spyFn();
  const log = logSpy();
  const syncLikedFn = likedSpy();
  const res = await run4910Step({ dbExists: () => true,
    today: TODAY, openStore: fakeStore, makeClient: () => ({}), trackFn: trackSpy(), notify, log, syncLikedFn,
    readToken: () => {
      throw new Error('EACCES: permission denied');
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.liked.memberStatus, 'error');
  assert.equal(notify.calls.length, 1);
  assert.match(notify.calls[0][0], /찜 가격 기록 실패 — Actions 로그 확인/);
  assert.equal(syncLikedFn.calls.length, 0);
  assert.match(log.lines.join('\n'), /찜 가격 기록 실패/);
});
