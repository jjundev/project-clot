// Imported first by every test file (enforced by test-isolation.test.js) so the
// src/db.js singleton opens a per-process temp DB instead of data/prices.db,
// and `clot visualize` writes its dashboard there instead of data/dashboard.html.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.CLOT_DB_PATH) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-test-singleton-'));
  process.env.CLOT_DB_PATH = path.join(tmpDir, 'prices.db');
  process.env.CLOT_DASHBOARD_PATH = path.join(tmpDir, 'dashboard.html');
  process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
}
