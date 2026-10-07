import { DEFAULT_SESSION_PATH, parseAuthCookies, serializeAuthCookies, readSessionCookie, writeSessionCookie } from './session.js';

/**
 * GitHub Actions bridge for the Musinsa session: the runner starts with no ~/.clot, so the cookie comes
 * from the MUSINSA_COOKIE secret and any rotation seen during the run has to go back into that secret.
 * Nothing here prints a cookie value.
 */

/** Secret text -> normalized auth cookie, or null when app_atk/app_rtk are missing or malformed. */
export function normalizeSecretCookie(raw) {
  const jar = parseAuthCookies(String(raw || '').trim());
  if (!jar.get('app_atk') || !jar.get('app_rtk')) return null;
  return serializeAuthCookies(jar);
}

/** Writes the secret cookie into the session cache the daily run reads. Throws without naming the value. */
export function restoreSessionFromSecret(raw, sessionPath = DEFAULT_SESSION_PATH) {
  const cookie = normalizeSecretCookie(raw);
  if (!cookie) throw new Error('MUSINSA_COOKIE is empty or lacks app_atk/app_rtk');
  writeSessionCookie(cookie, sessionPath);
  return cookie;
}

/**
 * Compares the cache after the run with the cookie restored before it.
 * 'rotated' = new tokens to push back into the secret; 'cleared' = the run dropped a dead/revoked cookie.
 */
export function detectSessionChange(originalRaw, sessionPath = DEFAULT_SESSION_PATH) {
  const original = normalizeSecretCookie(originalRaw);
  const current = readSessionCookie(sessionPath); // already normalized; null when missing or unusable
  if (!current) return { status: 'cleared', cookie: null };
  return current === original ? { status: 'unchanged', cookie: null } : { status: 'rotated', cookie: current };
}

/** Values to register with ::add-mask:: so a rotated (not yet secret) token never shows in a log. */
export function maskableValues(cookie) {
  return [...parseAuthCookies(cookie).values()].flatMap((v) => {
    let decoded = v;
    try {
      decoded = decodeURIComponent(v);
    } catch {
      // keep the raw value only
    }
    return decoded === v ? [v] : [v, decoded];
  });
}
