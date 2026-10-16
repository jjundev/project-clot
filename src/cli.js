#!/usr/bin/env node

import { DAILY_GOODS_TARGET } from './musinsaWide/partitions.js';
import { resumeMusinsaPricing } from './musinsaWide/recover.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { syncLikedItemsFromMusinsa } from './sync.js';
import { collectPricesForActiveItems, collectAuthenticatedPrices, fetchProductPriceInfo, prewarmMusinsaSession } from './collector.js';
import { fetchAuthenticatedPriceInfo } from './myprice.js';
import { makeSessionProvider, keepSessionAlive, readSessionMeta, updateSessionMeta, DEFAULT_SESSION_PATH } from './session.js';
import { notifyPriceDropsAndRestocks, sendMacNotification, formatHotDealsSummary, sendTelegramMessage, notifySessionWarning, notifySessionLost, notifyExpiryProbe } from './notifier.js';
import {
  discoverCategoryGoods,
  parseAuthLimit,
  selectDiscoveryAuthTargets,
  summarizeMyPriceGap,
  partialScanReasons,
  DISCOVERY_DROP_AFTER_MISSES,
} from './discovery.js';
import { setupEnvironment, getExtendedPath } from './env.js';
import { generateDashboardHtml } from './visualizer.js';
import { classifyCategory } from './classifier.js';
import { probeBrowserBridge, getMacPowerState } from './power.js';
import { runAudit, formatAuditTerminal } from './audit.js';
import { skipDailyRun, formatSkipTerminal } from './skip.js';
import { createClient } from './site4910/client.js';
import { Store4910, default4910DbPath } from './site4910/store.js';
import { PINNED_BRANDS_4910 } from './site4910/brands.js';
import { pullDb, pushDb } from './site4910/release.js';
import { track4910 } from './site4910/track.js';
import { format4910Digest } from './site4910/digest.js';
import { syncLiked4910, readAblyToken } from './site4910/liked.js';
import { createMusinsaClient, CATEGORIES_MUSINSA, DEPTH_PAGES } from './musinsaWide/client.js';
import { MusinsaWideStore, defaultMusinsaWideDbPath } from './musinsaWide/store.js';
import { pullDb as pullDbMusinsa, pushDb as pushDbMusinsa } from './musinsaWide/release.js';
import { trackMusinsa, backfillMusinsaCoupons } from './musinsaWide/track.js';
import { formatMusinsaWideDigest, formatBackfillDigest } from './musinsaWide/digest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const PLIST_NAME = 'com.musinsa.price-tracker.plist';
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library/LaunchAgents');
const PLIST_TARGET = path.join(LAUNCH_AGENTS_DIR, PLIST_NAME);

export function parseArgs(rawArgs = process.argv.slice(2)) {
  const args = Array.isArray(rawArgs) ? rawArgs : [];
  const command = args[0] || 'help';
  const flags = {};
  const positional = [];
  const BOOLEAN_FLAGS = new Set(['force', 'with-discovery', 'no-open', 'help', 'skip-opencli', 'assume-awake', 'json', 'skip-4910', 'dry-run', 'allow-fresh', 'init', 'backfill']);

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (a.includes('=')) {
        const parts = a.slice(2).split('=');
        flags[parts[0]] = parts.slice(1).join('=');
      } else {
        const key = a.slice(2);
        if (!BOOLEAN_FLAGS.has(key) && i + 1 < args.length && !args[i + 1].startsWith('--')) {
          flags[key] = args[++i];
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }

  return { command, flags, positional };
}


export function parseConcurrency(val, defaultVal = 3) {
  if (typeof val === 'boolean' || val === undefined || val === null || val === '') {
    return defaultVal;
  }
  const parsed = Number(val);
  if (!Number.isFinite(parsed) || isNaN(parsed)) {
    return defaultVal;
  }
  // Clamp strictly between 1 and 5 for rate limit safety
  return Math.max(1, Math.min(Math.floor(parsed), 5));
}

/**
 * Current and lowest price of the same kind: real with real, estimate with estimate,
 * so a real lowest is never shown next to an estimated current price.
 */
export function pickDisplayPrices(latest, item = {}) {
  // lowest_price_date is shared and, once a real lowest exists, dated to it (db.updateLowestEstimatedPrice).
  const hasRealLowest = item.lowest_my_price != null;
  const date = item.lowest_price_date ?? null;
  if (latest?.my_price) {
    return { current: latest.my_price, lowest: item.lowest_my_price ?? latest.my_price, lowestDate: hasRealLowest ? date : null };
  }
  if (latest?.estimated_my_price) {
    return { current: latest.estimated_my_price, lowest: item.lowest_estimated_price ?? null, lowestDate: hasRealLowest ? null : date };
  }
  if (latest?.sale_price) {
    return { current: latest.sale_price, lowest: item.lowest_sale_price || null, lowestDate: hasRealLowest ? null : date };
  }
  // No price log yet: nothing to pair with, keep the old fallback chain.
  return {
    current: null,
    lowest: item.lowest_my_price || item.lowest_estimated_price || item.lowest_sale_price || null,
    lowestDate: date,
  };
}

export function exportDataForGit({ dbInstance = db, dataDir = DATA_DIR } = {}) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const items = dbInstance.getAllItems();
  const summary = {
    updated_at: new Date().toISOString(),
    total_items: items.length,
    active_items: items.filter((it) => it.status === 'ACTIVE').length,
    soldout_items: items.filter((it) => it.status === 'SOLDOUT').length,
    unliked_items: items.filter((it) => it.status === 'UNLIKED').length,
    dropped_items: items.filter((it) => it.status === 'DROPPED').length,
    items: items.map((it) => {
      const latest = dbInstance.getLatestPrice(it.goods_no);
      const { current, lowest, lowestDate } = pickDisplayPrices(latest, it);
      const tag = it.source === 'discovery' ? '[탐색]' : '[VIP]';
      const cleanName = (it.goods_name || '').replace(/^\[(VIP|탐색)\]\s*/, '');
      return {
        goods_no: it.goods_no,
        goods_name: `${tag} ${cleanName}`,
        brand_name: it.brand_name,
        source: it.source,
        status: it.status,
        url: it.url,
        current_price: current,
        lowest_price: lowest,
        lowest_price_date: lowestDate,
        is_sold_out: Boolean(latest?.is_sold_out),
        last_checked: it.last_checked_at,
      };
    }),
  };

  const jsonPath = path.join(dataDir, 'latest_prices.json');
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), 'utf-8');
  return jsonPath;
}


function tryGitAutoCommit() {
  try {
    const isGit = fs.existsSync(path.join(ROOT_DIR, '.git'));
    if (!isGit) return;

    exportDataForGit();
    try {
      db.checkpoint(); // otherwise today's rows can sit in the ignored -wal file and miss the commit
    } catch (err) {
      console.warn(`⚠️ Warning: WAL checkpoint failed; the committed prices.db may lag (${err.message})`);
    }
    const today = new Date().toISOString().split('T')[0];
    execSync('git add data/', { cwd: ROOT_DIR, stdio: 'ignore' });
    
    // Check if there are staged changes
    const status = execSync('git status --porcelain data/', { cwd: ROOT_DIR, encoding: 'utf-8' });
    if (status.trim()) {
      execSync(`git commit -m "chore(tracker): update daily prices [${today}]"`, {
        cwd: ROOT_DIR,
        stdio: 'ignore',
      });
      // Push to GitHub remote origin main
      try {
        execSync('git push origin main', { cwd: ROOT_DIR, stdio: 'ignore' });
        console.log(`🚀 Git pushed changes to remote repository for ${today}`);
      } catch (pushErr) {
        // Non-fatal
      }
      console.log(`📌 Git auto-commit created for ${today}`);
    }
  } catch (err) {
    // Non-fatal
  }
}

