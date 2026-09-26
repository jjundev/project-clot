#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skipDailyRun, formatSkipTerminal } from '../src/skip.js';
import { ClotDatabase } from '../src/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const LOG_DIR = path.join(ROOT_DIR, 'logs');

async function main() {
  const targetDate = process.argv[2] || new Date().toISOString().split('T')[0];
  const db = new ClotDatabase(path.join(DATA_DIR, 'prices.db'));

  try {
    const result = await skipDailyRun({
      dateStr: targetDate,
      dbInstance: db,
      dataDir: DATA_DIR,
      logDir: LOG_DIR,
    });
    console.log(formatSkipTerminal(result));
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('❌ Error skipping daily collection:', err);
  process.exit(1);
});
