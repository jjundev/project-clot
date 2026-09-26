# Musinsa Session Keeper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the cached Musinsa login cookie (`~/.clot/musinsa-session.json`) valid for as long as possible without a browser. Verify it over HTTPS, absorb any token the server hands back, renew it through the OpenCLI bridge on every awake daily tick when it has died, and record how long tokens actually live.

**Architecture:** Most of the work is in `src/session.js`. It gains a cookie jar (parse/serialize/merge `Set-Cookie`), a metadata-bearing cache file, `verifySession` (one `login-status` call), and `keepSessionAlive`. `getSessionCookie` and `refreshSessionCookie` now verify over HTTPS before touching the bridge. The collector passes product-page `Set-Cookie` headers back to the provider (`absorb`). The daily "already collected" tick runs the keeper when the Mac is awake and sends a Telegram alert at most once a day when the session is lost.

**Tech Stack:** Node.js ESM, global `fetch` (`res.headers.getSetCookie()`), `node:test` + `node:assert/strict`, OpenCLI CLI (`opencli browser …`).

**Spec:** Design from the 2026-09-26 grill-yourself session (A only of the "OpenCLI 의존 제거" handoff). It is condensed in *Background (Spec)* below.

## Background (Spec)

Facts verified on 2026-09-26. No token values were printed.

| Fact | Evidence |
|---|---|
| `app_atk` is opaque (URL-encoded base64, 838 chars → 576 bytes). It is **not** a JWT and has no readable `exp`. | Local decode of `~/.clot/musinsa-session.json` |
| `mss_mac` is an HS256 JWT with a 1-year `exp`. It is not needed to authenticate. | Local decode; cookie-combination test |
| Only `app_atk` **+** `app_rtk` together make `login-status` return `loggedIn: true`. atk alone, rtk alone and mss_mac alone all return false. | Combination probe |
| `GET https://my.musinsa.com/api/member/v1/login-status` returns `data.loggedIn` and `data.authTokenInfo.{accessToken,refreshToken}`. `accessToken` equals the **raw (still URL-encoded)** `app_atk` cookie value and `refreshToken` equals `app_rtk`. The values are stable across calls. | Probe |
| While tokens are valid, no response carries auth `Set-Cookie` (only `SCOUTER`, `_gf`, `one_uuid`, `__cf_bm`). | Probe of login-status and www |
| A corrupted `app_atk` with the real `app_rtk` is **not** reissued by the server (login-status and product page → `loggedIn: false`, no auth `Set-Cookie`). The real cookie still worked afterwards, so the Chrome session was unaffected. | Experiment approved by the user (N1) |
| In the bridge, `opencli browser <s> eval '<js>'` **awaits a returned Promise**. An in-page `fetch(login-status, {credentials:"include"})` from `https://www.musinsa.com/` works (prints `LOGGED_IN`). | Probe |
| The daily LaunchAgent `com.musinsa.price-tracker` fires every 30 min, 9:30–21:30. Once the day is collected, each tick takes the skip branch at `src/cli.js:330-334`. | `plutil -p` of the plist |

Design decisions:
1. The main mechanism is the **session keeper**. On each awake tick it verifies the cache over HTTPS and, only if the cache is invalid or missing, renews it through the bridge. Absorbing server-sent tokens (`Set-Cookie` / `authTokenInfo`) stays as a cheap safety net.
2. A cached cookie is usable only if it has both `app_atk` and `app_rtk`.
3. Refresh order: HTTPS verify → clear cookie → bridge (only if allowed).
4. `login-status` result unknown (network error, non-2xx, non-JSON, missing flag) → keep the cache and use it. This is the same principle as commit `3f255d7`.
5. A `Set-Cookie` that deletes `app_atk` or `app_rtk` (empty value, `Max-Age<=0`, past `Expires`) means logged out: clear the cookie and fall back.
6. Absorb `Set-Cookie` from product-page responses only, not from the coupon or card APIs (other domains).
7. The bridge confirms `LOGGED_IN` in-page before reading `document.cookie`.
8. Record token lifetime in the cache file (`issuedAt`, `observedLifetimeHours[]` capped at 10). Each sample runs from issue until the token is *first observed* invalid, so it is an upper bound with up to 30 min of error while awake.
9. `daily_runs.mode` rules are unchanged: likes sync still needs the bridge.
10. Session lost (HTTPS and bridge both failed on an awake tick) → Mac + Telegram notification **at most once per day** (`lastWarnedOn` in the cache file). Deferred (asleep) collection runs never alert about this, because the bridge is expected to be unavailable then.

## Global Constraints

- Never print, log or commit cookie or token values, nor their lengths or substrings. Only names, ages and booleans may appear.
- The session cache lives only at `~/.clot/musinsa-session.json`, with mode `0600` and parent directory `0700`. Nothing session-related goes under the repo (`data/` is auto-committed and pushed by `daily`).
- Do not verify by running `node src/cli.js daily` (with or without `--force`): it re-collects and pushes to origin. Use `npm test`, `node src/cli.js power-status` and one-off `node -e` scripts.
- Product-page requests stay sequential with 700 ms spacing (existing `authDelayMs`). `login-status` is one extra request per run or tick.
- Incomplete input → fall back or return an error, never guess a price or a login state.
- Tests must never hit the network: always inject `verify` / `fetchFn` / `execFn` / `fetchFromBridge`.
- Commit messages use Conventional Commits and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in a git worktree off `main` (superpowers:using-git-worktrees). Tests import `tests/setup-env.js` first, so they no longer touch `data/prices.db`.

