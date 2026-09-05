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

export function estimateMemberPrice(couponPrice, isRestrictedUsePoint = false, options = {}) {
  if (!couponPrice || typeof couponPrice !== 'number' || couponPrice <= 0) return null;
  if (isRestrictedUsePoint) return couponPrice;

  const gradeDiscountRate = options.gradeDiscountRate ?? 0.03; // Silver member 3%
  const pointRate = options.pointRate ?? 0.07; // Points 7%

  return Math.round(couponPrice * (1 - gradeDiscountRate) * (1 - pointRate));
}

export async function fetchLikeCountsBatch(goodsNos, fetchFn = fetch) {
  if (!goodsNos || goodsNos.length === 0) return new Map();

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
    throw new Error(`Failed to fetch batch like counts: HTTP ${response.status}`);
  }

  const json = await response.json();
  const items = json?.data?.contents?.items || [];
  const map = new Map();
  for (const item of items) {
    map.set(Number(item.relationId), item.count ?? 0);
  }
  return map;
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

          discovered.push({
            goodsNo: Number(item.goodsNo),
            goodsName: item.goodsName || '',
            brandName: item.brandName || item.brand || '',
            url: item.goodsLinkUrl || `https://www.musinsa.com/products/${item.goodsNo}`,
            imageUrl: item.thumbnail || item.thumbnailImageUrl || '',
            normalPrice,
            salePrice,
            couponPrice,
            estimatedMyPrice: estimateMemberPrice(couponPrice, isRestrictedUsePoint),
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
