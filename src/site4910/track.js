// Daily 4910 run: scan the top brands concurrently, keep the qualified sellers' listings, apply them per brand,
// price them with today's coupons; plus the GitHub-runner reachability probe.
import { BRANDS_4910, scanBrand } from './client.js';
import { tokenExpiry } from './liked.js';
import { resolveBrands } from './brands.js';
import { refreshMarkets } from './sellers.js';
import { learnMarketCoupons, applyCouponPrices } from './coupons.js';
import { mapConcurrent, clientPool } from '../pool.js';

// Keeps a degraded (slow, not dead) API from running the Actions job (45-minute timeout) into its timeout; brands
// not finished by then count as incomplete, so their listings take no misses.
export const BUDGET_MS_4910 = 20 * 60_000;
// The whole run, from its start: past it the seller checks and the coupon sampling start no new work, so the
// coupon prices, scan_runs and the Release push still happen inside the job timeout.
export const RUN_BUDGET_MS_4910 = 35 * 60_000;

async function scanOne(client, brand, deadline) {
  try {
    return await scanBrand(client, brand, { deadline });
  } catch (err) {
    return { brandTotal: null, rows: new Map(), complete: false, problems: [`scan: ${err.message}`] };
  }
}

// Item by item, not push(...list): spreading a first-day `added` list (~120k rows) as call arguments overflows
// the stack. (No test: a stack-overflow-sized fixture would only test V8's argument limit.)
function mergeDiffs(diffs, initial) {
  const merged = { initial, added: [], priceChanged: 0, drops: [], revived: [], dropped: [] };
  for (const d of diffs) {
    merged.priceChanged += d.priceChanged;
    for (const key of ['added', 'drops', 'revived', 'dropped']) {
      for (const item of d[key]) merged[key].push(item);
    }
  }
  merged.drops.sort((a, b) => b.dropRate - a.dropRate);
  return merged;
}

/**
 * Order: brand list → concurrent scan → seller verdicts → OUT_OF_SCOPE → per-brand applyScan of the qualified
 * sellers' rows → coupons (concurrent per seller) → coupon prices → scan_runs. OUT_OF_SCOPE comes before
 * applyScan so a seller that just failed takes no misses (applyScan counts misses only for ACTIVE rows). A dry run
 * stops after the scan and writes nothing (no seller calls either).
 */
export async function track4910({
  makeClient, store, date, brands = null, concurrency = 3, dryRun = false, memberToken = null,
  budgetMs = BUDGET_MS_4910, runBudgetMs = RUN_BUDGET_MS_4910, now = new Date(), log = console.log,
}) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const runDeadline = started + runBudgetMs;
  const withClient = clientPool(makeClient);
  const initial = dryRun ? false : store.isEmpty();

  const brandList = brands ?? (await withClient((client) => resolveBrands({ client, store: dryRun ? null : store, date, now, log }))).brands;
  const scans = await mapConcurrent(brandList, concurrency, (brand) => withClient(async (client) => {
    const scan = await scanOne(client, brand, deadline);
    log(`[4910] ${brand.name}: ${scan.rows.size}/${scan.brandTotal ?? '?'} 스캔${scan.complete ? '' : ` (불완전: ${scan.problems.slice(0, 3).join('; ')})`}`);
    return scan;
  }));
  const brandCounts = brandList.map((brand, i) => ({
    sno: brand.sno, name: brand.name, total: scans[i].brandTotal, scanned: scans[i].rows.size, complete: scans[i].complete, problems: scans[i].problems,
  }));

  // Nothing reached 4910 at all (blocked runner, token endpoint down): a failure, not an empty scan.
  if (brandCounts.every((b) => b.total === null)) {
    throw new Error(brandCounts[0]?.problems[0] ?? 'no brand reachable');
  }

  const marketSnos = [...new Set(scans.flatMap((s) => [...s.rows.values()].map((r) => r.market_sno)).filter((m) => m != null).map(Number))];
  if (dryRun) {
    return {
      date, brandCounts, diff: null, sellers: { seen: marketSnos.length, qualified: null, checked: 0 }, coupons: null, outOfScope: 0,
      durationMs: Date.now() - started,
    };
  }

  const { qualified, checked } = await withClient((client) => refreshMarkets({ client, store, date, marketSnos, deadline: runDeadline, log }));
  // Every stored qualified seller, not only today's: an incomplete brand's unseen listings must stay as they are.
  const qualifiedMarketSnos = [...store.getMarkets().values()].filter((m) => m.qualified).map((m) => m.sno);
  // An explicit brand list (`--brand`) is a partial run: the stored brand list stays in scope, so the brands not
  // scanned today keep their ACTIVE rows instead of going OUT_OF_SCOPE (and REVIVED on the next full run).
  const activeBrandSnos = brands
    ? [...new Set([...store.getActiveBrands().map((b) => Number(b.sno)), ...brandList.map((b) => Number(b.sno))])]
    : brandList.map((b) => b.sno);
  const outOfScope = store.markOutOfScope({ activeBrandSnos, qualifiedMarketSnos });

  const diffs = brandList.map((brand, i) => {
    const rows = [...scans[i].rows.values()].filter((r) => qualified.has(Number(r.market_sno)));
    brandCounts[i].qualifiedRows = rows.length;
    return store.applyScan(date, rows, { completeBrands: scans[i].complete ? [brand.sno] : [], observedAt: new Date(started).toISOString() });
  });
  const diff = mergeDiffs(diffs, initial);

  let learned;
  try {
    learned = await learnMarketCoupons({ withClient, concurrency, store, date, marketSnos: [...qualified], memberToken, deadline: runDeadline, log });
  } catch (err) {
    // The client never puts the member token in an error message.
    log(`⚠️ [4910] 쿠폰 학습 실패 (${err.status ?? err.name}: ${err.message})`);
    learned = { memberStatus: 'error', wallet: 0, walletChanges: { added: [], removed: [] }, emoney: null, eligible: 0, mismatched: 0, hidden: { scope: 0, naver: 0, mismatch: 0 } };
  }
  // Only an ok run knows today's coupons; otherwise the last coupon prices and their history stay as they were.
  const couponsOk = learned.memberStatus === 'ok';
  let priced = 0, validation = { verified: 0, unverified: 0, reasons: {} };
  if (couponsOk) ({ priced, validation } = applyCouponPrices({ store, date, marketSnos: [...qualified], observations: learned.observations }));
  else log('⚠️ [4910] 쿠폰가 갱신 생략 — 마지막 쿠폰가 유지');
  // The digest shows a coupon price next to each alert; drops are a short list, so read them back one by one.
  for (const d of diff.drops) d.couponPrice = couponsOk ? store.getGoods(d.row.sno)?.coupon_price ?? null : null;

  const durationMs = Date.now() - started;
  store.recordScanRun({
    date,
    brandCounts,
    complete: brandCounts.every((b) => b.complete),
    changed: diff.priceChanged,
    added: diff.added.length,
    dropped: diff.dropped.length,
    durationMs,
    couponsOk,
  });
  const { observations, ...couponSummary } = learned;
  return {
    date, brandCounts, diff, sellers: { seen: marketSnos.length, qualified: qualified.size, checked },
    coupons: { ...couponSummary, priced, validation }, outOfScope, durationMs,
  };
}

