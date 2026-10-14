// The Musinsa wide scan's DB lives in a GitHub Release asset (tag data-musinsa), same mechanism as the 4910 DB:
// `musinsa-db pull` before a run, `musinsa-db push` after. See ../site4910/release.js.
import { createRelease } from '../site4910/release.js';

export const RELEASE_TAG_MUSINSA = 'data-musinsa';
export const ASSET_MUSINSA = 'musinsa-wide.db.gz';
export const PREV_ASSET_MUSINSA = 'musinsa-wide.db.prev.gz';
// Dated daily copies kept next to latest/prev, newest first.
export const DATED_KEEP_MUSINSA = 7;
export const datedAssetMusinsa = (date) => `musinsa-wide.db.${date}.gz`;

export const { pullDb, pushDb } = createRelease({
  tag: RELEASE_TAG_MUSINSA,
  asset: ASSET_MUSINSA,
  prevAsset: PREV_ASSET_MUSINSA,
  datedAsset: datedAssetMusinsa,
  datedRe: /^musinsa-wide\.db\.\d{4}-\d{2}-\d{2}\.gz$/,
  keep: DATED_KEEP_MUSINSA,
  title: 'Musinsa wide data',
  notes: 'Daily Musinsa wide DB (managed by .github/workflows/musinsa-wide.yml)',
  label: 'musinsa-db',
  cliName: 'node src/cli.js musinsa-db',
});
