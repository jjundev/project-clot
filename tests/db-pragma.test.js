import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ClotDatabase } from '../src/db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('SQLite Database Pragmas', () => {
  test('initializes schema with WAL journal_mode and busy_timeout', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-test-db-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    let testDb;

    try {
      testDb = new ClotDatabase(testDbPath);
      const journalMode = testDb.db.prepare('PRAGMA journal_mode;').get();
      const busyTimeout = testDb.db.prepare('PRAGMA busy_timeout;').get();

      assert.equal(journalMode.journal_mode.toLowerCase(), 'wal');
      assert.equal(busyTimeout.timeout, 5000);
    } finally {
      if (testDb) {
        try { testDb.close(); } catch {}
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
