import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getExecOptions } from './env.js';

/**
 * Musinsa login cookie cache for authenticated HTTPS price collection.
 * Lives under ~/.clot — never inside the repo, because the daily run does `git add data/` and pushes.
 */
export const DEFAULT_SESSION_PATH = path.join(os.homedir(), '.clot', 'musinsa-session.json');

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

/**
 * Reads the auth cookies from the logged-in Chrome through the OpenCLI browser bridge.
 * @returns {string|null} null when the bridge is unavailable or Chrome is logged out
 */
export function fetchSessionCookieFromBridge({ execFn = execSync, session = 'clot-auth' } = {}) {
  const opts = getExecOptions({ encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    execFn(`opencli browser ${session} open https://www.musinsa.com/`, opts);
    const raw = String(execFn(`opencli browser ${session} eval 'document.cookie'`, opts) || '').trim();
    let value = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') value = parsed;
    } catch {
      // plain (unquoted) output
    }
    const cookie = pickAuthCookies(value);
    return cookie.includes('app_atk=') ? cookie : null;
  } catch (err) {
    console.warn(`[Session Notice] Could not read Musinsa cookies from browser bridge: ${err.message}`);
    return null;
  } finally {
    try {
      execFn(`opencli browser ${session} close`, opts);
    } catch {
      // best effort
    }
  }
}

export async function getSessionCookie({
  path: sessionPath = DEFAULT_SESSION_PATH,
  allowBridge = true,
  fetchFromBridge = fetchSessionCookieFromBridge,
} = {}) {
  const cached = readSessionCookie(sessionPath);
  if (cached) return cached;
  if (!allowBridge) return null;
  const fresh = await fetchFromBridge();
  if (fresh) writeSessionCookie(fresh, sessionPath);
  return fresh || null;
}

export async function refreshSessionCookie({
  path: sessionPath = DEFAULT_SESSION_PATH,
  allowBridge = true,
  fetchFromBridge = fetchSessionCookieFromBridge,
} = {}) {
  clearSessionCookie(sessionPath);
  return getSessionCookie({ path: sessionPath, allowBridge, fetchFromBridge });
}

/** Builds the `sessionProvider` consumed by collectPricesForActiveItems. */
export function makeSessionProvider({ allowBridge = true, path: sessionPath = DEFAULT_SESSION_PATH, fetchFromBridge } = {}) {
  const opts = { path: sessionPath, allowBridge, ...(fetchFromBridge ? { fetchFromBridge } : {}) };
  return async ({ refresh = false } = {}) => (refresh ? refreshSessionCookie(opts) : getSessionCookie(opts));
}
