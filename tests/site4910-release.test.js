import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { pullDb, pushDb, RELEASE_TAG_4910, ASSET_4910, PREV_ASSET_4910, DATED_KEEP_4910 } from '../src/site4910/release.js';
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

function makeDb(file, goodsRows = 2, scanDays = 2) {
  const store = new Store4910(file);
  for (let d = 1; d <= scanDays; d++) {
    store.db.prepare('INSERT INTO scan_runs (date, completed_at) VALUES (?, ?)').run(`2026-10-0${d}`, 'x');
  }
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
  assert.throws(() => pullDb({ dest, run, tmpDir: dir }), /release download 4910\.db\.gz failed.*release not found; fallback 4910\.db\.prev\.gz: .*failed/);
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

test('pullDb falls back to the prev asset when 4910.db.gz cannot be downloaded', (t) => {
  const dir = scratch(t);
  const dest = path.join(dir, '4910.db');
  const payload = Buffer.from('day-before database');
  const run = fakeRun((args) => {
    if (args[4] === ASSET_4910) return { status: 1, stderr: 'no assets match the file pattern' };
    fs.writeFileSync(path.join(args[args.indexOf('-D') + 1], PREV_ASSET_4910), zlib.gzipSync(payload));
    return undefined;
  });
  const res = pullDb({ dest, run, tmpDir: path.join(dir, 'tmp') });
  assert.deepEqual(res, { bytes: payload.length, source: 'prev' });
  assert.deepEqual(fs.readFileSync(dest), payload);
  assert.deepEqual(run.calls.map((c) => c.args[4]), [ASSET_4910, PREV_ASSET_4910]);
});

test('pullDb reports source latest and never asks for prev when 4910.db.gz is there', (t) => {
  const dir = scratch(t);
  const run = fakeRun((args) => {
    fs.writeFileSync(path.join(args[args.indexOf('-D') + 1], ASSET_4910), zlib.gzipSync(Buffer.from('x')));
  });
  assert.deepEqual(pullDb({ dest: path.join(dir, '4910.db'), run, tmpDir: path.join(dir, 'tmp') }), { bytes: 1, source: 'latest' });
  assert.equal(run.calls.length, 1);
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

const DATE = '2026-10-11';
const DATED = `4910.db.${DATE}.gz`;

// A fake Release: `assets` are the names `release view --json assets` lists; `prev` is the current 4910.db.gz
// (null = none). Every uploaded file's bytes are kept by asset name.
function releaseState({ exists = true, prev = Buffer.from('previous gz'), assets = [], fail = {} } = {}) {
  const run = fakeRun((args) => {
    const step = args[1] === 'upload' ? `upload ${path.basename(args[3])}` : args[1] === 'view' && args.includes('--json') ? 'list' : args[1];
    if (fail[step]) return fail[step];
    if (step === 'view') return exists ? undefined : { status: 1, stderr: 'release not found' };
    if (step === 'list') return { stdout: JSON.stringify({ assets: assets.map((name) => ({ name, size: 1 })) }) };
    if (step === 'download') {
      if (!prev) return { status: 1, stderr: 'no assets match' };
      const d = args[args.indexOf('-D') + 1];
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, ASSET_4910), prev);
    }
    if (args[1] === 'upload') run.uploaded[path.basename(args[3])] = fs.readFileSync(args[3]);
    return undefined;
  });
  run.uploaded = {};
  return run;
}
const steps = (run) => run.calls.map((c) => (c.args[1] === 'upload' ? `upload ${path.basename(c.args[3])}` : c.args.slice(0, 2).join(' ') + (c.args.includes('--json') ? ' --json' : '')));

test('pushDb uploads prev first, then the dated copy, then latest, each as its own call', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, '4910.db');
  makeDb(src);
  const run = releaseState();
  const res = pushDb({ src, run, tmpDir: path.join(dir, 'tmp'), date: DATE, log: () => {} });

  assert.deepEqual(steps(run), [
    'release view', 'release download', `upload ${PREV_ASSET_4910}`, `upload ${DATED}`, `upload ${ASSET_4910}`, 'release view --json',
  ]);
  assert.equal(run.calls.every((c) => c.cmd === 'gh'), true);
  assert.deepEqual(run.calls[1].args.slice(0, 5), ['release', 'download', RELEASE_TAG_4910, '-p', ASSET_4910]);
  for (const c of run.calls.filter((c) => c.args[1] === 'upload')) {
    assert.deepEqual(c.args.slice(0, 3), ['release', 'upload', RELEASE_TAG_4910]);
    assert.equal(c.args.length, 5);
    assert.equal(c.args.at(-1), '--clobber');
  }
  assert.equal(run.uploaded[PREV_ASSET_4910].toString(), 'previous gz');
  assert.deepEqual(run.uploaded[DATED], run.uploaded[ASSET_4910]);
  assert.equal(res.bytes, run.uploaded[ASSET_4910].length);
  assert.deepEqual(res.pruned, []);
  // The uploaded gzip is a whole, openable database.
  const restored = path.join(dir, 'restored.db');
  fs.writeFileSync(restored, zlib.gunzipSync(run.uploaded[ASSET_4910]));
  const check = new DatabaseSync(restored);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM goods').get().n, 2);
  check.close();
});

