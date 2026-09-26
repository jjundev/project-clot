import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ClotDatabase } from '../src/db.js';
import { runAudit, formatAuditTerminal, scanLogsForAudit, checkArtifacts } from '../src/audit.js';

describe('Audit Diagnostic Engine', () => {
  test('db.getDailyAuditReport computes correct metrics and price drops', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-audit-test-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    let testDb;

    try {
      testDb = new ClotDatabase(testDbPath);

      // Insert 2 items
      testDb.upsertItem({
        goods_no: 1001,
        goods_name: '테스트 상품 1',
        brand_name: '브랜드A',
        url: 'https://musinsa.com/1001',
        status: 'ACTIVE',
      });
      testDb.upsertItem({
        goods_no: 1002,
        goods_name: '테스트 상품 2',
        brand_name: '브랜드B',
        url: 'https://musinsa.com/1002',
        status: 'ACTIVE',
      });

      // Day 1 logs
      testDb.recordPriceLog({
        goods_no: 1001,
        date: '2026-09-11',
        sale_price: 50000,
        my_price: 45000,
      });
      testDb.recordPriceLog({
        goods_no: 1002,
        date: '2026-09-11',
        sale_price: 30000,
        my_price: 28000,
      });

      // Day 2 (target date): item 1 drops in price, item 2 stays same
      testDb.recordPriceLog({
        goods_no: 1001,
        date: '2026-09-12',
        sale_price: 40000,
        my_price: 35000,
      });
      testDb.recordPriceLog({
        goods_no: 1002,
        date: '2026-09-12',
        sale_price: 30000,
        my_price: 28000,
      });

      testDb.recordDailyRun({
        date: '2026-09-12',
        total_tracked: 2,
        price_dropped_count: 1,
        duration_ms: 12000,
        mode: 'full',
      });

      const report = testDb.getDailyAuditReport('2026-09-12');
      assert.equal(report.catalogCount, 2);
      assert.equal(report.totalLogs, 2);
      assert.equal(report.distinctItems, 2);
      assert.equal(report.myPriceCount, 2);
      assert.equal(report.priceDrops.length, 1);
      assert.equal(report.priceDrops[0].goods_no, 1001);
      assert.equal(report.priceDrops[0].drop_amount, 10000);
    } finally {
      if (testDb) {
        try { testDb.close(); } catch {}
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('runAudit evaluates full mode as PASS across dimensions', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-audit-run-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    const logDir = path.join(tmpDir, 'logs');
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    // Mock logs & artifacts
    fs.writeFileSync(path.join(logDir, 'daily.log'), 'Daily Run: 2026-09-12 (full)\nCollection complete.\n');
    fs.writeFileSync(path.join(logDir, 'daily.err'), 'Update available: v1.8.6 -> v1.8.7\n');
    fs.writeFileSync(path.join(dataDir, 'dashboard.html'), '<html>' + 'x'.repeat(2000) + '</html>');
    fs.writeFileSync(path.join(dataDir, 'latest_prices.json'), JSON.stringify({ updated_at: '2026-09-12T10:00:00Z' }));

    let testDb;
    try {
      testDb = new ClotDatabase(testDbPath);
      testDb.upsertItem({ goods_no: 2001, goods_name: '상품', brand_name: 'B', url: 'u', status: 'ACTIVE' });
      testDb.recordPriceLog({ goods_no: 2001, date: '2026-09-12', sale_price: 10000, my_price: 9000 });
      testDb.recordDailyRun({ date: '2026-09-12', total_tracked: 1, duration_ms: 5000, mode: 'full' });

      const audit = runAudit({
        dateStr: '2026-09-12',
        dbInstance: testDb,
        logDir,
        dataDir,
      });

      assert.equal(audit.overallVerdict, 'PASS');
      assert.equal(audit.dimensions.runStatus.verdict, 'PASS');
      assert.equal(audit.dimensions.coverage.verdict, 'PASS');
      assert.equal(audit.dimensions.authRate.verdict, 'PASS');
      assert.equal(audit.dimensions.logCleanliness.verdict, 'PASS');
      assert.equal(audit.dimensions.artifactSync.verdict, 'PASS');
      assert.equal(audit.metrics.authPercent, 100);

      const formatted = formatAuditTerminal(audit);
      assert.match(formatted, /Overall Verdict: ✅ PASS/);
      assert.match(formatted, /1\. Run Status:\s+✅ PASS/);
    } finally {
      if (testDb) {
        try { testDb.close(); } catch {}
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('runAudit evaluates deferred mode as WARN with remediation', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-audit-warn-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    const logDir = path.join(tmpDir, 'logs');
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(path.join(logDir, 'daily.log'), 'Daily Run: 2026-09-12 (deferred)\n');
    fs.writeFileSync(path.join(logDir, 'daily.err'), '');

    let testDb;
    try {
      testDb = new ClotDatabase(testDbPath);
      testDb.upsertItem({ goods_no: 3001, goods_name: '상품', brand_name: 'B', url: 'u', status: 'ACTIVE' });
      testDb.recordPriceLog({ goods_no: 3001, date: '2026-09-12', sale_price: 10000, my_price: null });
      testDb.recordDailyRun({ date: '2026-09-12', total_tracked: 1, duration_ms: 3000, mode: 'deferred' });

      const audit = runAudit({
        dateStr: '2026-09-12',
        dbInstance: testDb,
        logDir,
        dataDir,
      });

      assert.equal(audit.overallVerdict, 'WARN');
      assert.equal(audit.dimensions.runStatus.verdict, 'WARN');
      assert.equal(audit.dimensions.authRate.verdict, 'WARN');
      assert.ok(audit.remediations.length > 0);
      assert.match(audit.remediations[0], /daily --force/);
    } finally {
      if (testDb) {
        try { testDb.close(); } catch {}
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('runAudit flags FAIL when circuit breaker is triggered in log', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-audit-fail-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    const logDir = path.join(tmpDir, 'logs');
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(
      path.join(logDir, 'daily.log'),
      'Daily Run: 2026-09-12 (full)\n[OpenCLI CircuitBreaker] 2 consecutive OpenCLI batch failures/timeouts.\n'
    );
    fs.writeFileSync(path.join(logDir, 'daily.err'), '');

    let testDb;
    try {
      testDb = new ClotDatabase(testDbPath);
      testDb.upsertItem({ goods_no: 4001, goods_name: '상품', brand_name: 'B', url: 'u', status: 'ACTIVE' });
      testDb.recordPriceLog({ goods_no: 4001, date: '2026-09-12', sale_price: 10000, my_price: 9000 });
      testDb.recordDailyRun({ date: '2026-09-12', total_tracked: 1, duration_ms: 3000, mode: 'full' });

      const audit = runAudit({
        dateStr: '2026-09-12',
        dbInstance: testDb,
        logDir,
        dataDir,
      });

      assert.equal(audit.overallVerdict, 'FAIL');
      assert.equal(audit.dimensions.logCleanliness.verdict, 'FAIL');
      assert.match(audit.dimensions.logCleanliness.details, /circuit breaker/i);
    } finally {
      if (testDb) {
        try { testDb.close(); } catch {}
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
