import { db } from './db.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export async function fetchProductPriceInfo(goodsNo, cookieHeader = '', retries = 3) {
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
        const waitTime = attempt * 2500;
        console.warn(`⏳ [RateLimit 429] Waiting ${waitTime / 1000}s before retrying goods ${goodsNo} (attempt ${attempt}/${retries})...`);
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
          saleRate: null,
          myPrice: null,
          isSoldOut: false,
        };
      }

      const normalPrice = detail.goodsPrice?.normalPrice ?? null;
      const salePrice = detail.goodsPrice?.finalPrice ?? normalPrice;
      const saleRate = detail.goodsPrice?.finalDiscount ?? 0;
      const isSoldOut = Boolean(detail.isSoldOut || detail.goodsSaleType === 'SOLDOUT');

      let myPrice = salePrice;
      let couponDiscount = 0;
      let couponName = '';
      let memberDiscount = 0;

      if (detail.couponDcPrice && detail.couponDcPrice < salePrice) {
        couponDiscount = salePrice - detail.couponDcPrice;
        myPrice = detail.couponDcPrice;
        couponName = '적용 가능 쿠폰';
      }

      if (detail.memberLevelPrice && detail.memberLevelPrice < myPrice) {
        memberDiscount = myPrice - detail.memberLevelPrice;
        myPrice = detail.memberLevelPrice;
      }

      return {
        goodsNo: Number(goodsNo),
        goodsName: detail.goodsNm || '',
        brandName: detail.brandInfo?.brandName || detail.brand || '',
        imageUrl: detail.thumbnailImageUrl || detail.goodsImage || '',
        url,
        normalPrice,
        salePrice,
        saleRate,
        myPrice,
        couponName,
        couponDiscount,
        memberDiscount,
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
  delayMs = 600,
  onProgress = null,
} = {}) {
  const activeItems = db.getActiveItems();
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

  for (let i = 0; i < activeItems.length; i++) {
    const item = activeItems[i];
    try {
      const priceInfo = await fetchProductPriceInfo(item.goods_no);

      if (priceInfo.discontinued) {
        db.updateItemStatus(item.goods_no, 'DISCONTINUED');
        results.discontinued.push(item);
        continue;
      }

      // Check status changes (Restock / Soldout)
      const prevPriceLog = db.getLatestPrice(item.goods_no);
      const wasSoldOut = prevPriceLog ? Boolean(prevPriceLog.is_sold_out) : item.status === 'SOLDOUT';

      if (wasSoldOut && !priceInfo.isSoldOut) {
        db.updateItemStatus(item.goods_no, 'ACTIVE');
        results.restocked.push({ item, priceInfo });
      } else if (!wasSoldOut && priceInfo.isSoldOut) {
        db.updateItemStatus(item.goods_no, 'SOLDOUT');
        results.newlySoldOut.push({ item, priceInfo });
      }

      // Update lowest price tracking
      let lowestMyPrice = item.lowest_my_price;
      let lowestSalePrice = item.lowest_sale_price;
      let isNewLowest = false;

      if (!lowestMyPrice || (priceInfo.myPrice && priceInfo.myPrice < lowestMyPrice)) {
        lowestMyPrice = priceInfo.myPrice;
        lowestSalePrice = priceInfo.salePrice;
        isNewLowest = Boolean(item.lowest_my_price); // only flag as new if had prior record
        db.updateLowestPrice(item.goods_no, lowestMyPrice, lowestSalePrice, today);
      }

      // Check for price drop compared to previous log
      if (prevPriceLog && priceInfo.myPrice && prevPriceLog.my_price) {
        if (priceInfo.myPrice < prevPriceLog.my_price) {
          const dropAmount = prevPriceLog.my_price - priceInfo.myPrice;
          const dropRate = Math.round((dropAmount / prevPriceLog.my_price) * 100);
          results.priceDropped.push({
            item,
            priceInfo,
            prevPrice: prevPriceLog.my_price,
            currentPrice: priceInfo.myPrice,
            dropAmount,
            dropRate,
            isNewLowest,
          });
        }
      }

      // Record in price_logs
      db.recordPriceLog({
        goods_no: item.goods_no,
        date: today,
        normal_price: priceInfo.normalPrice,
        sale_price: priceInfo.salePrice,
        sale_rate: priceInfo.saleRate,
        my_price: priceInfo.myPrice,
        coupon_name: priceInfo.couponName,
        coupon_discount: priceInfo.couponDiscount,
        member_discount: priceInfo.memberDiscount,
        is_sold_out: priceInfo.isSoldOut,
      });

      results.success++;
      results.items.push(priceInfo);

      if (onProgress) {
        onProgress({
          current: i + 1,
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
      console.error(`\n[Error] Failed to collect price for ${item.goods_no} (${item.goods_name}):`, err.message);
    }
  }

  const durationMs = Date.now() - startTime;
  results.durationMs = durationMs;

  db.recordDailyRun({
    date: today,
    total_tracked: results.success,
    price_dropped_count: results.priceDropped.length,
    restocked_count: results.restocked.length,
    duration_ms: durationMs,
  });

  return results;
}
