import './setup-env.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  keepSessionAlive, writeSessionCookie, readSessionCookie, readSessionMeta, getSessionCookie,
  refreshSessionCookie, verifySession,
} from '../src/session.js';
import { sessionKeeperSuffix } from '../src/cli.js';

const SECRET_ATK = 'SECRETATKVALUE123';
const SECRET_RTK = 'SECRETRTKVALUE456';
const COOKIE = `app_atk=${SECRET_ATK}; app_rtk=${SECRET_RTK}; mss_mac=MACVALUE789`;
const okVerify = async (cookie) => ({ loggedIn: true, cookie, rotated: false });
const deadVerify = async (cookie) => ({ loggedIn: false, cookie, rotated: false });
const unknownVerify = async (cookie) => ({ loggedIn: null, cookie, rotated: false });
let tmpPath;

beforeEach(() => {
  tmpPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clot-keeper-')), 'session.json');
});

describe('keepSessionAlive', () => {
  test('bridge unusable: skipped, no verify, no bridge', async () => {
    writeSessionCookie(COOKIE, tmpPath);
    let calls = 0;
    const r = await keepSessionAlive({
      bridgeUsable: false, path: tmpPath,
      verify: async (c) => { calls++; return okVerify(c); }, fetchFromBridge: async () => { calls++; return COOKIE; },
    });
    assert.equal(r.status, 'skipped');
    assert.equal(calls, 0);
  });

  test('valid or unknown cache: ok, bridge untouched', async () => {
    for (const verify of [okVerify, unknownVerify]) {
      writeSessionCookie(COOKIE, tmpPath);
      let bridgeCalls = 0;
      const r = await keepSessionAlive({ bridgeUsable: true, path: tmpPath, verify, fetchFromBridge: async () => { bridgeCalls++; return null; } });
      assert.equal(r.status, 'ok');
      assert.equal(r.cached, true);
      assert.equal(bridgeCalls, 0);
    }
  });

  test('dead cache: lifetime recorded, renewed through the bridge', async () => {
    writeSessionCookie(COOKIE, tmpPath, { now: new Date(Date.now() - 12 * 3_600_000) });
    const fresh = 'app_atk=NEW; app_rtk=R2';
    const r = await keepSessionAlive({ bridgeUsable: true, path: tmpPath, verify: deadVerify, fetchFromBridge: async () => fresh });
    assert.equal(r.status, 'renewed');
    assert.equal(readSessionCookie(tmpPath), fresh);
    assert.equal(readSessionMeta(tmpPath).observedLifetimeHours[0], 12);
  });

  test('no cache: bridge is tried; failure -> lost', async () => {
    const r = await keepSessionAlive({ bridgeUsable: true, path: tmpPath, verify: okVerify, fetchFromBridge: async () => null });
    assert.equal(r.status, 'lost');
    assert.equal(r.cached, false);
  });
});

describe('keepSessionAlive bridge backoff', () => {
  const T0 = new Date('2026-09-26T03:00:00Z');
  const plus = (min) => new Date(T0.getTime() + min * 60_000);
  const bridgeSpy = (value) => {
    const fn = async () => { fn.calls++; return typeof value === 'function' ? value() : value; };
    fn.calls = 0;
    return fn;
  };

  test('after a failed bridge attempt, ticks within 2 h stay lost without opening Chrome', async () => {
    const bridge = bridgeSpy(null);
    assert.equal((await keepSessionAlive({ bridgeUsable: true, path: tmpPath, verify: okVerify, fetchFromBridge: bridge, now: T0 })).status, 'lost');
    assert.equal((await keepSessionAlive({ bridgeUsable: true, path: tmpPath, verify: okVerify, fetchFromBridge: bridge, now: plus(30) })).status, 'lost');
    assert.equal((await keepSessionAlive({ bridgeUsable: true, path: tmpPath, verify: okVerify, fetchFromBridge: bridge, now: plus(119) })).status, 'lost');
    assert.equal(bridge.calls, 1);
  });

  test('the bridge is retried once the 2 h backoff has passed', async () => {
    const bridge = bridgeSpy(null);
    await keepSessionAlive({ bridgeUsable: true, path: tmpPath, verify: okVerify, fetchFromBridge: bridge, now: T0 });
    await keepSessionAlive({ bridgeUsable: true, path: tmpPath, verify: okVerify, fetchFromBridge: bridge, now: plus(120) });
    assert.equal(bridge.calls, 2);
  });

  test('a successful renewal clears the backoff so the next death retries immediately', async () => {
    let result = null;
    const bridge = bridgeSpy(() => result);
    await keepSessionAlive({ bridgeUsable: true, path: tmpPath, verify: okVerify, fetchFromBridge: bridge, now: T0 });
    result = COOKIE;
    assert.equal((await keepSessionAlive({ bridgeUsable: true, path: tmpPath, verify: okVerify, fetchFromBridge: bridge, now: plus(150) })).status, 'renewed');
    result = null;
    assert.equal((await keepSessionAlive({ bridgeUsable: true, path: tmpPath, verify: deadVerify, fetchFromBridge: bridge, now: plus(160) })).status, 'lost');
    assert.equal(bridge.calls, 3);
  });

  test('collection runs (getSessionCookie) ignore the keeper backoff', async () => {
    const bridge = bridgeSpy(null);
    await keepSessionAlive({ bridgeUsable: true, path: tmpPath, verify: okVerify, fetchFromBridge: bridge, now: T0 });
    await getSessionCookie({ path: tmpPath, verify: okVerify, fetchFromBridge: bridge });
    assert.equal(bridge.calls, 2);
  });
});