test('pushDb skips the prev upload when there is no previous asset', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, '4910.db');
  makeDb(src);
  const run = releaseState({ prev: null });
  pushDb({ src, run, tmpDir: path.join(dir, 'tmp'), date: DATE, log: () => {} });
  assert.deepEqual(Object.keys(run.uploaded), [DATED, ASSET_4910]);
});

test('a failed prev upload stops the push before latest is touched', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, '4910.db');
  makeDb(src);
  const run = releaseState({ fail: { [`upload ${PREV_ASSET_4910}`]: { status: 1, stderr: 'HTTP 502' } } });
  assert.throws(() => pushDb({ src, run, tmpDir: path.join(dir, 'tmp'), date: DATE, log: () => {} }), /upload 4910\.db\.prev\.gz failed.*HTTP 502/);
  assert.deepEqual(Object.keys(run.uploaded), []);
});

test('a failed latest upload throws but leaves prev and the dated copy uploaded', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, '4910.db');
  makeDb(src);
  const run = releaseState({ fail: { [`upload ${ASSET_4910}`]: { status: 1, stderr: 'HTTP 502' } } });
  assert.throws(() => pushDb({ src, run, tmpDir: path.join(dir, 'tmp'), date: DATE, log: () => {} }), /upload 4910\.db\.gz failed.*HTTP 502/);
  assert.deepEqual(Object.keys(run.uploaded), [PREV_ASSET_4910, DATED]);
  assert.equal(steps(run).includes('release view --json'), false);
});

test('pushDb deletes dated copies beyond the newest 7 and leaves other assets alone', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, '4910.db');
  makeDb(src);
  const dated = Array.from({ length: 9 }, (_, i) => `4910.db.2026-10-0${i + 1}.gz`).concat(DATED); // 10 dated copies
  const run = releaseState({ assets: [ASSET_4910, PREV_ASSET_4910, ...dated, 'notes.txt'] });
  const res = pushDb({ src, run, tmpDir: path.join(dir, 'tmp'), date: DATE, log: () => {} });
  assert.equal(DATED_KEEP_4910, 7);
  assert.deepEqual(res.pruned, ['4910.db.2026-10-03.gz', '4910.db.2026-10-02.gz', '4910.db.2026-10-01.gz']);
  const deletes = run.calls.filter((c) => c.args[1] === 'delete-asset').map((c) => c.args);
  assert.deepEqual(deletes, res.pruned.map((n) => ['release', 'delete-asset', RELEASE_TAG_4910, n, '--yes']));
});

