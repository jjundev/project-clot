// 4910.db lives in a GitHub Release asset (tag data-4910), not in git: it is ~100MB and changes daily.
// `4910-db pull` fetches it before a run, `4910-db push` publishes it after. Everything goes through the gh CLI;
// `run` is injectable so tests never touch GitHub. gh keeps its own credentials and never prints a token.
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const RELEASE_TAG_4910 = 'data-4910';
export const ASSET_4910 = '4910.db.gz';
export const PREV_ASSET_4910 = '4910.db.prev.gz';

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

/**
 * Downloads the Release asset and replaces `dest` with its gunzipped bytes. dest is only touched by the final
 * rename, after the download and the gunzip both succeeded; any failure throws and leaves it byte-identical.
 */
export function pullDb({ dest, run = defaultRun, tmpDir }) {
  return withTmpDir(tmpDir, (dir) => {
    gh(run, ['release', 'download', RELEASE_TAG_4910, '-p', ASSET_4910, '-D', dir, '--clobber'], 'release download');
    const gz = path.join(dir, ASSET_4910);
    if (!fs.existsSync(gz)) throw new Error(`release ${RELEASE_TAG_4910} has no ${ASSET_4910} asset`);

    let bytes;
    try {
      bytes = zlib.gunzipSync(fs.readFileSync(gz));
    } catch (err) {
      throw new Error(`${ASSET_4910} is not a valid gzip (${err.message})`);
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
    return { bytes: bytes.length };
  });
}

// Folds the WAL into the main file and compacts it, so the gzip holds the whole DB and nothing else.
// Refuses an absent or empty DB: pushing that would overwrite the Release with nothing.
function prepareForPush(src) {
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
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
  } finally {
    db.close();
  }
}

/**
 * Uploads `src` as 4910.db.gz, keeping the asset it replaces as 4910.db.prev.gz (a one-step undo). Creates the
 * Release when absent. Only the prev download is optional; any other gh failure throws.
 */
export function pushDb({ src, run = defaultRun, tmpDir }) {
  prepareForPush(src);
  return withTmpDir(tmpDir, (dir) => {
    const gz = path.join(dir, ASSET_4910);
    fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(src), { level: 9 }));
    const bytes = fs.statSync(gz).size;

    if (run('gh', ['release', 'view', RELEASE_TAG_4910]).status !== 0) {
      gh(run, ['release', 'create', RELEASE_TAG_4910, '--prerelease', '--title', RELEASE_TITLE, '--notes', RELEASE_NOTES], 'release create');
    }

    const files = [gz];
    const prevDir = path.join(dir, 'prev');
    const prevDownload = run('gh', ['release', 'download', RELEASE_TAG_4910, '-p', ASSET_4910, '-D', prevDir]);
    const prevFile = path.join(prevDir, ASSET_4910);
    if (prevDownload.status === 0 && fs.existsSync(prevFile)) {
      const prev = path.join(dir, PREV_ASSET_4910);
      fs.renameSync(prevFile, prev);
      files.push(prev);
    }

    gh(run, ['release', 'upload', RELEASE_TAG_4910, ...files, '--clobber'], 'release upload');
    return { bytes };
  });
}