export async function handleDiscover(
  flags = {},
  dbInstance = db,
  {
    discoverFn = discoverCategoryGoods,
    sessionProvider = null,
    authFetchFn = fetchAuthenticatedPriceInfo,
    authDelayMs = 700,
    authLimit = parseAuthLimit(flags['auth-limit']),
    dataDir = DATA_DIR,
    today = new Date().toISOString().split('T')[0],
  } = {}
) {
  const limit = (typeof flags.limit === 'string' || typeof flags.limit === 'number') ? Number(flags.limit) : 100;
  const minLikes = (typeof flags['min-likes'] === 'string' || typeof flags['min-likes'] === 'number') ? Number(flags['min-likes']) : 1000;
  const years = (typeof flags.years === 'string' || typeof flags.years === 'number') ? Number(flags.years) : 2;
  const categoryRaw = typeof flags.category === 'string' ? flags.category : '001,002,003,103,004';
  const categoryAliases = { '007': '103', '008': '004' };
  const categories = categoryRaw
    .split(',')
    .map((c) => c.trim())
    .map((c) => categoryAliases[c] || c)
    .filter(Boolean);

  console.log(`\n========================================`);
  console.log(`🔍 [Project-Clot] Discovering Category Goods`);
  console.log(`   Categories: ${categories.join(', ')}`);
  console.log(`   Limit per category: ${limit} (Min likes: ${minLikes.toLocaleString()})`);
  console.log(`========================================\n`);

  // 1. Scan every category first so the auth stage can prioritize across the whole catalog.
  const allDiscovered = [];
  const toRecord = []; // discovery-owned goods, one entry per goodsNo
  const seen = new Set();
  const categoryStats = [];
  let newlyIngestedCount = 0;

  for (const cat of categories) {
    try {
      console.log(`📂 Scanning category [${cat}]...`);
      let degraded = false;
      const items = await discoverFn({ categoryCode: cat, limit, minLikes, years, onDegraded: () => { degraded = true; } });
      console.log(`   ✓ Found ${items.length} items matching criteria in category [${cat}].`);
      categoryStats.push({ cat, ok: !degraded, count: items.length, reason: degraded ? '좋아요 조회 실패' : undefined });

      for (const item of items) {
        allDiscovered.push(item);
        if (seen.has(item.goodsNo)) continue;
        seen.add(item.goodsNo);
        const existing = dbInstance.getItem(item.goodsNo);
        if (!existing) newlyIngestedCount++;
        // Do not overwrite price_logs for VIP items during discovery scan
        if (existing && existing.source !== 'discovery') continue;
        toRecord.push({ item, existing, cat });
      }
    } catch (err) {
      categoryStats.push({ cat, ok: false, count: 0, reason: '스캔 실패' });
      console.error(`❌ Failed scanning category ${cat}:`, err.message);
    }
  }

  // 2. Authenticated real prices for a rotating, capped subset. Anything missing stays estimate-only.
  let authMap = new Map();
  if (sessionProvider && authLimit > 0 && toRecord.length > 0) {
    try {
      const lastDates = dbInstance.getLastMyPriceDates(toRecord.map((e) => e.item.goodsNo));
      const { goodsNos, eligible } = selectDiscoveryAuthTargets(toRecord.map((e) => e.item), lastDates, authLimit);
      authMap = await collectAuthenticatedPrices({ goodsNos, sessionProvider, authFetchFn, authDelayMs });
      const priced = [...authMap.values()].filter((a) => a && !a.discontinued && a.myPrice).length;
      console.log(
        `🔐 [Discovery Auth] ${priced}/${goodsNos.length} priced (cap ${authLimit}, ${eligible - goodsNos.length} deferred to later runs).`
      );
    } catch (err) {
      console.warn(`⚠️ [Discovery Auth] Skipped: ${err.message}`);
      authMap = new Map();
    }
  }
  const realPriceOf = (goodsNo) => {
    const a = authMap.get(goodsNo);
    return a && !a.discontinued && a.myPrice ? a.myPrice : null;
  };

  // 3. Record. Real prices only compare with real prices; the listing estimate keeps its own series.
  const gapPairs = [];
  let myPriceDrops = 0;
  let revivedCount = 0;
  for (const { item, existing, cat } of toRecord) {
    const myPrice = realPriceOf(item.goodsNo);
    item.myPrice = myPrice;

    dbInstance.upsertItem({
      goods_no: item.goodsNo,
      goods_name: item.goodsName,
      brand_name: item.brandName,
      url: item.url,
      image_url: item.imageUrl,
      source: existing ? existing.source : 'discovery',
      status: item.isSoldOut ? 'SOLDOUT' : 'ACTIVE',
      category: classifyCategory(item.goodsName, item.brandName, cat),
    });

    // upsertItem keeps an existing row's status, so align known discovery goods with the listing here.
    const listedStatus = item.isSoldOut ? 'SOLDOUT' : 'ACTIVE';
    if (existing && existing.status !== listedStatus && ['ACTIVE', 'SOLDOUT', 'DROPPED'].includes(existing.status)) {
      dbInstance.updateItemStatus(item.goodsNo, listedStatus);
      if (existing.status === 'DROPPED') revivedCount++;
    }

    if (myPrice) {
      // Most discovery rows are estimate-only (capped rotation), so skip back to the last real price.
      const baseline = dbInstance.getLatestMyPriceBefore(item.goodsNo, today);
      if (baseline?.my_price && myPrice < baseline.my_price) myPriceDrops++;
      if (item.estimatedMyPrice) gapPairs.push({ myPrice, estimatedMyPrice: item.estimatedMyPrice });
    }

    dbInstance.recordPriceLog({
      goods_no: item.goodsNo,
      date: today,
      normal_price: item.normalPrice,
      sale_price: item.salePrice,
      coupon_price: item.couponPrice,
      sale_rate:
        item.normalPrice && item.salePrice && item.normalPrice > item.salePrice
          ? Math.round(((item.normalPrice - item.salePrice) / item.normalPrice) * 100)
          : 0,
      my_price: myPrice,
      estimated_my_price: item.estimatedMyPrice,
      coupon_name:
        item.couponPrice && item.salePrice && item.couponPrice < item.salePrice
          ? '쿠폰 적용가'
          : null,
      coupon_discount:
        item.couponPrice && item.salePrice && item.couponPrice < item.salePrice
          ? item.salePrice - item.couponPrice
          : 0,
      is_sold_out: item.isSoldOut ? 1 : 0,
    });

    // Real lowest first: the estimated update below then keeps the real lowest's date.
    if (myPrice && (!existing?.lowest_my_price || myPrice < existing.lowest_my_price)) {
      dbInstance.updateLowestPrice(item.goodsNo, myPrice, existing?.lowest_sale_price ?? null, today);
    }
    if (
      !existing ||
      !existing.lowest_estimated_price ||
      (item.estimatedMyPrice && item.estimatedMyPrice < existing.lowest_estimated_price)
    ) {
      dbInstance.updateLowestEstimatedPrice(item.goodsNo, item.estimatedMyPrice, today);
    }
  }

  // 4. Cleanup. Seen goods restart their count on any scan; only a complete scan counts misses.
  const seenGoodsNos = [...seen];
  dbInstance.markDiscoverySeen(seenGoodsNos);
  const partialReasons = partialScanReasons(flags, categoryStats, limit);
  if (partialReasons.length === 0) {
    const { dropped } = dbInstance.markDiscoveryUnseen(seenGoodsNos, DISCOVERY_DROP_AFTER_MISSES);
    console.log(`🧹 [Discovery] ${DISCOVERY_DROP_AFTER_MISSES}회 연속 미노출 ${dropped}개 → DROPPED, 재등장 ${revivedCount}개 복귀`);
  } else {
    const revivedNote = revivedCount > 0 ? ` (재등장 ${revivedCount}개 복귀)` : '';
    console.log(`🧹 [Discovery] 부분 스캔이라 정리를 건너뜀 — ${partialReasons.join(', ')}${revivedNote}`);
  }

  if (gapPairs.length > 0) {
    const gap = summarizeMyPriceGap(gapPairs);
    console.log(
      `📐 [Discovery Auth] myPrice vs estimate: n=${gap.n}, median ${gap.medianDiff.toLocaleString()}원, myPrice<estimate ${gap.belowEstimate}`
    );
  }
  if (authMap.size > 0) {
    console.log(`📉 [Discovery] myPrice drops vs last myPrice: ${myPriceDrops}`);
  }

  // Summary statistics
  let totalDiscountRate = 0;
  let discountCount = 0;
  let minPrice = Infinity;
  let maxPrice = 0;

  for (const it of allDiscovered) {
    const effPrice = it.estimatedMyPrice || it.couponPrice || it.salePrice;
    if (effPrice) {
      if (effPrice < minPrice) minPrice = effPrice;
      if (effPrice > maxPrice) maxPrice = effPrice;
    }
    const norm = it.normalPrice;
    if (norm && effPrice && norm > effPrice) {
      const rate = Math.round(((norm - effPrice) / norm) * 100);
      totalDiscountRate += rate;
      discountCount++;
    }
  }

  const avgDiscount = discountCount > 0 ? Math.round(totalDiscountRate / discountCount) : 0;
  const priceRangeStr =
    minPrice !== Infinity ? `${minPrice.toLocaleString()}원 ~ ${maxPrice.toLocaleString()}원` : '-';

  console.log(`\n========================================`);
  console.log(`✨ [Project-Clot] Discovery Summary`);
  console.log(`========================================`);
  console.log(`  • Categories: ${categories.join(', ')}`);
  console.log(`  • Total Discovered: ${allDiscovered.length} items`);
  console.log(`  • Newly Ingested: ${newlyIngestedCount} items`);
  console.log(`  • Average Discount: ${avgDiscount}%`);
  console.log(`  • Estimated Price Range: ${priceRangeStr}`);
  console.log(`========================================\n`);

  exportDataForGit({ dbInstance, dataDir });
  return allDiscovered;
}

