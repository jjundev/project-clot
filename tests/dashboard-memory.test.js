import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Store4910 } from '../src/site4910/store.js';

test('sparse scan IDs exclude large unrelated evidence under a 512MiB heap', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-dashboard-memory-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const dbPath = path.join(dir, '4910.db');
  const store = new Store4910(dbPath);
  try {
    store.applyScan('2026-10-24', [1, 100000].map(sno => ({
      sno, brand_sno: 10, brand: 'fixture', name: String(sno), url: 'https://4910.kr',
      market_sno: 1, market_name: null, category: null, image_url: null,
      sale_price: 85200, original_price: 90000, discount_rate: null,
    })));
    for (const sno of [1, 100000]) store.putPriceValidation({
      kind: 'scan', sno, date: '2026-10-24', status: 'corrected', reason: 'fixture',
      corrected: {sale_price: 75900, coupon_price: 72110},
    });
    store.recordScanRun({date: '2026-10-24', complete: true, brandCounts: [], changed: 0, added: 2, dropped: 0, durationMs: 1, couponsOk: true});
    // A single reused string keeps fixture preparation bounded; only SQLite retains the copies.
    const evidence = JSON.stringify({padding: '가'.repeat(1048576)});
    const goods = store.db.prepare(`INSERT INTO goods (sno,brand_sno,name,url,first_seen_date)
      VALUES (?,20,'unrelated','https://4910.kr','2026-10-24')`);
    const validation = store.db.prepare(`INSERT INTO price_validations
      (kind,sno,date,status,reason,evidence_json,checked_at)
      VALUES ('scan',?,'2026-10-24','verified','fixture',?,'2026-10-24')`);
    store.db.exec('BEGIN');
    for (let sno = 50000; sno < 50320; sno++) {
      goods.run(sno);
      validation.run(sno, evidence);
    }
    store.db.exec('COMMIT');
  } finally {
    store.close();
  }
  const probe = fileURLToPath(new URL('./helpers/dashboard-memory-probe.js', import.meta.url));
  const result = spawnSync(process.execPath, ['--max-old-space-size=512', probe, dbPath], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 1048576,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)), {ids: [1, 100000], historyRows: 2});
});
