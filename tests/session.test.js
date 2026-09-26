import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SESSION_PATH, pickAuthCookies, readSessionCookie, writeSessionCookie, clearSessionCookie,
  fetchSessionCookieFromBridge, getSessionCookie, refreshSessionCookie, makeSessionProvider,
} from '../src/session.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE = 'app_atk=AAA; app_rtk=BBB; mss_mac=CCC';
let tmpPath;

beforeEach(() => {
  tmpPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clot-session-')), 'nested', 'session.json');
});

describe('session cache', () => {
  test('default cache path lives outside the repo (data/ is auto-committed)', () => {
    assert.equal(DEFAULT_SESSION_PATH.startsWith(REPO_ROOT + path.sep), false);
    assert.equal(DEFAULT_SESSION_PATH, path.join(os.homedir(), '.clot', 'musinsa-session.json'));
  });

  test('pickAuthCookies keeps only the three auth cookies', () => {
    assert.equal(pickAuthCookies('_ga=1; app_atk=AAA; cart_no=9; app_rtk=BBB; mss_mac=CCC; _fbp=2'), COOKIE);
    assert.equal(pickAuthCookies(''), '');
  });

  test('write then read round-trips, file mode is 0600', () => {
    writeSessionCookie(COOKIE, tmpPath);
    assert.equal(readSessionCookie(tmpPath), COOKIE);
    assert.equal(fs.statSync(tmpPath).mode & 0o777, 0o600);
  });

  test('missing, corrupt, or cookie-less cache files read as null', () => {
    assert.equal(readSessionCookie(tmpPath), null);
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, '{not json');
    assert.equal(readSessionCookie(tmpPath), null);
    fs.writeFileSync(tmpPath, JSON.stringify({ cookie: '_ga=1' }));
    assert.equal(readSessionCookie(tmpPath), null);
    fs.writeFileSync(tmpPath, '');
    assert.equal(readSessionCookie(tmpPath), null);
  });

  test('a cached cookie is re-filtered so only the three auth cookies are sent', () => {
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify({ cookie: '_ga=1; app_atk=AAA; evil=x; app_rtk=BBB; mss_mac=CCC' }));
    assert.equal(readSessionCookie(tmpPath), COOKIE);
  });

  test('clearSessionCookie removes the file and tolerates absence', () => {
    writeSessionCookie(COOKIE, tmpPath);
    clearSessionCookie(tmpPath);
    assert.equal(fs.existsSync(tmpPath), false);
    clearSessionCookie(tmpPath);
  });
});

describe('fetchSessionCookieFromBridge', () => {
  test('opens musinsa, reads document.cookie (JSON-quoted), filters, and always closes', () => {
    const cmds = [];
    const execFn = (cmd) => {
      cmds.push(cmd);
      if (cmd.includes(' eval ')) return JSON.stringify('_ga=1; app_atk=AAA; app_rtk=BBB; mss_mac=CCC');
      return '';
    };
    assert.equal(fetchSessionCookieFromBridge({ execFn }), COOKIE);
    assert.match(cmds[0], /^opencli browser clot-auth open https:\/\/www\.musinsa\.com\/$/);
    assert.match(cmds.at(-1), /^opencli browser clot-auth close$/);
  });

  test('returns null when logged out (no app_atk) and still closes', () => {
    const cmds = [];
    const execFn = (cmd) => { cmds.push(cmd); return cmd.includes(' eval ') ? '"_ga=1"' : ''; };
    assert.equal(fetchSessionCookieFromBridge({ execFn }), null);
    assert.match(cmds.at(-1), /close$/);
  });

  test('returns null when the bridge throws', () => {
    const execFn = (cmd) => { if (cmd.includes(' open ')) throw new Error('ETIMEDOUT'); return ''; };
    assert.equal(fetchSessionCookieFromBridge({ execFn }), null);
  });
});

describe('getSessionCookie / refreshSessionCookie / makeSessionProvider', () => {
  test('cache hit does not touch the bridge', async () => {
    writeSessionCookie(COOKIE, tmpPath);
    let bridgeCalls = 0;
    const cookie = await getSessionCookie({ path: tmpPath, allowBridge: true, fetchFromBridge: () => { bridgeCalls++; return 'x'; } });
    assert.equal(cookie, COOKIE);
    assert.equal(bridgeCalls, 0);
  });

  test('cache miss + allowBridge fetches and caches', async () => {
    const cookie = await getSessionCookie({ path: tmpPath, allowBridge: true, fetchFromBridge: () => COOKIE });
    assert.equal(cookie, COOKIE);
    assert.equal(readSessionCookie(tmpPath), COOKIE);
  });

  test('cache miss + bridge not allowed returns null without calling the bridge', async () => {
    let bridgeCalls = 0;
    const cookie = await getSessionCookie({ path: tmpPath, allowBridge: false, fetchFromBridge: () => { bridgeCalls++; return COOKIE; } });
    assert.equal(cookie, null);
    assert.equal(bridgeCalls, 0);
  });

  test('refresh clears the stale cache even when the bridge is not allowed', async () => {
    writeSessionCookie(COOKIE, tmpPath);
    assert.equal(await refreshSessionCookie({ path: tmpPath, allowBridge: false, fetchFromBridge: () => 'x' }), null);
    assert.equal(readSessionCookie(tmpPath), null);
  });

  test('provider: refresh=false reads cache, refresh=true re-fetches', async () => {
    writeSessionCookie('app_atk=OLD', tmpPath);
    const provider = makeSessionProvider({ path: tmpPath, allowBridge: true, fetchFromBridge: () => 'app_atk=NEW' });
    assert.equal(await provider(), 'app_atk=OLD');
    assert.equal(await provider({ refresh: true }), 'app_atk=NEW');
    assert.equal(readSessionCookie(tmpPath), 'app_atk=NEW');
  });
});
