# OpenCLI PATH & Musinsa Likes Sync Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure macOS background launchd daemon and CLI properly resolve OpenCLI by injecting Node/NVM bin and system PATHs, enabling automatic daily synchronization of newly liked Musinsa items and robust personalized price collection.

**Architecture:** Create an environment helper module (`src/env.js`) providing `getExtendedPath()`, `setupEnvironment()`, and `getExecOptions()`. Use this helper across `src/cli.js`, `src/sync.js`, and `src/collector.js` for child process execution, and inject it into the macOS `launchd` plist `EnvironmentVariables`. Add execution guards to `src/cli.js` so it can be cleanly imported in tests without side effects.

**Tech Stack:** Node.js (v24.17.0, ESM, node:sqlite, node:test), macOS launchd plist, OpenCLI (`opencli musinsa likes`, `opencli musinsa my-prices`).

## Global Constraints

- Must work in macOS launchd daemon environment where PATH is minimal (`/usr/bin:/bin:/usr/sbin:/sbin`).
- Must not hardcode user-specific paths; dynamically compute home directory (`os.homedir()`) and current node execution path (`path.dirname(process.execPath)`).
- Preserve existing database schema and non-destructive sync logic (`db.upsertItem`, `ACTIVE`, `UNLIKED`).
- Must maintain testability via Node.js built-in test runner (`node --test`).
- No external npm dependencies added; rely on Node built-ins (`node:os`, `node:path`, `node:child_process`, `node:test`).

---

## File Structure

- **`package.json` [MODIFY]**: Add `"test": "node --test tests/*.test.js"` script.
- **`src/env.js` [NEW]**: Central environment helper module. Computes search paths (`getExtendedPath`), bootstraps `process.env.PATH` (`setupEnvironment`), and builds execution options with augmented PATH (`getExecOptions`).
- **`tests/env.test.js` [NEW]**: Unit tests for `src/env.js` verifying path construction, deduplication, `process.env.PATH` mutation, and `getExecOptions` behavior.
- **`src/sync.js` [MODIFY]**: Import `getExecOptions` and pass it to `execSync` for `opencli musinsa likes`.
- **`src/collector.js` [MODIFY]**: Import `getExecOptions` and pass it to `execSync` for `opencli musinsa my-prices`.
- **`tests/sync-env.test.js` [NEW]**: Integration test verifying `sync.js` and `collector.js` exports can be imported cleanly and integrate with `getExecOptions`.
- **`src/cli.js` [MODIFY]**: Call `setupEnvironment()` at startup; use `os.homedir()` for `LAUNCH_AGENTS_DIR`; export `generatePlistContent()` including `<key>EnvironmentVariables</key>` (`PATH` and `HOME`); wrap top-level `main()` call in an ESM execution guard with symlink resolution (`isMainModule`).
- **`tests/daemon-plist.test.js` [NEW]**: Unit tests validating that importing `src/cli.js` produces no side effects and `generatePlistContent()` generates valid plist XML containing `EnvironmentVariables` with system defaults and custom inputs.

---

## Tasks

### Task 1: Environment Helper Module (`src/env.js`), Package Script, & Tests

**Files:**
- Modify: `package.json:10-18`
- Create: `src/env.js`
- Create: `tests/env.test.js`

**Interfaces:**
- Consumes: `node:os`, `node:path`
- Produces: 
  - `getExtendedPath(): string`
  - `setupEnvironment(): void`
  - `getExecOptions(customOptions?: object): object`

- [ ] **Step 1: Update `package.json` to add the `test` script**

In `package.json`, add `"test": "node --test tests/*.test.js"` under `"scripts"`:
```json
  "scripts": {
    "start": "node src/cli.js daily",
    "test": "node --test tests/*.test.js",
    "sync": "node src/cli.js sync",
    "track": "node src/cli.js track",
    "list": "node src/cli.js list",
    "report": "node src/cli.js report",
    "daemon:install": "node src/cli.js daemon-install",
    "daemon:uninstall": "node src/cli.js daemon-uninstall"
  },
```

- [ ] **Step 2: Write the failing test in `tests/env.test.js`**

Create `tests/env.test.js`:
```javascript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/env.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` (Cannot find module '../src/env.js')

- [ ] **Step 4: Write minimal implementation in `src/env.js`**

