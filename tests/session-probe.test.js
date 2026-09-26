import './setup-env.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as session from '../src/session.js';
import { formatExpiryProbeMessage } from '../src/notifier.js';
import { sessionProbeOptions } from '../src/cli.js';

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

function captureConsole() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => Object.assign(console, orig) };
}

describe('formatExpiryProbeSummary', () => {
  test('formats every part of an entry', () => {
    const entry = {
      at: '2026-09-27T01:30:00.000Z', trigger: 'keeper', ageHours: 10.2, ageBasis: 'savedAt', sinceLastVerifiedHours: 0.5,
      initialVerify: { status: 200, authSetCookies: [] },
      httpsProbe: { renewed: false, tokensChanged: false, steps: [
        { target: 'main', status: 302, location: '/auth/login', authSetCookies: [] },
        { target: 'product', status: 200, location: null, authSetCookies: [{ name: 'app_atk', hasValue: false, deleted: true, attrs: {} }], pageLoggedIn: false },
        { target: 'login-status', status: null, error: 'timeout' },
      ] },
      browser: { ran: true, chromeLoggedIn: true, atkChanged: true, rtkChanged: false, captureError: null,
        requests: [{ method: 'POST', host: 'my.musinsa.com', path: '/api/auth/reissue', status: 200 }] },
    };
    assert.equal(
      session.formatExpiryProbeSummary(entry),
      '[keeper] age≈10.2h(savedAt), last ok 0.5h ago — first login-status 200 no-auth-cookie; ' +
        'https not renewed: main 302→/auth/login no-auth-cookie, product 200 app_atk✗ loggedIn=false, login-status timeout; ' +
        'browser: chrome=LOGGED_IN atkChanged=true rtkChanged=false authReqs=1 [POST my.musinsa.com/api/auth/reissue 200]',
    );
  });

  test('unknown age, same-token renewal, no browser run', () => {
    const line = session.formatExpiryProbeSummary({
      trigger: 'collect', ageHours: null, ageBasis: null, sinceLastVerifiedHours: null,
      initialVerify: { status: null, authSetCookies: [] },
      httpsProbe: { renewed: true, tokensChanged: false, steps: [] },
      browser: null,
    });
    assert.equal(line, '[collect] age ? — first login-status ? no-auth-cookie; https RENEWED(same tokens): ; browser: not run');
  });
});

describe('probe log line and notification', () => {
  test('keeper prints one 🧪 line and notifies once with the same summary', async () => {
    session.writeSessionCookie(COOKIE, tmpPath);
    const { fetchFn } = probeRoutes();
    const notified = [];
    const con = captureConsole();
    try {
      await session.keepSessionAlive({
        bridgeUsable: true, path: tmpPath, verify: deadVerify, fetchFromBridge: async () => FRESH,
        probe: { fetchFn, delayMs: 0, notify: async (l) => notified.push(l) },
      });
    } finally {
      con.restore();
    }
    const probeLines = con.lines.filter((l) => l.startsWith('🧪 [Session Probe] '));
    assert.equal(probeLines.length, 1);
    assert.deepEqual(notified, [probeLines[0].slice('🧪 [Session Probe] '.length)]);
  });

  test('collect without bridge still logs and notifies (browser: not run)', async () => {
    session.writeSessionCookie(COOKIE, tmpPath);
    const { fetchFn } = probeRoutes();
    const notified = [];
    await session.getSessionCookie({
      path: tmpPath, allowBridge: false, verify: deadVerify, probe: { fetchFn, delayMs: 0, notify: async (l) => notified.push(l) },
    });
    assert.equal(notified.length, 1);
    assert.match(notified[0], /browser: not run$/);
  });

  test('a failing notifier is only a warning', async () => {
    session.writeSessionCookie(COOKIE, tmpPath);
    const { fetchFn } = probeRoutes();
    const con = captureConsole();
    let r;
    try {
      r = await session.keepSessionAlive({
        bridgeUsable: true, path: tmpPath, verify: deadVerify, fetchFromBridge: async () => FRESH,
        probe: { fetchFn, delayMs: 0, notify: async () => { throw new Error('telegram down'); } },
      });
    } finally {
      con.restore();
    }
    assert.equal(r.status, 'renewed');
    assert.equal(con.lines.some((l) => l.includes('[Session Probe Notice] telegram down')), true);
  });

  test('no probe: no 🧪 line', async () => {
    session.writeSessionCookie(COOKIE, tmpPath);
    const con = captureConsole();
    try {
      await session.keepSessionAlive({ bridgeUsable: true, path: tmpPath, verify: deadVerify, fetchFromBridge: async () => FRESH });
    } finally {
      con.restore();
    }
    assert.equal(con.lines.some((l) => l.includes('🧪')), false);
  });
});

