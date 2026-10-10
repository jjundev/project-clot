import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { pullDb, pushDb, RELEASE_TAG_4910, ASSET_4910, PREV_ASSET_4910 } from '../src/site4910/release.js';
import { Store4910 } from '../src/site4910/store.js';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-4910-rel-'));
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

function makeDb(file, goodsRows = 2) {
  const store = new Store4910(file);
  for (let i = 1; i <= goodsRows; i++) {
    store.db
      .prepare("INSERT INTO goods (sno, brand_sno, name, url, first_seen_date) VALUES (?, 1, 'g', 'u', '2026-10-10')")
      .run(i);
  }
  store.close();
}

// ---- pullDb ----

test('pullDb writes the gunzipped asset to dest and clears stale sidecars', (t) => {
  const dir = scratch(t);
  const dest = path.join(dir, 'sub', '4910.db');
  fs.mkdirSync(path.dirname(dest));
  fs.writeFileSync(dest, 'old');
  fs.writeFileSync(`${dest}-wal`, 'w');
  fs.writeFileSync(`${dest}-shm`, 's');
  const payload = Buffer.from('fresh database bytes');
  const run = fakeRun((args) => {
    fs.writeFileSync(path.join(args[args.indexOf('-D') + 1], ASSET_4910), zlib.gzipSync(payload));
  });
  const res = pullDb({ dest, run, tmpDir: path.join(dir, 'tmp') });
  assert.equal(res.bytes, payload.length);
  assert.deepEqual(fs.readFileSync(dest), payload);
  assert.equal(fs.existsSync(`${dest}-wal`), false);
  assert.equal(fs.existsSync(`${dest}-shm`), false);
  assert.deepEqual(run.calls[0].args.slice(0, 5), ['release', 'download', RELEASE_TAG_4910, '-p', ASSET_4910]);
  assert.ok(run.calls[0].args.includes('--clobber'));
  assert.deepEqual(fs.readdirSync(path.dirname(dest)).filter((n) => n.includes('tmp')), [], 'no partial file is left behind');
});

test('pullDb leaves dest untouched when gh fails', (t) => {
  const dir = scratch(t);
  const dest = path.join(dir, '4910.db');
  fs.writeFileSync(dest, 'precious');
  const run = fakeRun(() => ({ status: 1, stderr: 'release not found\n' }));
  assert.throws(() => pullDb({ dest, run, tmpDir: dir }), /release download failed.*release not found/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'precious');
});

test('pullDb leaves dest untouched when the asset is missing', (t) => {
  const dir = scratch(t);
  const dest = path.join(dir, '4910.db');
  fs.writeFileSync(dest, 'precious');
  const run = fakeRun(); // gh exits 0 but downloads nothing
  assert.throws(() => pullDb({ dest, run, tmpDir: dir }), /no 4910\.db\.gz asset/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'precious');
});

test('pullDb leaves dest untouched on a corrupt gzip', (t) => {
  const dir = scratch(t);
  const dest = path.join(dir, '4910.db');
  fs.writeFileSync(dest, 'precious');
  fs.writeFileSync(`${dest}-wal`, 'w');
  const run = fakeRun((args) => {
    fs.writeFileSync(path.join(args[args.indexOf('-D') + 1], ASSET_4910), Buffer.from('definitely not gzip'));
  });
  assert.throws(() => pullDb({ dest, run, tmpDir: path.join(dir, 'tmp') }), /not a valid gzip/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'precious');
  assert.equal(fs.existsSync(`${dest}-wal`), true);
});

// ---- pushDb ----

function releaseState({ exists = true, prev = Buffer.from('previous gz') } = {}) {
  return fakeRun((args) => {
    if (args[1] === 'view') return exists ? undefined : { status: 1, stderr: 'release not found' };
    if (args[1] === 'download') {
      if (!prev) return { status: 1, stderr: 'no assets match' };
      const d = args[args.indexOf('-D') + 1];
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, ASSET_4910), prev);
    }
    return undefined;
  });
}

