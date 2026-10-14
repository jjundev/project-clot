import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import {
  pullDb, pushDb, RELEASE_TAG_MUSINSA, ASSET_MUSINSA, PREV_ASSET_MUSINSA, datedAssetMusinsa,
} from '../src/musinsaWide/release.js';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-musinsa-rel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Fake gh: `handler(args)` returns { status, stdout, stderr } or undefined for success; every call is recorded.
function fakeRun(handler = () => undefined) {
  const run = (cmd, args) => {
    run.calls.push({ cmd, args });
    return { status: 0, stdout: '', stderr: '', ...(handler(args) ?? {}) };
  };
  run.calls = [];
  return run;
}

// The MusinsaWideStore does not exist yet, so build the two tables prepareForPush checks with raw sqlite.
function makeDb(file, goodsRows = 2, scanDays = 2) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE goods(goods_no INTEGER PRIMARY KEY)');
  db.exec('CREATE TABLE scan_runs(date TEXT PRIMARY KEY, completed_at TEXT)');
  for (let d = 1; d <= scanDays; d++) db.prepare('INSERT INTO scan_runs (date, completed_at) VALUES (?, ?)').run(`2026-10-0${d}`, 'x');
  for (let i = 1; i <= goodsRows; i++) db.prepare('INSERT INTO goods (goods_no) VALUES (?)').run(i);
  db.close();
}

test('musinsa constants', () => {
  assert.equal(RELEASE_TAG_MUSINSA, 'data-musinsa');
  assert.equal(ASSET_MUSINSA, 'musinsa-wide.db.gz');
  assert.equal(PREV_ASSET_MUSINSA, 'musinsa-wide.db.prev.gz');
  assert.equal(datedAssetMusinsa('2026-10-14'), 'musinsa-wide.db.2026-10-14.gz');
});

test('musinsa pushDb uploads under data-musinsa with musinsa asset names', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, 'musinsa-wide.db');
  makeDb(src);
  const run = fakeRun((args) => {
    if (args[1] === 'view' && args.includes('--json')) return { stdout: JSON.stringify({ assets: [] }) };
    return undefined; // release exists; no previous asset downloaded
  });
  pushDb({ src, run, tmpDir: path.join(dir, 'tmp'), date: '2026-10-14', log: () => {} });
  const uploads = run.calls.filter((c) => c.args[1] === 'upload').map((c) => [c.args[2], path.basename(c.args[3])]);
  assert.deepEqual(uploads.map((u) => u[0]), ['data-musinsa', 'data-musinsa']);
  assert.deepEqual(uploads.map((u) => u[1]), ['musinsa-wide.db.2026-10-14.gz', 'musinsa-wide.db.gz']);
});

test('musinsa pushDb creates the release with the musinsa title and notes', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, 'musinsa-wide.db');
  makeDb(src);
  const run = fakeRun((args) => {
    if (args[1] === 'view' && !args.includes('--json')) return { status: 1, stderr: 'release not found' };
    if (args[1] === 'view') return { stdout: JSON.stringify({ assets: [] }) };
    return undefined;
  });
  pushDb({ src, run, tmpDir: path.join(dir, 'tmp'), date: '2026-10-14', log: () => {} });
  const create = run.calls.find((c) => c.args[1] === 'create');
  assert.deepEqual(create.args, [
    'release', 'create', 'data-musinsa', '--prerelease', '--title', 'Musinsa wide data',
    '--notes', 'Daily Musinsa wide DB (managed by .github/workflows/musinsa-wide.yml)',
  ]);
});

test('musinsa pushDb prunes only musinsa dated copies beyond the newest 7', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, 'musinsa-wide.db');
  makeDb(src);
  const dated = Array.from({ length: 9 }, (_, i) => `musinsa-wide.db.2026-10-0${i + 1}.gz`);
  const run = fakeRun((args) => {
    if (args[1] === 'view' && args.includes('--json')) {
      return { stdout: JSON.stringify({ assets: [{ name: ASSET_MUSINSA }, { name: '4910.db.2026-10-01.gz' }, ...dated.map((name) => ({ name }))] }) };
    }
    return undefined;
  });
  const res = pushDb({ src, run, tmpDir: path.join(dir, 'tmp'), date: '2026-10-14', log: () => {} });
  assert.deepEqual(res.pruned, ['musinsa-wide.db.2026-10-02.gz', 'musinsa-wide.db.2026-10-01.gz']);
});

test('musinsa pushDb refuses a one-day DB and names musinsa-db pull', (t) => {
  const dir = scratch(t);
  const oneDay = path.join(dir, 'one.db');
  makeDb(oneDay, 2, 1);
  const run = fakeRun();
  assert.throws(() => pushDb({ src: oneDay, run, tmpDir: path.join(dir, 'tmp') }), /musinsa-db pull/);
  assert.equal(run.calls.length, 0);
});

test('musinsa pullDb downloads musinsa-wide.db.gz from data-musinsa and logs nothing 4910', (t) => {
  const dir = scratch(t);
  const dest = path.join(dir, 'musinsa-wide.db');
  const payload = Buffer.from('musinsa bytes');
  const run = fakeRun((args) => {
    fs.writeFileSync(path.join(args[args.indexOf('-D') + 1], ASSET_MUSINSA), zlib.gzipSync(payload));
  });
  const res = pullDb({ dest, run, tmpDir: path.join(dir, 'tmp') });
  assert.deepEqual(res, { bytes: payload.length, source: 'latest' });
  assert.deepEqual(run.calls[0].args.slice(0, 5), ['release', 'download', RELEASE_TAG_MUSINSA, '-p', ASSET_MUSINSA]);
  assert.deepEqual(fs.readFileSync(dest), payload);
});

test('musinsa pullDb falls back to the musinsa prev asset when latest is missing', (t) => {
  const dir = scratch(t);
  const dest = path.join(dir, 'musinsa-wide.db');
  const payload = Buffer.from('day-before');
  const run = fakeRun((args) => {
    if (args[4] === ASSET_MUSINSA) return { status: 1, stderr: 'no assets match the file pattern' };
    fs.writeFileSync(path.join(args[args.indexOf('-D') + 1], PREV_ASSET_MUSINSA), zlib.gzipSync(payload));
    return undefined;
  });
  assert.deepEqual(pullDb({ dest, run, tmpDir: path.join(dir, 'tmp') }), { bytes: payload.length, source: 'prev' });
});
