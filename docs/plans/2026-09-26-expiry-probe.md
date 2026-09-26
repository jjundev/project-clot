# Musinsa Token Expiry Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first time a cached Musinsa cookie is seen dead (`login-status` → `loggedIn: false`), record how the server reacts to that expired cookie over HTTPS, and which auth-looking requests Chrome makes during the bridge renewal that follows. Store the record in `expiryProbes[]` (last 3) of `~/.clot/musinsa-session.json`, log one value-free summary line, and send it to Telegram. If the HTTPS probe itself gets fresh tokens, adopt them and skip the bridge.

**Architecture:** Everything but wiring lives in `src/session.js`. `verifySession` gains opt-in `diagnostics` (status + value-free `Set-Cookie` summary). A new `probeExpiredSession` walks `www` main → one product page → `login-status` with a chained cookie jar. `verifyCached` runs it on first death when a `probe` option is given (opt-in: library defaults stay network-free). `fetchSessionCookieFromBridge` gains an `onCapture` hook that runs `opencli browser <s> network --all` right after `open`. `src/cli.js` turns the probe on for real runs and supplies the product `goodsNo` and the Telegram notifier.

**Tech Stack:** Node.js 24 ESM, global `fetch` (`redirect: 'manual'`, `res.headers.getSetCookie()`), `node:test` + `node:assert/strict`, OpenCLI 1.8.6 (`opencli browser …`).

**Spec:** Design from the 2026-09-26 grill-yourself session ("무신사 토큰 갱신 경로를 만료 순간에 자동으로 잡아내기"), decisions #1–#12, with #11 = adopt HTTPS-renewed cookie and skip the bridge, #12 = one Telegram summary per probe. It is condensed in *Background (Spec)* below. Earlier context: `docs/plans/2026-09-26-session-keeper.md` → *Background (Spec)*.

## Background (Spec)

Facts (verified 2026-09-26, no token values printed):

| Fact | Evidence |
|---|---|
| The current cache has `cookie` + `savedAt` only — **no `issuedAt`, no `lastVerifiedAt`** (written before those fields existed). `recordObservedLifetime` returns early without `issuedAt`, so the first lifetime sample will be lost; the probe entry must carry its own `savedAt`-based age. | `node -e` field extraction |
| `opencli browser <s> open <url>` starts session network capture **before** navigating, then waits 2 s. | `@jackwener/opencli/dist/src/cli.js:1032-1036` |
| `opencli browser <s> network` prints one JSON envelope: `{ session, captured_at, count, filtered_out, entries: [{ key, method, timestamp, status, url, ct, size, shape }], detail_hint }`. On failure it prints `{ error: { code, message } }` and exits non-zero. Without `--all` it keeps only json/xml/text/js responses (HTML documents are dropped). | `cli.js:2283-2507`, `cli.js:136-143` |
| `network` **saves every captured response body to `$OPENCLI_CACHE_DIR/browser-network/<session>.json`** (default `~/.opencli/cache`). The page's own `login-status` response carries `authTokenInfo` (token values), so an unredirected capture leaves a token copy on disk for 24 h. | `browser/network-cache.js:16-40` |
| Product-page SSR embeds `LoginStatus` (`extractProductDetail(html, goodsNo).loggedIn`). | `src/myprice.js:59-70` |
| The bridge always `close`s its session in `finally`, so each bridge run is a fresh tab load (no "same URL re-open gives empty capture" problem). | `src/session.js:251-256` |

Design decisions:
1. Probe on first death from **any** caller (`keeper`, `collect`, `refresh`) — an overnight expiry is usually first seen by the morning collect run, which clears the cache without a bridge.
2. One probe per cookie needs no guard: after a probe the cookie is cleared (or replaced), and `verifyCached` never probes when there is no cached cookie.
3. The first `login-status` call is the first contact with the expired token, so its status and auth `Set-Cookie` summary are kept as `initialVerify`.
4. Probe requests: sequential, chained cookie jar, `redirect: 'manual'`, 10 s timeout each, 700 ms between `www` requests.
5. Product for the probe: first of `db.getActiveVipItems()`; none → skip that step.
6. Recorded data: cookie names, attributes, `hasValue`/`deleted` booleans, HTTP status, URL host + path (query dropped), booleans comparing Chrome's tokens to the expired ones. **Never values, never lengths.**
7. `observedLifetimeHours` is unchanged. The probe entry carries `ageHours` + `ageBasis` (`issuedAt` or `savedAt`) + `sinceLastVerifiedHours`, which together bracket the lifetime.
8. `fetchSessionCookieFromBridge` keeps its `string|null` return; capture is reported through an `onCapture` callback, so injected bridge fakes keep working.
9. Capture once, right after `open` and before our own `eval` fetch; use `--all` so documents and redirects are included; point `OPENCLI_CACHE_DIR` at a temp dir and delete it afterwards.
10. Log one `🧪 [Session Probe] …` line per probe; the quiet `⏭ [Daily Lock]` line format is unchanged.
11. HTTPS probe ends with `login-status` true → write that cookie, skip the bridge; keeper reports `renewed`.
12. One Telegram message per probe with the same summary line.

Entry shape stored in `expiryProbes[]`:

```js
{
  at: '2026-09-27T01:30:00.000Z',
  trigger: 'keeper' | 'collect' | 'refresh',
  ageHours: 10.2 | null, ageBasis: 'issuedAt' | 'savedAt' | null, sinceLastVerifiedHours: 0.5 | null,
  initialVerify: { status: 200 | null, authSetCookies: [/* summary */] },
  httpsProbe: {
    renewed: false, tokensChanged: false,
    steps: [
      { target: 'main', status: 302, location: '/auth/login', authSetCookies: [] },
      { target: 'product', status: 200, location: null, authSetCookies: [], pageLoggedIn: false },
      { target: 'login-status', status: 200, authSetCookies: [], loggedIn: false },
      // a failed step: { target, status: null, error: 'timeout' | 'network' }
    ],
  },
  browser: null | { ran, chromeLoggedIn, atkChanged, rtkChanged, requests: [{ method, host, path, status }], captureError },
}
// authSetCookies item: { name: 'app_atk', hasValue: true, deleted: false, attrs: { path: '/', 'max-age': '86400', httponly: true, ... } }
```

