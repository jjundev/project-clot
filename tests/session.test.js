import './setup-env.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SESSION_PATH, pickAuthCookies, readSessionCookie, writeSessionCookie, clearSessionCookie,
  fetchSessionCookieFromBridge, getSessionCookie, refreshSessionCookie, makeSessionProvider,
  parseAuthCookies, serializeAuthCookies, mergeAuthSetCookies, readSessionMeta, updateSessionMeta,
  recordObservedLifetime, describeSession, formatSessionSummary, verifySession, LOGIN_STATUS_URL,
} from '../src/session.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE = 'app_atk=AAA; app_rtk=BBB; mss_mac=CCC';
const okVerify = async (cookie) => ({ loggedIn: true, cookie, rotated: false });
const deadVerify = async (cookie) => ({ loggedIn: false, cookie, rotated: false });
const unknownVerify = async (cookie) => ({ loggedIn: null, cookie, rotated: false });

function jsonRes(status, body, setCookies = []) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { getSetCookie: () => setCookies },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}
let tmpPath;

beforeEach(() => {
  tmpPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clot-session-')), 'nested', 'session.json');
});

describe('session cache', () => {
  test('default cache path lives outside the repo (data/ is auto-committed)', () => {
    assert.equal(DEFAULT_SESSION_PATH.startsWith(REPO_ROOT + path.sep), false);
    assert.equal(DEFAULT_SESSION_PATH, path.join(os.homedir(), '.clot', 'musinsa-session.json'));
  });

  test('pickAuthCookies keeps only the three auth cookies', () => {
    assert.equal(pickAuthCookies('_ga=1; app_atk=AAA; cart_no=9; app_rtk=BBB; mss_mac=CCC; _fbp=2'), COOKIE);
    assert.equal(pickAuthCookies(''), '');
  });

  test('write then read round-trips, file mode is 0600', () => {
    writeSessionCookie(COOKIE, tmpPath);
    assert.equal(readSessionCookie(tmpPath), COOKIE);
    assert.equal(fs.statSync(tmpPath).mode & 0o777, 0o600);
  });

  test('missing, corrupt, or cookie-less cache files read as null', () => {
    assert.equal(readSessionCookie(tmpPath), null);
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, '{not json');
    assert.equal(readSessionCookie(tmpPath), null);
    fs.writeFileSync(tmpPath, JSON.stringify({ cookie: '_ga=1' }));
    assert.equal(readSessionCookie(tmpPath), null);
    fs.writeFileSync(tmpPath, '');
    assert.equal(readSessionCookie(tmpPath), null);
  });

  test('a cached cookie is re-filtered so only the three auth cookies are sent', () => {
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify({ cookie: '_ga=1; app_atk=AAA; evil=x; app_rtk=BBB; mss_mac=CCC' }));
    assert.equal(readSessionCookie(tmpPath), COOKIE);
  });

  test('clearSessionCookie drops the cookie but keeps metadata, and tolerates absence', () => {
    writeSessionCookie(COOKIE, tmpPath);
    updateSessionMeta({ lastWarnedOn: '2026-09-26' }, tmpPath);
    clearSessionCookie(tmpPath);
    assert.equal(readSessionCookie(tmpPath), null);
    assert.equal(readSessionMeta(tmpPath).lastWarnedOn, '2026-09-26');
    assert.equal(fs.statSync(tmpPath).mode & 0o777, 0o600);
    fs.rmSync(tmpPath);
    clearSessionCookie(tmpPath);
    assert.equal(fs.existsSync(tmpPath), false);
  });
});