describe('sessionKeeperSuffix', () => {
  const awake = { bridgeUsable: true };

  test('bridge unusable -> empty suffix, keeper not called', async () => {
    let called = false;
    const s = await sessionKeeperSuffix({ power: { bridgeUsable: false }, today: '2026-09-26', keep: async () => { called = true; }, sessionPath: tmpPath });
    assert.equal(s, '');
    assert.equal(called, false);
  });

  test('formats status and age', async () => {
    const keep = async () => ({ status: 'ok', cached: true, ageHours: 5.1, observedLifetimeHours: [] });
    assert.equal(await sessionKeeperSuffix({ power: awake, today: '2026-09-26', keep, sessionPath: tmpPath }), ' session=ok age=5.1h');
  });

  test('lost: notifies once per day', async () => {
    const keep = async () => ({ status: 'lost', cached: false, ageHours: null, observedLifetimeHours: [] });
    let notified = 0;
    const notify = async () => { notified++; };
    for (let i = 0; i < 3; i++) {
      assert.equal(await sessionKeeperSuffix({ power: awake, today: '2026-09-26', keep, notify, sessionPath: tmpPath }), ' session=lost');
    }
    assert.equal(notified, 1);
    await sessionKeeperSuffix({ power: awake, today: '2026-09-27', keep, notify, sessionPath: tmpPath });
    assert.equal(notified, 2);
  });

  test('a failing notifier does not break the tick', async () => {
    const keep = async () => ({ status: 'lost', cached: false, ageHours: null, observedLifetimeHours: [] });
    const s = await sessionKeeperSuffix({ power: awake, today: '2026-09-26', keep, notify: async () => { throw new Error('telegram down'); }, sessionPath: tmpPath });
    assert.equal(s, ' session=lost');
  });

  test('keeper failure does not break the tick', async () => {
    const keep = async () => { throw new Error('EACCES: permission denied'); };
    assert.equal(await sessionKeeperSuffix({ power: awake, today: '2026-09-26', keep, sessionPath: tmpPath }), ' session=error');
  });
});

describe('no token leaks to console', () => {
  test('verify/get/refresh/keeper/suffix never print cookie values', async () => {
    const lines = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(' '));
    try {
      writeSessionCookie(COOKIE, tmpPath);
      await verifySession(COOKIE, { fetchFn: async () => { throw new Error('boom'); } });
      await getSessionCookie({ path: tmpPath, verify: deadVerify, fetchFromBridge: async () => COOKIE });
      await refreshSessionCookie({ path: tmpPath, verify: deadVerify, fetchFromBridge: async () => null });
      await keepSessionAlive({ bridgeUsable: true, path: tmpPath, verify: deadVerify, fetchFromBridge: async () => COOKIE });
      await sessionKeeperSuffix({
        power: { bridgeUsable: true }, today: '2026-09-26', sessionPath: tmpPath, notify: async () => {},
        keep: () => keepSessionAlive({ bridgeUsable: true, path: tmpPath, verify: deadVerify, fetchFromBridge: async () => null }),
      });
    } finally {
      Object.assign(console, orig);
    }
    const out = lines.join('\n');
    for (const secret of [SECRET_ATK, SECRET_RTK, 'MACVALUE789']) assert.equal(out.includes(secret), false);
  });
});
