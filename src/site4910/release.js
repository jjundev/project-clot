// A site's SQLite DB lives in a GitHub Release asset, not in git: it is ~100MB and changes daily.
// `<cli> pull` fetches it before a run, `<cli> push` publishes it after (latest, prev and dated copies).
// Everything goes through the gh CLI; `run` is injectable so tests never touch GitHub. gh keeps its own
// credentials and never prints a token.
// `createRelease(config)` builds the pull/push pair for one Release tag. The 4910 site (tag data-4910) is configured at
// the bottom of this file; the Musinsa wide scan (tag data-musinsa) in ../musinsaWide/release.js.
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

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
function withTmpDir(prefix, tmpDir, fn) {
  const own = !tmpDir;
  const dir = tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `clot-${prefix}-`));
  fs.mkdirSync(dir, { recursive: true });
  try {
    return fn(dir);
  } finally {
    if (own) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// gh's answer when the release exists but has no asset by that name.
const NO_ASSET_RE = /no assets? match/i;

/**
 * Builds { pullDb, pushDb } for one Release.
 * @param {object} config
 * @param {string} config.tag release tag holding the DB
 * @param {string} config.asset latest DB asset name (gzip)
 * @param {string} config.prevAsset the day-before copy, re-uploaded on every push
 * @param {(date: string) => string} config.datedAsset name of the dated daily copy
 * @param {RegExp} config.datedRe matches every dated copy name (and nothing else) for pruning
 * @param {number} config.keep how many dated copies to keep, newest first
 * @param {string} config.title title used when the release has to be created
 * @param {string} config.notes notes used when the release has to be created
 * @param {string} config.label log prefix, shown as `[label]`
 * @param {string} config.cliName command prefix named in the fresh-DB refusal, as in `${cliName} pull`
 */
export function createRelease({ tag, asset, prevAsset, datedAsset, datedRe, keep, title, notes, label, cliName }) {
  // Downloads one asset into dir; returns its path, or throws when gh fails or the asset did not arrive. The error
  // has `missing: true` only when the asset is genuinely absent (gh's "no assets match", or exit 0 with no file), not
  // for a network, 5xx, auth or missing-release failure.
  function downloadAsset(run, dir, name) {
    try {
      gh(run, ['release', 'download', tag, '-p', name, '-D', dir, '--clobber'], `release download ${name}`);
    } catch (err) {
      if (NO_ASSET_RE.test(err.message)) err.missing = true;
      throw err;
    }
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) throw Object.assign(new Error(`release ${tag} has no ${name} asset`), { missing: true });
    return file;
  }

  /**
   * Downloads the Release asset and replaces `dest` with its gunzipped bytes. Only when the latest asset is genuinely
   * missing (an upload that failed after gh deleted it) does it fall back to the prev asset, saying so with source
   * 'prev'; any other download failure (network, 5xx, auth) throws, so a run never starts from a day-old base while
   * the latest asset still exists.
   * dest is only touched by the final rename, after the download and the gunzip both succeeded; any failure throws and
   * leaves it byte-identical.
   */
  function pullDb({ dest, run = defaultRun, tmpDir }) {
    return withTmpDir(label, tmpDir, (dir) => {
      let gz;
      let source = 'latest';
      try {
        gz = downloadAsset(run, dir, asset);
      } catch (latestErr) {
        if (!latestErr.missing) throw latestErr;
        try {
          gz = downloadAsset(run, dir, prevAsset);
          source = 'prev';
        } catch (prevErr) {
          throw new Error(`${latestErr.message}; fallback ${prevAsset}: ${prevErr.message}`);
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
  // with fewer than two scan days: that is a fresh DB from a skipped or failed `pull`, and uploading it would
  // replace the Release's history with a single day. Both sites' schemas carry the goods and scan_runs tables.
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
            `${src} has ${days} scan day(s); it looks like a fresh DB (was \`${cliName} pull\` skipped or did it fail?) and ` +
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
  function pruneDated(run, log) {
    const listing = run('gh', ['release', 'view', tag, '--json', 'assets']);
    let names;
    try {
      if (listing.status !== 0) throw new Error(`exit ${listing.status}: ${String(listing.stderr ?? '').trim()}`);
      names = (JSON.parse(listing.stdout).assets ?? []).map((a) => a.name).filter((n) => datedRe.test(n));
    } catch (err) {
      log(`⚠️ [${label}] could not list release assets to prune dated copies (${err.message})`);
      return [];
    }
    const pruned = [];
    for (const name of names.sort().reverse().slice(keep)) {
      const res = run('gh', ['release', 'delete-asset', tag, name, '--yes']);
      if (res.status === 0) pruned.push(name);
      else log(`⚠️ [${label}] could not delete old asset ${name} (exit ${res.status}: ${String(res.stderr ?? '').trim()})`);
    }
    return pruned;
  }

  /**
   * Publishes `src` as the latest asset. gh's --clobber deletes an asset before uploading its replacement, so every
   * step leaves a usable copy behind if the next one fails: (1) the current latest asset is re-uploaded as the prev
   * asset, (2) the new DB as the dated copy (UTC date), (3) the new DB as the latest asset, each its own gh call;
   * then (4) dated copies beyond the newest `keep` are deleted (best effort). Creates the Release when absent. Any
   * failure in steps 1–3 throws.
   */
  function pushDb({ src, run = defaultRun, tmpDir, allowFresh = false, date = new Date().toISOString().slice(0, 10), log = console.log }) {
    prepareForPush(src, allowFresh);
    return withTmpDir(label, tmpDir, (dir) => {
      const gz = path.join(dir, asset);
      fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(src), { level: 9 }));
      const bytes = fs.statSync(gz).size;
      const dated = path.join(dir, datedAsset(date));
      fs.copyFileSync(gz, dated);

      if (run('gh', ['release', 'view', tag]).status !== 0) {
        gh(run, ['release', 'create', tag, '--prerelease', '--title', title, '--notes', notes], 'release create');
      }

      const prevDir = path.join(dir, 'prev');
      const prevDownload = run('gh', ['release', 'download', tag, '-p', asset, '-D', prevDir]);
      const prevFile = path.join(prevDir, asset);
      if (prevDownload.status === 0 && fs.existsSync(prevFile)) {
        const prev = path.join(dir, prevAsset);
        fs.renameSync(prevFile, prev);
        gh(run, ['release', 'upload', tag, prev, '--clobber'], `release upload ${prevAsset}`);
      }
      gh(run, ['release', 'upload', tag, dated, '--clobber'], `release upload ${path.basename(dated)}`);
      gh(run, ['release', 'upload', tag, gz, '--clobber'], `release upload ${asset}`);

      const pruned = pruneDated(run, log);
      return { bytes, pruned };
    });
  }

  return { pullDb, pushDb };
}

export const RELEASE_TAG_4910 = 'data-4910';
export const ASSET_4910 = '4910.db.gz';
export const PREV_ASSET_4910 = '4910.db.prev.gz';
// Dated daily copies kept next to latest/prev, newest first.
export const DATED_KEEP_4910 = 7;
export const datedAsset4910 = (date) => `4910.db.${date}.gz`;

export const { pullDb, pushDb } = createRelease({
  tag: RELEASE_TAG_4910,
  asset: ASSET_4910,
  prevAsset: PREV_ASSET_4910,
  datedAsset: datedAsset4910,
  datedRe: /^4910\.db\.\d{4}-\d{2}-\d{2}\.gz$/,
  keep: DATED_KEEP_4910,
  title: '4910 data',
  notes: 'Daily 4910 DB (managed by .github/workflows/4910.yml)',
  label: '4910-db',
  cliName: '4910-db',
});
