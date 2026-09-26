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

const AUTH_COOKIE_RE = /^(app_atk|app_rtk|mss_mac)=/;

export function pickAuthCookies(documentCookie) {
  return String(documentCookie || '')
    .split(/;\s*/)
    .filter((c) => AUTH_COOKIE_RE.test(c))
    .join('; ');
}

export function readSessionCookie(sessionPath = DEFAULT_SESSION_PATH) {
  try {
    const { cookie } = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    const filtered = typeof cookie === 'string' ? pickAuthCookies(cookie) : '';
    return filtered.includes('app_atk=') ? filtered : null;
  } catch {
    return null;
  }
}

export function writeSessionCookie(cookie, sessionPath = DEFAULT_SESSION_PATH) {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sessionPath, JSON.stringify({ cookie, savedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.chmodSync(sessionPath, 0o600);
}

export function clearSessionCookie(sessionPath = DEFAULT_SESSION_PATH) {
  fs.rmSync(sessionPath, { force: true });
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
