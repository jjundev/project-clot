// Daily Musinsa wide run: scan the top-level categories concurrently and apply each category's listings; then, once the
// coupon registry is built (backfill_done), enumerate new coupon numbers, classify the pending ones with member calls,
// sample goods with member calls while walking the usable coupons' goods lists, and price every ACTIVE goods from those
// lists plus the fresh direct checks.
import { CATEGORIES_MUSINSA, DEPTH_PAGES, scanCategory } from './client.js';
import {
  createMemberChecker, applyCouponPrices, sampleAccuracy, CLASSIFY_CAP, SAMPLE_PER_DAY, BACKFILL_CLASSIFY_CAP,
} from './coupons.js';
import {
  enumerateNumbers, recheckEmpties, probeNeighbors, classifyPending, BACKFILL_FROM, NEIGHBOR_CAP,
} from './registry.js';
import { walkCouponLists } from './walk.js';
import { mapConcurrent, clientPool } from '../pool.js';

// Keeps a degraded (slow, not dead) site from running the Actions job into its timeout; categories not finished by
// then count as incomplete, so their listings take no misses.
export const BUDGET_MS_MUSINSA = 20 * 60_000;
// The whole run, from its start: past it the sample and the list walks start nothing new, so the coupon prices,
// scan_runs and the Release push still happen inside the job timeout.
export const RUN_BUDGET_MS_MUSINSA = 35 * 60_000;
// From the run's start: the number enumeration (and the empty-number recheck) end here, the classification here.
export const ENUM_BUDGET_MS = 12 * 60_000;
export const CLASSIFY_BUDGET_MS = 15 * 60_000;

// The one-time backfill, from its start: the whole run, of which the number enumeration may take the first 130 minutes
// (the Actions job's limit is 180).
export const BACKFILL_BUDGET_MS = 160 * 60_000;
export const BACKFILL_ENUM_BUDGET_MS = 130 * 60_000;
// The enumeration cursor is saved about every this many numbers.
export const CURSOR_EVERY = 1000;

const NOT_READY_LINE = '⚠️ [무신사] 쿠폰 등록부 미완성 — backfill 필요';

