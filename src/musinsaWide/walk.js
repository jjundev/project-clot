// Reads every USABLE coupon's goods list anonymously (REVIEW-sorted, 300 per page) and stores it as coupon_goods; the
// coupon prices are then worked out locally from these lists. No cookie is involved.
import { anonCall, ALL_CATEGORIES_PARAM } from './client.js';
import { ANON_CONCURRENCY } from './registry.js';
import { mapConcurrent } from '../pool.js';

// A safety guard, not a successful truncation limit. The known combined scope needs far fewer pages.
export const MAX_COUPON_PAGES = 10000;

/**
 * Reads the five-category combined list to hasNext=false. totalCount can change during the walk and REVIEW order
 * is not strictly monotonic, so neither totals nor review floors establish completeness. The floors argument stays
 * for caller compatibility. Incomplete or anomalous walks throw so yesterday's mapping can be retained.
 */
export async function walkCoupon(client, couponNo, floors, { checkStop } = {}) {
  const goodsNos = new Set();
  const seenPages = new Set();
  const incomplete = (reason) => Object.assign(new Error(`Coupon walk incomplete: ${reason}`), { code: 'WALK_INCOMPLETE' });
  for (let p = 1; p <= MAX_COUPON_PAGES; p++) {
    const r = await anonCall(() => client.getCouponGoodsPage(couponNo, { page: p, category: ALL_CATEGORIES_PARAM }),
      { sleep: client.sleep, beforeAttempt: checkStop });
    if (!r.items.length && r.hasNext) throw incomplete('empty page with hasNext');
    // Compare complete ID sequences, not overlap: moving listings can legitimately repeat individual goods.
    const signature = JSON.stringify(r.items.map((it) => it.goodsNo));
    if (r.items.length && seenPages.has(signature)) throw incomplete('repeated page sequence');
    seenPages.add(signature);
    for (const it of r.items) goodsNos.add(it.goodsNo);
    if (!r.hasNext) return { goodsNos: [...goodsNos], pages: p, mode: 'combined' };
  }
  throw incomplete('page safety limit reached');
}

/**
 * Walks the given coupons' lists (ANON_CONCURRENCY at a time) and replaces each one's coupon_goods. A coupon whose walk
 * fails, or comes back empty although a stored member check holds it (suspectEmpty), keeps yesterday's rows. The first
 * 429 ('throttled') or the deadline stops new page requests, including retries; incomplete coupons keep yesterday's rows.
 * `calls` counts page requests, retries included.
 */
export async function walkCouponLists({ withClient, store, date, couponNos, deadline = Infinity, concurrency = ANON_CONCURRENCY, now = Date.now }) {
  const floors = store.categoryReviewFloors();
  const result = { requested: couponNos.length, walked: 0, failed: 0, suspectEmpty: 0, calls: 0, stop: null, failedCoupons: [] };
  const checkStop = () => {
    if (now() >= deadline) result.stop ??= 'deadline';
    if (result.stop) throw Object.assign(new Error('Coupon walk stopped'), { code: 'WALK_STOP' });
  };

  await mapConcurrent(couponNos, concurrency, async (couponNo) => {
    if (result.stop) return;
    if (now() >= deadline) {
      result.stop = 'deadline';
      return;
    }
    try {
      const { goodsNos } = await withClient((client) =>
        walkCoupon(
          { ...client, getCouponGoodsPage: (...args) => (result.calls++, client.getCouponGoodsPage(...args)) },
          couponNo,
          floors,
          { checkStop }
        )
      );
      if (goodsNos.length === 0 && store.goodsHasDirectCoupon(couponNo)) {
        result.suspectEmpty++;
        result.failed++;
        result.failedCoupons.push(couponNo);
        return;
      }
      store.replaceCouponGoods(couponNo, date, goodsNos);
      result.walked++;
    } catch (err) {
      if (err?.status === 429) result.stop ??= 'throttled';
      result.failed++;
      result.failedCoupons.push(couponNo);
    }
  });

  result.failedCoupons.sort((a, b) => a - b);
  result.remaining = result.requested - result.walked;
  result.complete = result.remaining === 0;
  return result;
}
