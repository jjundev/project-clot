import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { getExtendedPath, setupEnvironment, getExecOptions } from '../src/env.js';

describe('Environment Helper (src/env.js)', () => {
  test('getExtendedPath includes node binary directory and standard bin paths', () => {
    const extendedPath = getExtendedPath();
    assert.ok(typeof extendedPath === 'string', 'extendedPath should be a string');
    
    const parts = extendedPath.split(path.delimiter);
    const nodeBinDir = path.dirname(process.execPath);
    
    assert.ok(parts.includes(nodeBinDir), `PATH should include node bin dir: ${nodeBinDir}`);
    assert.ok(parts.includes(path.join(os.homedir(), '.local/bin')), 'PATH should include ~/.local/bin');
    assert.ok(parts.includes('/usr/bin'), 'PATH should include /usr/bin');
    assert.ok(parts.includes('/bin'), 'PATH should include /bin');
  });

  test('setupEnvironment updates process.env.PATH', () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = '/usr/bin:/bin';
      setupEnvironment();
      const nodeBinDir = path.dirname(process.execPath);
      const parts = process.env.PATH.split(path.delimiter);
      assert.ok(parts.includes(nodeBinDir), 'process.env.PATH should now include node bin dir');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test('getExecOptions merges options and injects extended PATH into env', () => {
    const options = getExecOptions({ encoding: 'utf-8', timeout: 5000 });
    assert.equal(options.encoding, 'utf-8');
    assert.equal(options.timeout, 5000);
    assert.ok(options.env, 'env object should be defined');
    assert.equal(options.env.PATH, getExtendedPath());
  });
});