const netEnvelope = (entries) => JSON.stringify({ session: 'clot-auth', captured_at: 'x', count: entries.length, filtered_out: 0, entries });

describe('parseNetworkCapture', () => {
  test('keeps auth-looking requests as method/host/path/status, query dropped', () => {
    const out = session.parseNetworkCapture(netEnvelope([
      { key: 'a', method: 'GET', status: 200, url: 'https://my.musinsa.com/api/member/v1/login-status', ct: 'application/json', shape: {} },
      { key: 'b', method: 'post', status: 200, url: `https://www.musinsa.com/api/auth/reissue?rt=${SECRET_RTK}`, ct: 'application/json' },
      { key: 'c', method: 'GET', status: 200, url: 'https://www.musinsa.com/api/goods/list', ct: 'application/json' },
      { key: 'd', method: 'GET', status: 200, url: 'not a url' },
    ]));
    assert.deepEqual(out, [
      { method: 'GET', host: 'my.musinsa.com', path: '/api/member/v1/login-status', status: 200 },
      { method: 'POST', host: 'www.musinsa.com', path: '/api/auth/reissue', status: 200 },
    ]);
  });

  test('caps the list at 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ method: 'GET', status: 200, url: `https://x.musinsa.com/token/${i}` }));
    assert.equal(session.parseNetworkCapture(netEnvelope(many)).length, 20);
  });

  test('error envelope throws with captureCode; non-JSON throws SyntaxError', () => {
    assert.throws(() => session.parseNetworkCapture(JSON.stringify({ error: { code: 'capture_failed', message: 'x' } })),
      (err) => err.captureCode === 'capture_failed');
    assert.throws(() => session.parseNetworkCapture('garbage'), SyntaxError);
  });
});

