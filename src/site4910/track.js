// Daily 4910 run: scan every brand, apply one diff to the store, and the GitHub-runner reachability probe.
import { BRANDS_4910, scanBrand } from './client.js';

// Keeps a degraded (slow, not dead) API from running the Actions job into its 30-minute timeout before the
// Musinsa commit; brands not finished by then count as incomplete, so their listings take no misses.
export const BUDGET_MS_4910 = 8 * 60_000;

export async function track4910({ client, store, date, brands = BRANDS_4910, dryRun = false, budgetMs = BUDGET_MS_4910, log = console.log }) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const brandCounts = [];
  const allRows = [];
  const completeBrands = [];

  for (const brand of brands) {
    let scan;
    try {
      scan = await scanBrand(client, brand, { deadline });
    } catch (err) {
      scan = { brandTotal: null, rows: new Map(), complete: false, problems: [`scan: ${err.message}`] };
    }
    brandCounts.push({
      sno: brand.sno, name: brand.name, total: scan.brandTotal, scanned: scan.rows.size, complete: scan.complete, problems: scan.problems,
    });
    allRows.push(...scan.rows.values());
    if (scan.complete) completeBrands.push(brand.sno);
    log(`[4910] ${brand.name}: ${scan.rows.size}/${scan.brandTotal ?? '?'} 스캔${scan.complete ? '' : ` (불완전: ${scan.problems.slice(0, 3).join('; ')})`}`);
  }

  // Nothing reached 4910 at all (blocked runner, token endpoint down): a failure, not an empty scan.
  if (brandCounts.every((b) => b.total === null)) {
    throw new Error(brandCounts[0]?.problems[0] ?? 'no brand reachable');
  }

  if (dryRun) return { date, brandCounts, diff: null, durationMs: Date.now() - started };

  const diff = store.applyScan(date, allRows, { completeBrands });
  const durationMs = Date.now() - started;
  store.recordScanRun({
    date,
    brandCounts,
    complete: brandCounts.every((b) => b.complete),
    changed: diff.priceChanged,
    added: diff.added.length,
    dropped: diff.dropped.length,
    durationMs,
  });
  return { date, brandCounts, diff, durationMs };
}

const failDetail = (err) => `${err.status ?? err.name}: ${err.message}`;

/** Read-only: can this machine get an anonymous token and one Uniqlo listing page? Never prints the token. */
export async function probe4910({ client }) {
  const checks = [];
  let tokenOk = false;
  try {
    const token = await client.getToken();
    tokenOk = typeof token === 'string' && token.length > 0;
    checks.push({ name: '4910 anonymous token', ok: tokenOk, detail: `${token?.length ?? 0} chars` });
  } catch (err) {
    checks.push({ name: '4910 anonymous token', ok: false, detail: failDetail(err) });
  }
  if (!tokenOk) {
    checks.push({ name: '4910 uniqlo listing', ok: false, detail: 'skipped (no token)' });
    return checks;
  }
  try {
    const { totalCount } = await client.listBrandGoods({ brandSno: BRANDS_4910[0].sno, limit: 1 });
    checks.push({ name: '4910 uniqlo listing', ok: totalCount > 0, detail: `total_count=${totalCount}` });
  } catch (err) {
    checks.push({ name: '4910 uniqlo listing', ok: false, detail: failDetail(err) });
  }
  return checks;
}
