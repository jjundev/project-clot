import './setup-env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseProcessList,
  findRunningDailyProcesses,
  terminateProcesses,
  skipDailyRun,
  formatSkipTerminal,
} from '../src/skip.js';
import { decideDailyRun } from '../src/cli.js';
import { ClotDatabase } from '../src/db.js';

describe('Skip Daily Collection Engine', () => {
  test('parseProcessList identifies daily collection, caffeinate, and opencli processes', () => {
    const mockPsOutput = `
      PID COMMAND
        1 /sbin/launchd
      101 node /Users/test/Documents/Private/project-clot/src/cli.js daily
      102 /usr/bin/caffeinate -i -s -u node /Users/test/Documents/Private/project-clot/src/cli.js daily
      103 node /usr/local/bin/opencli musinsa my-prices 595039,595040 -f json
      104 node /Users/test/Documents/Private/project-clot/src/cli.js skip
      105 grep -E node.*cli.js
      106 /usr/libexec/logd
      107 node /test/tests/skip.test.js
    `;

    const matched = parseProcessList(mockPsOutput, 999);
    assert.equal(matched.length, 3);
    assert.deepEqual(
      matched.map((m) => m.pid),
      [101, 102, 103]
    );
  });

  test('parseProcessList ignores self PID and parent PID', () => {
    const mockPsOutput = `
      PID COMMAND
      201 node /Users/test/Documents/Private/project-clot/src/cli.js daily
      202 node /Users/test/Documents/Private/project-clot/src/cli.js daily
    `;

    const matched = parseProcessList(mockPsOutput, 201);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].pid, 202);
  });

  test('findRunningDailyProcesses calls execFn and parses output', () => {
    const mockExec = (cmd) => {
      assert.match(cmd, /^ps /);
      return `
        PID COMMAND
        301 node src/cli.js daily
      `;
    };

    const procs = findRunningDailyProcesses({ execFn: mockExec, selfPid: 999 });
    assert.equal(procs.length, 1);
    assert.equal(procs[0].pid, 301);
  });

  test('terminateProcesses calls kill with SIGTERM', () => {
    const killed = [];
    const mockKill = (pid, signal) => {
      killed.push({ pid, signal });
    };

    const procs = [
      { pid: 401, command: 'node src/cli.js daily' },
      { pid: 402, command: 'caffeinate ... daily' },
    ];

    const result = terminateProcesses(procs, { killFn: mockKill });
    assert.deepEqual(result, [401, 402]);
    assert.equal(killed.length, 2);
    assert.equal(killed[0].signal, 'SIGTERM');
  });

  test('skipDailyRun creates skipped record when no prior run exists and decides skip', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-skip-test-'));
    const testDb = new ClotDatabase(path.join(tmpDir, 'test.db'));
    const logsDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    try {
      const targetDate = '2026-09-25';
      const result = await skipDailyRun({
        dateStr: targetDate,
        dbInstance: testDb,
        dataDir: tmpDir,
        logDir: logsDir,
        terminateRunning: false,
      });

      assert.equal(result.date, targetDate);
      assert.equal(result.dailyRun.mode, 'skipped');
      assert.equal(result.dailyRun.total_tracked, 0);
      assert.equal(result.logAppended, true);

      // Verify log file content
      const logContent = fs.readFileSync(path.join(logsDir, 'daily.log'), 'utf-8');
      assert.match(logContent, /🛑 \[Daily Skip\] 2026-09-25/);

      // Verify decideDailyRun returns skip
      const decision = decideDailyRun({ existingRun: result.dailyRun, bridgeUsable: true });
      assert.equal(decision.action, 'skip');
      assert.equal(decision.mode, 'skipped');
    } finally {
      testDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('skipDailyRun updates existing deferred run to skipped and preserves total_tracked', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-skip-test-'));
    const testDb = new ClotDatabase(path.join(tmpDir, 'test.db'));
    const logsDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    try {
      const targetDate = '2026-09-25';
      // Record an earlier deferred run
      testDb.recordDailyRun({
        date: targetDate,
        total_tracked: 85,
        price_dropped_count: 2,
        restocked_count: 0,
        duration_ms: 45000,
        mode: 'deferred',
      });

      // User decides to skip remaining upgrade collection
      const result = await skipDailyRun({
        dateStr: targetDate,
        dbInstance: testDb,
        dataDir: tmpDir,
        logDir: logsDir,
        terminateRunning: false,
      });

      assert.equal(result.dailyRun.mode, 'skipped');
      assert.equal(result.dailyRun.total_tracked, 85);

      // Verify decideDailyRun will skip instead of upgrading
      const decision = decideDailyRun({ existingRun: result.dailyRun, bridgeUsable: true });
      assert.equal(decision.action, 'skip');
    } finally {
      testDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('formatSkipTerminal generates expected user-friendly output', () => {
    const formatted = formatSkipTerminal({
      date: '2026-09-25',
      terminatedProcesses: [{ pid: 1234, command: 'node src/cli.js daily' }],
      dailyRun: { mode: 'skipped', completed_at: '2026-09-25T01:00:00.000Z' },
    });

    assert.match(formatted, /🛑 \[Project-Clot\] Skip Daily Collection: 2026-09-25/);
    assert.match(formatted, /Running Processes Stopped: 1 process\(es\)/);
    assert.match(formatted, /PID 1234/);
    assert.match(formatted, /Mode set to 'skipped'/);
    assert.match(formatted, /All remaining 30-min catch-up ticks today will skip automatically/);
  });
});