test('pushDb keeps the previous asset as prev and uploads both', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, '4910.db');
  makeDb(src);
  const run = releaseState();
  const tmpDir = path.join(dir, 'tmp');
  fs.mkdirSync(tmpDir);
  const uploaded = {};
  const orig = run;
  const spy = (cmd, args) => {
    if (args[1] === 'upload') for (const f of args.filter((a) => a.endsWith('.gz'))) uploaded[path.basename(f)] = fs.readFileSync(f);
    return orig(cmd, args);
  };
  spy.calls = orig.calls;

  const res = pushDb({ src, run: spy, tmpDir });
  assert.deepEqual(orig.calls.map((c) => c.args.slice(0, 2).join(' ')), ['release view', 'release download', 'release upload']);
  assert.equal(orig.calls.every((c) => c.cmd === 'gh'), true);
  assert.deepEqual(orig.calls[1].args.slice(0, 5), ['release', 'download', RELEASE_TAG_4910, '-p', ASSET_4910]);
  const up = orig.calls[2].args;
  assert.deepEqual(up.slice(0, 3), ['release', 'upload', RELEASE_TAG_4910]);
  assert.deepEqual(up.slice(3, 5).map((f) => path.basename(f)), [ASSET_4910, PREV_ASSET_4910]);
  assert.equal(up.at(-1), '--clobber');
  assert.equal(uploaded[PREV_ASSET_4910].toString(), 'previous gz');
  assert.equal(res.bytes, uploaded[ASSET_4910].length);
  // The uploaded gzip is a whole, openable database.
  const restored = path.join(dir, 'restored.db');
  fs.writeFileSync(restored, zlib.gunzipSync(uploaded[ASSET_4910]));
  const check = new DatabaseSync(restored);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM goods').get().n, 2);
  check.close();
});

test('pushDb uploads only the new asset when there is no previous one', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, '4910.db');
  makeDb(src);
  const run = releaseState({ prev: null });
  pushDb({ src, run, tmpDir: path.join(dir, 'tmp') });
  const up = run.calls.at(-1).args;
  assert.deepEqual(up.filter((a) => a.endsWith('.gz')).map((f) => path.basename(f)), [ASSET_4910]);
});

test('pushDb creates the release when it does not exist', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, '4910.db');
  makeDb(src);
  const run = releaseState({ exists: false });
  pushDb({ src, run, tmpDir: path.join(dir, 'tmp') });
  assert.deepEqual(run.calls.map((c) => c.args.slice(0, 2).join(' ')), ['release view', 'release create', 'release download', 'release upload']);
  assert.deepEqual(run.calls[1].args, [
    'release', 'create', 'data-4910', '--prerelease', '--title', '4910 data', '--notes', 'Daily 4910 DB (managed by .github/workflows/4910.yml)',
  ]);
});

test('pushDb throws with gh stderr when the upload fails', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, '4910.db');
  makeDb(src);
  const run = fakeRun((args) => (args[1] === 'upload' ? { status: 1, stderr: ' HTTP 502 \n' } : undefined));
  assert.throws(() => pushDb({ src, run, tmpDir: path.join(dir, 'tmp') }), /release upload failed.*HTTP 502$/);
});

test('pushDb throws when the release cannot be created', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, '4910.db');
  makeDb(src);
  const run = fakeRun((args) => (args[1] === 'view' || args[1] === 'create' ? { status: 1, stderr: 'auth required' } : undefined));
  assert.throws(() => pushDb({ src, run, tmpDir: path.join(dir, 'tmp') }), /release create failed.*auth required/);
  assert.equal(run.calls.some((c) => c.args[1] === 'upload'), false);
});

test('pushDb refuses to upload when the DB is missing or has no goods', (t) => {
  const dir = scratch(t);
  const missing = path.join(dir, 'nope.db');
  const empty = path.join(dir, 'empty.db');
  makeDb(empty, 0);
  const run = releaseState();
  assert.throws(() => pushDb({ src: missing, run }), /does not exist/);
  assert.equal(fs.existsSync(missing), false, 'a missing DB is not created as a side effect');
  assert.throws(() => pushDb({ src: empty, run }), /0 goods rows/);
  assert.equal(run.calls.length, 0);
});

test('pushDb folds the WAL into the pushed file', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, '4910.db');
  const store = new Store4910(src); // stays open: rows live in the -wal file
  store.db.prepare("INSERT INTO goods (sno, brand_sno, name, url, first_seen_date) VALUES (7, 1, 'g', 'u', '2026-10-10')").run();
  let uploaded;
  const run = fakeRun((args) => {
    if (args[1] === 'upload') uploaded = fs.readFileSync(args.find((a) => a.endsWith(ASSET_4910)));
  });
  pushDb({ src, run, tmpDir: path.join(dir, 'tmp') });
  store.close();
  const restored = path.join(dir, 'restored.db');
  fs.writeFileSync(restored, zlib.gunzipSync(uploaded));
  const check = new DatabaseSync(restored);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM goods').get().n, 1);
  check.close();
});
