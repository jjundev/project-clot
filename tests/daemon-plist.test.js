import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { generatePlistContent } from '../src/cli.js';
import { getExtendedPath } from '../src/env.js';

describe('Daemon Plist Generation', () => {
  test('generatePlistContent creates plist with custom options', () => {
    const nodePath = process.execPath;
    const scriptPath = '/test/src/cli.js';
    const rootDir = '/test';
    const logDir = '/test/logs';
    const extendedPath = getExtendedPath();
    const homeDir = '/Users/testuser';

    const plist = generatePlistContent({
      nodePath,
      scriptPath,
      rootDir,
      logDir,
      extendedPath,
      homeDir,
    });

    assert.ok(plist.includes('<key>EnvironmentVariables</key>'), 'Plist must contain EnvironmentVariables key');
    assert.ok(plist.includes('<key>PATH</key>'), 'Plist must contain PATH key');
    assert.ok(plist.includes(extendedPath), 'Plist must contain extendedPath value');
    assert.ok(plist.includes('<key>HOME</key>'), 'Plist must contain HOME key');
    assert.ok(plist.includes(homeDir), 'Plist must contain homeDir value');
  });

  test('generatePlistContent produces valid plist with default dynamic arguments', () => {
    const plist = generatePlistContent();
    assert.ok(plist.includes('<key>EnvironmentVariables</key>'));
    assert.ok(plist.includes('<key>PATH</key>'));
    assert.ok(plist.includes(path.dirname(process.execPath)));
    assert.ok(plist.includes(os.homedir()));
  });
});
