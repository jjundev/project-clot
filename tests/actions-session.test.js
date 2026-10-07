import './setup-env.js';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeSecretCookie,
  restoreSessionFromSecret,
  detectSessionChange,
  maskableValues,
} from '../src/actions-session.js';
import { readSessionCookie, writeSessionCookie, clearSessionCookie } from '../src/session.js';

const SECRET = 'app_atk=AAA%2Bx; app_rtk=rtk1; mss_mac=mac1';

let tmpDir;
let sessionPath;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-actions-session-'));
  sessionPath = path.join(tmpDir, 'musinsa-session.json');
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('normalizeSecretCookie', () => {
  test('keeps only the auth cookies and tolerates surrounding whitespace', () => {
    assert.equal(normalizeSecretCookie(`  _gf=x; ${SECRET}; other=1\n`), SECRET);
  });

  test('rejects a secret without both app_atk and app_rtk', () => {
    assert.equal(normalizeSecretCookie('app_atk=AAA'), null);
    assert.equal(normalizeSecretCookie(''), null);
    assert.equal(normalizeSecretCookie(undefined), null);
  });
});

describe('restoreSessionFromSecret', () => {
  test('writes the cookie where the daily run reads it', () => {
    restoreSessionFromSecret(SECRET, sessionPath);
    assert.equal(readSessionCookie(sessionPath), SECRET);
  });

  test('throws without echoing the secret', () => {
    assert.throws(
      () => restoreSessionFromSecret('app_atk=SECRETVALUE', sessionPath),
      (err) => !err.message.includes('SECRETVALUE')
    );
    assert.equal(fs.existsSync(sessionPath), false);
  });
});

describe('detectSessionChange', () => {
  test('unchanged when the run kept the same tokens', () => {
    restoreSessionFromSecret(SECRET, sessionPath);
    assert.deepEqual(detectSessionChange(SECRET, sessionPath), { status: 'unchanged', cookie: null });
  });

  test('cookie order or extra non-auth cookies in the secret do not count as a rotation', () => {
    restoreSessionFromSecret(SECRET, sessionPath);
    assert.equal(detectSessionChange('mss_mac=mac1; app_rtk=rtk1; foo=1; app_atk=AAA%2Bx', sessionPath).status, 'unchanged');
  });

  test('rotated returns the new cookie to store', () => {
    restoreSessionFromSecret(SECRET, sessionPath);
    writeSessionCookie('app_atk=BBB; app_rtk=rtk2; mss_mac=mac1', sessionPath);
    assert.deepEqual(detectSessionChange(SECRET, sessionPath), {
      status: 'rotated',
      cookie: 'app_atk=BBB; app_rtk=rtk2; mss_mac=mac1',
    });
  });

  test('cleared when the run dropped a dead cookie', () => {
    restoreSessionFromSecret(SECRET, sessionPath);
    clearSessionCookie(sessionPath);
    assert.deepEqual(detectSessionChange(SECRET, sessionPath), { status: 'cleared', cookie: null });
  });
});

describe('maskableValues', () => {
  test('lists each token raw and URL-decoded', () => {
    assert.deepEqual(maskableValues(SECRET).sort(), ['AAA%2Bx', 'AAA+x', 'mac1', 'rtk1'].sort());
  });
});