## Review Focus

1. **A pre-existing cache file** (written by the old code: only `{cookie, savedAt}`, possibly without `app_rtk`) must still load: rtk present → usable, with `ageHours` shown as `?`; rtk missing → treated as no cache → bridge. *Test: Task 1 "legacy cache file".*
2. **`login-status` returns a Cloudflare HTML page / 5xx / throws** → `loggedIn: null`. The cache is kept and used, not cleared, and no bridge tab opens. *Test: Task 2 "unknown status keeps cache".*
3. **A deletion `Set-Cookie` with a comma-bearing `Expires` date** (`Expires=Thu, 01 Jan 1970 00:00:00 GMT`) must count as revoked and not be mis-split. *Test: Task 1 "past Expires with comma".*
4. **Token values never reach stdout/stderr** from verify, get/refresh, the keeper or the skip-tick helper. *Test: Task 5 "no token leaks to console".*
5. **The keeper throws** (e.g. `EACCES` on `~/.clot`). The skip tick must still print its one line and return normally. *Test: Task 5 "keeper failure does not break the tick".*

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/session.js` | Modify (most of the work) | Cookie jar, cache file + metadata, `verifySession`, get/refresh ordering, provider `absorb`/`describe`, bridge login check, `keepSessionAlive` |
| `src/myprice.js` | Modify | Export `USER_AGENT`; `fetchAuthenticatedPriceInfo` forwards product-page `Set-Cookie` to an `onSetCookie` callback |
| `src/collector.js` | Modify `collectAuthenticatedPrices` (`:167-221`) | Wire `onSetCookie` → `provider.absorb`; print the session summary line |
| `src/notifier.js` | Modify | Add `notifySessionLost()` |
| `src/cli.js` | Modify skip branch (`:330-334`) + new export | `sessionKeeperSuffix()` helper |
| `tests/session.test.js` | Modify + extend | Jar, meta, verify, ordering, provider, bridge |
| `tests/collector-auth.test.js` | Extend | Mid-run absorb |
| `tests/myprice-fetch.test.js` | Extend | `onSetCookie` forwarding |
| `tests/session-keeper.test.js` | Create | `keepSessionAlive`, `sessionKeeperSuffix`, no-leak test |

---

### Task 1: Cookie jar and cache metadata

**Files:**
- Modify: `src/session.js:13-40` (replace `AUTH_COOKIE_RE`, `pickAuthCookies`, `readSessionCookie`, `writeSessionCookie`, `clearSessionCookie`)
- Test: `tests/session.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (all exported from `src/session.js`):
  - `parseAuthCookies(cookie: string|undefined): Map<string,string>`: only `app_atk|app_rtk|mss_mac`
  - `serializeAuthCookies(jar: Map): string`: canonical order `app_atk; app_rtk; mss_mac`
  - `pickAuthCookies(documentCookie: string): string` (unchanged signature)
  - `mergeAuthSetCookies(cookie: string, setCookieHeaders: string[], now?: number): { cookie: string, rotated: boolean, revoked: boolean }`
  - `readSessionCookie(path?): string|null`: null unless both `app_atk` and `app_rtk` are present
  - `writeSessionCookie(cookie: string, path?, { now?: Date }?): void`: keeps other fields; `issuedAt` moves only when `app_atk` changed
  - `clearSessionCookie(path?): void`: drops `cookie`, keeps metadata
  - `readSessionMeta(path?): object`: every field except `cookie`
  - `updateSessionMeta(patch: object, path?): void`
  - `recordObservedLifetime(path?, now?: Date): void`
  - `describeSession(path?, now?: Date): { cached: boolean, ageHours: number|null, observedLifetimeHours: number[] }`
  - `formatSessionSummary(desc): string`

- [ ] **Step 1: Write the failing tests**

In `tests/session.test.js`, extend the import list:

```js
import {
  DEFAULT_SESSION_PATH, pickAuthCookies, readSessionCookie, writeSessionCookie, clearSessionCookie,
  fetchSessionCookieFromBridge, getSessionCookie, refreshSessionCookie, makeSessionProvider,
  parseAuthCookies, serializeAuthCookies, mergeAuthSetCookies, readSessionMeta, updateSessionMeta,
  recordObservedLifetime, describeSession, formatSessionSummary,
} from '../src/session.js';
```

Replace the existing test `'clearSessionCookie removes the file and tolerates absence'` with:

```js
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
```

Append a new `describe` block:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/session.test.js`
Expected: FAIL. The new exports (`parseAuthCookies`, …) are not found (SyntaxError on import).

- [ ] **Step 3: Implement**

In `src/session.js`, replace everything from `const AUTH_COOKIE_RE = …` down to the end of `clearSessionCookie` (current lines 13-40) with:

```js
const AUTH_COOKIE_NAMES = ['app_atk', 'app_rtk', 'mss_mac'];
const MAX_LIFETIME_SAMPLES = 10;
const HOUR_MS = 3_600_000;

/** 'a=1; b=2' -> Map of only the auth cookies (values kept raw, still URL-encoded). */
export function parseAuthCookies(cookie) {
  const jar = new Map();
  for (const part of String(cookie || '').split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (AUTH_COOKIE_NAMES.includes(name)) jar.set(name, part.slice(eq + 1));
  }
  return jar;
}

export function serializeAuthCookies(jar) {
  return AUTH_COOKIE_NAMES.filter((n) => jar.get(n)).map((n) => `${n}=${jar.get(n)}`).join('; ');
}