async function scanOne(client, cat, maxPages, deadline, now) {
  try {
    return await scanCategory(client, cat, { maxPages, deadline, now });
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

// Runs one phase; one that throws keeps its fallback metrics with stop 'error' and lets the run go on.
const phaseRunner = (log) => async (label, fallback, fn) => {
  try {
    return await fn();
  } catch (err) {
    // Status only: an error message could carry a request detail.
    log(`⚠️ [무신사] ${label} 실패 (${err?.status ?? err?.name ?? 'error'})`);
    return { ...fallback, stop: 'error' };
  }
};

const sumWalks = (a, b) => ({
  walked: a.walked + b.walked,
  failed: a.failed + b.failed,
  suspectEmpty: a.suspectEmpty + b.suspectEmpty,
  calls: a.calls + b.calls,
  stop: a.stop ?? b.stop,
});

/**
 * The registry part of a ready run, steps 2-5 of the daily order. Each phase is caught on its own: a phase that throws
 * keeps its zero metrics with stop 'error' and the run goes on. Returns the registry metrics (the `registry` result
 * field and scan_runs.coupon_metrics_json, `sample` still null) and what the accuracy check needs: the sample's member
 * results, the registry states before the sample, and the sample phase's stop.
 */
async function runRegistry({ withClient, store, date, checker, started, runDeadline, now, log }) {
  const phase = phaseRunner(log);
  const enumDeadline = started + ENUM_BUDGET_MS;

  const enumerated = await phase('번호 순회', { probed: 0, hits: 0, newCoupons: 0, highest: null }, async () => {
    // A ready registry has a frontier; without one, carry on from the highest number known (or the backfill start).
    const frontier = store.getMeta('frontier') ?? store.maxCouponNo() ?? BACKFILL_FROM - 1;
    const r = await enumerateNumbers({
      withClient, store, date, from: Number(frontier) + 1, mustReach: store.maxCouponNo(), deadline: enumDeadline, now,
    });
    return { probed: r.probed, hits: r.hits, newCoupons: r.newCoupons, highest: r.highest, stop: r.stop };
  });
  const recheck = await phase('빈 번호 재조회', { probed: 0, newPositive: 0 }, () => (
    recheckEmpties({ withClient, store, date, deadline: enumDeadline, now })
  ));

  const classified = await phase('판별', { calls: 0, usable: 0, other: 0, outOfScope: 0, pending: 0, neighborCenters: [], checks: [], added: [] }, () => (
    classifyPending({ store, checker, date, cap: CLASSIFY_CAP, deadline: started + CLASSIFY_BUDGET_MS })
  ));
  const { neighborCenters, checks: classifyChecks, added: classifyAdded, ...classify } = classified;

  // The accuracy baseline: the registry as classification left it, before the sample can add to it.
  const before = store.couponStates();

  const floorMeta = store.getMeta('enum_floor');
  const floor = floorMeta == null ? null : Number(floorMeta);
  const sampleResults = [];
  const sampleChecks = [];
  const sampleAdded = [];
  const sampleFound = new Set(); // added or revived by a sample result: USABLE from today on
  const walkFallback = { walked: 0, failed: 0, suspectEmpty: 0, calls: 0 };
  let walkedToday = new Set();
  const [sampled, walk1] = await Promise.all([
    phase('표본 조회', {}, async () => {
      await checker.check(store.pickSample(SAMPLE_PER_DAY, date), {
        deadline: runDeadline,
        onResult: (goods, coupons) => {
          store.putGoodsCoupons(goods.goods_no, date, coupons, goods);
          const { added, revived } = store.upsertMemberCoupons(date, coupons);
          for (const no of added) sampleAdded.push(no);
          for (const no of [...added, ...revived]) sampleFound.add(no);
          sampleResults.push({ goods, coupons });
          sampleChecks.push({ goods_no: goods.goods_no, couponNos: coupons.map((c) => Number(c.id)) });
        },
      });
      return {};
    }),
    phase('목록 순회', walkFallback, async () => {
      const couponNos = store.usableCoupons(date).map((c) => c.coupon_no);
      walkedToday = new Set(couponNos);
      const r = await walkCouponLists({ withClient, store, date, couponNos, deadline: runDeadline, now });
      return { walked: r.walked, failed: r.failed, suspectEmpty: r.suspectEmpty, calls: r.calls, stop: r.stop };
    }),
  ]);

  // Coupons the sample made USABLE that the walk above did not have: walked now. Not after a stop (a 429 ends the walk).
  let walk = walk1;
  if (walk1.stop == null) {
    const walk2 = await phase('목록 순회', walkFallback, async () => {
      const usable = new Set(store.usableCoupons(date).map((c) => c.coupon_no));
      const couponNos = [...sampleFound].filter((no) => !walkedToday.has(no) && usable.has(no)).sort((a, b) => a - b);
      if (couponNos.length === 0) return { ...walkFallback, stop: null };
      const r = await walkCouponLists({ withClient, store, date, couponNos, deadline: runDeadline, now });
      return { walked: r.walked, failed: r.failed, suspectEmpty: r.suspectEmpty, calls: r.calls, stop: r.stop };
    });
    walk = sumWalks(walk1, walk2);
  }

  const centers = [...neighborCenters, ...(floor == null ? [] : sampleAdded.filter((no) => no < floor))];
  const neighbors = await phase('이웃 조회', { probed: 0, hits: 0 }, () => (
    probeNeighbors({ withClient, store, date, centers, deadline: runDeadline, now })
  ));

  const liveness = await phase('생존 관리', { retired: [] }, () => {
    store.recordObservations(date, [...classifyChecks, ...sampleChecks]);
    return { retired: store.retireDead(date) };
  });

  return {
    registry: {
      enum: enumerated,
      recheck,
      classify,
      neighbors,
      walk,
      sample: null, // the accuracy check fills it in once the prices are set
      counts: { ...store.registryCounts(date), added: classifyAdded.length + sampleAdded.length, retired: liveness.retired.length },
    },
    sample: { results: sampleResults, before, stop: sampled.stop ?? null },
  };
}

/**
 * Order: concurrent category scan → (dry run stops here, nothing written) → per-category applyScan → when the coupon
 * registry is ready: number enumeration and the empty-number recheck (12 min) → classification of pending coupons
 * (member calls, 15 min) → the member sample alongside the walk of every usable coupon's goods list, then a walk of
 * the coupons the sample found → neighbour counts → liveness → coupon prices for every ACTIVE goods → sample accuracy →
 * registry pruning → scan_runs. A registry not yet backfilled makes no coupon call of any kind (member or anonymous)
 * and leaves every coupon price null. `partial` (--category/--depth) means no category was read in full, so none counts
 * a miss.
 */
export async function trackMusinsa({
  makeClient, store, date, categories = CATEGORIES_MUSINSA, depthPages = DEPTH_PAGES, partial = false, concurrency = 3,
  dryRun = false, sessionProvider = null, budgetMs = BUDGET_MS_MUSINSA, runBudgetMs = RUN_BUDGET_MS_MUSINSA, log = console.log,
  now = Date.now,
}) {
  const started = now();
  const deadline = started + budgetMs;
  const runDeadline = started + runBudgetMs;
  const withClient = clientPool(makeClient);
  const initial = dryRun ? false : store.isEmpty();

  const scans = await mapConcurrent(categories, concurrency, (cat) => withClient(async (client) => {
    const scan = await scanOne(client, cat, depthPages, deadline, now);
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
  if (dryRun) return { date, categoryCounts, diff: null, coupons: null, registry: null, durationMs: now() - started };

  const diffs = categories.map((cat, i) => (
    store.applyScan(date, [...scans[i].rows.values()], { cat, complete: scans[i].complete && !partial })
  ));
  const diff = mergeDiffs(diffs, initial);

  const ready = store.getMeta('backfill_done') != null;
  const checker = createMemberChecker({ withClient, sessionProvider, concurrency, log, now });
  let registry = null;
  let sample = null;
  let memberStatus = 'skipped';
  if (ready) {
    // Only a ready run reads the session: the provider verifies the cookie online, and a not-ready run calls nothing.
    memberStatus = await checker.start();
    if (memberStatus !== 'ok') log(`⚠️ [무신사] 회원 세션 ${memberStatus} — 판별·표본 생략`);
    ({ registry, sample } = await runRegistry({ withClient, store, date, checker, started, runDeadline, now, log }));
    memberStatus = checker.status;
  } else {
    log(NOT_READY_LINE);
  }

  const prices = applyCouponPrices({ store, date, ready });
  let { drops } = prices;
  let lateDrops = prices.lateDrops.length;
  // The first day priced from the registry moves many prices at once (per-goods lists → per-coupon lists): no drop
  // alerts until that day is recorded, nor on a same-day rerun of it (it logs the same switch against the day before).
  const firstPriced = ready ? store.getMeta('registry_first_priced') : null;
  const dropsSuppressed = ready && (firstPriced == null || firstPriced === date);
  if (dropsSuppressed) {
    drops = [];
    lateDrops = 0;
    if (firstPriced == null && store.couponGoodsCount() > 0) store.setMeta('registry_first_priced', date);
  }

  if (registry) {
    let accuracy;
    try {
      accuracy = sampleAccuracy({ store, date, results: sample.results, before: sample.before });
    } catch (err) {
      log(`⚠️ [무신사] 표본 정확도 실패 (${err?.name ?? 'error'})`);
      accuracy = { checked: 0, exact: 0, under: 0, over: 0, reasons: { unregistered: 0, listGap: 0, retired: 0 }, stop: 'error' };
    }
    registry.sample = sample.stop ? { ...accuracy, stop: sample.stop } : accuracy;
    const { enum: en, classify, walk } = registry;
    log(
      `[무신사] 등록부: 번호 ${en.probed}개 (새 쿠폰 ${en.newCoupons}, 최대 ${en.highest ?? '-'}) · 판별 ${classify.calls}회 (대기 ${classify.pending})`
      + ` · 목록 ${walk.walked}종 (호출 ${walk.calls}, 실패 ${walk.failed}) · 표본 ${registry.sample.checked}개 (정확 ${registry.sample.exact})`,
    );
  }
  try {
    store.pruneRegistry(date);
  } catch (err) {
    log(`⚠️ [무신사] 등록부 정리 실패 (${err?.name ?? 'error'})`);
  }

  const coupons = {
    memberStatus,
    checked: checker.calls,
    failed: checker.failed,
    priced: prices.priced,
    withCoupon: prices.withCoupon,
    // The goods left without a coupon price (all of them before the registry is ready); the digest reads it until the
    // registry lines replace that line.
    stale: prices.best.size - prices.priced,
    drops,
    lateDrops,
    dropsSuppressed,
    ready,
  };
  const durationMs = now() - started;
  store.recordScanRun({
    date,
    categoryCounts,
    complete: categoryCounts.every((c) => c.complete) && !partial,
    changed: diff.priceChanged,
    added: diff.added.length,
    outOfScope: diff.outOfScope,
    durationMs,
    couponsOk: memberStatus === 'ok',
    couponChecks: checker.calls,
    couponMetrics: registry,
  });
  return { date, categoryCounts, diff, coupons, registry, durationMs };
}

/**
 * The one-time registry backfill: walks the coupon numbers from `from` (the saved enum_cursor, else BACKFILL_FROM) up
 * through the highest known coupon, then classifies the new PENDING coupons with member calls (capped). It stores no
 * empty numbers, and no sample, list walk or coupon price is made: the next daily run does those. The first run seeds
 * the registry from the coupons already stored on the goods and records enum_floor; a run cut short by its enumeration
 * deadline (or a throttle, an error) keeps enum_cursor at the next number to probe and is not done, so running it again
 * resumes there. Done (backfill_done = date, cursor cleared, both only after the classification has returned) means the
 * enumeration finished by itself, the classification did not throw, the member session is still ok and the classification
 * deadline has not passed (`stop` says which failed: the checker status or 'deadline'). The cap and single-goods failures
 * still count as done; the coupons left PENDING are classified by the daily runs. The cursor is saved at `next` as soon
 * as the enumeration ends, so a run killed during the classification resumes at the end. Without a member session the
 * classification is skipped and the backfill is not done. Afterwards the neighbours of any coupon the member calls found
 * below enum_floor are counted (their hits stay PENDING; this does not affect done).
 */
export async function backfillMusinsaCoupons({
  makeClient, store, date, sessionProvider = null, from = null, concurrency = 3, budgetMs = BACKFILL_BUDGET_MS,
  enumBudgetMs = BACKFILL_ENUM_BUDGET_MS, now = Date.now, log = console.log,
}) {
  const started = now();
  const withClient = clientPool(makeClient);
  const phase = phaseRunner(log);

  const saved = store.getMeta('enum_cursor');
  const start = Number(saved ?? from ?? BACKFILL_FROM);
  let seeded = 0;
  // Only the first run: seeding again would revive the OTHER/RETIRED rows a later run settled.
  if (store.getMeta('enum_floor') == null) {
    seeded = store.seedFromGoodsCoupons(date);
    store.setMeta('enum_floor', start);
  }

  let cursor = start; // the latest number the enumeration reported reaching
  let savedAt = start;
  const enumerated = await phase('번호 순회', { from: start, probed: 0, hits: 0, newCoupons: 0, highest: null }, async () => {
    return enumerateNumbers({
      withClient, store, date, from: start, mustReach: store.maxCouponNo(), recordEmpties: false,
      deadline: started + enumBudgetMs, now,
      onCursor: (n) => {
        cursor = n;
        if (n - savedAt >= CURSOR_EVERY) {
          store.setMeta('enum_cursor', n);
          savedAt = n;
        }
      },
    });
  });
  const { stop } = enumerated;
  const next = enumerated.next ?? cursor;
  // Saved whether or not the enumeration finished: a run killed during the classification resumes at the end and
  // re-walks almost nothing. The cursor is cleared only once the classification has returned.
  store.setMeta('enum_cursor', next);

  const checker = createMemberChecker({ withClient, sessionProvider, concurrency, log, now });
  await checker.start();
  if (checker.status !== 'ok') log(`⚠️ [무신사] 회원 세션 ${checker.status} — 판별 생략`);
  const classified = await phase('판별', { calls: 0, usable: 0, other: 0, outOfScope: 0, pending: 0 }, () => (
    classifyPending({ store, checker, date, cap: BACKFILL_CLASSIFY_CAP, deadline: started + budgetMs })
  ));
  const { neighborCenters, checks, added, stop: classifyStop, ...classify } = classified;

  // Done needs the classification to have really run: an enumeration that finished, a classification that did not throw,
  // a member session still ok (not absent, expired, throttled or failed) and the classification deadline not passed.
  // The cap and failures on single goods still count as done: the daily runs classify the rest. Otherwise the daily run
  // would price from a registry still full of PENDING coupons.
  const classifyDeadline = started + budgetMs;
  let finalStop = stop ?? classifyStop ?? null;
  if (finalStop === null && checker.status !== 'ok') finalStop = checker.status;
  if (finalStop === null && now() >= classifyDeadline) finalStop = 'deadline';
  const done = finalStop === null;
  if (done) {
    store.setMeta('backfill_done', date);
    store.setMeta('enum_cursor', null);
  }

  // Neighbours of the coupons the member calls found below enum_floor: their centres are not stored anywhere, so no later
  // run would probe them. Hits stay PENDING for the daily classification; this does not affect `done`.
  const neighbors = await phase('이웃 조회', { probed: 0, hits: 0 }, () => (
    probeNeighbors({ withClient, store, date, centers: neighborCenters, cap: NEIGHBOR_CAP, deadline: classifyDeadline, now })
  ));

  log(
    `[무신사] 전환: 번호 ${start}~${next} (${enumerated.probed}개, 쿠폰 ${enumerated.hits}종) · 시드 ${seeded}`
    + ` · 판별 ${classify.calls}회 (대기 ${classify.pending}) · ${done ? '완료' : `중단 (${finalStop})`}`,
  );
  return {
    date, from: start, next, probed: enumerated.probed, hits: enumerated.hits, seeded, classify,
    neighbors: { probed: neighbors.probed, hits: neighbors.hits }, done,
    memberStatus: checker.status, stop: finalStop,
  };
}
