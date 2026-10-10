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

// Same for the 4910 store: never let a test open the committed data/4910.db.
if (!process.env.CLOT_4910_DB_PATH) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-test-4910-'));
  process.env.CLOT_4910_DB_PATH = path.join(tmpDir, '4910.db');
  process.on('exit', () => fs.rmSync(tmpDir, { recursive: true, force: true }));
}

// Never notify for real: skip the repo's .env (src/notifier.js) and macOS banners, and drop any
// Telegram/Discord credentials (and the 4910 member token) inherited from the shell. Tests that need creds set them explicitly.
process.env.CLOT_NOTIFY_SANDBOX = '1';
for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'DISCORD_WEBHOOK_URL', 'ABLY_JWT_TOKEN']) delete process.env[key];