/**
 * Decides what the `daily` command should do given today's existing run (if any) and
 * whether the Chrome/OpenCLI browser bridge is currently usable.
 *
 * Modes recorded in daily_runs.mode:
 *   - 'full'     : Authenticated prices collected (HTTPS or OpenCLI). Done for the day. A deferred
 *                  run is recorded as 'full' when HTTPS synced the likes and priced every VIP item.
 *   - 'deferred' : Mac was asleep/DarkWake, OpenCLI skipped on purpose (cheap run, direct parser).
 *                  Re-run automatically ("upgrade") as soon as the bridge becomes usable.
 *   - 'degraded' : OpenCLI was attempted while awake but failed. Not retried automatically
 *                  (the user already got a session warning) — avoids hammering all day.
 *
 * @returns {{ action: 'run'|'skip', mode: 'full'|'deferred', upgrade: boolean, reason: string }}
 */
export function decideDailyRun({ existingRun = null, bridgeUsable = true, force = false } = {}) {
  const mode = bridgeUsable ? 'full' : 'deferred';
  if (force) {
    return { action: 'run', mode, upgrade: false, reason: '--force' };
  }
  if (!existingRun) {
    return { action: 'run', mode, upgrade: false, reason: 'first run of the day' };
  }
  const prevMode = existingRun.mode || 'full';
  if (prevMode === 'deferred' && bridgeUsable) {
    return {
      action: 'run',
      mode: 'full',
      upgrade: true,
      reason: 'earlier run was deferred (Mac asleep); browser bridge is now available',
    };
  }
  if (prevMode === 'deferred') {
    return { action: 'skip', mode: prevMode, upgrade: false, reason: 'deferred run already recorded; Mac still not fully awake' };
  }
  return { action: 'skip', mode: prevMode, upgrade: false, reason: `already collected today (mode: ${prevMode})` };
}

function formatPowerState(power) {
  const lid = power.lidClosed === null ? '?' : power.lidClosed ? 'closed' : 'open';
  const wake = power.lastWake || '?';
  const display = power.displayOn === null ? '?' : power.displayOn ? 'on' : 'off';
  return `lid=${lid} wake=${wake} display=${display}`;
}

/** Real runs probe an expired Musinsa cookie once (see session.js runExpiryProbe). Never throws. */
export function sessionProbeOptions({ getVipItems = () => db.getActiveVipItems(), notify = notifyExpiryProbe } = {}) {
  let goodsNo = null;
  try {
    goodsNo = getVipItems()[0]?.goods_no ?? null;
  } catch {
    goodsNo = null; // the probe then just skips its product-page step
  }
  return { goodsNo, notify };
}

/**
 * Session keeper for the 30-minute "already collected" ticks. Never throws: a keeper
 * problem must not turn a quiet skip tick into a failed LaunchAgent run.
 */
export async function sessionKeeperSuffix({
  power,
  today,
  keep = keepSessionAlive,
  notify = notifySessionLost,
  sessionPath = DEFAULT_SESSION_PATH,
  probe = null,
} = {}) {
  if (!power?.bridgeUsable) return '';
  try {
    const result = await keep({ bridgeUsable: true, path: sessionPath, probe });
    if (result.status === 'lost' && readSessionMeta(sessionPath).lastWarnedOn !== today) {
      updateSessionMeta({ lastWarnedOn: today }, sessionPath);
      try {
        await notify();
      } catch (err) {
        console.warn(`[Session Keeper Notice] Notification failed: ${err.message}`);
      }
    }
    const age = typeof result.ageHours === 'number' ? ` age=${result.ageHours}h` : '';
    return ` session=${result.status}${age}`;
  } catch (err) {
    console.warn(`[Session Keeper Notice] ${err.message}`);
    return ' session=error';
  }
}

// --brand: none → null (track4910 resolves the top brands itself), uniqlo|gu → that pinned brand, digits → that sno.
function selectBrands4910(brand) {
  if (brand === undefined) return { brands: null };
  const pinned = new Map([['uniqlo', PINNED_BRANDS_4910[0]], ['gu', PINNED_BRANDS_4910[1]]]).get(brand);
  if (pinned) return { brands: [pinned] };
  if (typeof brand === 'string' && /^\d+$/.test(brand)) return { brands: [{ sno: Number(brand), name: `brand ${brand}` }] };
  return { error: `unknown brand '${brand}' (use a brand sno | uniqlo | gu)` };
}

/**
 * Scans the top 4910.kr brands (plus Uniqlo and GU) into data/4910.db, records member prices of the liked items,
 * and sends one digest. Run by `track-4910` (the 4910 workflow), not by `daily`.
 * Never throws: the scan and the liked sync fail independently; only a successful scan sends the digest.
 */
