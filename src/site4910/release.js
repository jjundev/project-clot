// 4910.db lives in a GitHub Release asset (tag data-4910), not in git: it is ~100MB and changes daily.
// `4910-db pull` fetches it before a run, `4910-db push` publishes it after (latest, prev and dated copies).
// Everything goes through the gh CLI; `run` is injectable so tests never touch GitHub. gh keeps its own
// credentials and never prints a token.
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const RELEASE_TAG_4910 = 'data-4910';
export const ASSET_4910 = '4910.db.gz';
export const PREV_ASSET_4910 = '4910.db.prev.gz';
// Dated daily copies kept next to latest/prev, newest first.
export const DATED_KEEP_4910 = 7;
export const datedAsset4910 = (date) => `4910.db.${date}.gz`;
const DATED_ASSET_RE = /^4910\.db\.\d{4}-\d{2}-\d{2}\.gz$/;

const RELEASE_TITLE = '4910 data';
const RELEASE_NOTES = 'Daily 4910 DB (managed by .github/workflows/4910.yml)';

export function defaultRun(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  if (res.error) return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.error.message };
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function gh(run, args, what) {
  const res = run('gh', args);
  if (res.status !== 0) {
    const detail = String(res.stderr ?? '').trim();
    throw new Error(`gh ${what} failed (exit ${res.status})${detail ? `: ${detail}` : ''}`);
  }
  return res;
}