Create `src/env.js`:
```javascript
import path from 'node:path';
import os from 'node:os';

/**
 * Computes an extended PATH string ensuring Node/NVM bin, Homebrew,
 * and user local bins are included even in minimal daemon environments.
 * @returns {string}
 */
export function getExtendedPath() {
  const homeDir = os.homedir();
  const nodeBinDir = path.dirname(process.execPath);

  const defaultBins = [
    nodeBinDir,
    path.join(homeDir, '.local/bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];

  const currentParts = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
  const combined = Array.from(new Set([...defaultBins, ...currentParts])).filter(Boolean);
  return combined.join(path.delimiter);
}

/**
 * Injects the extended PATH into process.env.PATH so all child processes
 * spawned by execSync or spawn automatically inherit it.
 */
export function setupEnvironment() {
  process.env.PATH = getExtendedPath();
}

/**
 * Merges process execution options with an environment containing the extended PATH.
 * @param {object} customOptions
 * @returns {object}
 */
export function getExecOptions(customOptions = {}) {
  return {
    ...customOptions,
    env: {
      ...process.env,
      PATH: getExtendedPath(),
      ...(customOptions.env || {}),
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/env.test.js`
Expected: PASS (3 tests pass)

- [ ] **Step 6: Commit**

```bash
git add package.json src/env.js tests/env.test.js
git commit -m "feat: add environment helper and package test script"
```

---

### Task 2: Inject Extended Environment into `src/sync.js` and `src/collector.js`

**Files:**
- Modify: `src/sync.js:1-25`
- Modify: `src/collector.js:1-20,130-150`
- Create: `tests/sync-env.test.js`

**Interfaces:**
- Consumes: `getExecOptions` from `src/env.js`
- Produces: `syncLikedItemsFromMusinsa` and `collectPricesForActiveItems` executing `opencli` with `getExecOptions()`

- [ ] **Step 1: Write baseline integration test in `tests/sync-env.test.js`**

Create `tests/sync-env.test.js`:
```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { syncLikedItemsFromMusinsa } from '../src/sync.js';
import { collectPricesForActiveItems, fetchProductPriceInfo } from '../src/collector.js';
import { getExecOptions, getExtendedPath } from '../src/env.js';

describe('Sync & Collector Integration', () => {
  test('sync and collector modules export expected functions cleanly', () => {
    assert.equal(typeof syncLikedItemsFromMusinsa, 'function');
    assert.equal(typeof collectPricesForActiveItems, 'function');
    assert.equal(typeof fetchProductPriceInfo, 'function');
  });

  test('getExecOptions passes augmented PATH to child process options', () => {
    const opts = getExecOptions({ stdio: ['pipe', 'pipe', 'pipe'] });
    assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(opts.env.PATH, getExtendedPath());
  });
});
```

- [ ] **Step 2: Run test to verify baseline behavior**

Run: `node --test tests/sync-env.test.js`
Expected: PASS baseline.

- [ ] **Step 3: Modify `src/sync.js` to use `getExecOptions`**

In `src/sync.js`, import `getExecOptions` from `./env.js` and replace the options passed to `execSync`:

```javascript
import { execSync } from 'node:child_process';
import { db } from './db.js';
import { getExecOptions } from './env.js';

export async function syncLikedItemsFromMusinsa({ limit = 300 } = {}) {
  console.log('🔄 Syncing Musinsa liked items via OpenCLI...');
  
  let rawOutput = '';
  try {
    rawOutput = execSync(
      `opencli musinsa likes --limit ${limit} -f json`,
      getExecOptions({
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    );
  } catch (err) {
    throw new Error(`Failed to execute opencli musinsa likes: ${err.message}`);
  }
...
```

- [ ] **Step 4: Modify `src/collector.js` to use `getExecOptions`**

In `src/collector.js`, import `getExecOptions` from `./env.js` and use it in `opencli musinsa my-prices`:

```javascript
import { db } from './db.js';
import { execSync } from 'node:child_process';
import { getExecOptions } from './env.js';
...
    for (let i = 0; i < goodsNos.length; i += 4) {
      const chunk = goodsNos.slice(i, i + 4).join(',');
      const raw = execSync(
        `opencli musinsa my-prices "${chunk}" -f json`,
        getExecOptions({
          encoding: 'utf-8',
          timeout: 45000,
        })
      );
```

- [ ] **Step 5: Run tests to verify**

Run: `npm test`
Expected: PASS (all tests in `tests/env.test.js` and `tests/sync-env.test.js` pass)

- [ ] **Step 6: Commit**

```bash
git add src/sync.js src/collector.js tests/sync-env.test.js
git commit -m "fix(sync): use getExecOptions to provide extended PATH in sync and collector"
```

---

### Task 3: Update `src/cli.js` Entry Point & `launchd` Plist Generator

**Files:**
- Modify: `src/cli.js`
- Create: `tests/daemon-plist.test.js`

**Interfaces:**
- Consumes: `setupEnvironment`, `getExtendedPath` from `src/env.js`, `node:os`
- Produces: 
  - `generatePlistContent({ nodePath, scriptPath, rootDir, logDir, extendedPath, homeDir }): string`
  - Safe ESM import without side effects (`isMainModule` guard with `fs.realpathSync` resilience)
  - `handleInstallDaemon()` writing plist with `<key>EnvironmentVariables</key>` using `os.homedir()`

