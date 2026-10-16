import { DatabaseSync } from 'node:sqlite';
import { verifyDailyCoverage } from '../src/musinsaWide/coverage.js';
const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
const db = new DatabaseSync('data/musinsa-wide.db', { readOnly: true });
try {
  const run = db.prepare('SELECT * FROM scan_runs WHERE date = ?').get(date);
  console.log(JSON.stringify({ date, ...verifyDailyCoverage(run) }));
} finally { db.close(); }