describe('fetchSessionCookieFromBridge', () => {
  test('opens musinsa, reads document.cookie (JSON-quoted), filters, and always closes', () => {
    const cmds = [];
    const execFn = (cmd) => {
      cmds.push(cmd);
      if (cmd.includes(' eval ')) return JSON.stringify('_ga=1; app_atk=AAA; app_rtk=BBB; mss_mac=CCC');
      return '';
    };
    assert.equal(fetchSessionCookieFromBridge({ execFn }), COOKIE);
    assert.match(cmds[0], /^opencli browser clot-auth open https:\/\/www\.musinsa\.com\/$/);
    assert.match(cmds.at(-1), /^opencli browser clot-auth close$/);
  });

  test('returns null when logged out (no app_atk) and still closes', () => {
    const cmds = [];
    const execFn = (cmd) => { cmds.push(cmd); return cmd.includes(' eval ') ? '"_ga=1"' : ''; };
    assert.equal(fetchSessionCookieFromBridge({ execFn }), null);
    assert.match(cmds.at(-1), /close$/);
  });

  test('returns null when the bridge throws', () => {
    const execFn = (cmd) => { if (cmd.includes(' open ')) throw new Error('ETIMEDOUT'); return ''; };
    assert.equal(fetchSessionCookieFromBridge({ execFn }), null);
  });
});

describe('verifySession', () => {
  test('logged in: sends the cookie to login-status and returns it unchanged', async () => {
    const calls = [];
    const fetchFn = async (url, opts) => {
      calls.push({ url, opts });
      return jsonRes(200, { data: { loggedIn: true, authTokenInfo: { accessToken: 'AAA', refreshToken: 'BBB' } } });
    };
    assert.deepEqual(await verifySession(COOKIE, { fetchFn }), { loggedIn: true, cookie: COOKIE, rotated: false });
    assert.equal(calls[0].url, LOGIN_STATUS_URL);
    assert.equal(calls[0].opts.headers.Cookie, COOKIE);
  });

  test('authTokenInfo with new tokens rotates the cookie', async () => {
    const fetchFn = async () => jsonRes(200, { data: { loggedIn: true, authTokenInfo: { accessToken: 'A2', refreshToken: 'B2' } } });
    assert.deepEqual(await verifySession(COOKIE, { fetchFn }), {
      loggedIn: true, cookie: 'app_atk=A2; app_rtk=B2; mss_mac=CCC', rotated: true,
    });
  });

  test('Set-Cookie rotation is applied', async () => {
    const fetchFn = async () => jsonRes(200, { data: { loggedIn: true } }, ['app_atk=A3; Path=/']);
    const r = await verifySession(COOKIE, { fetchFn });
    assert.equal(r.cookie, 'app_atk=A3; app_rtk=BBB; mss_mac=CCC');
    assert.equal(r.rotated, true);
  });

  test('loggedIn false and revoking Set-Cookie both report false', async () => {
    assert.equal((await verifySession(COOKIE, { fetchFn: async () => jsonRes(200, { data: { loggedIn: false } }) })).loggedIn, false);
    const revoking = async () => jsonRes(200, { data: { loggedIn: true } }, ['app_atk=; Max-Age=0']);
    assert.equal((await verifySession(COOKIE, { fetchFn: revoking })).loggedIn, false);
  });

  test('unknown status (throw, 5xx, HTML, missing flag) is null and keeps the cookie', async () => {
    const cases = [
      async () => { throw new Error('ECONNRESET'); },
      async () => jsonRes(503, {}),
      async () => jsonRes(200, '<html>cf challenge</html>'),
      async () => jsonRes(200, { data: {} }),
    ];
    for (const fetchFn of cases) {
      assert.deepEqual(await verifySession(COOKIE, { fetchFn }), { loggedIn: null, cookie: COOKIE, rotated: false });
    }
  });
});