describe('bridge capture', () => {
  const EXPIRED = 'app_atk=OLDATK; app_rtk=SAMERTK';
  const makeExec = ({ network = netEnvelope([]), login = 'LOGGED_IN', cookie = JSON.stringify('app_atk=CHROMEATK; app_rtk=SAMERTK') } = {}) => {
    const cmds = [];
    const envs = [];
    const execFn = (cmd, opts) => {
      cmds.push(cmd);
      if (cmd.includes(' network')) {
        envs.push(opts?.env?.OPENCLI_CACHE_DIR);
        if (network instanceof Error) throw network;
        return network;
      }
      if (cmd.includes('login-status')) return login;
      if (cmd.includes('document.cookie')) return cookie;
      return '';
    };
    return { execFn, cmds, envs };
  };

  test('captures right after open, before the login eval, and compares tokens as booleans', () => {
    const { execFn, cmds } = makeExec({ network: netEnvelope([{ method: 'POST', status: 200, url: 'https://my.musinsa.com/auth/token' }]) });
    const captured = [];
    const c = session.fetchSessionCookieFromBridge({ execFn, onCapture: (x) => captured.push(x), expiredCookie: EXPIRED });
    assert.equal(c, 'app_atk=CHROMEATK; app_rtk=SAMERTK');
    assert.match(cmds[0], / open https:\/\/www\.musinsa\.com\/$/);
    assert.match(cmds[1], /^opencli browser clot-auth network --all$/);
    assert.match(cmds[2], /login-status/);
    assert.deepEqual(captured, [{
      ran: true, chromeLoggedIn: true, atkChanged: true, rtkChanged: false, captureError: null,
      requests: [{ method: 'POST', host: 'my.musinsa.com', path: '/auth/token', status: 200 }],
    }]);
  });

  test('network capture uses a throwaway cache dir that is gone afterwards, even on failure', () => {
    for (const network of [netEnvelope([]), new Error('exit 1')]) {
      const { execFn, envs } = makeExec({ network });
      session.fetchSessionCookieFromBridge({ execFn, onCapture: () => {}, expiredCookie: EXPIRED });
      assert.equal(envs.length, 1);
      assert.equal(envs[0].startsWith(os.tmpdir()), true);
      assert.equal(fs.existsSync(envs[0]), false);
    }
  });

  test('capture failure does not block the cookie; onCapture is called once with captureError', () => {
    for (const [network, code] of [[new Error('exit 1'), 'exec'], ['garbage', 'parse'],
      [JSON.stringify({ error: { code: 'capture_failed', message: 'x' } }), 'opencli:capture_failed']]) {
      const { execFn } = makeExec({ network });
      const captured = [];
      const c = session.fetchSessionCookieFromBridge({ execFn, onCapture: (x) => captured.push(x), expiredCookie: EXPIRED });
      assert.equal(c, 'app_atk=CHROMEATK; app_rtk=SAMERTK');
      assert.equal(captured.length, 1);
      assert.equal(captured[0].captureError, code);
      assert.deepEqual(captured[0].requests, []);
    }
  });

  test('Chrome logged out: capture reports chromeLoggedIn false, token comparison null', () => {
    const { execFn } = makeExec({ login: 'LOGGED_OUT' });
    const captured = [];
    assert.equal(session.fetchSessionCookieFromBridge({ execFn, onCapture: (x) => captured.push(x), expiredCookie: EXPIRED }), null);
    assert.equal(captured[0].chromeLoggedIn, false);
    assert.equal(captured[0].atkChanged, null);
  });

  test('without onCapture there is no network command', () => {
    const { execFn, cmds } = makeExec();
    session.fetchSessionCookieFromBridge({ execFn });
    assert.equal(cmds.some((c) => c.includes(' network')), false);
  });

  test('keeper stores the bridge capture on the probe entry', async () => {
    session.writeSessionCookie(COOKIE, tmpPath);
    const { fetchFn } = probeRoutes();
    const seen = [];
    const fetchFromBridge = async (o) => {
      seen.push(o?.expiredCookie === COOKIE);
      o.onCapture({ ran: true, chromeLoggedIn: true, atkChanged: true, rtkChanged: true, requests: [], captureError: null });
      return FRESH;
    };
    const notified = [];
    await session.keepSessionAlive({
      bridgeUsable: true, path: tmpPath, verify: deadVerify, fetchFromBridge,
      probe: { fetchFn, delayMs: 0, notify: async (l) => notified.push(l) },
    });
    assert.deepEqual(seen, [true]);
    assert.equal(probes()[0].browser.rtkChanged, true);
    assert.match(notified[0], /browser: chrome=LOGGED_IN atkChanged=true rtkChanged=true authReqs=0/);
    assert.equal(session.readSessionCookie(tmpPath), FRESH);
  });

  test('no probe: fetchFromBridge is called without capture options (unchanged behavior)', async () => {
    session.writeSessionCookie(COOKIE, tmpPath);
    const args = [];
    await session.getSessionCookie({ path: tmpPath, verify: deadVerify, fetchFromBridge: async (o) => { args.push(o); return FRESH; } });
    assert.deepEqual(args, [undefined]);
  });
});

