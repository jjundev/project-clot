// Reads every USABLE coupon's goods list anonymously (REVIEW-sorted, 300 per page) and stores it as coupon_goods; the
// coupon prices are then worked out locally from these lists. No cookie is involved.
import { anonCall, ALL_CATEGORIES_PARAM, CATEGORIES_MUSINSA } from './client.js';
import { ANON_CONCURRENCY } from './registry.js';
import { mapConcurrent } from '../pool.js';

export const SMALL_COUPON_MAX = 3000; // up to this many goods in the five categories: read whole with the combined filter
export const MAX_PAGES_PER_CAT = 60;
export const WALK_EXTRA_PAGES = 1; // pages read after the one whose last goods fell below the category's review floor

/**
 * Reads one coupon's goods list. Page 1 of the five categories combined gives the total: a small coupon is read to the
 * end, a large one category by category. A category stops at hasNext false, or WALK_EXTRA_PAGES pages after the page
 * whose last goods has fewer reviews than that category's floor (no floor: after page 1), or at MAX_PAGES_PER_CAT.
 * Each page call is retried by anonCall; a 429 or an error that outlasts the retries is thrown.
 */
export async function walkCoupon(client, couponNo, floors) {
  const page = (p, category) => anonCall(() => client.getCouponGoodsPage(couponNo, { page: p, category }), { sleep: client.sleep });
  const goodsNos = new Set();
  const add = (items) => {
    for (const it of items) goodsNos.add(it.goodsNo);
  };
  let pages = 1;
  const first = await page(1, ALL_CATEGORIES_PARAM);

  if (first.totalCount <= SMALL_COUPON_MAX) {
    add(first.items);
    for (let r = first, p = 2; r.hasNext && p <= MAX_PAGES_PER_CAT; p++) {
      r = await page(p, ALL_CATEGORIES_PARAM);
      pages++;
      add(r.items);
    }
    return { goodsNos: [...goodsNos], pages, mode: 'combined' };
  }

  // Per category the list is review-sorted, so past the floor nothing more can be a goods the registry tracks.
  for (const cat of CATEGORIES_MUSINSA) {
    const floor = floors[cat];
    let extra = null; // pages still to read once the floor was crossed
    for (let p = 1; p <= MAX_PAGES_PER_CAT; p++) {
      const r = await page(p, cat);
      pages++;
      add(r.items);
      if (!r.hasNext) break;
      if (extra === null) {
        const last = r.items.at(-1);
        if (floor == null) extra = 0; // no floor known: the first page is all there is
        else if (last && last.reviewCount < floor) extra = WALK_EXTRA_PAGES;
      } else extra--;
      if (extra !== null && extra <= 0) break;
    }
  }
  return { goodsNos: [...goodsNos], pages, mode: 'per-category' };
}

/**
 * Walks the given coupons' lists (ANON_CONCURRENCY at a time) and replaces each one's coupon_goods. A coupon whose walk
 * fails, or comes back empty although a stored member check holds it (suspectEmpty), keeps yesterday's rows. The first
 * 429 ('throttled') or the deadline stops new coupons from starting; coupons not started keep yesterday's rows too.
 * `calls` counts page requests, retries included.
 */
export async function walkCouponLists({ withClient, store, date, couponNos, deadline = Infinity, concurrency = ANON_CONCURRENCY, now = Date.now }) {
  const floors = store.categoryReviewFloors();
  const result = { walked: 0, failed: 0, suspectEmpty: 0, calls: 0, stop: null, failedCoupons: [] };

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
          floors
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
  return result;
}
