import './setup-env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
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

  test('checkpoint() folds the WAL into the main file so a copy of prices.db alone has the data', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-test-db-'));
    const testDbPath = path.join(tmpDir, 'test.db');
    const copyPath = path.join(tmpDir, 'copy.db');
    const testDb = new ClotDatabase(testDbPath);
    try {
      testDb.db.exec('CREATE TABLE marker (x INTEGER); INSERT INTO marker VALUES (42);');
      testDb.checkpoint();
      // What `git add data/prices.db` sees: the main file without its -wal side file.
      fs.copyFileSync(testDbPath, copyPath);
      const copy = new DatabaseSync(copyPath, { readOnly: true });
      try {
        assert.deepEqual({ ...copy.prepare('SELECT x FROM marker').get() }, { x: 42 });
      } finally {
        copy.close();
      }
    } finally {
      testDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