describe('probe wiring', () => {
  test('formatExpiryProbeMessage escapes HTML and names where the data lives', () => {
    const msg = formatExpiryProbeMessage('main 302→/a<b>&c');
    assert.match(msg, /^<b>🧪 \[Project-Clot\] 무신사 토큰 만료 계측<\/b>/);
    assert.equal(msg.includes('main 302→/a&lt;b&gt;&amp;c'), true);
    assert.equal(msg.includes('expiryProbes'), true);
  });

  test('sessionProbeOptions picks the first VIP item and survives a DB error', () => {
    const notify = async () => {};
    assert.deepEqual(sessionProbeOptions({ getVipItems: () => [{ goods_no: 42 }, { goods_no: 7 }], notify }), { goodsNo: 42, notify });
    assert.deepEqual(sessionProbeOptions({ getVipItems: () => [], notify }), { goodsNo: null, notify });
    assert.deepEqual(sessionProbeOptions({ getVipItems: () => { throw new Error('locked'); }, notify }), { goodsNo: null, notify });
  });

  test('the probe flow never leaks token values to console, notification or meta', async () => {
    session.writeSessionCookie(COOKIE, tmpPath);
    const { fetchFn } = router([
      [MAIN, () => res(302, { location: `/auth/login?t=${SECRET_ATK}`, setCookies: [`app_atk=${NEW_ATK}; Path=/`, `app_rtk=${SECRET_RTK}; Max-Age=0`] })],
      [PRODUCT, () => res(200, { body: productHtml(false) })],
      [LOGIN, () => res(200, { body: loginBody(false) })],
    ]);
    const network = netEnvelope([{ method: 'POST', status: 200, url: `https://my.musinsa.com/api/auth/reissue?rt=${SECRET_RTK}`, shape: { accessToken: SECRET_ATK } }]);
    const execFn = (cmd) => (cmd.includes(' network') ? network
      : cmd.includes('login-status') ? 'LOGGED_IN'
      : cmd.includes('document.cookie') ? JSON.stringify(`app_atk=${NEW_ATK}; app_rtk=${SECRET_RTK}`) : '');
    const notified = [];
    const con = captureConsole();
    try {
      await session.keepSessionAlive({
        bridgeUsable: true, path: tmpPath,
        verify: async (c) => ({ loggedIn: false, cookie: c, rotated: false, status: 200, authSetCookies: [] }),
        fetchFromBridge: (o) => session.fetchSessionCookieFromBridge({ execFn, ...o }),
        probe: { fetchFn, goodsNo: 1, delayMs: 0, notify: async (l) => notified.push(formatExpiryProbeMessage(l)) },
      });
    } finally {
      con.restore();
    }
    const meta = JSON.stringify(session.readSessionMeta(tmpPath).expiryProbes);
    for (const blob of [con.lines.join('\n'), notified.join('\n'), meta]) {
      for (const secret of [SECRET_ATK, SECRET_RTK, NEW_ATK]) assert.equal(blob.includes(secret), false);
    }
    assert.equal(session.readSessionMeta(tmpPath).expiryProbes[0].browser.requests[0].path, '/api/auth/reissue');
    assert.equal(notified.length, 1);
  });
});

describe('final review fixes', () => {
  test('same-token acceptance is recorded but not adopted: the bridge still renews', async () => {
    session.writeSessionCookie(COOKIE, tmpPath);
    const { fetchFn } = router([
      [MAIN, () => res(200)],
      [LOGIN, () => res(200, { body: loginBody(true) })],
    ]);
    let bridgeCalls = 0;
    const r = await session.keepSessionAlive({
      bridgeUsable: true, path: tmpPath, verify: deadVerify,
      fetchFromBridge: async () => { bridgeCalls++; return FRESH; },
      probe: { fetchFn, delayMs: 0 },
    });
    assert.equal(bridgeCalls, 1);
    assert.equal(r.status, 'renewed');
    assert.equal(session.readSessionCookie(tmpPath), FRESH);
    assert.equal(probes()[0].httpsProbe.renewed, true);
    assert.equal(probes()[0].httpsProbe.tokensChanged, false);
  });

  test('www requests keep 700 ms-style spacing before main and after the product page', async () => {
    const { fetchFn, calls } = router([
      [MAIN, () => res(200)],
      [PRODUCT, () => res(200, { body: productHtml(false) })],
      [LOGIN, () => res(200, { body: loginBody(false) })],
    ]);
    const t0 = Date.now();
    await session.probeExpiredSession(COOKIE, { fetchFn, goodsNo: 1, delayMs: 60 });
    const end = Date.now();
    assert.ok(calls[0].at - t0 >= 55, 'wait before main');
    assert.ok(end - calls[1].at >= 55, 'wait after the product page');
  });

  test('a capture temp dir that cannot be created does not fail the renewal', () => {
    const orig = process.env.TMPDIR;
    process.env.TMPDIR = path.join(tmpPath, 'no', 'such', 'dir');
    const captured = [];
    const execFn = (cmd) => (cmd.includes(' network') ? netEnvelope([])
      : cmd.includes('login-status') ? 'LOGGED_IN'
      : cmd.includes('document.cookie') ? JSON.stringify('app_atk=A; app_rtk=R') : '');
    let c;
    try {
      c = session.fetchSessionCookieFromBridge({ execFn, onCapture: (x) => captured.push(x), expiredCookie: COOKIE });
    } finally {
      if (orig === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = orig;
    }
    assert.equal(c, 'app_atk=A; app_rtk=R');
    assert.equal(captured[0].captureError, 'tmpdir');
  });
});