// Runs fn with a scratch directory; one made here is removed afterwards, an injected one is the caller's.
function withTmpDir(tmpDir, fn) {
  const own = !tmpDir;
  const dir = tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'clot-4910-'));
  fs.mkdirSync(dir, { recursive: true });
  try {
    return fn(dir);
  } finally {
    if (own) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Downloads one asset into dir; returns its path, or throws when gh fails or the asset did not arrive.
function downloadAsset(run, dir, asset) {
  gh(run, ['release', 'download', RELEASE_TAG_4910, '-p', asset, '-D', dir, '--clobber'], `release download ${asset}`);
  const file = path.join(dir, asset);
  if (!fs.existsSync(file)) throw new Error(`release ${RELEASE_TAG_4910} has no ${asset} asset`);
  return file;
}

/**
 * Downloads the Release asset and replaces `dest` with its gunzipped bytes. When 4910.db.gz cannot be downloaded
 * (an upload that failed after gh deleted it), falls back to 4910.db.prev.gz and says so with source 'prev'.
 * dest is only touched by the final rename, after the download and the gunzip both succeeded; any failure throws and
 * leaves it byte-identical.
 */
export function pullDb({ dest, run = defaultRun, tmpDir }) {
  return withTmpDir(tmpDir, (dir) => {
    let gz;
    let source = 'latest';
    try {
      gz = downloadAsset(run, dir, ASSET_4910);
    } catch (latestErr) {
      try {
        gz = downloadAsset(run, dir, PREV_ASSET_4910);
        source = 'prev';
      } catch (prevErr) {
        throw new Error(`${latestErr.message}; fallback ${PREV_ASSET_4910}: ${prevErr.message}`);
      }
    }

    let bytes;
    try {
      bytes = zlib.gunzipSync(fs.readFileSync(gz));
    } catch (err) {
      throw new Error(`${path.basename(gz)} is not a valid gzip (${err.message})`);
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const partial = `${dest}.pull-${process.pid}.tmp`;
    try {
      fs.writeFileSync(partial, bytes);
      fs.renameSync(partial, dest);
    } finally {
      fs.rmSync(partial, { force: true });
    }
    // Sidecars of the replaced file would be replayed onto the new one.
    fs.rmSync(`${dest}-wal`, { force: true });
    fs.rmSync(`${dest}-shm`, { force: true });
    return { bytes: bytes.length, source };
  });
}

// Folds the WAL into the main file and compacts it, so the gzip holds the whole DB and nothing else.
// Refuses an absent or empty DB (pushing that would overwrite the Release with nothing) and, unless allowFresh, a DB
// with fewer than two scan days: that is a fresh DB from a skipped or failed `4910-db pull`, and uploading it would
// replace the Release's history with a single day.
function prepareForPush(src, allowFresh) {
  if (!fs.existsSync(src)) throw new Error(`${src} does not exist; nothing to push`);
  const db = new DatabaseSync(src);
  try {
    let goods;
    try {
      goods = db.prepare('SELECT COUNT(*) AS n FROM goods').get().n;
    } catch (err) {
      throw new Error(`${src} has no goods table; refusing to push (${err.message})`);
    }
    if (goods === 0) throw new Error(`${src} has 0 goods rows; refusing to overwrite the release with an empty DB`);
    if (!allowFresh) {
      let days;
      try {
        days = db.prepare('SELECT COUNT(DISTINCT date) AS n FROM scan_runs').get().n;
      } catch (err) {
        throw new Error(`${src} has no scan_runs table; refusing to push (${err.message})`);
      }
      if (days < 2) {
        throw new Error(
          `${src} has ${days} scan day(s); it looks like a fresh DB (was \`4910-db pull\` skipped or did it fail?) and ` +
            'pushing it would replace the release history. Pass --allow-fresh to push it anyway.'
        );
      }
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
  } finally {
    db.close();
  }
}

// Deletes the dated assets beyond the newest `keep`. Best effort: a failure is logged, never thrown, because the
// new DB is already uploaded by then.
function pruneDated(run, keep, log) {
  const listing = run('gh', ['release', 'view', RELEASE_TAG_4910, '--json', 'assets']);
  let names;
  try {
    if (listing.status !== 0) throw new Error(`exit ${listing.status}: ${String(listing.stderr ?? '').trim()}`);
    names = (JSON.parse(listing.stdout).assets ?? []).map((a) => a.name).filter((n) => DATED_ASSET_RE.test(n));
  } catch (err) {
    log(`⚠️ [4910-db] could not list release assets to prune dated copies (${err.message})`);
    return [];
  }
  const pruned = [];
  for (const name of names.sort().reverse().slice(keep)) {
    const res = run('gh', ['release', 'delete-asset', RELEASE_TAG_4910, name, '--yes']);
    if (res.status === 0) pruned.push(name);
    else log(`⚠️ [4910-db] could not delete old asset ${name} (exit ${res.status}: ${String(res.stderr ?? '').trim()})`);
  }
  return pruned;
}

/**
 * Publishes `src` as 4910.db.gz. gh's --clobber deletes an asset before uploading its replacement, so every step
 * leaves a usable copy behind if the next one fails: (1) the current 4910.db.gz is re-uploaded as 4910.db.prev.gz,
 * (2) the new DB as the dated copy 4910.db.<date>.gz (UTC), (3) the new DB as 4910.db.gz, each its own gh call;
 * then (4) dated copies beyond the newest DATED_KEEP_4910 are deleted (best effort). Creates the Release when
 * absent. Any failure in steps 1–3 throws.
 */
export function pushDb({ src, run = defaultRun, tmpDir, allowFresh = false, date = new Date().toISOString().slice(0, 10), log = console.log }) {
  prepareForPush(src, allowFresh);
  return withTmpDir(tmpDir, (dir) => {
    const gz = path.join(dir, ASSET_4910);
    fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(src), { level: 9 }));
    const bytes = fs.statSync(gz).size;
    const dated = path.join(dir, datedAsset4910(date));
    fs.copyFileSync(gz, dated);

    if (run('gh', ['release', 'view', RELEASE_TAG_4910]).status !== 0) {
      gh(run, ['release', 'create', RELEASE_TAG_4910, '--prerelease', '--title', RELEASE_TITLE, '--notes', RELEASE_NOTES], 'release create');
    }

    const prevDir = path.join(dir, 'prev');
    const prevDownload = run('gh', ['release', 'download', RELEASE_TAG_4910, '-p', ASSET_4910, '-D', prevDir]);
    const prevFile = path.join(prevDir, ASSET_4910);
    if (prevDownload.status === 0 && fs.existsSync(prevFile)) {
      const prev = path.join(dir, PREV_ASSET_4910);
      fs.renameSync(prevFile, prev);
      gh(run, ['release', 'upload', RELEASE_TAG_4910, prev, '--clobber'], `release upload ${PREV_ASSET_4910}`);
    }
    gh(run, ['release', 'upload', RELEASE_TAG_4910, dated, '--clobber'], `release upload ${path.basename(dated)}`);
    gh(run, ['release', 'upload', RELEASE_TAG_4910, gz, '--clobber'], `release upload ${ASSET_4910}`);

    const pruned = pruneDated(run, DATED_KEEP_4910, log);
    return { bytes, pruned };
  });
}