export async function run4910Step({
  flags = {},
  today,
  openStore = () => new Store4910(),
  dbExists = () => fs.existsSync(default4910DbPath()),
  makeClient = () => createClient(),
  trackFn = track4910,
  syncLikedFn = syncLiked4910,
  readToken = readAblyToken,
  notify = sendTelegramMessage,
  log = console.log,
} = {}) {
  if (flags['skip-4910']) return { ran: false, ok: true };

  const { brands, error: brandError } = selectBrands4910(flags.brand);
  if (brandError) {
    log(`⚠️ [4910] ${brandError}`);
    return { ran: false, ok: false, error: brandError };
  }
  const concurrency = Math.min(parseConcurrency(flags.concurrency, 3), 4);

  // Opening the store would create an empty DB, the scan would fill it with one day, and a push would then replace the
  // release history. The DB has to come from `4910-db pull` first.
  if (!flags['dry-run'] && !dbExists()) {
    const error = '4910.db 없음 — 먼저 `node src/cli.js 4910-db pull`';
    log(`⚠️ [4910] ${error}`);
    return { ran: false, ok: false, error };
  }

  // One token read serves the scan (member-price coupons) and the liked sync; a throwing read means no token.
  let memberToken = null;
  let tokenError = null;
  try {
    memberToken = readToken() || null;
  } catch (err) {
    tokenError = err;
  }

  const dryRun = Boolean(flags['dry-run']);
  let store = null;
  try {
    let result = null;
    let scanError = null;
    try {
      if (!dryRun) store = openStore();
      result = await trackFn({ makeClient, store, date: today, brands, concurrency, dryRun, memberToken, log });
    } catch (err) {
      scanError = err;
      log(`⚠️ [4910] 수집 실패 (${err.message})`);
    }

    if (dryRun) {
      if (scanError) return { ran: true, ok: false, error: scanError.message };
      log(format4910Digest(result));
      return { ran: true, ok: true, result };
    }

    let liked = null;
    if (store) {
      try {
        if (tokenError) throw tokenError;
        if (!memberToken) {
          log('[4910] ABLY_JWT_TOKEN 없음 — 찜 가격 기록 건너뜀');
        } else {
          liked = await syncLikedFn({ client: makeClient(), store, date: today, memberToken, log });
          log(`💜 [4910] 찜 ${liked.liked}개 · 가격 기록 ${liked.logged}개 (${liked.memberStatus})`);
        }
      } catch (err) {
        // Surfaced in the digest too, so a frozen dashboard 4910 section is not silent.
        liked = { memberStatus: 'error', liked: 0, logged: 0, drops: [] };
        log(`⚠️ [4910] 찜 가격 기록 실패 (${err.message})`);
      }
    }

    if (scanError) return { ran: true, ok: false, error: scanError.message, liked };

    const { diff } = result;
    log(
      `🇯🇵 [4910] ${result.brandCounts.map((b) => `${b.name} ${b.scanned}`).join(' / ')} 스캔 — ` +
        `가격변동 ${diff.priceChanged}, 신규 ${diff.added.length}, 종료 ${diff.dropped.length}`
    );
    await notify(format4910Digest(result, { liked }));
    return { ran: true, ok: true, result, liked };
  } catch (err) {
    log(`⚠️ [4910] 수집 실패 (${err.message})`);
    return { ran: true, ok: false, error: err.message };
  } finally {
    if (store) {
      try {
        store.checkpoint(); // otherwise today's rows can sit in the ignored -wal file
      } catch (err) {
        log(`⚠️ [4910] WAL checkpoint failed; the 4910.db pushed to the release may lag (${err.message})`);
      }
      try {
        store.close();
      } catch {}
    }
  }
}