export function pickAuthCookies(documentCookie) {
  return serializeAuthCookies(parseAuthCookies(documentCookie));
}

// Musinsa authenticates only with app_atk AND app_rtk together (verified 2026-09-26).
const isUsable = (jar) => Boolean(jar.get('app_atk') && jar.get('app_rtk'));

function isDeletion(attrs, value, now) {
  if (!value) return true;
  for (const attr of attrs) {
    const eq = attr.indexOf('=');
    const key = (eq < 0 ? attr : attr.slice(0, eq)).trim().toLowerCase();
    const val = eq < 0 ? '' : attr.slice(eq + 1).trim();
    if (key === 'max-age' && val !== '' && Number(val) <= 0) return true;
    if (key === 'expires' && Date.parse(val) <= now) return true;
  }
  return false;
}

/**
 * Applies Set-Cookie headers to the auth cookie string.
 * revoked = the server deleted app_atk or app_rtk (logged out).
 */
export function mergeAuthSetCookies(cookie, setCookieHeaders = [], now = Date.now()) {
  const jar = parseAuthCookies(cookie);
  let rotated = false;
  let revoked = false;
  for (const header of setCookieHeaders || []) {
    const [pair, ...attrs] = String(header).split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!AUTH_COOKIE_NAMES.includes(name)) continue;
    const value = pair.slice(eq + 1).trim();
    if (isDeletion(attrs, value, now)) {
      jar.delete(name);
      if (name !== 'mss_mac') revoked = true;
    } else if (jar.get(name) !== value) {
      jar.set(name, value);
      rotated = true;
    }
  }
  return { cookie: serializeAuthCookies(jar), rotated, revoked };
}