describe('getSessionCookie / refreshSessionCookie / makeSessionProvider', () => {
  const bridgeSpy = (value) => {
    const fn = async () => { fn.calls++; return value; };
    fn.calls = 0;
    return fn;
  };

  test('valid cache: verified, bridge untouched, lastVerifiedAt stamped', async () => {
    writeSessionCookie(COOKIE, tmpPath);
    const bridge = bridgeSpy('x');
    assert.equal(await getSessionCookie({ path: tmpPath, fetchFromBridge: bridge, verify: okVerify }), COOKIE);
    assert.equal(bridge.calls, 0);
    assert.ok(readSessionMeta(tmpPath).lastVerifiedAt);
  });

  test('rotated cookie from verify is persisted', async () => {
    writeSessionCookie(COOKIE, tmpPath);
    const verify = async () => ({ loggedIn: true, cookie: 'app_atk=NEW; app_rtk=BBB; mss_mac=CCC', rotated: true });
    assert.equal(await getSessionCookie({ path: tmpPath, verify }), 'app_atk=NEW; app_rtk=BBB; mss_mac=CCC');
    assert.equal(readSessionCookie(tmpPath), 'app_atk=NEW; app_rtk=BBB; mss_mac=CCC');
  });

  test('unknown status keeps cache: returns it, no bridge, not cleared', async () => {
    writeSessionCookie(COOKIE, tmpPath);
    const bridge = bridgeSpy('x');
    assert.equal(await getSessionCookie({ path: tmpPath, fetchFromBridge: bridge, verify: unknownVerify }), COOKIE);
    assert.equal(bridge.calls, 0);
    assert.equal(readSessionCookie(tmpPath), COOKIE);
  });

  test('dead cache + bridge allowed: records lifetime, renews via bridge', async () => {
    writeSessionCookie(COOKIE, tmpPath, { now: new Date(Date.now() - 2 * 3_600_000) });
    const fresh = 'app_atk=NEW; app_rtk=R2; mss_mac=CCC';
    assert.equal(await getSessionCookie({ path: tmpPath, fetchFromBridge: bridgeSpy(fresh), verify: deadVerify }), fresh);
    assert.equal(readSessionCookie(tmpPath), fresh);
    assert.equal(readSessionMeta(tmpPath).observedLifetimeHours.length, 1);
  });

  test('dead cache + bridge not allowed: cleared, null, bridge untouched', async () => {
    writeSessionCookie(COOKIE, tmpPath);
    const bridge = bridgeSpy('x');
    assert.equal(await getSessionCookie({ path: tmpPath, allowBridge: false, fetchFromBridge: bridge, verify: deadVerify }), null);
    assert.equal(bridge.calls, 0);
    assert.equal(readSessionCookie(tmpPath), null);
  });

  test('cache miss + allowBridge fetches and caches; verify is not called', async () => {
    let verifyCalls = 0;
    const verify = async (c) => { verifyCalls++; return okVerify(c); };
    assert.equal(await getSessionCookie({ path: tmpPath, fetchFromBridge: bridgeSpy(COOKIE), verify }), COOKIE);
    assert.equal(readSessionCookie(tmpPath), COOKIE);
    assert.equal(verifyCalls, 0);
  });

  test('cache miss + bridge not allowed returns null without calling the bridge', async () => {
    const bridge = bridgeSpy(COOKIE);
    assert.equal(await getSessionCookie({ path: tmpPath, allowBridge: false, fetchFromBridge: bridge, verify: okVerify }), null);
    assert.equal(bridge.calls, 0);
  });

  test('refresh: HTTPS verify succeeding avoids the bridge and keeps the cache', async () => {
    writeSessionCookie(COOKIE, tmpPath);
    const bridge = bridgeSpy('x');
    assert.equal(await refreshSessionCookie({ path: tmpPath, fetchFromBridge: bridge, verify: okVerify }), COOKIE);
    assert.equal(bridge.calls, 0);
    assert.equal(readSessionCookie(tmpPath), COOKIE);
  });

  test('refresh: unknown status is not trusted (page already said expired) -> bridge', async () => {
    writeSessionCookie(COOKIE, tmpPath);
    const fresh = 'app_atk=NEW; app_rtk=R2';
    assert.equal(await refreshSessionCookie({ path: tmpPath, fetchFromBridge: bridgeSpy(fresh), verify: unknownVerify }), fresh);
  });

  test('refresh clears the stale cache when the bridge is not allowed', async () => {
    writeSessionCookie(COOKIE, tmpPath);
    assert.equal(await refreshSessionCookie({ path: tmpPath, allowBridge: false, fetchFromBridge: bridgeSpy('x'), verify: deadVerify }), null);
    assert.equal(readSessionCookie(tmpPath), null);
  });

  test('provider: refresh=false reads cache, refresh=true re-fetches', async () => {
    writeSessionCookie('app_atk=OLD; app_rtk=R', tmpPath);
    let alive = true;
    const verify = async (c) => (alive ? okVerify(c) : deadVerify(c));
    const provider = makeSessionProvider({ path: tmpPath, fetchFromBridge: async () => 'app_atk=NEW; app_rtk=R', verify });
    assert.equal(await provider(), 'app_atk=OLD; app_rtk=R');
    alive = false;
    assert.equal(await provider({ refresh: true }), 'app_atk=NEW; app_rtk=R');
    assert.equal(readSessionCookie(tmpPath), 'app_atk=NEW; app_rtk=R');
  });

  test('provider.absorb: rotation persisted, revocation clears, no cache -> null', () => {
    const provider = makeSessionProvider({ path: tmpPath, verify: okVerify });
    assert.equal(provider.absorb(['app_atk=X']), null);
    writeSessionCookie(COOKIE, tmpPath);
    assert.deepEqual(provider.absorb(['__cf_bm=1']), { cookie: COOKIE, revoked: false });
    assert.deepEqual(provider.absorb(['app_atk=A2; Path=/']), { cookie: 'app_atk=A2; app_rtk=BBB; mss_mac=CCC', revoked: false });
    assert.equal(readSessionCookie(tmpPath), 'app_atk=A2; app_rtk=BBB; mss_mac=CCC');
    assert.deepEqual(provider.absorb(['app_rtk=; Max-Age=0']), { cookie: null, revoked: true });
    assert.equal(readSessionCookie(tmpPath), null);
  });

  test('provider.describe reports cache state', () => {
    const provider = makeSessionProvider({ path: tmpPath, verify: okVerify });
    assert.equal(provider.describe().cached, false);
    writeSessionCookie(COOKIE, tmpPath);
    assert.equal(provider.describe().cached, true);
  });
});