/** `4910-db pull|push`: moves data/4910.db (or CLOT_4910_DB_PATH) to and from the data-4910 Release asset. */
export function run4910Db({ sub, allowFresh = false, dbPath = default4910DbPath(), pullFn = pullDb, pushFn = pushDb, log = console.log } = {}) {
  if (sub !== 'pull' && sub !== 'push') {
    log('Usage: node src/cli.js 4910-db pull|push [--allow-fresh]');
    return { ok: false };
  }
  try {
    const { bytes, source } = sub === 'pull' ? pullFn({ dest: dbPath }) : pushFn({ src: dbPath, allowFresh });
    log(sub === 'pull' ? `⬇️ [4910-db] pulled ${bytes.toLocaleString('en-US')} bytes into ${dbPath}` : `⬆️ [4910-db] pushed ${bytes.toLocaleString('en-US')} gzipped bytes from ${dbPath}`);
    // 4910.db.gz was missing (an upload that died after gh deleted it): today runs on the day-before DB.
    if (source === 'prev') log('⚠️ [4910-db] 4910.db.gz 없음 — 직전본 4910.db.prev.gz를 받음 (Release 확인 필요)');
    return { ok: true, bytes };
  } catch (err) {
    log(`⚠️ [4910-db] ${sub} failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Registry dates and daily budgets follow the Korean calendar, regardless of the runner timezone.
export function musinsaRunDate(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

// Either --category or --depth makes the category scan partial.
function parseMusinsaScope(flags) {
  let categories = CATEGORIES_MUSINSA;
  let depthPages = DEPTH_PAGES;
  if (flags.category !== undefined) {
    const list = typeof flags.category === 'string' ? [...new Set(flags.category.split(',').map((c) => c.trim()))] : [];
    const unknown = list.filter((c) => !CATEGORIES_MUSINSA.includes(c));
    if (!list.length || unknown.length) {
      return { error: `unknown category '${unknown.length ? unknown.join(',') : flags.category}' (use ${CATEGORIES_MUSINSA.join(',')})` };
    }
    categories = list;
  }
  if (flags.depth !== undefined) {
    const n = typeof flags.depth === 'string' && /^\d+$/.test(flags.depth) ? Number(flags.depth) : NaN;
    if (!(n >= 1 && n <= 100)) return { error: `invalid --depth '${flags.depth}' (use an integer 1-100)` };
    depthPages = n;
  }
  return { categories, depthPages, partial: flags.category !== undefined || flags.depth !== undefined };
}

/**
 * Scans the Musinsa top-level categories into data/musinsa-wide.db, checks goods coupons and sends one digest.
 * Run by `track-musinsa` (the musinsa-wide workflow), not by `daily`. Never throws; a failing track sends nothing.
 * The session provider is made for write runs only (a dry run is anonymous).
 */
export async function runMusinsaWideStep({
  flags = {},
  today,
  openStore = () => new MusinsaWideStore(),
  dbExists = () => fs.existsSync(defaultMusinsaWideDbPath()),
  makeClient = () => createMusinsaClient(),
  makeProvider = () => makeSessionProvider({ allowBridge: false }),
  trackFn = trackMusinsa,
  backfillFn = backfillMusinsaCoupons,
  resumeFn = resumeMusinsaPricing,
  notify = sendTelegramMessage,
  log = console.log,
} = {}) {
  const { categories, depthPages, partial, error: scopeError } = parseMusinsaScope(flags);
  if (scopeError) {
    log(`⚠️ [무신사] ${scopeError}`);
    return { ran: false, ok: false, error: scopeError };
  }
  const concurrency = Math.min(parseConcurrency(flags.concurrency, 3), 4);
  const dryRun = Boolean(flags['dry-run']);
  const backfill = Boolean(flags.backfill);
  const resume = Boolean(flags['resume-pricing']);
  if (resume && (partial || dryRun || backfill || flags.init || flags.from!==undefined)) {
    return { ran:false,ok:false,error:'--resume-pricing requires an existing full daily snapshot, without other scope/mode flags' };
  }

  // The one-time registry fill writes the DB and needs the member session: not a dry run, not a fresh DB.
  let from = null;
  if (backfill) {
    let backfillError = null;
    if (flags.init || dryRun) {
      backfillError = '--backfill은 --init·--dry-run과 함께 쓸 수 없음';
    } else if (flags.from !== undefined) {
      const n = typeof flags.from === 'string' && /^\d+$/.test(flags.from) ? Number(flags.from) : NaN;
      if (Number.isSafeInteger(n) && n >= 1) from = n;
      else backfillError = `invalid --from '${flags.from}' (use a positive integer)`;
    }
    if (backfillError) {
      log(`⚠️ [무신사] ${backfillError}`);
      return { ran: false, ok: false, error: backfillError };
    }
  }

  // Opening the store would create an empty DB, the scan would fill it with one day, and a push would then replace the
  // release history. The DB has to come from `musinsa-db pull` first (or be created on purpose with --init).
  if (!dryRun && !flags.init && !dbExists()) {
    const error = 'musinsa-wide.db 없음 — 먼저 `node src/cli.js musinsa-db pull`';
    log(`⚠️ [무신사] ${error}`);
    return { ran: false, ok: false, error };
  }

  let store = null;
  try {
    if (!dryRun) store = openStore();
    if (resume) {
      const result = await resumeFn({ makeClient,store,date:today,log });
      await notify(formatMusinsaWideDigest(result,{lookup:no=>store.getGoods(no)}));
      return { ran:true,ok:true,result };
    }
    const sessionProvider = dryRun ? null : makeProvider();
    if (backfill) {
      // Not done (deadline, throttle, expired session) is not a failure: the saved cursor still has to be pushed, and the
      // digest tells the operator to run it again.
      const result = await backfillFn({ makeClient, store, date: today, sessionProvider, from, concurrency, log });
      await notify(formatBackfillDigest(result));
      return { ran: true, ok: true, result };
    }
    const result = await trackFn({ makeClient, store, date: today, categories, depthPages, targetGoods: partial ? null : DAILY_GOODS_TARGET, partial, concurrency, dryRun, sessionProvider, log });
    if (dryRun) {
      log(formatMusinsaWideDigest(result));
      return { ran: true, ok: true, result };
    }
    const { diff } = result;
    log(`🛍 [무신사] ${result.categoryCounts.length}개 대분류 스캔 — 신규 ${diff.added.length}, 가격변동 ${diff.priceChanged}, 범위이탈 ${diff.outOfScope}`);
    await notify(formatMusinsaWideDigest(result, { lookup: (goodsNo) => store.getGoods(goodsNo) }));
    return { ran: true, ok: true, result };
  } catch (err) {
    log(`⚠️ [무신사] ${backfill ? '전환' : '수집'} 실패 (${err.message})`);
    return { ran: true, ok: false, error: err.message };
  } finally {
    if (store) {
      try {
        store.checkpoint(); // otherwise today's rows can sit in the ignored -wal file
      } catch (err) {
        log(`⚠️ [무신사] WAL checkpoint failed; the musinsa-wide.db pushed to the release may lag (${err.message})`);
      }
      try {
        store.close();
      } catch {}
    }
  }
}

/** `musinsa-db pull|push`: moves data/musinsa-wide.db (or CLOT_MUSINSA_WIDE_DB_PATH) to and from the data-musinsa Release asset. */
export function runMusinsaDb({ sub, allowFresh = false, dbPath = defaultMusinsaWideDbPath(), pullFn = pullDbMusinsa, pushFn = pushDbMusinsa, log = console.log } = {}) {
  if (sub !== 'pull' && sub !== 'push') {
    log('Usage: node src/cli.js musinsa-db pull|push [--allow-fresh]');
    return { ok: false };
  }
  try {
    const { bytes, source } = sub === 'pull' ? pullFn({ dest: dbPath }) : pushFn({ src: dbPath, allowFresh });
    log(sub === 'pull' ? `⬇️ [musinsa-db] pulled ${bytes.toLocaleString('en-US')} bytes into ${dbPath}` : `⬆️ [musinsa-db] pushed ${bytes.toLocaleString('en-US')} gzipped bytes from ${dbPath}`);
    // musinsa-wide.db.gz was missing (an upload that died after gh deleted it): today runs on the day-before DB.
    if (source === 'prev') log('⚠️ [musinsa-db] musinsa-wide.db.gz 없음 — 직전본 musinsa-wide.db.prev.gz를 받음 (Release 확인 필요)');
    return { ok: true, bytes };
  } catch (err) {
    log(`⚠️ [musinsa-db] ${sub} failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function handleDailyRun(flags) {
  const today = new Date().toISOString().split('T')[0];
  const force = Boolean(flags.force);

  // 0. Decide run mode from macOS power state (lid closed / DarkWake => defer OpenCLI)
  const existingRun = db.getDailyRun ? db.getDailyRun(today) : null;
  let power;
  if (flags['skip-opencli']) {
    power = { platform: process.platform, bridgeUsable: false, reason: '--skip-opencli flag', lidClosed: null, lastWake: null, displayOn: null };
  } else if (flags['assume-awake']) {
    power = { platform: process.platform, bridgeUsable: true, reason: '--assume-awake flag', lidClosed: null, lastWake: null, displayOn: null };
  } else {
    power = await probeBrowserBridge({ retryDelayMs: process.env.NODE_ENV === 'test' ? 0 : 5000 });
  }
  const decision = decideDailyRun({ existingRun, bridgeUsable: power.bridgeUsable, force });

  if (decision.action === 'skip') {
    // Catch-up ticks fire every 30 minutes; keep this to a single quiet line.
    const keeper = await sessionKeeperSuffix({ power, today, probe: sessionProbeOptions() });
    console.log(`⏭ [Daily Lock] ${today} ${decision.reason}. (${formatPowerState(power)})${keeper}`);
    return;
  }

  const deferred = decision.mode === 'deferred';
  // One provider for likes sync and prices: a dead cookie is probed/renewed once and absorbed rotations carry over.
  // Cached cookie works while asleep; only fetch a fresh one when the browser bridge is usable.
  const sessionProvider = makeSessionProvider({ allowBridge: !deferred, probe: sessionProbeOptions() });

  console.log(`\n========================================`);
  console.log(`🚀 [Project-Clot] Daily Run: ${today}${deferred ? ' (deferred mode)' : decision.upgrade ? ' (upgrade run)' : ''}`);
  console.log(`========================================`);
  console.log(`🔋 Power state: ${formatPowerState(power)} — ${power.reason}`);
  if (deferred) {
    console.log(
      `⏸ [Deferred Mode] Browser bridge unavailable. Skipping OpenCLI; likes sync and VIP prices use the cached HTTPS session only.\n   Upgrades on the next awake check unless HTTPS covered both.`
    );
  } else if (decision.upgrade) {
    console.log(`🔁 [Upgrade Run] Morning run was deferred; re-collecting with the authenticated Chrome session.`);
  }

  // 1. Sync liked items: HTTPS first; OpenCLI fallback only when the browser bridge is usable
  let likesSynced = false;
  try {
    const syncRes = await syncLikedItemsFromMusinsa({
      sessionProvider,
      allowOpenCli: !deferred,
      prewarmFn: deferred ? null : prewarmMusinsaSession,
    });
    likesSynced = true;
    const promotedCount = syncRes.promotedItems?.length || 0;
    console.log(
      `📊 Sync Summary (${syncRes.source}): +${syncRes.newItems.length} new, ${syncRes.reactivatedItems.length} reactivated, ${promotedCount} promoted, ${syncRes.unlikedItems.length} unliked, ${syncRes.unchangedCount} unchanged.`
    );
  } catch (err) {
    console.warn(`⚠️ Warning: Liked items sync failed, proceeding with existing items. (${err.message})`);
    if (err.message.includes('로그인이 필요합니다') || err.message.includes('AUTH_REQUIRED')) {
      await notifySessionWarning({ reason: '무신사 좋아요 목록 동기화 인증 실패 (로그인 만료)' });
    }
  }

  // 2. Collect prices for VIP active items
  const concurrency = parseConcurrency(flags.concurrency, 3);
  console.log(`\n🔍 Fetching latest prices & discounts (concurrency: ${concurrency})...`);
  const results = await collectPricesForActiveItems({
    source: 'like',
    concurrency,
    prewarmFn: deferred ? null : prewarmMusinsaSession,
    skipOpenCli: deferred,
    sessionProvider,
    likesSynced,
    enableSelfHealing: !deferred,
    onSessionWarning: notifySessionWarning,
    onProgress: ({ current, total, item, priceInfo }) => {
      const displayPrice = priceInfo.isSoldOut
        ? '품절'
        : `${(priceInfo.myPrice || priceInfo.salePrice || 0).toLocaleString()}원`;
      process.stdout.write(
        `\r  [${current}/${total}] ${(item.brand_name || '-').slice(0, 15)} - ${displayPrice}`.padEnd(65)
      );
    },
  });
  console.log('\n');

  console.log(`✅ Collection complete in ${(results.durationMs / 1000).toFixed(1)}s.`);
  console.log(`  • Mode: ${results.mode}${results.mode !== 'full' ? ' (public/estimated prices)' : ' (authenticated my-prices)'} — HTTPS auth: ${results.authPriced}`);
  console.log(`  • Success: ${results.success} / Failed: ${results.failed}`);
  console.log(`  • Price Drops: ${results.priceDropped.length}`);
  console.log(`  • Restocks: ${results.restocked.length}`);

  // 3. Dispatch notifications if price drop or restock detected
  await notifyPriceDropsAndRestocks(results);

  // Discovery mode if flagged
  if (flags['with-discovery']) {
    console.log(`\n🌐 [Discovery Mode] Running catalog discovery...`);
    try {
      // Shares the daily provider: one refresh budget, and deferred runs stay bridge-free.
      const discovered = await handleDiscover(flags, db, { sessionProvider });
      if (discovered && discovered.length > 0) {
        const hotDealsSummary = formatHotDealsSummary(discovered);
        if (hotDealsSummary) {
          await sendTelegramMessage(hotDealsSummary);
          console.log(`📢 [Discovery] Sent Top 5 hot deals summary to Telegram.`);
        }
      }
    } catch (discErr) {
      console.warn(`⚠️ Warning: Discovery failed (${discErr.message})`);
    }
  }

  // 4. Export JSON and try Git auto-commit
  exportDataForGit();
  tryGitAutoCommit();

  // 5. Refresh static dashboard in background
  try {
    generateDashboardHtml({ db, openBrowser: false });
    console.log('📊 Static dashboard refreshed (data/dashboard.html).');
  } catch (dashErr) {
    console.warn('⚠️ Warning: Dashboard regeneration failed:', dashErr.message);
  }

  console.log(`🎉 Daily run finished successfully for ${today}!\n`);
}


export async function handleWatch(
  positional,
  { dbInstance = db, fetchInfoFn = fetchProductPriceInfo, dataDir = DATA_DIR } = {}
) {
  const target = positional[0];
  if (!target) {
    console.error('Usage: clot watch <url_or_goodsNo>');
    process.exit(1);
  }

  const match = target.match(/(?:products\/|^)(\d+)/);
  const goodsNo = match ? Number(match[1]) : Number(target);

  if (!goodsNo || isNaN(goodsNo)) {
    console.error('Invalid product URL or goodsNo:', target);
    process.exit(1);
  }

  console.log(`🔍 Inspecting product ${goodsNo}...`);
  const info = await fetchInfoFn(goodsNo);
  if (info.discontinued) {
    console.error(`❌ Product ${goodsNo} does not exist or has been discontinued.`);
    process.exit(1);
  }

  // upsertItem keeps an existing row's source and status, so a discovery goods has to be claimed explicitly.
  if (dbInstance.getItem(goodsNo)?.source === 'discovery') dbInstance.claimDiscoveryItem(goodsNo, 'manual');
  dbInstance.upsertItem({
    goods_no: goodsNo,
    goods_name: info.goodsName,
    brand_name: info.brandName,
    url: info.url,
    image_url: info.imageUrl,
    source: 'manual',
    status: info.isSoldOut ? 'SOLDOUT' : 'ACTIVE',
  });

  const today = new Date().toISOString().split('T')[0];
  dbInstance.recordPriceLog({
    goods_no: goodsNo,
    date: today,
    normal_price: info.normalPrice,
    sale_price: info.salePrice,
    sale_rate: info.saleRate,
    my_price: info.myPrice,
    coupon_name: info.couponName,
    coupon_discount: info.couponDiscount,
    is_sold_out: info.isSoldOut,
  });

  exportDataForGit({ dbInstance, dataDir });
  console.log(`✅ Successfully added [${info.brandName}] ${info.goodsName} to watchlist!`);
  const displayPrice = (info.myPrice || info.salePrice)?.toLocaleString() || '-';
  console.log(`   Current price: ${displayPrice}원 (Normal: ${info.normalPrice?.toLocaleString()}원)`);
}

function handleList(flags) {
  const items = db.getAllItems();
  console.log(`\n📋 Tracked Items List (${items.length} total)\n`);
  console.log(
    'No'.padEnd(4) +
      'Status'.padEnd(10) +
      'Brand'.padEnd(16) +
      'Current Price'.padEnd(16) +
      'Lowest Price'.padEnd(16) +
      'Product Name'
  );
  console.log('-'.repeat(90));

  items.forEach((it, i) => {
    const latest = db.getLatestPrice(it.goods_no);
    const { current: activePrice, lowest: lowestPrice } = pickDisplayPrices(latest, it);
    const currStr = activePrice ? activePrice.toLocaleString() + '원' : it.status === 'SOLDOUT' ? '품절' : '-';
    const lowStr = lowestPrice ? lowestPrice.toLocaleString() + '원' : '-';
    const tag = it.source === 'discovery' ? '[탐색]' : '[VIP]';
    const cleanName = (it.goods_name || '').replace(/^\[(VIP|탐색)\]\s*/, '');
    const brand = (it.brand_name || '-').slice(0, 14);
    const name = `${tag} ${cleanName}`.slice(0, 40);
    console.log(
      String(i + 1).padEnd(4) +
        it.status.padEnd(10) +
        brand.padEnd(16) +
        currStr.padEnd(16) +
        lowStr.padEnd(16) +
        name
    );
  });
  console.log('');
}


function handleHistory(positional) {
  const target = positional[0];
  if (!target) {
    console.error('Usage: clot history <goodsNo>');
    process.exit(1);
  }
  const goodsNo = Number(target.replace(/[^0-9]/g, ''));
  const item = db.getItem(goodsNo);
  if (!item) {
    console.error(`Product ${goodsNo} not found in database.`);
    process.exit(1);
  }

  const logs = db.getPriceHistory(goodsNo, 60);
  console.log(`\n📈 Price History for [${item.brand_name}] ${item.goods_name} (goodsNo: ${goodsNo})\n`);
  console.log('Date'.padEnd(14) + 'Normal Price'.padEnd(16) + 'Sale Price'.padEnd(16) + 'My Price (Coupon)'.padEnd(20) + 'Status');
  console.log('-'.repeat(80));

  for (const l of logs) {
    const normStr = l.normal_price ? l.normal_price.toLocaleString() + '원' : '-';
    const saleStr = l.sale_price ? l.sale_price.toLocaleString() + '원' : '-';
    const myStr = l.my_price ? l.my_price.toLocaleString() + '원' : '-';
    const status = l.is_sold_out ? '품절' : '판매중';
    console.log(
      l.date.padEnd(14) +
        normStr.padEnd(16) +
        saleStr.padEnd(16) +
        myStr.padEnd(20) +
        status
    );
  }
  console.log('');
}

/**
 * Daily schedule: the primary 09:30 run plus catch-up ticks every 30 minutes until 22:00.
 * Catch-up ticks are near-free (single "Daily Lock" line) unless the morning run was
 * deferred because the Mac was asleep, in which case the first tick after the lid opens
 * upgrades the day's data to authenticated prices.
 */
export function buildDailySchedule({
  primary = { hour: 9, minute: 30 },
  catchupEveryMinutes = 30,
  catchupFromHour = 10,
  catchupUntilHour = 22,
} = {}) {
  const entries = [primary];
  for (let hour = catchupFromHour; hour < catchupUntilHour; hour++) {
    for (let minute = 0; minute < 60; minute += catchupEveryMinutes) {
      if (hour === primary.hour && minute === primary.minute) continue;
      entries.push({ hour, minute });
    }
  }
  return entries;
}

function renderCalendarIntervals(schedule) {
  return schedule
    .map(
      ({ hour, minute }) => `        <dict>
            <key>Hour</key>
            <integer>${hour}</integer>
            <key>Minute</key>
            <integer>${minute}</integer>
        </dict>`
    )
    .join('\n');
}

export const CAFFEINATE_PATH = '/usr/bin/caffeinate';
// -i: no idle sleep while the run is in progress (a DarkWake would otherwise re-sleep in
//     seconds and stretch a 5-minute run across several sleep cycles, as on 2026-09-11).
// -s: also hold off system sleep while on AC power.
// -u: declare user activity — turns the display on / promotes a DarkWake to a full wake
//     when the lid is open, which is what lets Chrome + the OpenCLI extension respond.
export const CAFFEINATE_ARGS = ['-i', '-s', '-u'];

export function generatePlistContent({
  nodePath = process.execPath,
  scriptPath = path.join(__dirname, 'cli.js'),
  rootDir = ROOT_DIR,
  logDir = path.join(ROOT_DIR, 'logs'),
  extendedPath = getExtendedPath(),
  homeDir = os.homedir(),
  schedule = buildDailySchedule(),
  caffeinatePath = CAFFEINATE_PATH,
} = {}) {
  const caffeinateArgs = caffeinatePath
    ? [`        <string>${caffeinatePath}</string>`, ...CAFFEINATE_ARGS.map((a) => `        <string>${a}</string>`)].join('\n') + '\n'
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.musinsa.price-tracker</string>
    <key>ProgramArguments</key>
    <array>
${caffeinateArgs}        <string>${nodePath}</string>
        <string>${scriptPath}</string>
        <string>daily</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${extendedPath}</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StartCalendarInterval</key>
    <array>
${renderCalendarIntervals(schedule)}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${path.join(logDir, 'daily.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(logDir, 'daily.err')}</string>
    <key>WorkingDirectory</key>
    <string>${rootDir}</string>
</dict>
</plist>`;
}

function handleInstallDaemon() {
  if (!fs.existsSync(LAUNCH_AGENTS_DIR)) {
    fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  }

  const logDir = path.join(ROOT_DIR, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const plistContent = generatePlistContent({
    nodePath: process.execPath,
    scriptPath: path.join(__dirname, 'cli.js'),
    rootDir: ROOT_DIR,
    logDir,
    extendedPath: getExtendedPath(),
    homeDir: os.homedir(),
  });

  fs.writeFileSync(PLIST_TARGET, plistContent, 'utf-8');

  try {
    execSync(`launchctl unload "${PLIST_TARGET}"`, { stdio: 'ignore' });
  } catch {}

  try {
    execSync(`launchctl load "${PLIST_TARGET}"`);
    console.log(`✅ Successfully installed & loaded macOS background daemon!`);
    console.log(`   Service: ${PLIST_NAME}`);
    console.log(`   Schedule: Daily at 09:30 AM + catch-up checks every 30 min until 22:00`);
    console.log(`   Sleep-aware: wrapped in caffeinate; defers OpenCLI while the Mac is asleep/lid closed`);
    console.log(`   Logs: ${path.join(logDir, 'daily.log')}`);
  } catch (err) {
    console.error('Failed to load launchctl:', err.message);
  }
}

function handleUninstallDaemon() {
  if (fs.existsSync(PLIST_TARGET)) {
    try {
      execSync(`launchctl unload "${PLIST_TARGET}"`, { stdio: 'ignore' });
      fs.unlinkSync(PLIST_TARGET);
      console.log('✅ Successfully uninstalled and removed background daemon.');
    } catch (err) {
      console.error('Error during uninstall:', err.message);
    }
  } else {
    console.log('No background daemon found to uninstall.');
  }
}

function handleVisualize(flags, positional) {
  const digits = positional[0] ? String(positional[0]).replace(/\D/g, '') : '';
  const targetGoodsNo = digits.length > 0 ? Number(digits) : undefined;
  const noOpen = Boolean(flags['no-open'] || flags.noOpen);

  console.log('🎨 Generating price trend dashboard...');
  const res = generateDashboardHtml({
    db,
    openBrowser: !noOpen,
    targetGoodsNo,
  });

  console.log(`✅ 대시보드가 생성되었습니다: ${res.outputPath}`);
  console.log(`   총 ${res.totalItems}개 상품 반영 완료.`);
  if (res.targetGoodsNo) {
    console.log(`   🎯 타겟 상품 번호: ${res.targetGoodsNo}`);
  }
  if (noOpen) {
    console.log('   (브라우저 열기 생략: --no-open)');
  } else {
    console.log('   🚀 기본 브라우저로 대시보드를 열었습니다.');
    console.log(`   💡 브라우저가 자동으로 뜨지 않으면 직접 열기: open ${res.outputPath}`);
  }
}

async function main() {
  const { command, flags, positional } = parseArgs();

  switch (command) {
    case 'daily':
    case 'run-daily':
      await handleDailyRun(flags);
      break;
    case 'discover':
      await handleDiscover(flags, db, {
        sessionProvider: makeSessionProvider({ allowBridge: true, probe: sessionProbeOptions() }),
      });
      break;
    case 'sync': {
      const syncRes = await syncLikedItemsFromMusinsa({
        ...flags,
        prewarmFn: prewarmMusinsaSession,
        sessionProvider: makeSessionProvider({ allowBridge: true, probe: sessionProbeOptions() }),
      });
      const promotedCount = syncRes.promotedItems?.length || 0;
      console.log(
        `📊 Sync Summary (${syncRes.source}): +${syncRes.newItems.length} new, ${syncRes.reactivatedItems.length} reactivated, ${promotedCount} promoted from discovery, ${syncRes.unlikedItems.length} unliked, ${syncRes.unchangedCount} unchanged.`
      );
      if (syncRes.newItems.length > 0) {
        console.log('🆕 Newly Added Items:');
        for (const it of syncRes.newItems) {
          console.log(`   • [${it.goodsNo}] ${it.name} (${it.brand})`);
        }
      }
      if (promotedCount > 0) {
        console.log('✨ Promoted from Discovery to VIP:');
        for (const it of syncRes.promotedItems) {
          console.log(`   • [${it.goods_no}] ${it.goods_name} (${it.brand_name})`);
        }
      }
      exportDataForGit();
      break;
    }
    case 'track':
    case 'update': {
      const singleTarget = positional[0] ? Number(positional[0].replace(/\D/g, '')) : null;
      if (singleTarget) {
        const existing = db.getItem(singleTarget);
        if (existing && existing.source === 'discovery') {
          db.promoteItemToLike(singleTarget);
          console.log(`✨ [VIP 승격] 탐색 카탈로그 상품 ${singleTarget}이(가) VIP 관심 상품으로 승격되었습니다.`);
          exportDataForGit();
          break;
        } else if (!existing) {
          console.log(`상품 ${singleTarget}을(를) 추적 목록에 추가합니다.`);
          await handleWatch([String(singleTarget)]);
          break;
        } else if (existing && existing.source !== 'discovery') {
          console.log(`ℹ️ 상품 ${singleTarget}은(는) 이미 VIP 관심 상품 목록에 등록되어 있습니다.`);
          break;
        }
      }
      // If no single target, proceed to batch price collection across active items
      const concurrency = parseConcurrency(flags.concurrency, 3);
      console.log(`🔍 Fetching latest prices (concurrency: ${concurrency})...`);
      const results = await collectPricesForActiveItems({
        concurrency,
        prewarmFn: prewarmMusinsaSession,
        sessionProvider: makeSessionProvider({ allowBridge: true, probe: sessionProbeOptions() }),
        enableSelfHealing: true,
        onSessionWarning: notifySessionWarning,
        onProgress: ({ current, total, item, priceInfo }) => {
          const displayPrice = priceInfo.isSoldOut
            ? '품절'
            : `${(priceInfo.myPrice || priceInfo.salePrice || 0).toLocaleString()}원`;
          process.stdout.write(
            `\r  [${current}/${total}] ${(item.brand_name || '-').slice(0, 15)} - ${displayPrice}`.padEnd(65)
          );
        },
      });
      console.log('\n');
      console.log(`✅ Collection complete in ${(results.durationMs / 1000).toFixed(1)}s.`);
      console.log(`  • Success: ${results.success} / Failed: ${results.failed}`);
      console.log(`  • Price Drops: ${results.priceDropped.length}`);
      console.log(`  • Restocks: ${results.restocked.length}`);
      exportDataForGit();
      break;
    }
    case 'watch':
      await handleWatch(positional);
      break;
    case 'unwatch': {
      const gNo = Number(positional[0]);
      if (gNo) {
        db.updateItemStatus(gNo, 'UNLIKED');
        console.log(`✅ Untracked item ${gNo}`);
        exportDataForGit();
      }
      break;
    }
    case 'status':
    case 'list':
      handleList(flags);
      break;
    case 'history':
      handleHistory(positional);
      break;
    case 'visualize':
    case 'dashboard':
      handleVisualize(flags, positional);
      break;
    case 'export':
      exportDataForGit();
      console.log('✅ Exported data to data/latest_prices.json');
      break;
    case 'daemon-install':
      handleInstallDaemon();
      break;
    case 'daemon-uninstall':
      handleUninstallDaemon();
      break;
    case 'power-status': {
      const power = getMacPowerState();
      const existingRun = db.getDailyRun(new Date().toISOString().split('T')[0]);
      console.log(`🔋 Power state: ${formatPowerState(power)}`);
      console.log(`   Browser bridge usable: ${power.bridgeUsable ? 'YES' : 'NO'} — ${power.reason}`);
      if (power.lastWakeAt) console.log(`   Last wake event: ${power.lastWakeAt}`);
      console.log(`   Today's run: ${existingRun ? `${existingRun.mode || 'full'} (completed ${existingRun.completed_at})` : 'none yet'}`);
      const decision = decideDailyRun({ existingRun, bridgeUsable: power.bridgeUsable });
      console.log(`   Next daily tick would: ${decision.action}${decision.action === 'run' ? ` (${decision.mode}${decision.upgrade ? ', upgrade' : ''})` : ''} — ${decision.reason}`);
      break;
    }
    case 'audit': {
      const targetDate = positional[0] || new Date().toISOString().split('T')[0];
      const auditResult = runAudit({ dateStr: targetDate, dbInstance: db, dataDir: DATA_DIR });
      if (flags.json) {
        console.log(JSON.stringify(auditResult, null, 2));
      } else {
        console.log(formatAuditTerminal(auditResult));
      }
      if (auditResult.overallVerdict === 'FAIL') {
        process.exitCode = 1;
      }
      break;
    }
    case 'track-4910': {
      const today = new Date().toISOString().split('T')[0];
      const res = await run4910Step({ flags, today });
      if (!res.ok) process.exitCode = 1;
      break;
    }
    case '4910-db': {
      const res = run4910Db({ sub: positional[0], allowFresh: Boolean(flags['allow-fresh']) });
      if (!res.ok) process.exitCode = 1;
      break;
    }
    case 'track-musinsa': {
      const today = musinsaRunDate();
      const res = await runMusinsaWideStep({ flags, today });
      if (!res.ok) process.exitCode = 1;
      break;
    }
    case 'musinsa-db': {
      const res = runMusinsaDb({ sub: positional[0], allowFresh: Boolean(flags['allow-fresh']) });
      if (!res.ok) process.exitCode = 1;
      break;
    }
    case 'skip': {
      const targetDate = positional[0] || new Date().toISOString().split('T')[0];
      const result = await skipDailyRun({
        dateStr: targetDate,
        dbInstance: db,
        dataDir: DATA_DIR,
        logDir: LOG_DIR,
      });
      console.log(formatSkipTerminal(result));
      break;
    }
    default:
      console.log(`
Project-Clot: Musinsa Automated Price Tracker & Wishlist Manager

Usage:
  node src/cli.js <command> [options]

Commands:
  daily [--force] [--concurrency=1-5] [--with-discovery] [--skip-opencli] [--assume-awake]
                         Run daily sync & price tracking (default concurrency: 3).
                         Defers OpenCLI automatically while the Mac is asleep / lid closed.
  skip [date]            Skip today's (or specified date's) price collection and stop running tasks
  audit [date] [--json]  Audit collection integrity, OpenCLI auth rate & health status
  discover [--category <codes>] [--limit <n>] [--min-likes <n>] [--auth-limit <n>]
                         Discover popular products; real prices for up to <n> of them (default 120, 0 = off)
  track-4910 [--brand <sno>|uniqlo|gu] [--concurrency=1-4] [--dry-run]
                         Scan the top 4910.kr brands into data/4910.db (--dry-run writes nothing)
  4910-db pull|push [--allow-fresh]
                         Download / upload data/4910.db as the data-4910 GitHub Release asset (gh CLI)
  track-musinsa [--category <codes>] [--depth <pages>] [--concurrency=1-4] [--dry-run] [--init] [--backfill [--from <n>]] [--resume-pricing]
                         Scan the Musinsa top-level categories into data/musinsa-wide.db (--dry-run writes nothing);
                         --backfill fills the coupon registry once (resumable, needs the DB and a member session)
  musinsa-db pull|push [--allow-fresh]
                         Download / upload data/musinsa-wide.db as the data-musinsa GitHub Release asset (gh CLI)
  sync                   Sync liked items from Musinsa account
  track [goodsNo] [--concurrency=1-5]  Track active items or promote discovery item to VIP
  watch <url/goodsNo>    Manually add a product to track
  unwatch <goodsNo>      Untrack a product
  list / status          List tracked items with current & lowest prices ([VIP] / [탐색])
  history <goodsNo>      View price history table for a specific product
  visualize [goodsNo]    Generate and launch interactive price trend dashboard
  export                 Export JSON snapshot for Git commit
  daemon-install         Install macOS launchd background scheduler (09:30 AM + 30-min catch-up)
  daemon-uninstall       Uninstall macOS background scheduler
  power-status           Show macOS power/wake state and what the next daily tick would do
`);
      break;
  }

}

const currentScript = fileURLToPath(import.meta.url);
const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : '';
let isMainModule = invokedScript === currentScript;
if (!isMainModule && invokedScript) {
  try {
    isMainModule = fs.realpathSync(invokedScript) === currentScript;
  } catch {}
}

if (isMainModule) {
  setupEnvironment();
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

