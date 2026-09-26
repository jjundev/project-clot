import './setup-env.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as session from '../src/session.js';

const SECRET_ATK = 'SECRETATKVALUE123';
const SECRET_RTK = 'SECRETRTKVALUE456';
const NEW_ATK = 'NEWATKSECRET789';
const COOKIE = `app_atk=${SECRET_ATK}; app_rtk=${SECRET_RTK}`;
const deadVerify = async (cookie) => ({ loggedIn: false, cookie, rotated: false });

function res(status, { setCookies = [], location = null, body = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      getSetCookie: () => setCookies,
      get: (name) => (name.toLowerCase() === 'location' ? location : null),
    },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}
const loginBody = (loggedIn) => JSON.stringify({ data: { loggedIn } });
const productHtml = (loggedIn) =>
  `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { dehydratedState: { queries: [
      { queryKey: ['Detail', 'LoginStatus'], state: { data: { data: { loggedIn } } } },
    ] } } },
  })}</script>`;

/** routes: [[RegExp, (url, init) => response]]; records every call. */
function router(routes) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, cookie: init.headers?.Cookie, redirect: init.redirect, at: Date.now() });
    const hit = routes.find(([re]) => re.test(url));
    if (!hit) throw new Error(`unexpected request ${url}`);
    return hit[1](url, init);
  };
  return { fetchFn, calls };
}

let tmpPath;
beforeEach(() => {
  tmpPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clot-probe-')), 'session.json');
});

describe('summarizeAuthSetCookies', () => {
  test('keeps names and attributes of auth cookies only, never values', () => {
    const out = session.summarizeAuthSetCookies([
      `app_atk=${NEW_ATK}; Path=/; Domain=.musinsa.com; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`,
      'app_rtk=; Max-Age=0; Path=/',
      '__cf_bm=zzz; Path=/',
    ]);
    assert.deepEqual(out, [
      { name: 'app_atk', hasValue: true, deleted: false,
        attrs: { path: '/', domain: '.musinsa.com', 'max-age': '86400', httponly: true, secure: true, samesite: 'Lax' } },
      { name: 'app_rtk', hasValue: false, deleted: true, attrs: { 'max-age': '0', path: '/' } },
    ]);
    assert.equal(JSON.stringify(out).includes(NEW_ATK), false);
  });

  test('a comma-bearing Expires stays one attribute and counts as deleted when past', () => {
    const [c] = session.summarizeAuthSetCookies(['app_atk=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/']);
    assert.equal(c.attrs.expires, 'Thu, 01 Jan 1970 00:00:00 GMT');
    assert.equal(c.deleted, true);
  });
});

describe('verifySession diagnostics', () => {
  test('diagnostics: true adds status and the auth Set-Cookie summary', async () => {
    const fetchFn = async () => res(200, { body: loginBody(false), setCookies: [`app_atk=${NEW_ATK}; Path=/`, '_gf=1'] });
    const r = await session.verifySession(COOKIE, { fetchFn, diagnostics: true });
    assert.equal(r.loggedIn, false);
    assert.equal(r.status, 200);
    assert.deepEqual(r.authSetCookies.map((c) => c.name), ['app_atk']);
  });

  test('network error: status null, empty summary', async () => {
    const r = await session.verifySession(COOKIE, { fetchFn: async () => { throw new Error('boom'); }, diagnostics: true });
    assert.equal(r.loggedIn, null);
    assert.equal(r.status, null);
    assert.deepEqual(r.authSetCookies, []);
  });

  test('without diagnostics the result shape is unchanged', async () => {
    const r = await session.verifySession(COOKIE, { fetchFn: async () => res(200, { body: loginBody(true) }) });
    assert.deepEqual(Object.keys(r).sort(), ['cookie', 'loggedIn', 'rotated']);
  });
});

const MAIN = /^https:\/\/www\.musinsa\.com\/$/;
const PRODUCT = /^https:\/\/www\.musinsa\.com\/products\//;
const LOGIN = /login-status/;