describe('cookie jar', () => {
  test('parse keeps only auth cookies; serialize uses canonical order', () => {
    const jar = parseAuthCookies('mss_mac=CCC; _ga=1; app_rtk=BBB; app_atk=AAA');
    assert.deepEqual([...jar.keys()].sort(), ['app_atk', 'app_rtk', 'mss_mac']);
    assert.equal(serializeAuthCookies(jar), COOKIE);
    assert.equal(serializeAuthCookies(parseAuthCookies(undefined)), '');
  });

  test('values containing "=" survive a round trip', () => {
    assert.equal(pickAuthCookies('app_atk=a%3D%3D=; app_rtk=B'), 'app_atk=a%3D%3D=; app_rtk=B');
  });

  test('readSessionCookie requires both app_atk and app_rtk', () => {
    writeSessionCookie('app_atk=AAA; mss_mac=CCC', tmpPath);
    assert.equal(readSessionCookie(tmpPath), null);
    writeSessionCookie('app_atk=AAA; app_rtk=BBB', tmpPath);
    assert.equal(readSessionCookie(tmpPath), 'app_atk=AAA; app_rtk=BBB');
  });

  test('legacy cache file ({cookie, savedAt} only) still loads', () => {
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify({ cookie: COOKIE, savedAt: '2026-09-26T07:25:15.669Z' }));
    assert.equal(readSessionCookie(tmpPath), COOKIE);
    assert.deepEqual(describeSession(tmpPath), { cached: true, ageHours: null, observedLifetimeHours: [] });
    assert.equal(formatSessionSummary(describeSession(tmpPath)), 'age ?');
  });

  test('merge: rotation replaces the value and reports rotated', () => {
    const r = mergeAuthSetCookies(COOKIE, ['app_atk=NEW; Path=/; Domain=musinsa.com; Secure', '__cf_bm=zzz; HttpOnly']);
    assert.equal(r.cookie, 'app_atk=NEW; app_rtk=BBB; mss_mac=CCC');
    assert.equal(r.rotated, true);
    assert.equal(r.revoked, false);
  });

  test('merge: same value and unrelated cookies are no-ops', () => {
    const r = mergeAuthSetCookies(COOKIE, ['app_atk=AAA; Path=/', 'SCOUTER=x']);
    assert.deepEqual(r, { cookie: COOKIE, rotated: false, revoked: false });
    assert.deepEqual(mergeAuthSetCookies(COOKIE, undefined), { cookie: COOKIE, rotated: false, revoked: false });
  });

  test('merge: empty value or Max-Age=0 on app_rtk revokes', () => {
    assert.equal(mergeAuthSetCookies(COOKIE, ['app_rtk=; Path=/']).revoked, true);
    const r = mergeAuthSetCookies(COOKIE, ['app_rtk=BBB; Max-Age=0']);
    assert.equal(r.revoked, true);
    assert.equal(r.cookie, 'app_atk=AAA; mss_mac=CCC');
  });

  test('merge: past Expires with comma counts as deletion', () => {
    const r = mergeAuthSetCookies(COOKIE, ['app_atk=AAA; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'], Date.parse('2026-09-26T00:00:00Z'));
    assert.equal(r.revoked, true);
    const future = mergeAuthSetCookies(COOKIE, ['app_atk=NEW; Expires=Fri, 25 Dec 2026 08:13:47 GMT'], Date.parse('2026-09-26T00:00:00Z'));
    assert.equal(future.revoked, false);
    assert.equal(future.rotated, true);
  });

  test('merge: deleting mss_mac alone is not a revocation', () => {
    const r = mergeAuthSetCookies(COOKIE, ['mss_mac=; Max-Age=0']);
    assert.equal(r.revoked, false);
    assert.equal(r.cookie, 'app_atk=AAA; app_rtk=BBB');
  });
});