function readSessionFile(sessionPath) {
  try {
    const data = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeSessionFile(data, sessionPath) {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sessionPath, JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(sessionPath, 0o600);
}

export function readSessionCookie(sessionPath = DEFAULT_SESSION_PATH) {
  const { cookie } = readSessionFile(sessionPath);
  if (typeof cookie !== 'string') return null;
  const jar = parseAuthCookies(cookie);
  return isUsable(jar) ? serializeAuthCookies(jar) : null;
}

export function readSessionMeta(sessionPath = DEFAULT_SESSION_PATH) {
  const { cookie, ...meta } = readSessionFile(sessionPath);
  return meta;
}

export function updateSessionMeta(patch, sessionPath = DEFAULT_SESSION_PATH) {
  writeSessionFile({ ...readSessionFile(sessionPath), ...patch }, sessionPath);
}

/** Stores the cookie, keeping metadata. issuedAt moves only when app_atk changed (a new token). */
export function writeSessionCookie(cookie, sessionPath = DEFAULT_SESSION_PATH, { now = new Date() } = {}) {
  const prev = readSessionFile(sessionPath);
  const prevAtk = parseAuthCookies(prev.cookie).get('app_atk');
  const sameToken = prevAtk && prevAtk === parseAuthCookies(cookie).get('app_atk') && prev.issuedAt;
  const iso = now.toISOString();
  writeSessionFile({ ...prev, cookie, savedAt: iso, issuedAt: sameToken ? prev.issuedAt : iso }, sessionPath);
}

/** Drops the cookie but keeps metadata (lifetime samples, lastWarnedOn). */
export function clearSessionCookie(sessionPath = DEFAULT_SESSION_PATH) {
  if (!fs.existsSync(sessionPath)) return;
  writeSessionFile(readSessionMeta(sessionPath), sessionPath);
}

const hoursSince = (iso, now) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.round(((now - t) / HOUR_MS) * 10) / 10 : null;
};

/** Upper bound of the token lifetime: issuedAt -> the moment it was first seen invalid. */
export function recordObservedLifetime(sessionPath = DEFAULT_SESSION_PATH, now = new Date()) {
  const meta = readSessionMeta(sessionPath);
  const hours = hoursSince(meta.issuedAt, now);
  if (hours === null) return;
  const prev = Array.isArray(meta.observedLifetimeHours) ? meta.observedLifetimeHours : [];
  updateSessionMeta({ observedLifetimeHours: [...prev, hours].slice(-MAX_LIFETIME_SAMPLES) }, sessionPath);
}

export function describeSession(sessionPath = DEFAULT_SESSION_PATH, now = new Date()) {
  const meta = readSessionMeta(sessionPath);
  return {
    cached: readSessionCookie(sessionPath) !== null,
    ageHours: hoursSince(meta.issuedAt, now),
    observedLifetimeHours: Array.isArray(meta.observedLifetimeHours) ? meta.observedLifetimeHours : [],
  };
}

/** Log-safe one-liner: never contains cookie values. */
export function formatSessionSummary({ cached, ageHours, observedLifetimeHours = [] }) {
  if (!cached) return 'no cached session';
  const age = ageHours === null ? 'age ?' : `age ${ageHours}h`;
  const lives = observedLifetimeHours.slice(-3);
  return lives.length ? `${age}, observed lifetimes: ${lives.join('h, ')}h` : age;
}
```

The existing test `'provider: refresh=false reads cache, refresh=true re-fetches'` writes `'app_atk=OLD'` without rtk and will now fail. Task 2 rewrites it. For this task, update only its two cookie literals so Task 1 stays green:

```js
  test('provider: refresh=false reads cache, refresh=true re-fetches', async () => {
    writeSessionCookie('app_atk=OLD; app_rtk=R', tmpPath);
    const provider = makeSessionProvider({ path: tmpPath, allowBridge: true, fetchFromBridge: () => 'app_atk=NEW; app_rtk=R' });
    assert.equal(await provider(), 'app_atk=OLD; app_rtk=R');
    assert.equal(await provider({ refresh: true }), 'app_atk=NEW; app_rtk=R');
    assert.equal(readSessionCookie(tmpPath), 'app_atk=NEW; app_rtk=R');
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/session.test.js`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add src/session.js tests/session.test.js
git commit -m "feat(session): add auth cookie jar, Set-Cookie merge, and cache metadata

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: HTTPS session verification and refresh ordering

**Files:**
- Modify: `src/myprice.js:45-46` (export `USER_AGENT`)
- Modify: `src/session.js` (`getSessionCookie`, `refreshSessionCookie`, `makeSessionProvider`; add `verifySession`, internal `verifyCached`, `renewFromBridge`)
- Test: `tests/session.test.js`

**Interfaces:**
- Consumes (Task 1): `parseAuthCookies`, `serializeAuthCookies`, `mergeAuthSetCookies`, `readSessionCookie`, `writeSessionCookie`, `clearSessionCookie`, `updateSessionMeta`, `recordObservedLifetime`, `describeSession`.
- Produces:
  - `LOGIN_STATUS_URL = 'https://my.musinsa.com/api/member/v1/login-status'` (exported const)
  - `verifySession(cookie: string, { fetchFn? }): Promise<{ loggedIn: true|false|null, cookie: string, rotated: boolean }>`
  - `getSessionCookie({ path?, allowBridge?, fetchFromBridge?, verify? }): Promise<string|null>`
  - `refreshSessionCookie({ path?, allowBridge?, fetchFromBridge?, verify? }): Promise<string|null>`
  - `makeSessionProvider({ allowBridge?, path?, fetchFromBridge?, verify? })` returns `provider({ refresh? }): Promise<string|null>` plus `provider.absorb(setCookieHeaders: string[]): { cookie: string|null, revoked: boolean } | null` and `provider.describe(): ReturnType<describeSession>`
  - Internal (not exported, reused in Task 5): `verifyCached(sessionPath, verify): Promise<{ cookie: string|null, loggedIn: true|false|null }>` and `renewFromBridge(sessionPath, allowBridge, fetchFromBridge): Promise<string|null>`

- [ ] **Step 1: Write the failing tests**

Add `verifySession` and `LOGIN_STATUS_URL` to the import list in `tests/session.test.js`. Add these helpers below `COOKIE`:

```js
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
```

Replace the whole existing `describe('getSessionCookie / refreshSessionCookie / makeSessionProvider', …)` block with:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/session.test.js`
Expected: FAIL (`verifySession` / `LOGIN_STATUS_URL` not exported).

- [ ] **Step 3: Implement**

In `src/myprice.js` line 45, change `const USER_AGENT =` to `export const USER_AGENT =`.

In `src/session.js`, add to the imports:

```js
import { USER_AGENT } from './myprice.js';
```

Below `DEFAULT_SESSION_PATH`, add:

```js
export const LOGIN_STATUS_URL = 'https://my.musinsa.com/api/member/v1/login-status';
```

Add `verifySession` after `mergeAuthSetCookies`:

```js
/**
 * One login-status call. loggedIn: true/false, or null when the answer is unknown
 * (network error, non-2xx, non-JSON, missing flag) — callers then keep the cache.
 * Picks up new tokens from Set-Cookie and from data.authTokenInfo (raw cookie values).
 */
export async function verifySession(cookie, { fetchFn = fetch } = {}) {
  let res;
  try {
    res = await fetchFn(LOGIN_STATUS_URL, {
      headers: { Cookie: cookie, 'User-Agent': USER_AGENT, Accept: 'application/json', Referer: 'https://www.musinsa.com/' },
    });
  } catch {
    return { loggedIn: null, cookie, rotated: false };
  }
  const merged = mergeAuthSetCookies(cookie, res.headers?.getSetCookie?.() ?? []);
  if (merged.revoked) return { loggedIn: false, cookie: merged.cookie, rotated: merged.rotated };
  if (!res.ok) return { loggedIn: null, cookie, rotated: false };
  let body;
  try {
    body = await res.json();
  } catch {
    return { loggedIn: null, cookie, rotated: false };
  }
  const loggedIn = typeof body?.data?.loggedIn === 'boolean' ? body.data.loggedIn : null;
  if (loggedIn !== true) return { loggedIn, cookie: loggedIn === null ? cookie : merged.cookie, rotated: false };

  const jar = parseAuthCookies(merged.cookie);
  let rotated = merged.rotated;
  const tokens = body.data.authTokenInfo || {};
  for (const [name, value] of [['app_atk', tokens.accessToken], ['app_rtk', tokens.refreshToken]]) {
    if (typeof value === 'string' && value && jar.get(name) !== value) {
      jar.set(name, value);
      rotated = true;
    }
  }
  return { loggedIn: true, cookie: serializeAuthCookies(jar), rotated };
}
```

Replace the existing `getSessionCookie`, `refreshSessionCookie` and `makeSessionProvider` (current lines 72-98) with:

```js
/** Verifies the cached cookie over HTTPS; persists rotations and records lifetime on death. */
async function verifyCached(sessionPath, verify) {
  const cached = readSessionCookie(sessionPath);
  if (!cached) return { cookie: null, loggedIn: false };
  const result = await verify(cached);
  if (result.loggedIn === true) {
    if (result.cookie !== cached) writeSessionCookie(result.cookie, sessionPath);
    updateSessionMeta({ lastVerifiedAt: new Date().toISOString() }, sessionPath);
    return { cookie: result.cookie, loggedIn: true };
  }
  if (result.loggedIn === false) recordObservedLifetime(sessionPath);
  return { cookie: cached, loggedIn: result.loggedIn };
}

async function renewFromBridge(sessionPath, allowBridge, fetchFromBridge) {
  clearSessionCookie(sessionPath);
  if (!allowBridge) return null;
  const fresh = await fetchFromBridge();
  if (fresh) writeSessionCookie(fresh, sessionPath);
  return fresh || null;
}

export async function getSessionCookie({
  path: sessionPath = DEFAULT_SESSION_PATH,
  allowBridge = true,
  fetchFromBridge = fetchSessionCookieFromBridge,
  verify = verifySession,
} = {}) {
  const { cookie, loggedIn } = await verifyCached(sessionPath, verify);
  // null = login-status unknown: keep using the cache rather than dropping a possibly-good session.
  if (loggedIn !== false) return cookie;
  return renewFromBridge(sessionPath, allowBridge, fetchFromBridge);
}

/** Called after a product page reported logged-out: only a confirmed HTTPS login avoids the bridge. */
export async function refreshSessionCookie({
  path: sessionPath = DEFAULT_SESSION_PATH,
  allowBridge = true,
  fetchFromBridge = fetchSessionCookieFromBridge,
  verify = verifySession,
} = {}) {
  const { cookie, loggedIn } = await verifyCached(sessionPath, verify);
  if (loggedIn === true) return cookie;
  return renewFromBridge(sessionPath, allowBridge, fetchFromBridge);
}

/** Builds the `sessionProvider` consumed by collectPricesForActiveItems. */
export function makeSessionProvider({ allowBridge = true, path: sessionPath = DEFAULT_SESSION_PATH, fetchFromBridge, verify } = {}) {
  const opts = {
    path: sessionPath,
    allowBridge,
    ...(fetchFromBridge ? { fetchFromBridge } : {}),
    ...(verify ? { verify } : {}),
  };
  const provider = async ({ refresh = false } = {}) => (refresh ? refreshSessionCookie(opts) : getSessionCookie(opts));
  /** Applies Set-Cookie headers from an authenticated response to the cache. */
  provider.absorb = (setCookieHeaders) => {
    const current = readSessionCookie(sessionPath);
    if (!current) return null;
    const merged = mergeAuthSetCookies(current, setCookieHeaders);
    if (merged.revoked) {
      clearSessionCookie(sessionPath);
      return { cookie: null, revoked: true };
    }
    if (merged.rotated) writeSessionCookie(merged.cookie, sessionPath);
    return { cookie: merged.cookie, revoked: false };
  };
  provider.describe = () => describeSession(sessionPath);
  return provider;
}
```

Note: `getSessionCookie` with no cache gets `loggedIn: false` from `verifyCached` and goes straight to the bridge without calling `verify` (the "cache miss" test).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/session.test.js tests/collector-auth.test.js tests/myprice-fetch.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session.js src/myprice.js tests/session.test.js
git commit -m "feat(session): verify cached cookie over HTTPS before falling back to the bridge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Absorb product-page Set-Cookie during collection

**Files:**
- Modify: `src/myprice.js` (`fetchProductPage` ~`:73-88`, `fetchAuthenticatedPriceInfo` ~`:100-108`)
- Modify: `src/collector.js:167-221` (`collectAuthenticatedPrices`) + import
- Test: `tests/myprice-fetch.test.js`, `tests/collector-auth.test.js`

**Interfaces:**
- Consumes (Task 2): `provider.absorb(headers) → { cookie, revoked } | null` and `provider.describe()`. Consumes (Task 1): `formatSessionSummary(desc)`.
- Produces: `fetchAuthenticatedPriceInfo(goodsNo, { cookie, fetchFn?, retries?, backoffBaseMs?, onSetCookie? })`. `onSetCookie(headers: string[])` is called once per product-page response that carries at least one `Set-Cookie`.

- [ ] **Step 1: Write the failing tests**

In `tests/myprice-fetch.test.js`, add inside the existing `describe` for `fetchAuthenticatedPriceInfo`. Reuse the file's `pageHtml`, `res`, `makeFetch` and `GOODS`: `makeFetch({ pages })` returns the fetch function itself, and a non-string `pages` entry is returned as-is:

```js
  test('forwards product-page Set-Cookie headers to onSetCookie', async () => {
    const page = { ...res(200, pageHtml()), headers: { getSetCookie: () => ['app_atk=NEW; Path=/'] } };
    const fetchFn = makeFetch({ pages: [page] });
    const seen = [];
    await fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=OLD; app_rtk=R', fetchFn, onSetCookie: (h) => seen.push(h) });
    assert.deepEqual(seen, [['app_atk=NEW; Path=/']]);
  });

  test('responses without headers or Set-Cookie do not call onSetCookie', async () => {
    const seen = [];
    await fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=OLD; app_rtk=R', fetchFn: makeFetch(), onSetCookie: (h) => seen.push(h) });
    assert.deepEqual(seen, []);
  });
```

In `tests/collector-auth.test.js`, inside `describe('collectAuthenticatedPrices', …)`:

```js
  test('a rotated cookie absorbed mid-run is used for the next item', async () => {
    const provider = async () => 'app_atk=old; app_rtk=r';
    provider.absorb = (headers) => (headers.length ? { cookie: 'app_atk=new; app_rtk=r', revoked: false } : null);
    provider.describe = () => ({ cached: true, ageHours: 1, observedLifetimeHours: [] });
    const seenCookies = [];
    const authFetchFn = async (g, { cookie, onSetCookie }) => {
      seenCookies.push(cookie);
      if (g === 1) onSetCookie(['app_atk=new']);
      return authInfo(g, 13000);
    };
    await collectAuthenticatedPrices({ goodsNos: [1, 2], sessionProvider: provider, authFetchFn, authDelayMs: 0 });
    assert.deepEqual(seenCookies, ['app_atk=old; app_rtk=r', 'app_atk=new; app_rtk=r']);
  });

  test('providers without absorb/describe still work (onSetCookie is undefined)', async () => {
    let received;
    await collectAuthenticatedPrices({
      goodsNos: [1], sessionProvider: async () => 'app_atk=x; app_rtk=y',
      authFetchFn: async (g, opts) => { received = opts; return authInfo(g, 1); }, authDelayMs: 0,
    });
    assert.equal(received.onSetCookie, undefined);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/myprice-fetch.test.js tests/collector-auth.test.js`
Expected: FAIL. `seen` is `[]` in the first test, and the collector test sees `'app_atk=old…'` twice (or `onSetCookie is not a function`).

- [ ] **Step 3: Implement**

In `src/myprice.js`, change the `fetchProductPage` signature and add the callback right after the fetch:

```js
async function fetchProductPage(goodsNo, headers, fetchFn, retries, backoffBaseMs, onSetCookie) {
  const url = `https://www.musinsa.com/products/${goodsNo}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetchFn(url, { headers: { ...headers, Accept: 'text/html,application/xhtml+xml' } });
    const setCookies = res.headers?.getSetCookie?.() ?? [];
    if (onSetCookie && setCookies.length) onSetCookie(setCookies);
    if (res.status === 404) return { discontinued: true };
```

(The rest of the loop is unchanged.) In `fetchAuthenticatedPriceInfo`:

```js
export async function fetchAuthenticatedPriceInfo(
  goodsNo,
  { cookie, fetchFn = fetch, retries = 4, backoffBaseMs = 2000, onSetCookie = null } = {}
) {
  const headers = { 'User-Agent': USER_AGENT, Referer: 'https://www.musinsa.com/', Cookie: cookie };

  const page = await fetchProductPage(goodsNo, headers, fetchFn, retries, backoffBaseMs, onSetCookie);
```

In `src/collector.js`, add to the imports:

```js
import { formatSessionSummary } from './session.js';
```

In `collectAuthenticatedPrices`, replace

```js
  let cookie = await getCookie(false);
  if (!cookie) return into;
```

with

```js
  let cookie = await getCookie(false);
  if (sessionProvider.describe) {
    console.log(`🔐 [Session] ${cookie ? 'ready' : 'unavailable'} — ${formatSessionSummary(sessionProvider.describe())}`);
  }
  if (!cookie) return into;
  // A rotated cookie seen on any product-page response is used from the next request on.
  const onSetCookie = sessionProvider.absorb
    ? (headers) => {
        const absorbed = sessionProvider.absorb(headers);
        if (absorbed?.cookie) cookie = absorbed.cookie;
      }
    : undefined;
```

and change the fetch call

```js
      into.set(goodsNo, await authFetchFn(goodsNo, { cookie }));
```

to

```js
      into.set(goodsNo, await authFetchFn(goodsNo, { cookie, onSetCookie }));
```

A revocation (`absorbed.cookie === null`) leaves `cookie` alone. The same page reports `loggedIn: false`, so the existing `SessionExpiredError` → refresh path handles it, and `refreshSessionCookie` finds the cache already cleared and goes to the bridge.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/myprice-fetch.test.js tests/collector-auth.test.js tests/session.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/myprice.js src/collector.js tests/myprice-fetch.test.js tests/collector-auth.test.js
git commit -m "feat(collector): absorb rotated Musinsa cookies from product-page responses

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Bridge confirms login before reading document.cookie

**Files:**
- Modify: `src/session.js` (`fetchSessionCookieFromBridge`)
- Test: `tests/session.test.js` (`describe('fetchSessionCookieFromBridge', …)`)

**Interfaces:**
- Consumes (Task 2): `LOGIN_STATUS_URL`.
- Produces: `fetchSessionCookieFromBridge({ execFn?, session? }): string|null` (unchanged signature). The command sequence is now `open` → `eval <login check>` → `eval 'document.cookie'` → `close`.

- [ ] **Step 1: Write the failing tests**

Replace the three tests in `describe('fetchSessionCookieFromBridge', …)` with:

```js
describe('fetchSessionCookieFromBridge', () => {
  const makeExec = ({ login = 'LOGGED_IN', cookie = JSON.stringify('_ga=1; app_atk=AAA; app_rtk=BBB; mss_mac=CCC') } = {}) => {
    const cmds = [];
    const execFn = (cmd) => {
      cmds.push(cmd);
      if (cmd.includes('login-status')) return login;
      if (cmd.includes('document.cookie')) return cookie;
      return '';
    };
    return { execFn, cmds };
  };

  test('opens musinsa, confirms login in-page, reads document.cookie, always closes', () => {
    const { execFn, cmds } = makeExec();
    assert.equal(fetchSessionCookieFromBridge({ execFn }), COOKIE);
    assert.match(cmds[0], /^opencli browser clot-auth open https:\/\/www\.musinsa\.com\/$/);
    assert.match(cmds[1], /eval '.*login-status.*credentials:"include".*'$/);
    assert.match(cmds[2], /eval 'document\.cookie'$/);
    assert.match(cmds.at(-1), /^opencli browser clot-auth close$/);
  });

  test('login check output may be JSON-quoted', () => {
    const { execFn } = makeExec({ login: '"LOGGED_IN"\n' });
    assert.equal(fetchSessionCookieFromBridge({ execFn }), COOKIE);
  });

  test('LOGGED_OUT: returns null without reading cookies, still closes', () => {
    const { execFn, cmds } = makeExec({ login: 'LOGGED_OUT' });
    assert.equal(fetchSessionCookieFromBridge({ execFn }), null);
    assert.equal(cmds.some((c) => c.includes('document.cookie')), false);
    assert.match(cmds.at(-1), /close$/);
  });

  test('logged in but cookie lacks app_rtk -> null', () => {
    const { execFn } = makeExec({ cookie: '"_ga=1; app_atk=AAA"' });
    assert.equal(fetchSessionCookieFromBridge({ execFn }), null);
  });

  test('returns null when the bridge throws', () => {
    const execFn = (cmd) => { if (cmd.includes(' open ')) throw new Error('ETIMEDOUT'); return ''; };
    assert.equal(fetchSessionCookieFromBridge({ execFn }), null);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/session.test.js`
Expected: FAIL. `cmds[1]` is the `document.cookie` eval, not the login check, and `LOGGED_OUT` still returns a cookie.

- [ ] **Step 3: Implement**

In `src/session.js`, above `fetchSessionCookieFromBridge`, add:

```js
// Runs in the Chrome page: `opencli browser eval` awaits the Promise (verified 2026-09-26).
// Contains no single quotes — it is embedded in a single-quoted shell argument.
const BRIDGE_LOGIN_CHECK_JS =
  `fetch("${LOGIN_STATUS_URL}",{credentials:"include"})` +
  '.then(r=>r.json()).then(j=>j&&j.data&&j.data.loggedIn===true?"LOGGED_IN":"LOGGED_OUT")' +
  '.catch(()=>"LOGGED_OUT")';
```

Replace the body of `fetchSessionCookieFromBridge`'s `try` block with:

```js
  try {
    execFn(`opencli browser ${session} open https://www.musinsa.com/`, opts);
    // Confirm the page's session is live (this also lets the page refresh its tokens) before reading cookies.
    const status = String(execFn(`opencli browser ${session} eval '${BRIDGE_LOGIN_CHECK_JS}'`, opts) || '');
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
    return jar.get('app_atk') && jar.get('app_rtk') ? serializeAuthCookies(jar) : null;
  } catch (err) {
```

(The `catch` and `finally` blocks stay as they are.) `'LOGGED_OUT'.includes('LOGGED_IN')` is false, so the check is safe.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/session.test.js`
Expected: PASS

- [ ] **Step 5: Live check (bridge only, prints no values)**

Only do this if Chrome is awake and logged in. It opens and closes a tab:

```bash
node --input-type=module -e "import { fetchSessionCookieFromBridge, parseAuthCookies } from './src/session.js'; const c = fetchSessionCookieFromBridge({ session: 'clot-plan-verify' }); console.log(c ? [...parseAuthCookies(c).keys()].join(',') : 'null');"
```

Expected: `app_atk,app_rtk,mss_mac`. The cache file is not touched: this function does not write.

- [ ] **Step 6: Commit**

```bash
git add src/session.js tests/session.test.js
git commit -m "fix(session): confirm Chrome login via in-page login-status before reading cookies

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Session keeper on awake daily ticks + once-a-day alert

**Files:**
- Modify: `src/session.js` (add `keepSessionAlive`)
- Modify: `src/notifier.js` (add `notifySessionLost`, next to `notifySessionWarning` at `:177`)
- Modify: `src/cli.js` (imports `:11-12`; new export `sessionKeeperSuffix`; skip branch `:330-334`)
- Create: `tests/session-keeper.test.js`

**Interfaces:**
- Consumes (Tasks 1-2): `verifyCached` and `renewFromBridge` (internal, same module), `describeSession`, `readSessionMeta`, `updateSessionMeta`, `verifySession`, `fetchSessionCookieFromBridge`, `DEFAULT_SESSION_PATH`.
- Produces:
  - `keepSessionAlive({ bridgeUsable: boolean, path?, verify?, fetchFromBridge? }): Promise<{ status: 'skipped'|'ok'|'renewed'|'lost', cached?, ageHours?, observedLifetimeHours? }>`
  - `notifySessionLost(): Promise<unknown>` (in `src/notifier.js`)
  - `sessionKeeperSuffix({ power, today, keep?, notify?, sessionPath? }): Promise<string>` (in `src/cli.js`). It returns `''` when the bridge is unusable, otherwise e.g. `' session=ok age=5.1h'`, `' session=renewed age=0h'`, `' session=lost'` or `' session=error'`. It never throws.

- [ ] **Step 1: Write the failing tests**

Create `tests/session-keeper.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/session-keeper.test.js`
Expected: FAIL (`keepSessionAlive` / `sessionKeeperSuffix` not exported).

- [ ] **Step 3: Implement `keepSessionAlive`**

Append to `src/session.js`:

```js
/**
 * Awake daily ticks keep the cache alive so asleep runs (no bridge) inherit a live cookie.
 * Opens a Chrome tab only when the cached cookie is missing or confirmed dead.
 */
export async function keepSessionAlive({
  bridgeUsable,
  path: sessionPath = DEFAULT_SESSION_PATH,
  verify = verifySession,
  fetchFromBridge = fetchSessionCookieFromBridge,
} = {}) {
  if (!bridgeUsable) return { status: 'skipped' };
  const { loggedIn } = await verifyCached(sessionPath, verify);
  if (loggedIn !== false) return { status: 'ok', ...describeSession(sessionPath) };
  const fresh = await renewFromBridge(sessionPath, true, fetchFromBridge);
  return { status: fresh ? 'renewed' : 'lost', ...describeSession(sessionPath) };
}
```

- [ ] **Step 4: Implement `notifySessionLost`**

In `src/notifier.js`, right after `notifySessionWarning`:

```js
export async function notifySessionLost() {
  sendMacNotification('⚠️ 무신사 로그인 필요', 'Chrome에서 무신사 로그인 쿠키를 받지 못했습니다. 다시 로그인해주세요.');
  const lines = [
    '<b>⚠️ [Project-Clot] 무신사 세션 만료</b>\n',
    '• 상태: 저장된 로그인 쿠키가 만료됐고, Chrome에서도 새 쿠키를 받지 못했습니다.',
    '• 영향: 다시 로그인할 때까지 VIP 실제가 대신 OpenCLI/공개가 폴백으로 수집됩니다.',
    '• 조치: Chrome에서 <a href="https://www.musinsa.com">musinsa.com</a> 에 로그인해주세요.',
  ];
  return await sendTelegramMessage(lines.join('\n'));
}
```

- [ ] **Step 5: Implement `sessionKeeperSuffix` and wire the skip branch**

In `src/cli.js`, change the imports at `:11-12`:

```js
import { makeSessionProvider, keepSessionAlive, readSessionMeta, updateSessionMeta, DEFAULT_SESSION_PATH } from './session.js';
import { notifyPriceDropsAndRestocks, sendMacNotification, formatHotDealsSummary, sendTelegramMessage, notifySessionWarning, notifySessionLost } from './notifier.js';
```

Add above `async function handleDailyRun` (after `formatPowerState`):

```js
/**
 * Session keeper for the 30-minute "already collected" ticks. Never throws: a keeper
 * problem must not turn a quiet skip tick into a failed LaunchAgent run.
 */
export async function sessionKeeperSuffix({
  power,
  today,
  keep = keepSessionAlive,
  notify = notifySessionLost,
  sessionPath = DEFAULT_SESSION_PATH,
} = {}) {
  if (!power?.bridgeUsable) return '';
  try {
    const result = await keep({ bridgeUsable: true, path: sessionPath });
    if (result.status === 'lost' && readSessionMeta(sessionPath).lastWarnedOn !== today) {
      updateSessionMeta({ lastWarnedOn: today }, sessionPath);
      try {
        await notify();
      } catch (err) {
        console.warn(`[Session Keeper Notice] Notification failed: ${err.message}`);
      }
    }
    const age = typeof result.ageHours === 'number' ? ` age=${result.ageHours}h` : '';
    return ` session=${result.status}${age}`;
  } catch (err) {
    console.warn(`[Session Keeper Notice] ${err.message}`);
    return ' session=error';
  }
}
```

Replace the skip branch at `:330-334`:

```js
  if (decision.action === 'skip') {
    // Catch-up ticks fire every 30 minutes; keep this to a single quiet line.
    const keeper = await sessionKeeperSuffix({ power, today });
    console.log(`⏭ [Daily Lock] ${today} ${decision.reason}. (${formatPowerState(power)})${keeper}`);
    return;
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/session-keeper.test.js`
Expected: PASS

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS (all files). Then confirm `git status --short data/` prints nothing (tests are isolated by `tests/setup-env.js`).

- [ ] **Step 8: Live read-only verification (no values printed, no daily run)**

```bash
node --input-type=module -e "import { verifySession, readSessionCookie, describeSession, formatSessionSummary } from './src/session.js'; const c = readSessionCookie(); const r = c ? await verifySession(c) : null; console.log({ cached: !!c, loggedIn: r?.loggedIn ?? null, rotated: r?.rotated ?? null, summary: formatSessionSummary(describeSession()) });"
```

Expected: `{ cached: true, loggedIn: true, rotated: false, summary: 'age ?' }` for the legacy cache written on 2026-09-26 (it has no `issuedAt` yet). `loggedIn: false` also counts as a valid outcome: it means the 16:25 token has died, which is itself the first lifetime data point. Then:

```bash
node src/cli.js power-status
```

Expected: prints the power state without errors (it confirms the `cli.js` imports load).

- [ ] **Step 9: Commit**

```bash
git add src/session.js src/notifier.js src/cli.js tests/session-keeper.test.js
git commit -m "feat(daily): keep the Musinsa session alive on awake ticks and alert once a day when lost

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After merge: what to watch

- In `logs/daily.log`, the skip-tick lines end with `session=ok age=…h` / `renewed` / `lost`, and collection runs print `🔐 [Session] ready — age …`.
- `observedLifetimeHours` in `~/.clot/musinsa-session.json` (read it with `node -e` and print only that field). If the samples are consistently **shorter than ~12 h** (the 21:30 → 9:30 overnight gap), asleep morning runs will still fall back. The next step then is capturing Chrome's own refresh request at expiry (handoff A-3).
- If the samples are long, go on to handoff B (likes over HTTPS) and revisit the `daily_runs.mode` rule.