- [ ] **Step 1: Write the failing test in `tests/daemon-plist.test.js`**

Create `tests/daemon-plist.test.js`:
```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/daemon-plist.test.js`
Expected: FAIL (`generatePlistContent is not a function` or unintended CLI usage output printed)

- [ ] **Step 3: Modify `src/cli.js`**

1. At top of `src/cli.js`, import `os` from `node:os` and `setupEnvironment`, `getExtendedPath` from `./env.js`:
```javascript
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { syncLikedItemsFromMusinsa } from './sync.js';
import { collectPricesForActiveItems, fetchProductPriceInfo } from './collector.js';
import { notifyPriceDropsAndRestocks, sendMacNotification } from './notifier.js';
import { setupEnvironment, getExtendedPath } from './env.js';

setupEnvironment();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PLIST_NAME = 'com.musinsa.price-tracker.plist';
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library/LaunchAgents');
const PLIST_TARGET = path.join(LAUNCH_AGENTS_DIR, PLIST_NAME);
```

2. Export `generatePlistContent` with dynamic defaults:
```javascript
export function generatePlistContent({
  nodePath = process.execPath,
  scriptPath = path.join(__dirname, 'cli.js'),
  rootDir = ROOT_DIR,
  logDir = path.join(ROOT_DIR, 'logs'),
  extendedPath = getExtendedPath(),
  homeDir = os.homedir(),
} = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.musinsa.price-tracker</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${scriptPath}</string>
        <string>daily</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${extendedPath}</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>9</integer>
        <key>Minute</key>
        <integer>30</integer>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${path.join(logDir, 'daily.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(logDir, 'daily.err')}</string>
    <key>WorkingDirectory</key>
    <string>${rootDir}</string>
</dict>
</plist>`;
}
```

3. In `handleInstallDaemon()`, call `generatePlistContent`:
```javascript
function handleInstallDaemon() {
  if (!fs.existsSync(LAUNCH_AGENTS_DIR)) {
    fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  }

  const logDir = path.join(ROOT_DIR, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const plistContent = generatePlistContent({
    nodePath: process.execPath,
    scriptPath: path.join(__dirname, 'cli.js'),
    rootDir: ROOT_DIR,
    logDir,
    extendedPath: getExtendedPath(),
    homeDir: os.homedir(),
  });

  fs.writeFileSync(PLIST_TARGET, plistContent, 'utf-8');

  try {
    execSync(`launchctl unload "${PLIST_TARGET}"`, { stdio: 'ignore' });
  } catch {}

  try {
    execSync(`launchctl load "${PLIST_TARGET}"`);
    console.log(`✅ Successfully installed & loaded macOS background daemon!`);
    console.log(`   Service: ${PLIST_NAME}`);
    console.log(`   Schedule: Daily at 09:30 AM (Catch-up on boot enabled)`);
    console.log(`   Logs: ${path.join(logDir, 'daily.log')}`);
  } catch (err) {
    console.error('Failed to load launchctl:', err.message);
  }
}
```

4. Wrap `main().catch(...)` at the end of `src/cli.js` with `isMainModule` check (with symlink resolution):
```javascript
const currentScript = fileURLToPath(import.meta.url);
const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : '';
let isMainModule = invokedScript === currentScript;
if (!isMainModule && invokedScript) {
  try {
    isMainModule = fs.realpathSync(invokedScript) === currentScript;
  } catch {}
}

if (isMainModule) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests to verify**

Run: `node --test tests/daemon-plist.test.js`
Expected: PASS (both tests pass with zero extraneous output)

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli.js tests/daemon-plist.test.js
git commit -m "feat(daemon): generate plist with EnvironmentVariables and guard CLI execution"
```

---

### Task 4: End-to-End Verification & Daemon Reinstallation

**Files:**
- Reinstall: `~/Library/LaunchAgents/com.musinsa.price-tracker.plist`

- [ ] **Step 1: Run all test suites**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 2: Reinstall launchd daemon**

Run: `node src/cli.js daemon-install`
Expected:
```text
✅ Successfully installed & loaded macOS background daemon!
   Service: com.musinsa.price-tracker.plist
   Schedule: Daily at 09:30 AM (Catch-up on boot enabled)
   Logs: .../project-clot/logs/daily.log
```

- [ ] **Step 3: Verify the installed plist contains PATH and HOME**

Run: `grep -A 6 "<key>EnvironmentVariables</key>" ~/Library/LaunchAgents/com.musinsa.price-tracker.plist`
Expected:
```xml
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>.../versions/node/v24.17.0/bin:...</string>
        <key>HOME</key>
        <string>...</string>
    </dict>
```

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "chore: verified end-to-end launchd daemon plist installation"
```
