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
