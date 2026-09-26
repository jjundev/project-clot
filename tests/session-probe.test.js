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
