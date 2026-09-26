const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export function isReleasedWithinYears(imageUrl, years = 2, now = new Date()) {
  if (!imageUrl || typeof imageUrl !== 'string') return false;
  const match = imageUrl.match(/\/images\/goods_img\/(\d{8})\//);
  if (!match) return false;

  const dateStr = match[1];
  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(4, 6), 10) - 1;
  const day = parseInt(dateStr.slice(6, 8), 10);

  const releaseDate = new Date(Date.UTC(year, month, day));
  if (isNaN(releaseDate.getTime())) return false;

  const msInYear = 365.25 * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(now.getTime() - years * msInYear);

  return releaseDate >= cutoffDate;
}

export function floor10(val) {
  return 10 * Math.floor(Number(val) / 10);
}

export function estimateMemberPrice(couponPrice, isRestrictedUsePoint = false, options = {}) {
  const price = Number(couponPrice);
  if (!price || isNaN(price) || price <= 0) return null;

  const isLimitedDc = Boolean(options.isLimitedDc);
  const gradeDiscountRate = isLimitedDc ? 0 : (options.gradeDiscountRate ?? 0.015);
  const pointRate = isRestrictedUsePoint ? 0 : (options.pointRate ?? 0.07);

  // Step 1: Grade discount (10-won truncation)
  const gradeDiscount = gradeDiscountRate > 0 ? floor10(price * gradeDiscountRate) : 0;
  const priceAfterGrade = Math.max(0, price - gradeDiscount);

  // Step 2: Point pre-discount (10-won truncation on remaining balance after grade discount)
  const pointDiscount = pointRate > 0 ? floor10(priceAfterGrade * pointRate) : 0;

  // Step 3: Final basic member price
  return Math.max(0, priceAfterGrade - pointDiscount);
}

export async function fetchLikeCountsBatch(goodsNos, fetchFn = fetch) {
  if (!goodsNos || goodsNos.length === 0) return new Map();

  try {
    const ids = goodsNos.map(String);
    const response = await fetchFn('https://like.musinsa.com/like/api/v2/liketypes/goods/counts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        Referer: 'https://www.musinsa.com/',
      },
      body: JSON.stringify({ relationIds: ids }),
    });

    if (!response.ok) {
      console.warn(`Failed to fetch batch like counts: HTTP ${response.status}`);
      return new Map();
    }

    const json = await response.json();
    const items = json?.data?.contents?.items || [];
    const map = new Map();
    for (const item of items) {
      map.set(Number(item.relationId), item.count ?? 0);
    }
    return map;
  } catch (err) {
    console.warn(`Failed to fetch batch like counts: ${err.message}`);
    return new Map();
  }
}

export async function fetchCategoryGoodsPage(categoryCode, pageUrl = null, fetchFn = fetch) {
  let targetUrl = pageUrl || `https://www.musinsa.com/categories/item/${categoryCode}?gf=A&sortCode=POPULAR`;
  if (targetUrl.startsWith('/')) {
    targetUrl = `https://api.musinsa.com${targetUrl}`;
  }

  const response = await fetchFn(targetUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Referer: 'https://www.musinsa.com/',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch category ${categoryCode}: HTTP ${response.status}`);
  }

  // If pageUrl was the PLP v2 JSON API
  if (targetUrl.includes('/api2/dp/v2/plp/goods')) {
    const json = await response.json();
    return {
      items: json?.data?.list || [],
      pagination: json?.data?.pagination || { hasNext: false },
    };
  }

  // Initial HTML page with NextData
  const html = await response.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error(`Could not find __NEXT_DATA__ on category page ${categoryCode}`);
  }

  const nextData = JSON.parse(match[1]);
  const queries = nextData.props?.pageProps?.dehydratedState?.queries || [];
  const itemsQ = queries.find(
    (q) =>
      (Array.isArray(q.queryKey) && (q.queryKey[0] === categoryCode || q.queryKey.includes(categoryCode))) ||
      (q.queryKey != null && JSON.stringify(q.queryKey).includes(String(categoryCode))) ||
      Boolean(q.state?.data?.pages?.[0]?.data?.list)
  );

  const pageData = itemsQ?.state?.data?.pages?.[0]?.data;
  return {
    items: pageData?.list || [],
    pagination: pageData?.pagination || { hasNext: false },
  };
}

export async function discoverCategoryGoods({
  categoryCode,
  limit = 100,
  minLikes = 1000,
  years = 2,
  fetchFn = fetch,
  delayMs = 300,
}) {
  const discovered = [];
  let currentUrl = null;
  let pageCount = 0;
  const maxPages = 15; // Safeguard

  while (discovered.length < limit && pageCount < maxPages) {
    pageCount++;
    const { items, pagination } = await fetchCategoryGoodsPage(categoryCode, currentUrl, fetchFn);
    if (!items || items.length === 0) break;

    // Step 1: High-speed date filtering using image CDN URL
    const recentCandidates = items.filter((item) =>
      isReleasedWithinYears(item.thumbnail || item.thumbnailImageUrl, years)
    );

    if (recentCandidates.length > 0) {
      // Step 2: Batch like count query
      const ids = recentCandidates.map((it) => it.goodsNo);
      const likesMap = await fetchLikeCountsBatch(ids, fetchFn);

      for (const item of recentCandidates) {
        const likeCount = likesMap.get(item.goodsNo) ?? 0;
        if (likeCount >= minLikes) {
          const couponPrice = item.finalPrice ?? item.couponPrice ?? item.price ?? item.normalPrice;
          const normalPrice = item.normalPrice ?? item.price ?? couponPrice;
          const salePrice = item.price ?? couponPrice;
          const isRestrictedUsePoint = Boolean(item.isRestrictedUsePoint ?? item.isRestictedUsePoint);
          const isLimitedDc = Boolean(item.isLimitedDc ?? item.isRestrictedMemberDiscount);

          discovered.push({
            goodsNo: Number(item.goodsNo),
            goodsName: item.goodsName || '',
            brandName: item.brandName || item.brand || '',
            url: item.goodsLinkUrl || `https://www.musinsa.com/products/${item.goodsNo}`,
            imageUrl: item.thumbnail || item.thumbnailImageUrl || '',
            normalPrice,
            salePrice,
            couponPrice,
            estimatedMyPrice: estimateMemberPrice(couponPrice, isRestrictedUsePoint, { isLimitedDc }),
            likeCount,
            isSoldOut: Boolean(item.isSoldOut),
            source: 'discovery',
          });

          if (discovered.length >= limit) break;
        }
      }
    }

    if (!pagination?.hasNext || !pagination?.nextPageUrl) {
      break;
    }

    currentUrl = pagination.nextPageUrl;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return discovered;
}

