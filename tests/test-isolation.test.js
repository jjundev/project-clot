import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

// setup-env.js must load before anything imports src/db.js, or a plain
// `node --test tests/x.test.js` opens (and migrates) the real data/prices.db.
test('every test file imports setup-env.js first', () => {
  const offenders = fs.readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.test.js'))
    .filter((name) => {
      const firstLine = fs.readFileSync(path.join(TESTS_DIR, name), 'utf-8').split('\n')[0];
      return firstLine.trim() !== "import './setup-env.js';";
    });
  assert.deepEqual(offenders, []);
});
