import { db } from './db.js';
import { execSync } from 'node:child_process';
import { getExecOptions } from './env.js';
import { mapConcurrent } from './pool.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

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

export async function collectPricesForActiveItems({
  concurrency = 3,
  delayMs = 250,
  onProgress = null,
  openCliTimeoutMs = 25000,
  openCliChunkSize = 2,
  dbInstance = db,
  execFn = execSync,
  fetchFn = fetchProductPriceInfo,
} = {}) {
  const activeItems = dbInstance.getActiveItems();
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
  };

  const startTime = Date.now();

  // Try batching via OpenCLI my-prices first with Circuit Breaker
  let openCliPriceMap = new Map();
  const goodsNos = activeItems.map((it) => it.goods_no);
  let consecutiveOpenCliErrors = 0;

  for (let i = 0; i < goodsNos.length; i += openCliChunkSize) {
    if (consecutiveOpenCliErrors >= 2) {
      console.warn(
        `⚡ [OpenCLI CircuitBreaker] 2 consecutive OpenCLI batch failures/timeouts. Skipping remaining ${goodsNos.length - i} items and proceeding to fast direct parser.`
      );
      break;
    }

    const chunk = goodsNos.slice(i, i + openCliChunkSize).join(',');
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
      consecutiveOpenCliErrors++;
      console.warn(`[OpenCLI Notice] Browser bridge batch error (${consecutiveOpenCliErrors}/2): ${err.message}`);
    }
  }

  let completedCount = 0;
  const orderedItems = new Array(activeItems.length);

  await mapConcurrent(activeItems, concurrency, async (item, itemIndex) => {
    try {
      let priceInfo;
      const liveData = openCliPriceMap.get(item.goods_no);

      if (liveData && liveData.myPrice) {
        priceInfo = {
          goodsNo: item.goods_no,
          goodsName: item.goods_name,
          brandName: item.brand_name,
          normalPrice: liveData.normalPrice,
          salePrice: liveData.salePrice,
          couponPrice: liveData.couponPrice,
          myPrice: liveData.myPrice,
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
      const wasSoldOut = prevPriceLog ? Boolean(prevPriceLog.is_sold_out) : item.status === 'SOLDOUT';

      if (wasSoldOut && !priceInfo.isSoldOut) {
        dbInstance.updateItemStatus(item.goods_no, 'ACTIVE');
        results.restocked.push({ item, priceInfo });
      } else if (!wasSoldOut && priceInfo.isSoldOut) {
        dbInstance.updateItemStatus(item.goods_no, 'SOLDOUT');
        results.newlySoldOut.push({ item, priceInfo });
      }

      // Update lowest price tracking: only update lowest_my_price if authentic myPrice is available
      let lowestMyPrice = item.lowest_my_price;
      let lowestSalePrice = item.lowest_sale_price;

      const hasNewLowestMyPrice = Boolean(priceInfo.myPrice && (!lowestMyPrice || priceInfo.myPrice < lowestMyPrice));
      const hasNewLowestSalePrice = Boolean(priceInfo.salePrice && (!lowestSalePrice || priceInfo.salePrice < lowestSalePrice));

      if (hasNewLowestMyPrice || hasNewLowestSalePrice) {
        if (hasNewLowestMyPrice) {
          lowestMyPrice = priceInfo.myPrice;
        }
        if (hasNewLowestSalePrice) {
          lowestSalePrice = priceInfo.salePrice;
        }
        dbInstance.updateLowestPrice(item.goods_no, lowestMyPrice, lowestSalePrice, today);
      }

      // Check for price drop: compare like-for-like
      if (prevPriceLog) {
        if (priceInfo.myPrice && prevPriceLog.my_price) {
          // Both have authentic personalized prices: compare myPrice
          if (priceInfo.myPrice < prevPriceLog.my_price) {
            const dropAmount = prevPriceLog.my_price - priceInfo.myPrice;
            const dropRate = Math.round((dropAmount / prevPriceLog.my_price) * 100);
            results.priceDropped.push({
              item,
              priceInfo,
              priceType: 'myPrice',
              prevPrice: prevPriceLog.my_price,
              currentPrice: priceInfo.myPrice,
              dropAmount,
              dropRate,
              isNewLowest: Boolean(hasNewLowestMyPrice && item.lowest_my_price),
            });
          }
        } else if (priceInfo.salePrice && prevPriceLog.sale_price) {
          // At least one snapshot lacks authentic myPrice: compare public salePrice
          if (priceInfo.salePrice < prevPriceLog.sale_price) {
            const dropAmount = prevPriceLog.sale_price - priceInfo.salePrice;
            const dropRate = Math.round((dropAmount / prevPriceLog.sale_price) * 100);
            results.priceDropped.push({
              item,
              priceInfo,
              priceType: 'salePrice',
              prevPrice: prevPriceLog.sale_price,
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
        sale_rate: priceInfo.saleRate || 0,
        my_price: priceInfo.myPrice,
        coupon_name: priceInfo.couponName,
        coupon_discount: priceInfo.couponDiscount,
        member_discount: 0,
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
  });

  return results;
}