const failDetail = (err) => `${err.status ?? err.name}: ${err.message}`;

// One liked-list item is enough to prove the member token is accepted; the detail never includes the token.
async function probeMemberLogin(client, memberToken) {
  try {
    await client.listLikedGoods({ memberToken, limit: 1 });
    const exp = tokenExpiry(memberToken);
    const detail = exp ? `liked page ok, exp in ${Math.floor((exp.getTime() - Date.now()) / 86_400_000)}d` : 'liked page ok, no exp';
    return { name: '4910 member login', ok: true, detail };
  } catch (err) {
    return { name: '4910 member login', ok: false, detail: failDetail(err) };
  }
}

// The wallet answers: only the coupon count goes out, never coupon names (or the token).
async function probeMemberCoupons(client, memberToken) {
  try {
    const coupons = await client.getMyCoupons({ memberToken });
    return { name: '4910 member coupons', ok: true, detail: `${coupons.length} coupons, ${coupons.filter((c) => c.usable).length} usable` };
  } catch (err) {
    return { name: '4910 member coupons', ok: false, detail: failDetail(err) };
  }
}

// Runs one anonymous check; a failure is reported, never thrown, so the next check still runs.
async function probeCheck(name, fn) {
  try {
    return { name, ...(await fn()) };
  } catch (err) {
    return { name, ok: false, detail: failDetail(err) };
  }
}

const PROBE_MARKET_SNO = 56293;
const PROBE_GOODS_SNO = 57821918;

// One listing's best coupon for the member, through the same anonymous detail → optionSno path the daily run uses.
// The detail says only whether a coupon applies and its amount: no coupon name, never the token.
async function probeMemberBestCoupon(client, memberToken) {
  const { optionSno } = await client.getGoodsDetail(PROBE_GOODS_SNO);
  if (optionSno == null) return { ok: false, detail: `goods ${PROBE_GOODS_SNO}: no option` };
  const best = await client.getBestCoupon(optionSno, { memberToken });
  return { ok: true, detail: best ? `coupon applies (discount ${best.discount})` : 'no coupon' };
}

/**
 * Read-only: can this machine get an anonymous token, one Uniqlo listing page, one brand ranking page and one
 * seller profile, and (given a member token) is that token still accepted by the liked list, the coupon wallet and
 * best-coupon?
 * Never prints either token.
 */
export async function probe4910({ client, memberToken = null }) {
  const checks = [];
  let tokenOk = false;
  try {
    const token = await client.getToken();
    tokenOk = typeof token === 'string' && token.length > 0;
    checks.push({ name: '4910 anonymous token', ok: tokenOk, detail: `${token?.length ?? 0} chars` });
  } catch (err) {
    checks.push({ name: '4910 anonymous token', ok: false, detail: failDetail(err) });
  }

  const anonymous = [
    ['4910 uniqlo listing', async () => {
      const { totalCount } = await client.listBrandGoods({ brandSno: BRANDS_4910[0].sno, limit: 1 });
      return { ok: totalCount > 0, detail: `total_count=${totalCount}` };
    }],
    ['4910 brand ranking', async () => {
      const { brands } = await client.listTopBrands({ limit: 1 });
      return { ok: brands.length > 0, detail: brands.length ? `top brand sno=${brands[0].sno}` : 'empty ranking' };
    }],
    ['4910 seller', async () => {
      const m = await client.getMarket(PROBE_MARKET_SNO);
      return { ok: m.satisfaction != null, detail: `market ${PROBE_MARKET_SNO}: satisfaction=${m.satisfaction}, reviews=${m.reviewsCount}` };
    }],
  ];
  for (const [name, fn] of anonymous) {
    checks.push(tokenOk ? await probeCheck(name, fn) : { name, ok: false, detail: 'skipped (no token)' });
  }

  if (memberToken) {
    checks.push(await probeMemberLogin(client, memberToken));
    checks.push(await probeMemberCoupons(client, memberToken));
    checks.push(await probeCheck('4910 member best coupon', () => probeMemberBestCoupon(client, memberToken)));
  }
  return checks;
}