test('a failed prune only warns', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, '4910.db');
  makeDb(src);
  const lines = [];
  const listFails = releaseState({ fail: { list: { status: 1, stderr: 'HTTP 500' } } });
  assert.deepEqual(pushDb({ src, run: listFails, tmpDir: path.join(dir, 'tmp'), date: DATE, log: (l) => lines.push(l) }).pruned, []);
  assert.match(lines.join('\n'), /⚠️.*could not list release assets.*HTTP 500/);

  const many = Array.from({ length: 8 }, (_, i) => `4910.db.2026-10-0${i + 1}.gz`);
  const deleteFails = releaseState({ assets: many, fail: { 'delete-asset': { status: 1, stderr: 'HTTP 403' } } });
  assert.deepEqual(pushDb({ src, run: deleteFails, tmpDir: path.join(dir, 'tmp'), date: DATE, log: (l) => lines.push(l) }).pruned, []);
  assert.match(lines.join('\n'), /⚠️.*could not delete old asset 4910\.db\.2026-10-01\.gz.*HTTP 403/);
});

test('pushDb creates the release when it does not exist', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, '4910.db');
  makeDb(src);
  const run = releaseState({ exists: false, prev: null });
  pushDb({ src, run, tmpDir: path.join(dir, 'tmp'), date: DATE, log: () => {} });
  assert.deepEqual(steps(run), ['release view', 'release create', 'release download', `upload ${DATED}`, `upload ${ASSET_4910}`, 'release view --json']);
  assert.deepEqual(run.calls[1].args, [
    'release', 'create', 'data-4910', '--prerelease', '--title', '4910 data', '--notes', 'Daily 4910 DB (managed by .github/workflows/4910.yml)',
  ]);
});

test('pushDb throws with gh stderr when the upload fails', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, '4910.db');
  makeDb(src);
  const run = fakeRun((args) => (args[1] === 'upload' ? { status: 1, stderr: ' HTTP 502 \n' } : undefined));
  assert.throws(() => pushDb({ src, run, tmpDir: path.join(dir, 'tmp'), date: DATE }), /release upload \S+ failed.*HTTP 502$/);
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
  store.db.prepare('INSERT INTO scan_runs (date, completed_at) VALUES (?, ?)').run('2026-10-01', 'x');
  store.db.prepare('INSERT INTO scan_runs (date, completed_at) VALUES (?, ?)').run('2026-10-02', 'x');
  store.db.prepare("INSERT INTO goods (sno, brand_sno, name, url, first_seen_date) VALUES (7, 1, 'g', 'u', '2026-10-10')").run();
  let uploaded;
  const run = releaseState({ prev: null });
  pushDb({ src, run, tmpDir: path.join(dir, 'tmp'), date: DATE });
  uploaded = run.uploaded[ASSET_4910];
  store.close();
  const restored = path.join(dir, 'restored.db');
  fs.writeFileSync(restored, zlib.gunzipSync(uploaded));
  const check = new DatabaseSync(restored);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM goods').get().n, 1);
  check.close();
});

test('pushDb refuses a one-day DB (a skipped pull) with zero gh calls, unless allowFresh', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, '4910.db');
  makeDb(src, 2, 1);
  const run = releaseState();
  assert.throws(() => pushDb({ src, run, tmpDir: path.join(dir, 'tmp') }), /1 scan day.*pull.*--allow-fresh/s);
  assert.equal(run.calls.length, 0);

  pushDb({ src, run, tmpDir: path.join(dir, 'tmp'), allowFresh: true, date: DATE });
  assert.ok(run.uploaded[ASSET_4910]);
});

test('pushDb refuses a DB with no scan days, and still refuses an empty DB under allowFresh', (t) => {
  const dir = scratch(t);
  const none = path.join(dir, 'none.db');
  const empty = path.join(dir, 'empty.db');
  makeDb(none, 2, 0);
  makeDb(empty, 0, 5);
  const run = releaseState();
  assert.throws(() => pushDb({ src: none, run }), /0 scan day/);
  assert.throws(() => pushDb({ src: empty, run, allowFresh: true }), /0 goods rows/);
  assert.equal(run.calls.length, 0);
});

test('pushDb uploads a two-day DB without allowFresh', (t) => {
  const dir = scratch(t);
  const src = path.join(dir, '4910.db');
  makeDb(src, 2, 2);
  const run = releaseState();
  pushDb({ src, run, tmpDir: path.join(dir, 'tmp'), date: DATE });
  assert.ok(run.uploaded[ASSET_4910]);
});
