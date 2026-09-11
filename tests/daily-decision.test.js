import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decideDailyRun, buildDailySchedule, generatePlistContent, CAFFEINATE_PATH } from '../src/cli.js';
import { ClotDatabase } from '../src/db.js';

describe('Sleep-aware daily run decision', () => {
  test('first run of the day: full when bridge usable, deferred when Mac is asleep', () => {
    assert.deepEqual(decideDailyRun({ existingRun: null, bridgeUsable: true }).mode, 'full');
    const deferred = decideDailyRun({ existingRun: null, bridgeUsable: false });
    assert.equal(deferred.action, 'run');
    assert.equal(deferred.mode, 'deferred');
    assert.equal(deferred.upgrade, false);
  });

  test('a deferred run is upgraded once the bridge is usable, and only then', () => {
    const existingRun = { date: '2026-09-11', mode: 'deferred' };
    const stillAsleep = decideDailyRun({ existingRun, bridgeUsable: false });
    assert.equal(stillAsleep.action, 'skip');

    const awake = decideDailyRun({ existingRun, bridgeUsable: true });
    assert.equal(awake.action, 'run');
    assert.equal(awake.mode, 'full');
    assert.equal(awake.upgrade, true);
  });

  test('full and degraded runs are never repeated automatically (no all-day hammering)', () => {
    assert.equal(decideDailyRun({ existingRun: { mode: 'full' }, bridgeUsable: true }).action, 'skip');
    assert.equal(decideDailyRun({ existingRun: { mode: 'degraded' }, bridgeUsable: true }).action, 'skip');
    // Legacy rows without a mode column count as full.
    assert.equal(decideDailyRun({ existingRun: { date: '2026-09-10' }, bridgeUsable: true }).action, 'skip');
  });

  test('--force always runs in the mode the power state allows', () => {
    const forced = decideDailyRun({ existingRun: { mode: 'full' }, bridgeUsable: false, force: true });
    assert.equal(forced.action, 'run');
    assert.equal(forced.mode, 'deferred');
  });

  test('buildDailySchedule yields 09:30 plus 30-minute catch-up ticks until 22:00', () => {
    const schedule = buildDailySchedule();
    assert.deepEqual(schedule[0], { hour: 9, minute: 30 });
    assert.deepEqual(schedule[1], { hour: 10, minute: 0 });
    assert.deepEqual(schedule[schedule.length - 1], { hour: 21, minute: 30 });
    assert.equal(schedule.length, 1 + 12 * 2);
    const seen = new Set(schedule.map((s) => `${s.hour}:${s.minute}`));
    assert.equal(seen.size, schedule.length, 'no duplicate intervals');
  });

  test('generated plist wraps node in caffeinate and lists every calendar interval', () => {
    const plist = generatePlistContent({
      nodePath: '/usr/local/bin/node',
      scriptPath: '/test/src/cli.js',
      rootDir: '/test',
      logDir: '/test/logs',
      extendedPath: '/usr/bin',
      homeDir: '/Users/testuser',
    });
    const programArgs = plist.split('<key>ProgramArguments</key>')[1].split('</array>')[0];
    assert.ok(programArgs.includes(`<string>${CAFFEINATE_PATH}</string>`));
    for (const flag of ['-i', '-s', '-u']) {
      assert.ok(programArgs.includes(`<string>${flag}</string>`), `caffeinate flag ${flag}`);
    }
    assert.ok(programArgs.indexOf(CAFFEINATE_PATH) < programArgs.indexOf('/usr/local/bin/node'), 'caffeinate must precede node');
    assert.ok(programArgs.includes('<string>daily</string>'));

    const calendar = plist.split('<key>StartCalendarInterval</key>')[1].split('</array>')[0];
    assert.ok(calendar.trim().startsWith('<array>'));
    assert.equal((calendar.match(/<dict>/g) || []).length, buildDailySchedule().length);
    assert.ok(calendar.includes('<integer>9</integer>\n            <key>Minute</key>\n            <integer>30</integer>'));
  });

  test('daily_runs.mode is migrated, stored and read back', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-test-mode-'));
    const dbPath = path.join(tmpDir, 'test.db');
    let testDb;
    try {
      testDb = new ClotDatabase(dbPath);
      testDb.recordDailyRun({ date: '2026-09-11', total_tracked: 85, mode: 'deferred' });
      assert.equal(testDb.getDailyRun('2026-09-11').mode, 'deferred');
      assert.equal(testDb.hasRunToday('2026-09-11'), true);
      assert.equal(testDb.getDailyRun('2026-09-12'), null);

      // Upgrade run replaces the row
      testDb.recordDailyRun({ date: '2026-09-11', total_tracked: 85 });
      assert.equal(testDb.getDailyRun('2026-09-11').mode, 'full');

      // Re-opening an existing DB must not fail the migration
      testDb.close();
      testDb = new ClotDatabase(dbPath);
      assert.equal(testDb.getDailyRun('2026-09-11').mode, 'full');
    } finally {
      try { testDb?.close(); } catch {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('getLatestPriceBefore excludes same-day rows so upgrade runs compare against yesterday', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-test-baseline-'));
    let testDb;
    try {
      testDb = new ClotDatabase(path.join(tmpDir, 'test.db'));
      testDb.db.exec(`INSERT INTO items (goods_no, goods_name, url, first_seen_at) VALUES (1, 'x', 'u', 'now')`);
      testDb.recordPriceLog({ goods_no: 1, date: '2026-09-10', normal_price: 100, sale_price: 90, my_price: 80 });
      testDb.recordPriceLog({ goods_no: 1, date: '2026-09-11', normal_price: 100, sale_price: 85, my_price: null });
      assert.equal(testDb.getLatestPrice(1).date, '2026-09-11');
      const baseline = testDb.getLatestPriceBefore(1, '2026-09-11');
      assert.equal(baseline.date, '2026-09-10');
      assert.equal(baseline.my_price, 80);
      assert.equal(testDb.getLatestPriceBefore(1, '2026-09-10'), undefined);
    } finally {
      try { testDb?.close(); } catch {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
