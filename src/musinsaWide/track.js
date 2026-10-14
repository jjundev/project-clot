// Daily Musinsa wide run: scan the top-level categories concurrently, apply each category's listings, rotate the
// per-goods coupon checks, price every ACTIVE goods from its stored coupons.
import { CATEGORIES_MUSINSA, DEPTH_PAGES, scanCategory } from './client.js';
import { checkGoodsCoupons, applyCouponPrices } from './coupons.js';
import { mapConcurrent, clientPool } from '../pool.js';

// Keeps a degraded (slow, not dead) site from running the Actions job into its timeout; categories not finished by
// then count as incomplete, so their listings take no misses.
export const BUDGET_MS_MUSINSA = 20 * 60_000;
// The whole run, from its start: past it the coupon checks start no new goods, so the coupon prices, scan_runs and
// the Release push still happen inside the job timeout.
export const RUN_BUDGET_MS_MUSINSA = 35 * 60_000;

async function scanOne(client, cat, maxPages, deadline) {
  try {
    return await scanCategory(client, cat, { maxPages, deadline });
  } catch (err) {
    return { cat, rows: new Map(), pages: 0, complete: false, problems: [`scan: ${err.message}`] };
  }
}

// Item by item, not push(...list): spreading a first-day `added` list (~30k rows) as call arguments risks the stack.
function mergeDiffs(diffs, initial) {
  const merged = { initial, added: [], priceChanged: 0, drops: [], revived: [], outOfScope: 0 };
  for (const d of diffs) {
    merged.priceChanged += d.priceChanged;
    merged.outOfScope += d.outOfScope;
    for (const key of ['added', 'drops', 'revived']) {
      for (const item of d[key]) merged[key].push(item);
    }
  }
  merged.drops.sort((a, b) => b.dropRate - a.dropRate);
  return merged;
}

/**
 * Order: concurrent category scan → (dry run stops here, nothing written) → per-category applyScan → coupon checks
 * (rotating, session required) → coupon prices from the stored lists (no session needed) → scan_runs. `partial`
 * (--category/--depth) means no category was read in full, so none counts a miss.
 */
export async function trackMusinsa({
  makeClient, store, date, categories = CATEGORIES_MUSINSA, depthPages = DEPTH_PAGES, partial = false, concurrency = 3,
  dryRun = false, sessionProvider = null, budgetMs = BUDGET_MS_MUSINSA, runBudgetMs = RUN_BUDGET_MS_MUSINSA, log = console.log,
}) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const runDeadline = started + runBudgetMs;
  const withClient = clientPool(makeClient);
  const initial = dryRun ? false : store.isEmpty();

  const scans = await mapConcurrent(categories, concurrency, (cat) => withClient(async (client) => {
    const scan = await scanOne(client, cat, depthPages, deadline);
    log(`[무신사] ${cat}: ${scan.rows.size}개 ${scan.pages}페이지${scan.complete ? '' : ` (불완전: ${scan.problems.slice(0, 3).join('; ')})`}`);
    return scan;
  }));
  const categoryCounts = categories.map((cat, i) => ({
    cat, scanned: scans[i].rows.size, pages: scans[i].pages, complete: scans[i].complete, problems: scans[i].problems,
  }));

  // Nothing came back from any category (blocked runner, changed page shape): a failure, not an empty scan.
  if (categoryCounts.every((c) => c.scanned === 0)) {
    throw new Error(categoryCounts.find((c) => c.problems.length)?.problems[0] ?? 'no category returned any goods');
  }
  if (dryRun) return { date, categoryCounts, diff: null, coupons: null, durationMs: Date.now() - started };

  const diffs = categories.map((cat, i) => (
    store.applyScan(date, [...scans[i].rows.values()], { cat, complete: scans[i].complete && !partial })
  ));
  const diff = mergeDiffs(diffs, initial);

  let checked;
  try {
    checked = await checkGoodsCoupons({ withClient, store, date, sessionProvider, concurrency, deadline: runDeadline, log });
  } catch (err) {
    // The client never puts the cookie in an error message.
    log(`⚠️ [무신사] 쿠폰 조회 실패 (${err.status ?? err.name}: ${err.message})`);
    checked = { memberStatus: 'error', checked: 0, failed: 0 };
  }
  if (checked.memberStatus !== 'ok') log(`⚠️ [무신사] 쿠폰 조회 ${checked.memberStatus} — 저장된 쿠폰 목록으로 계산`);
  const { priced, stale, drops } = applyCouponPrices({ store, date });

  const durationMs = Date.now() - started;
  store.recordScanRun({
    date,
    categoryCounts,
    complete: categoryCounts.every((c) => c.complete) && !partial,
    changed: diff.priceChanged,
    added: diff.added.length,
    outOfScope: diff.outOfScope,
    durationMs,
    couponsOk: checked.memberStatus === 'ok',
    couponChecks: checked.checked,
  });
  return {
    date, categoryCounts, diff,
    coupons: { memberStatus: checked.memberStatus, checked: checked.checked, failed: checked.failed, priced, stale, drops },
    durationMs,
  };
}
