import '../setup-env.js';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildScan4910Payload } from '../../src/visualizer.js';

const db = new DatabaseSync(process.argv[2], {readOnly: true});
try {
  const payload = buildScan4910Payload(db, {brandSno: 10, snoFrom: 1, snoTo: 100000});
  assert.deepEqual(payload.r.map(row => row[7]), [
    [['2026-10-24', 90000, 75900, 72110]],
    [['2026-10-24', 90000, 75900, 72110]],
  ]);
  console.log(JSON.stringify({ids: payload.r.map(row => row[0]), historyRows: payload.r.reduce((n, row) => n + row[7].length, 0)}));
} finally {
  db.close();
}
