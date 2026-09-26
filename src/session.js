import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getExecOptions } from './env.js';
import { USER_AGENT, extractProductDetail } from './myprice.js';

/**
 * Musinsa login cookie cache for authenticated HTTPS price collection.
 * Lives under ~/.clot — never inside the repo, because the daily run does `git add data/` and pushes.
 */
export const DEFAULT_SESSION_PATH = path.join(os.homedir(), '.clot', 'musinsa-session.json');
export const LOGIN_STATUS_URL = 'https://my.musinsa.com/api/member/v1/login-status';
const LOGIN_STATUS_TIMEOUT_MS = 10_000;

const AUTH_COOKIE_NAMES = ['app_atk', 'app_rtk', 'mss_mac'];
const MAX_LIFETIME_SAMPLES = 10;
const HOUR_MS = 3_600_000;
const KEEPER_BRIDGE_BACKOFF_MS = 2 * HOUR_MS;
const PROBE_DELAY_MS = 700;
const MAX_EXPIRY_PROBES = 3;
const AUTH_URL_RE = /auth|token|refresh|reissue|login|member/i;
const MAX_CAPTURED_REQUESTS = 20;

// RFC 6265 cookie-octet. Anything else (CR/LF, spaces, quotes) would break or smuggle into the
// Cookie header — and Node's header-validation error would print the whole value to the log.
const COOKIE_VALUE_RE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/;
const isValidCookieValue = (v) => typeof v === 'string' && COOKIE_VALUE_RE.test(v);

/** 'a=1; b=2' -> Map of only the auth cookies (values kept raw, still URL-encoded). */
export function parseAuthCookies(cookie) {
  const jar = new Map();
  for (const part of String(cookie || '').split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1);
    if (AUTH_COOKIE_NAMES.includes(name) && isValidCookieValue(value)) jar.set(name, value);
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
    if (value && !isValidCookieValue(value)) continue;
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
  // The caller may have just hit www (a failing product page); keep the 700 ms spacing on both sides.
  await sleep(delayMs);
  const steps = [await probeStep('main', 'https://www.musinsa.com/', jar, fetchFn)];
  if (goodsNo) {
    await sleep(delayMs);
    steps.push(await probeStep('product', `https://www.musinsa.com/products/${goodsNo}`, jar, fetchFn, goodsNo));
    await sleep(delayMs); // a collect run fires its next www product request right after this probe
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

function readSessionFile(sessionPath) {
  try {
    const data = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

// Temp file + rename: a concurrent reader (skip-tick keeper vs a track/daily run) never sees a
// truncated file, which it would read as "no cookie" and clear a valid session.
function writeSessionFile(data, sessionPath) {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
  const tmp = `${sessionPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, sessionPath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
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
  const cached = readSessionCookie(sessionPath) !== null;
  return {
    cached,
    // issuedAt survives clearSessionCookie; without a cookie there is no age to report.
    ageHours: cached ? hoursSince(meta.issuedAt, now) : null,
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

function patchExpiryProbe(at, patch, sessionPath) {
  const list = readSessionMeta(sessionPath).expiryProbes;
  if (!Array.isArray(list)) return;
  updateSessionMeta({ expiryProbes: list.map((e) => (e.at === at ? { ...e, ...patch } : e)) }, sessionPath);
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
    // Same tokens accepted again = login-status flapped, not a refresh: recorded, but not adopted, so the
    // caller clears the cookie and this dead token cannot trigger a probe (and a message) on every tick.
    return { probeAt: entry.at, renewedCookie: https.tokensChanged ? https.renewedCookie : null };
  } catch (err) {
    console.warn(`[Session Probe Notice] ${err.message}`);
    return { probeAt: null, renewedCookie: null };
  }
}

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

// Runs in the Chrome page: `opencli browser eval` awaits the Promise (verified 2026-09-26).
// Contains no single quotes — it is embedded in a single-quoted shell argument.
const BRIDGE_LOGIN_CHECK_JS =
  `fetch("${LOGIN_STATUS_URL}",{credentials:"include"})` +
  '.then(r=>r.json()).then(j=>j&&j.data&&j.data.loggedIn===true?"LOGGED_IN":"LOGGED_OUT")' +
  '.catch(()=>"LOGGED_OUT")';

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
  let cacheDir;
  try {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-netcap-'));
  } catch {
    return { requests: [], captureError: 'tmpdir' }; // skip the capture rather than risk a token copy in ~/.opencli
  }
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
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    } catch {
      // instrumentation cleanup must not fail the renewal
    }
  }
}

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

export async function getSessionCookie({
  path: sessionPath = DEFAULT_SESSION_PATH,
  allowBridge = true,
  fetchFromBridge = fetchSessionCookieFromBridge,
  verify = verifySession,
  probe = null,
} = {}) {
  const v = await verifyCached(sessionPath, verify, probe, 'collect');
  // null = login-status unknown: keep using the cache rather than dropping a possibly-good session.
  const cookie = v.loggedIn !== false ? v.cookie : await renewFromBridge(sessionPath, allowBridge, fetchFromBridge, v);
  await finishExpiryProbe(sessionPath, v.probeAt, probe?.notify);
  return cookie;
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
  const cookie =
    v.loggedIn === true && v.cookie !== failedCookie ? v.cookie : await renewFromBridge(sessionPath, allowBridge, fetchFromBridge, v);
  await finishExpiryProbe(sessionPath, v.probeAt, probe?.notify);
  return cookie;
}

/** Builds the `sessionProvider` consumed by collectPricesForActiveItems. */
export function makeSessionProvider({ allowBridge = true, path: sessionPath = DEFAULT_SESSION_PATH, fetchFromBridge, verify, probe = null } = {}) {
  const opts = {
    path: sessionPath,
    allowBridge,
    ...(fetchFromBridge ? { fetchFromBridge } : {}),
    ...(verify ? { verify } : {}),
    ...(probe ? { probe } : {}),
  };
  const provider = async ({ refresh = false, failedCookie = null } = {}) =>
    refresh ? refreshSessionCookie({ ...opts, failedCookie }) : getSessionCookie(opts);
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

/**
 * Awake daily ticks keep the cache alive so asleep runs (no bridge) inherit a live cookie.
 * Opens a Chrome tab only when the cached cookie is missing or confirmed dead.
 */
export async function keepSessionAlive({
  bridgeUsable,
  path: sessionPath = DEFAULT_SESSION_PATH,
  verify = verifySession,
  fetchFromBridge = fetchSessionCookieFromBridge,
  now = new Date(),
  probe = null,
} = {}) {
  if (!bridgeUsable) return { status: 'skipped' };
  const v = await verifyCached(sessionPath, verify, probe, 'keeper');
  const done = async (status) => {
    await finishExpiryProbe(sessionPath, v.probeAt, probe?.notify);
    return { status, ...describeSession(sessionPath, now) };
  };
  if (v.loggedIn !== false) return done(v.renewedByProbe ? 'renewed' : 'ok');
  // Chrome logged out: don't flash a tab on every 30-minute tick; retry at most every 2 h.
  const lastFail = Date.parse(readSessionMeta(sessionPath).lastBridgeFailedAt);
  if (Number.isFinite(lastFail) && now - lastFail < KEEPER_BRIDGE_BACKOFF_MS) return done('lost');
  const fresh = await renewFromBridge(sessionPath, true, fetchFromBridge, v);
  updateSessionMeta({ lastBridgeFailedAt: fresh ? null : now.toISOString() }, sessionPath);
  return done(fresh ? 'renewed' : 'lost');
}