export const DEFAULT_DISCOVERY_AUTH_LIMIT = 120;

/** `--auth-limit` value: 0 disables the auth stage; missing, invalid, or fractional (<1) values use the default. */
export function parseAuthLimit(val, defaultVal = DEFAULT_DISCOVERY_AUTH_LIMIT) {
  if (typeof val === 'boolean' || val === undefined || val === null || val === '') return defaultVal;
  const n = Number(val);
  // Only an explicit 0 turns auth off; a fraction below 1 would floor to 0 by accident.
  if (!Number.isFinite(n) || n < 0 || (n > 0 && n < 1)) return defaultVal;
  return Math.floor(n);
}

/**
 * Picks which discovered goods get an authenticated price this run. Never-priced goods first,
 * then the ones whose last real price is oldest, so capped runs rotate through the catalog.
 */
export function selectDiscoveryAuthTargets(items = [], lastMyPriceDates = new Map(), limit = DEFAULT_DISCOVERY_AUTH_LIMIT) {
  const seen = new Set();
  const eligible = [];
  for (const it of items) {
    const goodsNo = Number(it.goodsNo);
    if (!goodsNo || it.isSoldOut || seen.has(goodsNo)) continue;
    seen.add(goodsNo);
    eligible.push(goodsNo);
  }
  eligible.sort((a, b) => {
    const da = lastMyPriceDates.get(a) ?? '';
    const db = lastMyPriceDates.get(b) ?? '';
    if (da !== db) return da < db ? -1 : 1;
    return a - b;
  });
  return { goodsNos: eligible.slice(0, Math.max(0, limit)), eligible: eligible.length };
}

/** Value-free stats of real price vs same-day listing estimate (diff = myPrice - estimate). */
export function summarizeMyPriceGap(pairs = []) {
  if (pairs.length === 0) return { n: 0, medianDiff: null, belowEstimate: 0 };
  const diffs = pairs.map((p) => p.myPrice - p.estimatedMyPrice).sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  const medianDiff = diffs.length % 2 ? diffs[mid] : Math.round((diffs[mid - 1] + diffs[mid]) / 2);
  return { n: diffs.length, medianDiff, belowEstimate: diffs.filter((d) => d < 0).length };
}

/** A discovery goods missing from this many consecutive complete scans becomes DROPPED. */
export const DISCOVERY_DROP_AFTER_MISSES = 2;
/** A category returning less than this share of `limit` means the listing page probably broke. */
export const DISCOVERY_MIN_CATEGORY_FILL = 0.5;

// Changing any of these changes what the listing covers, so "missing" can't be told apart from "out of scope".
const DISCOVERY_SCOPE_FLAGS = ['category', 'limit', 'min-likes', 'years'];

export function isDefaultDiscoveryScan(flags = {}) {
  return DISCOVERY_SCOPE_FLAGS.every((k) => flags[k] === undefined);
}

/** Only a complete scan may count misses: default scope, every category ok and at least half full. */
export function isCompleteDiscoveryScan(flags, categoryStats = [], limit) {
  if (!isDefaultDiscoveryScan(flags) || categoryStats.length === 0) return false;
  return categoryStats.every((s) => s.ok && s.count >= limit * DISCOVERY_MIN_CATEGORY_FILL);
}