## Global Constraints

- Never print, log, store in meta, or send cookie/token values, nor their lengths or substrings. Only names, attributes, booleans, HTTP status and URL host + path may appear.
- The session cache lives only at `~/.clot/musinsa-session.json` (mode `0600`). Nothing session-related goes under the repo (`data/` is auto-committed and pushed by `daily`).
- Do not verify by running `node src/cli.js daily` (with or without `--force`): it re-collects and pushes to origin. Use `npm test`, `node src/cli.js power-status` and one-off `node -e` scripts that print only chosen fields.
- Musinsa `www` requests stay sequential with 700 ms spacing. Concurrent requests hit the rate limit.
- Incomplete input → fall back, never guess a price or a login state.
- Tests must never hit the network or Chrome: always inject `verify` / `fetchFn` / `execFn` / `fetchFromBridge`. The probe is **opt-in** (`probe` option); library defaults make no probe requests.
- The probe and its notifications must never break a keeper tick or a collection run.
- Commit messages use Conventional Commits and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in a git worktree off `main` (superpowers:using-git-worktrees). Tests import `tests/setup-env.js` first, so they never touch `data/prices.db`. Baseline: `npm test` → 248 passing.

## Review Focus

1. **Callers that pass no `probe`** (existing tests, `makeSessionProvider()` without options) must not send any probe request on a dead cookie. *Test: Task 3 "probe is off by default".*
2. **A cache file written by the old code** (`{cookie, savedAt}` only — today's real cache) must yield `ageBasis: 'savedAt'`, a numeric `ageHours` and `sinceLastVerifiedHours: null`. *Test: Task 3 "keeper records one entry…".*
3. **`login-status` flaps**: the expired cookie itself is accepted on the probe's final check. It must count as `renewed` with `tokensChanged: false` and be shown as `RENEWED(same tokens)`, not as a discovered refresh path. *Tests: Task 2 "expired cookie accepted again", Task 4 formatter.*
4. **OpenCLI's capture cache** must not leave token-bearing bodies on disk: `OPENCLI_CACHE_DIR` points to a temp dir that is gone after the bridge returns, even when `network` throws. *Test: Task 5 "network capture uses a throwaway cache dir".*
5. **`network` fails or prints an error envelope / non-JSON**: the bridge still returns the cookie, `onCapture` is called exactly once with `captureError` set. *Test: Task 5 "capture failure does not block the cookie".*

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/session.js` | Modify | `summarizeAuthSetCookies`, `verifySession` diagnostics, `probeExpiredSession`, probe recording in `verifyCached`, `formatExpiryProbeSummary`, `parseNetworkCapture`, bridge `onCapture` |
| `src/notifier.js` | Modify | `formatExpiryProbeMessage`, `notifyExpiryProbe` |
| `src/cli.js` | Modify | `sessionProbeOptions()`; pass `probe` to the keeper (`:362`) and to both `makeSessionProvider` calls (`:408`, `:807`) |
| `tests/session-probe.test.js` | Create | All probe tests, including the no-leak test |
| `tests/session-keeper.test.js` | Extend | `sessionKeeperSuffix` forwards `probe` |

## Before Task 1

- [ ] Create the worktree off `main` (superpowers:using-git-worktrees), copy this plan into it, and commit it:

```bash
git add docs/plans/2026-09-26-expiry-probe.md
git commit -m "docs(plans): add Musinsa token expiry probe implementation plan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] Run `npm test`. Expected: 248 passing, 0 failing.

---

### Task 1: Value-free Set-Cookie summary and `verifySession` diagnostics

**Files:**
- Modify: `src/session.js:50-127` (add `summarizeAuthSetCookies` after `isDeletion`; replace `verifySession`)
- Create: `tests/session-probe.test.js`

**Interfaces:**
- Consumes: existing `isDeletion(attrs, value, now)`, `mergeAuthSetCookies`, `parseAuthCookies`, `serializeAuthCookies`, `isValidCookieValue`.
- Produces:
  - `summarizeAuthSetCookies(setCookieHeaders: string[], now?: number) → Array<{ name: string, hasValue: boolean, deleted: boolean, attrs: Record<string, string|true> }>` (auth cookies only; `attrs` keys lower-case: `path`, `domain`, `max-age`, `expires`, `samesite` → string; `httponly`, `secure` → `true`)
  - `verifySession(cookie, { fetchFn = fetch, diagnostics = false })` → as before; with `diagnostics: true` also `status: number|null` and `authSetCookies` (summary above).

- [ ] **Step 1: Write the failing tests**

Create `tests/session-probe.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/session-probe.test.js`
Expected: FAIL — `session.summarizeAuthSetCookies is not a function`; the diagnostics test fails on `r.status` being `undefined`.

- [ ] **Step 3: Implement**

In `src/session.js`, directly after `isDeletion` (ends at `:60`), add:

```js
const SUMMARY_STRING_ATTRS = ['path', 'domain', 'max-age', 'expires', 'samesite'];
const SUMMARY_FLAG_ATTRS = ['httponly', 'secure'];

/** Log-safe view of auth Set-Cookie headers: names, attributes and booleans — never values or lengths. */
export function summarizeAuthSetCookies(setCookieHeaders = [], now = Date.now()) {
  const out = [];
  for (const header of setCookieHeaders || []) {
    const [pair, ...attrs] = String(header).split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!AUTH_COOKIE_NAMES.includes(name)) continue;
    const value = pair.slice(eq + 1).trim();
    const summary = {};
    for (const attr of attrs) {
      const i = attr.indexOf('=');
      const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
      if (SUMMARY_STRING_ATTRS.includes(key) && i >= 0) summary[key] = attr.slice(i + 1).trim();
      else if (SUMMARY_FLAG_ATTRS.includes(key)) summary[key] = true;
    }
    out.push({ name, hasValue: Boolean(value), deleted: isDeletion(attrs, value, now), attrs: summary });
  }
  return out;
}
```

Replace the whole `verifySession` (`:89-127`, doc comment included) with:

```js
/**
 * One login-status call. loggedIn: true/false, or null when the answer is unknown
 * (network error, non-2xx, non-JSON, missing flag) — callers then keep the cache.
 * Picks up new tokens from Set-Cookie and from data.authTokenInfo (raw cookie values).
 * diagnostics: true also returns the HTTP status and a value-free auth Set-Cookie summary.
 */
export async function verifySession(cookie, { fetchFn = fetch, diagnostics = false } = {}) {
  const { result, status, setCookies } = await verifyOnce(cookie, fetchFn);
  return diagnostics ? { ...result, status, authSetCookies: summarizeAuthSetCookies(setCookies) } : result;
}

async function verifyOnce(cookie, fetchFn) {
  let res;
  try {
    res = await fetchFn(LOGIN_STATUS_URL, {
      headers: { Cookie: cookie, 'User-Agent': USER_AGENT, Accept: 'application/json', Referer: 'https://www.musinsa.com/' },
      // A stalled connection must not hold up a daily tick for fetch's ~300 s default.
      signal: AbortSignal.timeout(LOGIN_STATUS_TIMEOUT_MS),
    });
  } catch {
    return { result: { loggedIn: null, cookie, rotated: false }, status: null, setCookies: [] };
  }
  const status = typeof res.status === 'number' ? res.status : null;
  const setCookies = res.headers?.getSetCookie?.() ?? [];
  const done = (result) => ({ result, status, setCookies });
  const merged = mergeAuthSetCookies(cookie, setCookies);
  if (merged.revoked) return done({ loggedIn: false, cookie: merged.cookie, rotated: merged.rotated });
  if (!res.ok) return done({ loggedIn: null, cookie, rotated: false });
  let body;
  try {
    body = await res.json();
  } catch {
    return done({ loggedIn: null, cookie, rotated: false });
  }
  const loggedIn = typeof body?.data?.loggedIn === 'boolean' ? body.data.loggedIn : null;
  if (loggedIn !== true) return done({ loggedIn, cookie: loggedIn === null ? cookie : merged.cookie, rotated: false });

  const jar = parseAuthCookies(merged.cookie);
  let rotated = merged.rotated;
  const tokens = body.data.authTokenInfo || {};
  for (const [name, value] of [['app_atk', tokens.accessToken], ['app_rtk', tokens.refreshToken]]) {
    if (isValidCookieValue(value) && jar.get(name) !== value) {
      jar.set(name, value);
      rotated = true;
    }
  }
  return done({ loggedIn: true, cookie: serializeAuthCookies(jar), rotated });
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/session-probe.test.js && npm test`
Expected: PASS; full suite 253 passing (248 + 5), 0 failing.

- [ ] **Step 5: Commit**

```bash
git add src/session.js tests/session-probe.test.js
git commit -m "feat(session): value-free auth Set-Cookie summary and opt-in verifySession diagnostics" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `probeExpiredSession` — main → product → login-status with a chained jar

**Files:**
- Modify: `src/session.js` (import `extractProductDetail`; add the probe after `verifyOnce`)
- Test: `tests/session-probe.test.js`

**Interfaces:**
- Consumes: `summarizeAuthSetCookies`, `verifySession(cookie, { fetchFn, diagnostics: true })` (Task 1); `mergeAuthSetCookies`, `parseAuthCookies`, `isUsable`; `extractProductDetail(html, goodsNo)` from `src/myprice.js`.
- Produces: `probeExpiredSession(cookie: string, { fetchFn = fetch, goodsNo = null, delayMs = 700 }) → Promise<{ steps: Step[], renewed: boolean, tokensChanged: boolean, renewedCookie: string|null }>`; `Step` = `{ target: 'main'|'product'|'login-status', status: number|null, location?: string|null, authSetCookies?: Summary[], pageLoggedIn?: boolean|null, loggedIn?: boolean|null, error?: 'timeout'|'network' }`. `renewedCookie` is for the caller only and must never be stored in meta.

- [ ] **Step 1: Write the failing tests**

Append to `tests/session-probe.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/session-probe.test.js`
Expected: FAIL — `session.probeExpiredSession is not a function`.

- [ ] **Step 3: Implement**

In `src/session.js` change the import at `:6`:

```js
import { USER_AGENT, extractProductDetail } from './myprice.js';
```

Add below the other constants (after `KEEPER_BRIDGE_BACKOFF_MS`):

```js
const PROBE_DELAY_MS = 700;
```

Add after `verifyOnce`:

```js
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

function locationPath(res, base) {
  const loc = res.headers?.get?.('location');
  if (!loc) return null;
  try {
    return new URL(loc, base).pathname; // the query may carry tokens (returnUrl, t=…)
  } catch {
    return null;
  }
}

async function probeStep(target, url, jar, fetchFn, goodsNo = null) {
  let res;
  try {
    res = await fetchFn(url, {
      headers: { Cookie: jar.cookie, 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml', Referer: 'https://www.musinsa.com/' },
      redirect: 'manual',
      signal: AbortSignal.timeout(LOGIN_STATUS_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { target, status: null, error: timedOut ? 'timeout' : 'network' };
  }
  const setCookies = res.headers?.getSetCookie?.() ?? [];
  jar.cookie = mergeAuthSetCookies(jar.cookie, setCookies).cookie;
  const step = {
    target,
    status: typeof res.status === 'number' ? res.status : null,
    location: locationPath(res, url),
    authSetCookies: summarizeAuthSetCookies(setCookies),
  };
  if (goodsNo !== null) {
    try {
      step.pageLoggedIn = res.ok ? extractProductDetail(await res.text(), goodsNo)?.loggedIn ?? null : null;
    } catch {
      step.pageLoggedIn = null;
    }
  }
  return step;
}

/**
 * Replays what a browser does with an expired cookie — main page, one product page (SSR), then
 * login-status — carrying any auth Set-Cookie forward, to see whether the server refreshes tokens.
 * renewedCookie is for the caller only; never store it in meta or print it.
 */
export async function probeExpiredSession(cookie, { fetchFn = fetch, goodsNo = null, delayMs = PROBE_DELAY_MS } = {}) {
  const jar = { cookie };
  const steps = [await probeStep('main', 'https://www.musinsa.com/', jar, fetchFn)];
  if (goodsNo) {
    await sleep(delayMs);
    steps.push(await probeStep('product', `https://www.musinsa.com/products/${goodsNo}`, jar, fetchFn, goodsNo));
  }
  const final = await verifySession(jar.cookie, { fetchFn, diagnostics: true });
  steps.push({ target: 'login-status', status: final.status, authSetCookies: final.authSetCookies, loggedIn: final.loggedIn });
  const renewed = final.loggedIn === true && isUsable(parseAuthCookies(final.cookie));
  return {
    steps,
    renewed,
    tokensChanged: renewed && final.cookie !== cookie,
    renewedCookie: renewed ? final.cookie : null,
  };
}
```

Note: `verifyOnce`'s network-error path gives `status: null`, so a failed final step reads `{ target: 'login-status', status: null, authSetCookies: [], loggedIn: null }`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/session-probe.test.js && npm test`
Expected: PASS; 259 passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add src/session.js tests/session-probe.test.js
git commit -m "feat(session): probe an expired cookie over HTTPS with a chained cookie jar" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Record the probe on first death; adopt an HTTPS renewal

**Files:**
- Modify: `src/session.js` — `verifyCached` (`:260-271`), `getSessionCookie` (`:281-292`), `refreshSessionCookie` (`:298-309`), `makeSessionProvider` (`:311-319`), `keepSessionAlive` (`:340-358`); add `probeAges`, `appendExpiryProbe`, `runExpiryProbe`
- Test: `tests/session-probe.test.js`

**Interfaces:**
- Consumes: `probeExpiredSession` (Task 2); `verify(cookie, { diagnostics: true })` returning optional `status` / `authSetCookies` (Task 1).
- Produces:
  - Option `probe: null | { fetchFn?, goodsNo?: number|null, delayMs?: number, notify?: (line: string) => Promise<unknown> }` on `getSessionCookie`, `refreshSessionCookie`, `keepSessionAlive`, `makeSessionProvider`. `null` (default) = no probe.
  - `verifyCached(sessionPath, verify, probe = null, trigger = 'collect')` → `{ cookie, loggedIn, probeAt?: string|null, expiredCookie?: string, renewedByProbe?: true }`.
  - Meta field `expiryProbes: Entry[]` (last 3; shape in *Background*), `browser: null` until Task 5.
  - `keepSessionAlive` returns `status: 'renewed'` when the HTTPS probe renewed.

- [ ] **Step 1: Write the failing tests**

Append to `tests/session-probe.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/session-probe.test.js`
Expected: FAIL — `probes()` is `undefined` in the recording tests; the HTTPS-renewal test sees `bridgeCalls === 1`.

- [ ] **Step 3: Implement**

Add below `PROBE_DELAY_MS`:

```js
const MAX_EXPIRY_PROBES = 3;
```

Add after `formatSessionSummary` (before the bridge section):

```js
function probeAges(meta, now) {
  const ageBasis = meta.issuedAt ? 'issuedAt' : meta.savedAt ? 'savedAt' : null;
  return {
    ageHours: ageBasis ? hoursSince(meta[ageBasis], now) : null,
    ageBasis,
    sinceLastVerifiedHours: hoursSince(meta.lastVerifiedAt, now),
  };
}

function appendExpiryProbe(entry, sessionPath) {
  const prev = readSessionMeta(sessionPath).expiryProbes;
  const list = Array.isArray(prev) ? prev : [];
  updateSessionMeta({ expiryProbes: [...list, entry].slice(-MAX_EXPIRY_PROBES) }, sessionPath);
}

/** First sight of a dead cookie: record how the server reacts to it. Never throws. */
async function runExpiryProbe(sessionPath, cached, initial, probe, trigger) {
  try {
    const now = new Date();
    const ages = probeAges(readSessionMeta(sessionPath), now);
    let https;
    try {
      https = await probeExpiredSession(cached, { fetchFn: probe.fetchFn, goodsNo: probe.goodsNo, delayMs: probe.delayMs });
    } catch {
      https = { steps: [], renewed: false, tokensChanged: false, renewedCookie: null };
    }
    const entry = {
      at: now.toISOString(),
      trigger,
      ...ages,
      initialVerify: { status: initial.status ?? null, authSetCookies: initial.authSetCookies ?? [] },
      httpsProbe: { steps: https.steps, renewed: https.renewed, tokensChanged: https.tokensChanged },
      browser: null,
    };
    appendExpiryProbe(entry, sessionPath);
    return { probeAt: entry.at, renewedCookie: https.renewedCookie };
  } catch (err) {
    console.warn(`[Session Probe Notice] ${err.message}`);
    return { probeAt: null, renewedCookie: null };
  }
}
```

Replace `verifyCached` with:

```js
/**
 * Verifies the cached cookie over HTTPS; persists rotations and records lifetime on death.
 * With `probe`, the first death is also probed (runExpiryProbe) before the caller clears the cache.
 */
async function verifyCached(sessionPath, verify, probe = null, trigger = 'collect') {
  const cached = readSessionCookie(sessionPath);
  if (!cached) return { cookie: null, loggedIn: false };
  const result = await verify(cached, probe ? { diagnostics: true } : undefined);
  if (result.loggedIn === true) {
    if (result.cookie !== cached) writeSessionCookie(result.cookie, sessionPath);
    updateSessionMeta({ lastVerifiedAt: new Date().toISOString() }, sessionPath);
    return { cookie: result.cookie, loggedIn: true };
  }
  if (result.loggedIn !== false) return { cookie: cached, loggedIn: result.loggedIn };
  recordObservedLifetime(sessionPath);
  if (!probe) return { cookie: cached, loggedIn: false };
  const { probeAt, renewedCookie } = await runExpiryProbe(sessionPath, cached, result, probe, trigger);
  if (renewedCookie) {
    writeSessionCookie(renewedCookie, sessionPath);
    updateSessionMeta({ lastVerifiedAt: new Date().toISOString() }, sessionPath);
    return { cookie: renewedCookie, loggedIn: true, probeAt, renewedByProbe: true };
  }
  return { cookie: cached, loggedIn: false, probeAt, expiredCookie: cached };
}
```

Replace `getSessionCookie` and `refreshSessionCookie` with:

```js
export async function getSessionCookie({
  path: sessionPath = DEFAULT_SESSION_PATH,
  allowBridge = true,
  fetchFromBridge = fetchSessionCookieFromBridge,
  verify = verifySession,
  probe = null,
} = {}) {
  const v = await verifyCached(sessionPath, verify, probe, 'collect');
  // null = login-status unknown: keep using the cache rather than dropping a possibly-good session.
  if (v.loggedIn !== false) return v.cookie;
  return renewFromBridge(sessionPath, allowBridge, fetchFromBridge);
}

/**
 * Called after a product page reported logged-out: only a confirmed HTTPS login avoids the bridge.
 * failedCookie = the cookie that page rejected; login-status accepting that same cookie is not
 * enough (it would be retried and fail again forever), so it also goes to the bridge.
 */
export async function refreshSessionCookie({
  path: sessionPath = DEFAULT_SESSION_PATH,
  allowBridge = true,
  fetchFromBridge = fetchSessionCookieFromBridge,
  verify = verifySession,
  failedCookie = null,
  probe = null,
} = {}) {
  const v = await verifyCached(sessionPath, verify, probe, 'refresh');
  if (v.loggedIn === true && v.cookie !== failedCookie) return v.cookie;
  return renewFromBridge(sessionPath, allowBridge, fetchFromBridge);
}
```

In `makeSessionProvider`, change the signature and `opts`:

```js
export function makeSessionProvider({ allowBridge = true, path: sessionPath = DEFAULT_SESSION_PATH, fetchFromBridge, verify, probe = null } = {}) {
  const opts = {
    path: sessionPath,
    allowBridge,
    ...(fetchFromBridge ? { fetchFromBridge } : {}),
    ...(verify ? { verify } : {}),
    ...(probe ? { probe } : {}),
  };
```

(the rest of `makeSessionProvider` is unchanged).

In `keepSessionAlive`, add `probe = null,` to the destructured options (after `now = new Date(),`) and replace the two lines

```js
  const { loggedIn } = await verifyCached(sessionPath, verify);
  if (loggedIn !== false) return { status: 'ok', ...describeSession(sessionPath, now) };
```

with

```js
  const v = await verifyCached(sessionPath, verify, probe, 'keeper');
  if (v.loggedIn !== false) return { status: v.renewedByProbe ? 'renewed' : 'ok', ...describeSession(sessionPath, now) };
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/session-probe.test.js && npm test`
Expected: PASS; 268 passing, 0 failing (existing `session.test.js` / `session-keeper.test.js` untouched and green).

- [ ] **Step 5: Commit**

```bash
git add src/session.js tests/session-probe.test.js
git commit -m "feat(session): record an expiry probe on first cookie death and adopt an HTTPS renewal" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: One-line summary, `🧪` log line and notify hook

**Files:**
- Modify: `src/session.js` — add `formatExpiryProbeSummary`, `finishExpiryProbe`; call it from `getSessionCookie`, `refreshSessionCookie`, `keepSessionAlive`
- Test: `tests/session-probe.test.js`

**Interfaces:**
- Consumes: `expiryProbes` entries and `probeAt` (Task 3); `probe.notify`.
- Produces: `formatExpiryProbeSummary(entry) → string` (value-free, single line); every probe prints exactly one `🧪 [Session Probe] <summary>` line and calls `probe.notify(summary)` once, after any bridge renewal (so Task 5's `browser` data is included).

- [ ] **Step 1: Write the failing tests**

Append to `tests/session-probe.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/session-probe.test.js`
Expected: FAIL — `session.formatExpiryProbeSummary is not a function`; no `🧪` line; `notified` empty.

- [ ] **Step 3: Implement**

Add after `runExpiryProbe`:

```js
const fmtAuth = (list) => (list?.length ? list.map((c) => `${c.name}${c.deleted ? '✗' : '✓'}`).join('+') : 'no-auth-cookie');

function fmtStep(s) {
  if (s.error) return `${s.target} ${s.error}`;
  const loc = s.location ? `→${s.location}` : '';
  const flag = s.target === 'product' ? ` loggedIn=${s.pageLoggedIn}` : s.target === 'login-status' ? ` loggedIn=${s.loggedIn}` : '';
  return `${s.target} ${s.status}${loc} ${fmtAuth(s.authSetCookies)}${flag}`;
}

function fmtBrowser(b) {
  if (!b) return 'browser: not run';
  const requests = b.requests || [];
  const shown = requests.slice(0, 5).map((r) => `${r.method} ${r.host}${r.path} ${r.status}`).join(', ');
  const err = b.captureError ? ` captureError=${b.captureError}` : '';
  return `browser: chrome=${b.chromeLoggedIn ? 'LOGGED_IN' : 'LOGGED_OUT'} atkChanged=${b.atkChanged} rtkChanged=${b.rtkChanged} authReqs=${requests.length}${shown ? ` [${shown}]` : ''}${err}`;
}

/** Log-safe one-liner for an expiryProbes entry (it holds no values to begin with). */
export function formatExpiryProbeSummary(e) {
  const age = e.ageHours === null ? 'age ?' : `age≈${e.ageHours}h(${e.ageBasis})`;
  const last = e.sinceLastVerifiedHours === null ? '' : `, last ok ${e.sinceLastVerifiedHours}h ago`;
  const iv = e.initialVerify || {};
  const https = e.httpsProbe?.renewed ? `RENEWED${e.httpsProbe.tokensChanged ? '' : '(same tokens)'}` : 'not renewed';
  const steps = (e.httpsProbe?.steps || []).map(fmtStep).join(', ');
  return `[${e.trigger}] ${age}${last} — first login-status ${iv.status ?? '?'} ${fmtAuth(iv.authSetCookies)}; https ${https}: ${steps}; ${fmtBrowser(e.browser)}`;
}

/** Prints the 🧪 line and notifies once the probe entry is complete. Never throws. */
async function finishExpiryProbe(sessionPath, probeAt, notify) {
  if (!probeAt) return;
  try {
    const list = readSessionMeta(sessionPath).expiryProbes;
    const entry = Array.isArray(list) ? list.find((e) => e.at === probeAt) : null;
    if (!entry) return;
    const line = formatExpiryProbeSummary(entry);
    console.log(`🧪 [Session Probe] ${line}`);
    if (notify) await notify(line);
  } catch (err) {
    console.warn(`[Session Probe Notice] ${err.message}`);
  }
}
```

Replace the bodies after `verifyCached` in the three callers:

`getSessionCookie` — replace its last three lines (from `const v = …` to `return renewFromBridge(…)`) with:

```js
  const v = await verifyCached(sessionPath, verify, probe, 'collect');
  // null = login-status unknown: keep using the cache rather than dropping a possibly-good session.
  const cookie = v.loggedIn !== false ? v.cookie : await renewFromBridge(sessionPath, allowBridge, fetchFromBridge);
  await finishExpiryProbe(sessionPath, v.probeAt, probe?.notify);
  return cookie;
```

`refreshSessionCookie` — replace its last two lines with:

```js
  const v = await verifyCached(sessionPath, verify, probe, 'refresh');
  const cookie =
    v.loggedIn === true && v.cookie !== failedCookie ? v.cookie : await renewFromBridge(sessionPath, allowBridge, fetchFromBridge);
  await finishExpiryProbe(sessionPath, v.probeAt, probe?.notify);
  return cookie;
```

`keepSessionAlive` — replace everything after `if (!bridgeUsable) return { status: 'skipped' };` with:

```js
  const v = await verifyCached(sessionPath, verify, probe, 'keeper');
  const done = async (status) => {
    await finishExpiryProbe(sessionPath, v.probeAt, probe?.notify);
    return { status, ...describeSession(sessionPath, now) };
  };
  if (v.loggedIn !== false) return done(v.renewedByProbe ? 'renewed' : 'ok');
  // Chrome logged out: don't flash a tab on every 30-minute tick; retry at most every 2 h.
  const lastFail = Date.parse(readSessionMeta(sessionPath).lastBridgeFailedAt);
  if (Number.isFinite(lastFail) && now - lastFail < KEEPER_BRIDGE_BACKOFF_MS) return done('lost');
  const fresh = await renewFromBridge(sessionPath, true, fetchFromBridge);
  updateSessionMeta({ lastBridgeFailedAt: fresh ? null : now.toISOString() }, sessionPath);
  return done(fresh ? 'renewed' : 'lost');
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/session-probe.test.js && npm test`
Expected: PASS; 274 passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add src/session.js tests/session-probe.test.js
git commit -m "feat(session): log and report a one-line expiry probe summary" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Browser capture during the bridge renewal

**Files:**
- Modify: `src/session.js` — add `parseNetworkCapture`, `captureAuthRequests`, `patchExpiryProbe`; extend `fetchSessionCookieFromBridge` (`:227-257`) and `renewFromBridge` (`:273-279`); pass `v` at the three `renewFromBridge` call sites
- Test: `tests/session-probe.test.js`

**Interfaces:**
- Consumes: `verifyCached` result `{ probeAt, expiredCookie }` (Task 3); `finishExpiryProbe` runs after renewal (Task 4).
- Produces:
  - `parseNetworkCapture(raw: string) → Array<{ method, host, path, status }>`; throws `SyntaxError` on non-JSON and an `Error` with `captureCode` on an `{ error }` envelope.
  - `fetchSessionCookieFromBridge({ execFn, session, onCapture = null, expiredCookie = null })` — still returns `string|null`; when `onCapture` is set it runs `opencli browser <s> network --all` after `open` and calls `onCapture({ ran, chromeLoggedIn, atkChanged, rtkChanged, requests, captureError })` exactly once.
  - `renewFromBridge(sessionPath, allowBridge, fetchFromBridge, expiry = null)` — with `expiry.probeAt`, calls `fetchFromBridge({ onCapture, expiredCookie })` and stores the capture as the entry's `browser`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/session-probe.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/session-probe.test.js`
Expected: FAIL — `session.parseNetworkCapture is not a function`; bridge tests see no `network` command; `probes()[0].browser` is `null`.

- [ ] **Step 3: Implement**

Add below `MAX_EXPIRY_PROBES`:

```js
const AUTH_URL_RE = /auth|token|refresh|reissue|login|member/i;
const MAX_CAPTURED_REQUESTS = 20;
```

Add before `fetchSessionCookieFromBridge`:

```js
/**
 * `opencli browser <s> network --all` envelope -> auth-looking requests as { method, host, path, status }.
 * Bodies, shapes and query strings are never kept. Throws on non-JSON (SyntaxError) or an error envelope.
 */
export function parseNetworkCapture(raw) {
  const parsed = JSON.parse(String(raw || '').trim());
  if (parsed?.error) {
    const err = new Error('network capture failed');
    err.captureCode = String(parsed.error.code || 'unknown');
    throw err;
  }
  const out = [];
  for (const e of Array.isArray(parsed?.entries) ? parsed.entries : []) {
    let u;
    try {
      u = new URL(e.url);
    } catch {
      continue;
    }
    if (!AUTH_URL_RE.test(u.hostname + u.pathname)) continue;
    out.push({
      method: String(e.method || 'GET').toUpperCase(),
      host: u.hostname,
      path: u.pathname,
      status: Number.isFinite(e.status) ? e.status : null,
    });
    if (out.length >= MAX_CAPTURED_REQUESTS) break;
  }
  return out;
}

function captureAuthRequests(execFn, session, opts) {
  // OpenCLI caches captured response bodies on disk, and the page's own login-status response carries
  // the tokens: keep that copy in a throwaway dir instead of ~/.opencli/cache.
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-netcap-'));
  try {
    const raw = execFn(`opencli browser ${session} network --all`, {
      ...opts,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...opts.env, OPENCLI_CACHE_DIR: cacheDir },
    });
    return { requests: parseNetworkCapture(raw), captureError: null };
  } catch (err) {
    const captureError = err instanceof SyntaxError ? 'parse' : err.captureCode ? `opencli:${err.captureCode}` : 'exec';
    return { requests: [], captureError };
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}
```

Replace `fetchSessionCookieFromBridge` with:

```js
/**
 * Reads the auth cookies from the logged-in Chrome through the OpenCLI browser bridge.
 * onCapture (expiry probe only): also captures the page load's auth-looking requests right after
 * `open` and reports them once, with booleans comparing Chrome's tokens to expiredCookie.
 * @returns {string|null} null when the bridge is unavailable or Chrome is logged out
 */
export function fetchSessionCookieFromBridge({ execFn = execSync, session = 'clot-auth', onCapture = null, expiredCookie = null } = {}) {
  const opts = getExecOptions({ encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
  const capture = onCapture
    ? { ran: false, chromeLoggedIn: null, atkChanged: null, rtkChanged: null, requests: [], captureError: null }
    : null;
  try {
    execFn(`opencli browser ${session} open https://www.musinsa.com/`, opts);
    // `open` starts network capture before navigating, so this sees the page load (not our eval below).
    if (capture) Object.assign(capture, { ran: true }, captureAuthRequests(execFn, session, opts));
    // Confirm the page's session is live (this also lets the page refresh its tokens) before reading cookies.
    const status = String(execFn(`opencli browser ${session} eval '${BRIDGE_LOGIN_CHECK_JS}'`, opts) || '');
    if (capture) capture.chromeLoggedIn = status.includes('LOGGED_IN');
    if (!status.includes('LOGGED_IN')) {
      console.warn('[Session Notice] Chrome is not logged in to Musinsa (bridge login-status check).');
      return null;
    }
    const raw = String(execFn(`opencli browser ${session} eval 'document.cookie'`, opts) || '').trim();
    let value = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') value = parsed;
    } catch {
      // plain (unquoted) output
    }
    const jar = parseAuthCookies(value);
    if (capture) {
      const old = parseAuthCookies(expiredCookie);
      const changed = (name) => (jar.get(name) ? jar.get(name) !== old.get(name) : null);
      capture.atkChanged = changed('app_atk');
      capture.rtkChanged = changed('app_rtk');
    }
    return jar.get('app_atk') && jar.get('app_rtk') ? serializeAuthCookies(jar) : null;
  } catch (err) {
    console.warn(`[Session Notice] Could not read Musinsa cookies from browser bridge: ${err.message}`);
    return null;
  } finally {
    if (capture) {
      try {
        onCapture(capture);
      } catch {
        // recording must never break renewal
      }
    }
    try {
      execFn(`opencli browser ${session} close`, opts);
    } catch {
      // best effort
    }
  }
}
```

Add after `appendExpiryProbe`:

```js
function patchExpiryProbe(at, patch, sessionPath) {
  const list = readSessionMeta(sessionPath).expiryProbes;
  if (!Array.isArray(list)) return;
  updateSessionMeta({ expiryProbes: list.map((e) => (e.at === at ? { ...e, ...patch } : e)) }, sessionPath);
}
```

Replace `renewFromBridge` with:

```js
async function renewFromBridge(sessionPath, allowBridge, fetchFromBridge, expiry = null) {
  clearSessionCookie(sessionPath);
  if (!allowBridge) return null;
  const captureOpts = expiry?.probeAt
    ? { onCapture: (browser) => patchExpiryProbe(expiry.probeAt, { browser }, sessionPath), expiredCookie: expiry.expiredCookie }
    : undefined;
  const fresh = await fetchFromBridge(captureOpts);
  if (fresh) writeSessionCookie(fresh, sessionPath);
  return fresh || null;
}
```

Pass the verify result at the three call sites (add `, v` as the fourth argument):
- `getSessionCookie`: `await renewFromBridge(sessionPath, allowBridge, fetchFromBridge, v)`
- `refreshSessionCookie`: `await renewFromBridge(sessionPath, allowBridge, fetchFromBridge, v)`
- `keepSessionAlive`: `await renewFromBridge(sessionPath, true, fetchFromBridge, v)`

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/session-probe.test.js && npm test`
Expected: PASS; 284 passing, 0 failing. Existing `fetchSessionCookieFromBridge` tests in `tests/session.test.js` still pass (their `cmds[1]` is the login eval because no `onCapture` is given).

- [ ] **Step 5: Commit**

```bash
git add src/session.js tests/session-probe.test.js
git commit -m "feat(session): capture auth-looking browser requests during the probe's bridge renewal" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Turn the probe on for real runs; Telegram; no-leak test

**Files:**
- Modify: `src/notifier.js` (add after `notifySessionLost`, `:192-201`)
- Modify: `src/cli.js:11-12` (imports), `:318-343` (`sessionKeeperSuffix`), `:362`, `:408`, `:807`; add `sessionProbeOptions`
- Test: `tests/session-probe.test.js`, `tests/session-keeper.test.js`

**Interfaces:**
- Consumes: `probe` option on `keepSessionAlive` / `makeSessionProvider` (Tasks 3–5); `sendTelegramMessage(text)`; `db.getActiveVipItems()` (`src/db.js:148`, rows have `goods_no`).
- Produces:
  - `formatExpiryProbeMessage(summaryLine) → string` (HTML-escaped), `notifyExpiryProbe(summaryLine) → Promise<boolean>` in `src/notifier.js`.
  - `sessionProbeOptions({ getVipItems?, notify? }) → { goodsNo: number|null, notify }` in `src/cli.js`; never throws.
  - `sessionKeeperSuffix({ …, probe = null })` forwards `probe` to `keep`.

- [ ] **Step 1: Write the failing tests**

In `tests/session-probe.test.js`, add these two lines to the imports at the top of the file (after `import * as session …`):

```js
import { formatExpiryProbeMessage } from '../src/notifier.js';
import { sessionProbeOptions } from '../src/cli.js';
```

Then append:

```js
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
```

Append inside the `describe('sessionKeeperSuffix', …)` block of `tests/session-keeper.test.js` (after the last test in that block, before its closing `});`):

```js
  test('forwards the probe options to the keeper', async () => {
    const probe = { goodsNo: 1, notify: async () => {} };
    let seen;
    const keep = async (o) => { seen = o.probe; return { status: 'ok', ageHours: 1 }; };
    await sessionKeeperSuffix({ power: awake, today: '2026-09-26', keep, sessionPath: tmpPath, probe });
    assert.equal(seen, probe);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/session-probe.test.js tests/session-keeper.test.js`
Expected: FAIL — `formatExpiryProbeMessage` / `sessionProbeOptions` not exported (SyntaxError on import); keeper forwarding sees `undefined`.

- [ ] **Step 3: Implement**

`src/notifier.js`, after `notifySessionLost`:

```js
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function formatExpiryProbeMessage(summaryLine) {
  return [
    '<b>🧪 [Project-Clot] 무신사 토큰 만료 계측</b>\n',
    escapeHtml(summaryLine),
    '\n• 전체 기록: ~/.clot/musinsa-session.json 의 expiryProbes[] (값 없음)',
  ].join('\n');
}

/** One message per expiry probe — the summary line is already value-free. */
export async function notifyExpiryProbe(summaryLine) {
  return await sendTelegramMessage(formatExpiryProbeMessage(summaryLine));
}
```

`src/cli.js` line 12 — add `notifyExpiryProbe` to the notifier import:

```js
import { notifyPriceDropsAndRestocks, sendMacNotification, formatHotDealsSummary, sendTelegramMessage, notifySessionWarning, notifySessionLost, notifyExpiryProbe } from './notifier.js';
```

Add just above `sessionKeeperSuffix`:

```js
/** Real runs probe an expired Musinsa cookie once (see session.js runExpiryProbe). Never throws. */
export function sessionProbeOptions({ getVipItems = () => db.getActiveVipItems(), notify = notifyExpiryProbe } = {}) {
  let goodsNo = null;
  try {
    goodsNo = getVipItems()[0]?.goods_no ?? null;
  } catch {
    goodsNo = null; // the probe then just skips its product-page step
  }
  return { goodsNo, notify };
}
```

In `sessionKeeperSuffix`, add `probe = null,` to the destructured options (after `sessionPath = DEFAULT_SESSION_PATH,`) and change the keep call to:

```js
    const result = await keep({ bridgeUsable: true, path: sessionPath, probe });
```

Call sites:
- `:362` → `const keeper = await sessionKeeperSuffix({ power, today, probe: sessionProbeOptions() });`
- `:408` → `sessionProvider: makeSessionProvider({ allowBridge: !deferred, probe: sessionProbeOptions() }),`
- `:807` → `sessionProvider: makeSessionProvider({ allowBridge: true, probe: sessionProbeOptions() }),`

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/session-probe.test.js tests/session-keeper.test.js && npm test`
Expected: PASS; 288 passing, 0 failing.

- [ ] **Step 5: Smoke-check without collecting**

Run: `node src/cli.js power-status`
Expected: prints the power state and daily decision as before, no error, no `🧪` line.

Run (prints only field presence, never values):

```bash
node -e 'const s=require("os").homedir()+"/.clot/musinsa-session.json";const j=JSON.parse(require("fs").readFileSync(s,"utf8"));console.log({hasCookie:!!j.cookie,savedAt:j.savedAt,issuedAt:j.issuedAt??null,lastVerifiedAt:j.lastVerifiedAt??null,expiryProbes:(j.expiryProbes||[]).length})'
```

Expected: `expiryProbes: 0` (no probe has run yet; the probe only fires on a real expiry during a LaunchAgent tick).

- [ ] **Step 6: Commit**

```bash
git add src/notifier.js src/cli.js tests/session-probe.test.js tests/session-keeper.test.js
git commit -m "feat(daily): probe the Musinsa token at expiry and report it to Telegram" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the tasks

- Read results later with (safe to print whole — entries hold no values):

```bash
node -e 'const s=require("os").homedir()+"/.clot/musinsa-session.json";console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(s,"utf8")).expiryProbes||[],null,2))'
```

- Branch on the result as in the handoff: `httpsProbe.renewed && tokensChanged` → implement `refreshViaHttps`; a `browser.requests` entry that looks like a refresh (e.g. `reissue`, `token`) → reproduce it in Node after one `--detail` look at its shape (names only); nothing → choose between option B and C.