describe('session metadata', () => {
  test('issuedAt moves only when app_atk changes', () => {
    writeSessionCookie(COOKIE, tmpPath, { now: new Date('2026-09-26T00:00:00Z') });
    writeSessionCookie('app_atk=AAA; app_rtk=BBB', tmpPath, { now: new Date('2026-09-26T05:00:00Z') });
    assert.equal(readSessionMeta(tmpPath).issuedAt, '2026-09-26T00:00:00.000Z');
    writeSessionCookie('app_atk=ZZZ; app_rtk=BBB', tmpPath, { now: new Date('2026-09-26T06:00:00Z') });
    assert.equal(readSessionMeta(tmpPath).issuedAt, '2026-09-26T06:00:00.000Z');
  });

  test('writeSessionCookie preserves unrelated metadata', () => {
    writeSessionCookie(COOKIE, tmpPath);
    updateSessionMeta({ lastWarnedOn: '2026-09-25', observedLifetimeHours: [12] }, tmpPath);
    writeSessionCookie('app_atk=NEW; app_rtk=BBB', tmpPath);
    const meta = readSessionMeta(tmpPath);
    assert.equal(meta.lastWarnedOn, '2026-09-25');
    assert.deepEqual(meta.observedLifetimeHours, [12]);
    assert.equal('cookie' in meta, false);
  });

  test('recordObservedLifetime appends hours since issuedAt, capped at 10 samples', () => {
    writeSessionCookie(COOKIE, tmpPath, { now: new Date('2026-09-26T00:00:00Z') });
    updateSessionMeta({ observedLifetimeHours: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, tmpPath);
    recordObservedLifetime(tmpPath, new Date('2026-09-26T13:30:00Z'));
    assert.deepEqual(readSessionMeta(tmpPath).observedLifetimeHours, [2, 3, 4, 5, 6, 7, 8, 9, 10, 13.5]);
  });

  test('recordObservedLifetime is a no-op without issuedAt', () => {
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify({ cookie: COOKIE }));
    recordObservedLifetime(tmpPath);
    assert.equal(readSessionMeta(tmpPath).observedLifetimeHours, undefined);
  });

  test('describe + format', () => {
    writeSessionCookie(COOKIE, tmpPath, { now: new Date('2026-09-26T00:00:00Z') });
    updateSessionMeta({ observedLifetimeHours: [11, 12.5, 13] }, tmpPath);
    const d = describeSession(tmpPath, new Date('2026-09-26T05:06:00Z'));
    assert.deepEqual(d, { cached: true, ageHours: 5.1, observedLifetimeHours: [11, 12.5, 13] });
    assert.equal(formatSessionSummary(d), 'age 5.1h, observed lifetimes: 11h, 12.5h, 13h');
    clearSessionCookie(tmpPath);
    assert.equal(formatSessionSummary(describeSession(tmpPath)), 'no cached session');
  });
});
