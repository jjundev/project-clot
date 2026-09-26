import { db } from './db.js';
import { execSync } from 'node:child_process';
import { getExecOptions } from './env.js';
import { mapConcurrent } from './pool.js';
import { estimateMemberPrice } from './discovery.js';
import { fetchAuthenticatedPriceInfo } from './myprice.js';
import { formatSessionSummary } from './session.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * Pre-warms the Chrome browser with Musinsa session in the background.
 * Triggers silent auto-refresh of login tokens and ensures OpenCLI bridge is responsive.
 * @param {object} options
 * @returns {Promise<boolean>}
 */
export async function prewarmMusinsaSession({
  execFn = execSync,
  waitMs = 3000,
  platform = process.platform,
} = {}) {
  if (platform !== 'darwin') {
    return false;
  }
  try {
    // Open in background (-g) without stealing window focus
    execFn('open -g -a "Google Chrome" "https://www.musinsa.com"', { stdio: 'ignore' });
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    return true;
  } catch (err) {
    // Non-fatal: if Chrome isn't installed or running in a headless sandbox
    console.warn(`⚠️ [Session Pre-warm Notice] Could not pre-warm Chrome: ${err.message}`);
    return false;
  }
}

export async function fetchProductPriceInfo(goodsNo, cookieHeader = '', retries = 4, backoffBaseMs = 2000) {

  const url = `https://www.musinsa.com/products/${goodsNo}`;
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    Referer: 'https://www.musinsa.com/',
  };
  if (cookieHeader) {
    headers['Cookie'] = cookieHeader;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { headers });

      if (response.status === 404) {
        return { status: 404, discontinued: true };
      }

      if (response.status === 429) {
        if (attempt === retries) {
          throw new Error(`HTTP 429 Rate Limited on goods ${goodsNo} after ${retries} attempts`);
        }
        const waitTime = Math.pow(2, attempt - 1) * backoffBaseMs + Math.floor(Math.random() * 500);
        console.warn(
          `⏳ [RateLimit 429] Waiting ${(waitTime / 1000).toFixed(1)}s before retrying goods ${goodsNo} (attempt ${attempt}/${retries})...`
        );
        await new Promise((r) => setTimeout(r, waitTime));
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} when fetching goods ${goodsNo}`);
      }

      const html = await response.text();
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);

      if (!nextDataMatch) {
        throw new Error(`Could not find __NEXT_DATA__ for goods ${goodsNo}`);
      }

      const nextData = JSON.parse(nextDataMatch[1]);
      const queries = nextData.props?.pageProps?.dehydratedState?.queries || [];
      const detailQuery = queries.find(
        (q) => q.queryKey?.[0] === 'Detail' && Number(q.queryKey?.[1]) === Number(goodsNo)
      );

      const detail = detailQuery?.state?.data?.data;
      if (!detail) {
        return {
          goodsNo: Number(goodsNo),
          goodsName: 'Unknown Product',
          brandName: '',
          normalPrice: null,
          salePrice: null,
          couponPrice: null,
          saleRate: null,
          myPrice: null,
          estimatedMyPrice: null,
          isRestrictedUsePoint: false,
          isLimitedDc: false,
          isSoldOut: false,
        };
      }

      const gp = detail.goodsPrice || {};
      const normalPrice = gp.normalPrice ?? null;
      const salePrice = gp.salePrice ?? normalPrice;
      const couponPrice = gp.couponPrice ?? gp.finalPrice ?? salePrice;
      const finalPrice = gp.finalPrice ?? couponPrice ?? salePrice;
      const finalDiscount = gp.finalDiscount ?? gp.discountRate ?? 0;
      const isSoldOut = Boolean(detail.isSoldOut || detail.goodsSaleType === 'SOLDOUT');
      const isRestrictedUsePoint = Boolean(detail.isRestrictedUsePoint ?? detail.isRestictedUsePoint);
      const isLimitedDc = Boolean(
        detail.isLimitedDc ??
        detail.goodsPrice?.isLimitedDc ??
        detail.isRestrictedMemberDiscount ??
        (detail.isGradeDiscountEligible === false)
      );
      const estimatedMyPrice = estimateMemberPrice(couponPrice, isRestrictedUsePoint, { isLimitedDc });

      let couponDiscount = 0;
      let couponName = '';
      if (salePrice && couponPrice && couponPrice < salePrice) {
        couponDiscount = salePrice - couponPrice;
        couponName = '쿠폰 적용가';
      }

      const brandName = detail.brandInfo?.brandName || detail.brand || '';

      return {
        goodsNo: Number(goodsNo),
        goodsName: detail.goodsNm || '',
        brandName,
        imageUrl: detail.thumbnailImageUrl || detail.goodsImage || '',
        url,
        normalPrice,
        salePrice,
        couponPrice,
        saleRate: finalDiscount,
        myPrice: null, // Public unauthenticated fetch cannot know member discount
        estimatedMyPrice,
        isRestrictedUsePoint,
        isLimitedDc,
        couponName,
        couponDiscount,
        isSoldOut,
        discontinued: false,
      };
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }

  throw new Error(`Failed to fetch product ${goodsNo} after ${retries} attempts`);
}

const AUTH_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Stage 1 of VIP price collection: exact myPrice over authenticated HTTPS.
 * Sequential with a delay — concurrent product-page requests get soft rate-limited
 * (HTTP 200 without __NEXT_DATA__). On SessionExpiredError the cookie is refreshed once.
 */
export async function collectAuthenticatedPrices({
  goodsNos,
  sessionProvider,
  authFetchFn = fetchAuthenticatedPriceInfo,
  authDelayMs = 700,
  into = new Map(),
}) {
  const getCookie = async (refresh) => {
    try {
      return await sessionProvider(refresh ? { refresh: true, failedCookie: cookie } : { refresh: false });
    } catch (err) {
      console.warn(`[HTTPS Auth Notice] Session provider failed: ${err.message}`);
      return null;
    }
  };

  let cookie = await getCookie(false);
  if (sessionProvider.describe) {
    console.log(`🔐 [Session] ${cookie ? 'ready' : 'unavailable'} — ${formatSessionSummary(sessionProvider.describe())}`);
  }
  if (!cookie) return into;
  // A rotated cookie seen on any product-page response is used from the next request on.
  const onSetCookie = sessionProvider.absorb
    ? (headers) => {
        const absorbed = sessionProvider.absorb(headers);
        if (absorbed?.cookie) cookie = absorbed.cookie;
      }
    : undefined;
  let refreshed = false;
  let consecutiveFailures = 0;

  for (let i = 0; i < goodsNos.length; i++) {
    const goodsNo = goodsNos[i];
    try {
      into.set(goodsNo, await authFetchFn(goodsNo, { cookie, onSetCookie }));
      consecutiveFailures = 0;
    } catch (err) {
      if (err?.name === 'SessionExpiredError') {
        if (refreshed) {
          console.warn('[HTTPS Auth Notice] Session still expired after refresh; falling back for remaining items.');
          break;
        }
        refreshed = true;
        cookie = await getCookie(true);
        if (!cookie) {
          console.warn('[HTTPS Auth Notice] Session expired and could not be refreshed; falling back for remaining items.');
          break;
        }
        i--; // retry the same item with the fresh cookie
        continue;
      }
      console.warn(`[HTTPS Auth Notice] ${goodsNo}: ${err.message}`);
      if (++consecutiveFailures >= AUTH_MAX_CONSECUTIVE_FAILURES) {
        console.warn(
          `⚡ [HTTPS Auth CircuitBreaker] ${consecutiveFailures} consecutive failures (rate limit or page change?). Leaving ${goodsNos.length - i - 1} items for fallback.`
        );
        break;
      }
    }
    if (authDelayMs > 0 && i < goodsNos.length - 1) {
      await new Promise((r) => setTimeout(r, authDelayMs));
    }
  }
  return into;
}

export async function collectPricesForActiveItems({
  concurrency = 3,
  delayMs = 250,
  onProgress = null,
  openCliTimeoutMs = 25000,
  openCliChunkSize = 2,
  dbInstance = db,
  execFn = execSync,
  fetchFn = fetchProductPriceInfo,
  prewarmFn = null,
  enableSelfHealing = false,
  onSessionWarning = null,
  items = null,
  source = null,
  skipOpenCli = false,
  sessionProvider = null,
  authFetchFn = fetchAuthenticatedPriceInfo,
  authDelayMs = 700,
  // Deferred runs only: the liked list was synced this run, so an all-HTTPS price run needs no awake upgrade.
  likesSynced = false,
} = {}) {
  let activeItems;
  if (items) {
    activeItems = items;
  } else if (source === 'discovery') {
    activeItems = dbInstance.getDiscoveredActiveItems ? dbInstance.getDiscoveredActiveItems() : [];
  } else if (source === 'like') {
    activeItems = dbInstance.getActiveVipItems ? dbInstance.getActiveVipItems() : [];
  } else {
    activeItems = dbInstance.getActiveItems();
  }

  const today = new Date().toISOString().split('T')[0];

  const results = {
    date: today,
    total: activeItems.length,
    success: 0,
    failed: 0,
    priceDropped: [],
    restocked: [],
    newlySoldOut: [],
    discontinued: [],
    items: [],
    sessionWarningTriggered: false,
    authPriced: 0,
    // 'full' = every VIP item has an authenticated price (HTTPS or OpenCLI); a deferred run counts
    // only if it also synced the liked list. 'deferred' = OpenCLI intentionally skipped (Mac asleep /
    // DarkWake) and HTTPS did not cover everything. 'degraded' = OpenCLI attempted but failed -> direct parser.
    mode: 'full',
  };

  const startTime = Date.now();

  // Try batching via OpenCLI my-prices first with Circuit Breaker (strictly VIP items)
  let openCliPriceMap = new Map();
  const vipItems = activeItems.filter((it) => it.source !== 'discovery');
  const vipGoodsNos = vipItems.map((it) => it.goods_no);
  let consecutiveOpenCliErrors = 0;

  // Stage 1: authenticated HTTPS with the cached Musinsa session (no browser needed).
  const authPriceMap = new Map();
  if (sessionProvider && vipGoodsNos.length > 0) {
    await collectAuthenticatedPrices({ goodsNos: vipGoodsNos, sessionProvider, authFetchFn, authDelayMs, into: authPriceMap });
    results.authPriced = authPriceMap.size;
    console.log(`🔐 [HTTPS Auth] ${authPriceMap.size}/${vipGoodsNos.length} VIP items priced via authenticated HTTPS.`);
  }
  // Stage 2 (OpenCLI) and Stage 3 (direct parser) only handle what Stage 1 left behind.
  const remainingVipGoodsNos = vipGoodsNos.filter((g) => !authPriceMap.has(g));

  if (skipOpenCli && vipGoodsNos.length > 0) {
    // 'full' (no awake upgrade) only when this run also synced the liked list and HTTPS priced every VIP item.
    results.mode = likesSynced && remainingVipGoodsNos.length === 0 ? 'full' : 'deferred';
    if (remainingVipGoodsNos.length > 0) {
      console.warn(
        `⏸ [OpenCLI Deferred] Browser bridge unavailable (Mac asleep/DarkWake). Skipping OpenCLI for ${remainingVipGoodsNos.length} VIP items; using fast direct parser.`
      );
    }
  }

  // Pre-warm Chrome Musinsa session in background before batching VIP items
  if (!skipOpenCli && remainingVipGoodsNos.length > 0 && prewarmFn) {
    try {
      console.log('🌅 Pre-warming Chrome Musinsa session in background...');
      await prewarmFn({ waitMs: process.env.NODE_ENV === 'test' ? 0 : 3000 });
    } catch (pwErr) {
      console.warn(`[Pre-warm Notice] Pre-warm failed: ${pwErr.message}`);
    }
  }

  for (let i = 0; skipOpenCli ? false : i < remainingVipGoodsNos.length; i += openCliChunkSize) {
    if (consecutiveOpenCliErrors >= 2) {
      console.warn(
        `⚡ [OpenCLI CircuitBreaker] 2 consecutive OpenCLI batch failures/timeouts. Skipping remaining ${remainingVipGoodsNos.length - i} items and proceeding to fast direct parser.`
      );
      results.sessionWarningTriggered = true;
      if (onSessionWarning) {
        try {
          await onSessionWarning({
            reason: 'OpenCLI 브라우저 세션 타임아웃 2회 연속 발생 (서킷 브레이커 작동)',
          });
        } catch (warnErr) {
          console.warn(`[Warning Handler Error] ${warnErr.message}`);
        }
      }
      break;
    }

    const chunk = remainingVipGoodsNos.slice(i, i + openCliChunkSize).join(',');
    try {
      const raw = execFn(
        `opencli musinsa my-prices "${chunk}" -f json`,
        getExecOptions({
          encoding: 'utf-8',
          timeout: openCliTimeoutMs,
        })
      );
      const jsonStart = raw ? raw.indexOf('[') : -1;
      if (jsonStart !== -1) {
        const list = JSON.parse(raw.slice(jsonStart));
        for (const it of list) {
          openCliPriceMap.set(Number(it.goodsNo), {
            normalPrice: Number(String(it.normalPrice).replace(/[^0-9]/g, '')) || null,
            salePrice: Number(String(it.salePrice).replace(/[^0-9]/g, '')) || null,
            couponPrice: Number(String(it.couponPrice).replace(/[^0-9]/g, '')) || null,
            myPrice: Number(String(it.myPrice).replace(/[^0-9]/g, '')) || null,
            isSoldOut: it.status === '품절',
          });
        }
        consecutiveOpenCliErrors = 0; // reset on success
      } else {
        consecutiveOpenCliErrors++;
        console.warn(`[OpenCLI Notice] Browser bridge returned non-JSON output (${consecutiveOpenCliErrors}/2).`);
      }
    } catch (err) {
      // If first failure and self-healing enabled, attempt session pre-warm and retry this chunk once
      if (enableSelfHealing && consecutiveOpenCliErrors === 0 && prewarmFn) {
        console.warn(`[OpenCLI Notice] First batch failed. Attempting self-healing session pre-warm and retry...`);
        try {
          await prewarmFn({ waitMs: process.env.NODE_ENV === 'test' ? 0 : 4000 });
          const retryRaw = execFn(
            `opencli musinsa my-prices "${chunk}" -f json`,
            getExecOptions({
              encoding: 'utf-8',
              timeout: openCliTimeoutMs,
            })
          );
          const retryJsonStart = retryRaw ? retryRaw.indexOf('[') : -1;
          if (retryJsonStart !== -1) {
            const list = JSON.parse(retryRaw.slice(retryJsonStart));
            for (const it of list) {
              openCliPriceMap.set(Number(it.goodsNo), {
                normalPrice: Number(String(it.normalPrice).replace(/[^0-9]/g, '')) || null,
                salePrice: Number(String(it.salePrice).replace(/[^0-9]/g, '')) || null,
                couponPrice: Number(String(it.couponPrice).replace(/[^0-9]/g, '')) || null,
                myPrice: Number(String(it.myPrice).replace(/[^0-9]/g, '')) || null,
                isSoldOut: it.status === '품절',
              });
            }
            consecutiveOpenCliErrors = 0;
            continue; // recovered successfully!
          }
        } catch (retryErr) {
          // Self-healing attempt failed; fall through to increment error count
        }
      }
      consecutiveOpenCliErrors++;
      console.warn(`[OpenCLI Notice] Browser bridge batch error (${consecutiveOpenCliErrors}/2): ${err.message}`);
    }
  }


  if (!skipOpenCli && vipGoodsNos.length > 0 && remainingVipGoodsNos.length === 0) {
    results.mode = 'full'; // every VIP item has an authenticated HTTPS price
  } else if (!skipOpenCli && remainingVipGoodsNos.length > 0) {
    results.mode = results.sessionWarningTriggered || openCliPriceMap.size === 0 ? 'degraded' : 'full';
  }

  let completedCount = 0;
  const orderedItems = new Array(activeItems.length);


  await mapConcurrent(activeItems, concurrency, async (item, itemIndex) => {
    try {
      let priceInfo;
      const authData = authPriceMap.get(item.goods_no);
      const liveData = openCliPriceMap.get(item.goods_no);

      if (authData) {
        priceInfo = authData;
      } else if (liveData && liveData.myPrice) {
        priceInfo = {
          goodsNo: item.goods_no,
          goodsName: item.goods_name,
          brandName: item.brand_name,
          normalPrice: liveData.normalPrice,
          salePrice: liveData.salePrice,
          couponPrice: liveData.couponPrice,
          myPrice: liveData.myPrice,
          estimatedMyPrice: liveData.couponPrice ? estimateMemberPrice(liveData.couponPrice, false) : null,
          couponName: '나의 할인가',
          couponDiscount: liveData.couponPrice && liveData.salePrice ? liveData.salePrice - liveData.couponPrice : 0,
          isSoldOut: liveData.isSoldOut,
          discontinued: false,
        };
      } else {
        priceInfo = await fetchFn(item.goods_no);
      }

      if (priceInfo.discontinued) {
        dbInstance.updateItemStatus(item.goods_no, 'DISCONTINUED');
        results.discontinued.push(item);
        completedCount++;
        if (onProgress) {
          onProgress({ current: completedCount, total: activeItems.length, item, priceInfo });
        }
        return;
      }

      if (priceInfo.goodsName) {
        dbInstance.updateItemDetails(item.goods_no, priceInfo.goodsName, priceInfo.brandName, priceInfo.imageUrl || item.image_url);
      }

      // Check status changes (Restock / Soldout)
      const prevPriceLog = dbInstance.getLatestPrice(item.goods_no);
      // Price-drop baseline: latest log *before today*, so a same-day re-run (deferred -> full
      // upgrade) compares against yesterday's snapshot instead of this morning's estimate.
      const baselinePriceLog = dbInstance.getLatestPriceBefore
        ? dbInstance.getLatestPriceBefore(item.goods_no, today)
        : prevPriceLog;
      const wasSoldOut = prevPriceLog ? Boolean(prevPriceLog.is_sold_out) : item.status === 'SOLDOUT';

      if (wasSoldOut && !priceInfo.isSoldOut) {
        dbInstance.updateItemStatus(item.goods_no, 'ACTIVE');
        results.restocked.push({ item, priceInfo });
      } else if (!wasSoldOut && priceInfo.isSoldOut) {
        dbInstance.updateItemStatus(item.goods_no, 'SOLDOUT');
        results.newlySoldOut.push({ item, priceInfo });
      }

      // Lowest price tracking for both VIP and discovery catalog items (executed BEFORE price drop check)
      let lowestMyPrice = item.lowest_my_price;
      let lowestSalePrice = item.lowest_sale_price;

      const hasNewLowestMyPrice = Boolean(priceInfo.myPrice && (!lowestMyPrice || priceInfo.myPrice < lowestMyPrice));
      const hasNewLowestSalePrice = Boolean(!priceInfo.myPrice && priceInfo.salePrice && (!lowestSalePrice || priceInfo.salePrice < lowestSalePrice));
      const hasNewLowestEstimated = Boolean(
        item.source === 'discovery' &&
        priceInfo.estimatedMyPrice &&
        (!item.lowest_estimated_price || priceInfo.estimatedMyPrice < item.lowest_estimated_price)
      );

      if (hasNewLowestMyPrice || hasNewLowestSalePrice) {
        if (hasNewLowestMyPrice) {
          lowestMyPrice = priceInfo.myPrice;
        }
        if (hasNewLowestSalePrice) {
          lowestSalePrice = priceInfo.salePrice;
        }
        dbInstance.updateLowestPrice(item.goods_no, lowestMyPrice, lowestSalePrice, today);
      }
      if (hasNewLowestEstimated && dbInstance.updateLowestEstimatedPrice) {
        dbInstance.updateLowestEstimatedPrice(item.goods_no, priceInfo.estimatedMyPrice, today);
      }

      // Check for price drop: compare like-for-like
      if (baselinePriceLog) {
        if (item.source === 'discovery') {
          // Like-for-like comparison for estimated prices
          const prevEst = baselinePriceLog.estimated_my_price;
          if (prevEst && priceInfo.estimatedMyPrice && priceInfo.estimatedMyPrice < prevEst) {
            const dropAmount = prevEst - priceInfo.estimatedMyPrice;
            const dropRate = Math.round((dropAmount / prevEst) * 100);
            results.priceDropped.push({
              item,
              priceInfo,
              priceType: 'estimated',
              prevPrice: prevEst,
              currentPrice: priceInfo.estimatedMyPrice,
              dropAmount,
              dropRate,
              isNewLowest: Boolean(hasNewLowestEstimated && item.lowest_estimated_price),
            });
          }
        } else if (priceInfo.myPrice && baselinePriceLog.my_price) {
          // Both have authentic personalized prices: compare myPrice
          if (priceInfo.myPrice < baselinePriceLog.my_price) {
            const dropAmount = baselinePriceLog.my_price - priceInfo.myPrice;
            const dropRate = Math.round((dropAmount / baselinePriceLog.my_price) * 100);
            results.priceDropped.push({
              item,
              priceInfo,
              priceType: 'myPrice',
              prevPrice: baselinePriceLog.my_price,
              currentPrice: priceInfo.myPrice,
              dropAmount,
              dropRate,
              isNewLowest: Boolean(hasNewLowestMyPrice && item.lowest_my_price),
            });
          }
        } else if (priceInfo.salePrice && baselinePriceLog.sale_price) {
          // At least one snapshot lacks authentic myPrice: compare public salePrice
          if (priceInfo.salePrice < baselinePriceLog.sale_price) {
            const dropAmount = baselinePriceLog.sale_price - priceInfo.salePrice;
            const dropRate = Math.round((dropAmount / baselinePriceLog.sale_price) * 100);
            results.priceDropped.push({
              item,
              priceInfo,
              priceType: 'salePrice',
              prevPrice: baselinePriceLog.sale_price,
              currentPrice: priceInfo.salePrice,
              dropAmount,
              dropRate,
              isNewLowest: Boolean(hasNewLowestSalePrice && item.lowest_sale_price),
            });
          }
        }
      }

      // Record in price_logs
      dbInstance.recordPriceLog({
        goods_no: item.goods_no,
        date: today,
        normal_price: priceInfo.normalPrice,
        sale_price: priceInfo.salePrice,
        coupon_price: priceInfo.couponPrice,
        sale_rate: priceInfo.saleRate || 0,
        my_price: priceInfo.myPrice,
        estimated_my_price: priceInfo.estimatedMyPrice,
        coupon_name: priceInfo.couponName,
        coupon_discount: priceInfo.couponDiscount,
        member_discount: 0,
        point_discount: 0,
        is_sold_out: priceInfo.isSoldOut,
      });

      results.success++;
      orderedItems[itemIndex] = priceInfo;

      completedCount++;
      if (onProgress) {
        onProgress({
          current: completedCount,
          total: activeItems.length,
          item,
          priceInfo,
        });
      }

      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    } catch (err) {
      results.failed++;
      completedCount++;
      console.error(`\n[Error] Failed to collect price for ${item.goods_no} (${item.goods_name}):`, err.message);
    }
  });

  // Preserve index correlation in results.items
  results.items = orderedItems.filter(Boolean);

  const durationMs = Date.now() - startTime;
  results.durationMs = durationMs;

  dbInstance.recordDailyRun({
    date: today,
    total_tracked: results.success,
    price_dropped_count: results.priceDropped.length,
    restocked_count: results.restocked.length,
    duration_ms: durationMs,
    mode: results.mode,
  });

  return results;
}