describe('probeExpiredSession', () => {
  test('visits main, product, login-status in order with a chained cookie jar', async () => {
    const { fetchFn, calls } = router([
      [MAIN, () => res(200, { setCookies: [`app_atk=${NEW_ATK}; Path=/; Max-Age=86400`] })],
      [PRODUCT, () => res(200, { body: productHtml(true) })],
      [LOGIN, () => res(200, { body: loginBody(true) })],
    ]);
    const r = await session.probeExpiredSession(COOKIE, { fetchFn, goodsNo: 123, delayMs: 0 });
    assert.deepEqual(calls.map((c) => c.url), [
      'https://www.musinsa.com/', 'https://www.musinsa.com/products/123', session.LOGIN_STATUS_URL,
    ]);
    assert.equal(calls[0].redirect, 'manual');
    assert.equal(calls[1].redirect, 'manual');
    assert.equal(calls[1].cookie.includes(NEW_ATK), true);
    assert.deepEqual(r.steps.map((s) => s.target), ['main', 'product', 'login-status']);
    assert.equal(r.steps[0].authSetCookies[0].name, 'app_atk');
    assert.equal(r.steps[1].pageLoggedIn, true);
    assert.equal(r.steps[2].loggedIn, true);
    assert.equal(r.renewed, true);
    assert.equal(r.tokensChanged, true);
    assert.equal(r.renewedCookie.includes(NEW_ATK), true);
    assert.equal(JSON.stringify(r.steps).includes(NEW_ATK), false);
  });

  test('redirect Location keeps only the path', async () => {
    const { fetchFn } = router([
      [MAIN, () => res(302, { location: `https://www.musinsa.com/auth/login?returnUrl=%2F&t=${SECRET_ATK}` })],
      [LOGIN, () => res(200, { body: loginBody(false) })],
    ]);
    const r = await session.probeExpiredSession(COOKIE, { fetchFn, delayMs: 0 });
    assert.equal(r.steps[0].status, 302);
    assert.equal(r.steps[0].location, '/auth/login');
    assert.equal(JSON.stringify(r.steps).includes(SECRET_ATK), false);
  });

  test('a timed-out step is recorded and the probe continues', async () => {
    const { fetchFn, calls } = router([
      [MAIN, () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }],
      [PRODUCT, () => { throw new TypeError('fetch failed'); }],
      [LOGIN, () => res(200, { body: loginBody(false) })],
    ]);
    const r = await session.probeExpiredSession(COOKIE, { fetchFn, goodsNo: 1, delayMs: 0 });
    assert.deepEqual(r.steps[0], { target: 'main', status: null, error: 'timeout' });
    assert.deepEqual(r.steps[1], { target: 'product', status: null, error: 'network' });
    assert.equal(calls.length, 3);
    assert.equal(r.renewed, false);
    assert.equal(r.renewedCookie, null);
  });

  test('no goodsNo: no product request', async () => {
    const { fetchFn, calls } = router([
      [MAIN, () => res(200)],
      [LOGIN, () => res(200, { body: loginBody(false) })],
    ]);
    const r = await session.probeExpiredSession(COOKIE, { fetchFn, delayMs: 0 });
    assert.equal(calls.length, 2);
    assert.deepEqual(r.steps.map((s) => s.target), ['main', 'login-status']);
  });

  test('waits delayMs between the two www requests', async () => {
    const { fetchFn, calls } = router([
      [MAIN, () => res(200)],
      [PRODUCT, () => res(200, { body: productHtml(false) })],
      [LOGIN, () => res(200, { body: loginBody(false) })],
    ]);
    await session.probeExpiredSession(COOKIE, { fetchFn, goodsNo: 1, delayMs: 60 });
    assert.ok(calls[1].at - calls[0].at >= 55);
  });

  test('expired cookie accepted again on the final check: renewed, tokensChanged false', async () => {
    const { fetchFn } = router([
      [MAIN, () => res(200)],
      [LOGIN, () => res(200, { body: loginBody(true) })],
    ]);
    const r = await session.probeExpiredSession(COOKIE, { fetchFn, delayMs: 0 });
    assert.equal(r.renewed, true);
    assert.equal(r.tokensChanged, false);
    assert.equal(r.renewedCookie, COOKIE);
  });
});

const FRESH = 'app_atk=BRIDGEATK; app_rtk=BRIDGERTK';
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const probeRoutes = ({ renew = false } = {}) => router([
  [MAIN, () => res(200, renew ? { setCookies: [`app_atk=${NEW_ATK}; Path=/`] } : {})],
  [PRODUCT, () => res(200, { body: productHtml(renew) })],
  [LOGIN, () => res(200, { body: loginBody(renew) })],
]);
const probes = () => session.readSessionMeta(tmpPath).expiryProbes;

describe('expiry probe recording', () => {
  test('probe is off by default: a dead cache sends no probe request and records nothing', async () => {
    session.writeSessionCookie(COOKIE, tmpPath);
    const origFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = async () => { fetched++; throw new Error('no network in tests'); };
    try {
      await session.getSessionCookie({ path: tmpPath, verify: deadVerify, fetchFromBridge: async () => null });
      await session.keepSessionAlive({ bridgeUsable: true, path: tmpPath, verify: deadVerify, fetchFromBridge: async () => null });
    } finally {
      globalThis.fetch = origFetch;
    }
    assert.equal(fetched, 0);
    assert.equal(probes(), undefined);
  });

  test('keeper records one entry for a legacy cache file, then renews through the bridge', async () => {
    fs.writeFileSync(tmpPath, JSON.stringify({ cookie: COOKIE, savedAt: hoursAgo(10) }), { mode: 0o600 });
    const { fetchFn } = probeRoutes();
    const verifyArgs = [];
    const verify = async (c, opts) => { verifyArgs.push(opts); return { ...(await deadVerify(c)), status: 200, authSetCookies: [] }; };
    const r = await session.keepSessionAlive({
      bridgeUsable: true, path: tmpPath, verify, fetchFromBridge: async () => FRESH,
      probe: { fetchFn, goodsNo: 123, delayMs: 0 },
    });
    assert.equal(r.status, 'renewed');
    assert.equal(session.readSessionCookie(tmpPath), FRESH);
    assert.deepEqual(verifyArgs[0], { diagnostics: true });
    const [e] = probes();
    assert.equal(probes().length, 1);
    assert.equal(e.trigger, 'keeper');
    assert.equal(e.ageBasis, 'savedAt');
    assert.equal(e.ageHours, 10);
    assert.equal(e.sinceLastVerifiedHours, null);
    assert.deepEqual(e.initialVerify, { status: 200, authSetCookies: [] });
    assert.deepEqual(e.httpsProbe.steps.map((s) => s.target), ['main', 'product', 'login-status']);
    assert.equal(e.httpsProbe.renewed, false);
    assert.equal(e.browser, null);
  });

  test('issuedAt, when present, is the age basis', async () => {
    session.writeSessionCookie(COOKIE, tmpPath, { now: new Date(hoursAgo(7)) });
    session.updateSessionMeta({ lastVerifiedAt: hoursAgo(0.5) }, tmpPath);
    const { fetchFn } = probeRoutes();
    await session.getSessionCookie({ path: tmpPath, allowBridge: false, verify: deadVerify, probe: { fetchFn, delayMs: 0 } });
    const [e] = probes();
    assert.equal(e.ageBasis, 'issuedAt');
    assert.equal(e.ageHours, 7);
    assert.equal(e.sinceLastVerifiedHours, 0.5);
    assert.equal(e.trigger, 'collect');
  });

  test('HTTPS renewal is adopted and the bridge is skipped', async () => {
    session.writeSessionCookie(COOKIE, tmpPath);
    const { fetchFn } = probeRoutes({ renew: true });
    let bridgeCalls = 0;
    const r = await session.keepSessionAlive({
      bridgeUsable: true, path: tmpPath, verify: deadVerify,
      fetchFromBridge: async () => { bridgeCalls++; return FRESH; },
      probe: { fetchFn, goodsNo: 1, delayMs: 0 },
    });
    assert.equal(r.status, 'renewed');
    assert.equal(bridgeCalls, 0);
    assert.equal(session.readSessionCookie(tmpPath).includes(NEW_ATK), true);
    assert.equal(probes()[0].httpsProbe.renewed, true);
    assert.equal(probes()[0].httpsProbe.tokensChanged, true);
    assert.equal(JSON.stringify(probes()).includes(NEW_ATK), false);
  });

  test('refresh trigger: a renewed cookie different from the failed one is returned', async () => {
    session.writeSessionCookie(COOKIE, tmpPath);
    const { fetchFn } = probeRoutes({ renew: true });
    const c = await session.refreshSessionCookie({
      path: tmpPath, verify: deadVerify, failedCookie: COOKIE, fetchFromBridge: async () => null,
      probe: { fetchFn, delayMs: 0 },
    });
    assert.equal(c.includes(NEW_ATK), true);
    assert.equal(probes()[0].trigger, 'refresh');
  });

  test('keeps only the 3 most recent probes', async () => {
    for (let i = 0; i < 4; i++) {
      session.writeSessionCookie(COOKIE, tmpPath);
      const { fetchFn } = probeRoutes();
      await session.getSessionCookie({ path: tmpPath, allowBridge: false, verify: deadVerify, probe: { fetchFn, delayMs: 0 } });
    }
    assert.equal(probes().length, 3);
  });

  test('unknown login-status: no probe', async () => {
    session.writeSessionCookie(COOKIE, tmpPath);
    const { fetchFn, calls } = probeRoutes();
    await session.getSessionCookie({
      path: tmpPath, verify: async (c) => ({ loggedIn: null, cookie: c, rotated: false }), probe: { fetchFn, delayMs: 0 },
    });
    assert.equal(calls.length, 0);
    assert.equal(probes(), undefined);
  });

  test('every probe request failing does not break the flow', async () => {
    session.writeSessionCookie(COOKIE, tmpPath);
    const fetchFn = async () => { throw new TypeError('fetch failed'); };
    const c = await session.getSessionCookie({ path: tmpPath, verify: deadVerify, fetchFromBridge: async () => FRESH, probe: { fetchFn, delayMs: 0 } });
    assert.equal(c, FRESH);
    assert.deepEqual(probes()[0].httpsProbe.steps.map((s) => s.error ?? s.loggedIn), ['network', null]);
  });

  test('makeSessionProvider forwards probe', async () => {
    session.writeSessionCookie(COOKIE, tmpPath);
    const { fetchFn } = probeRoutes();
    const provider = session.makeSessionProvider({
      allowBridge: false, path: tmpPath, verify: deadVerify, probe: { fetchFn, delayMs: 0 },
    });
    await provider();
    assert.equal(probes().length, 1);
  });
});
