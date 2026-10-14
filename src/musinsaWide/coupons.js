// Musinsa coupon math for the wide scan (docs/verify/musinsa-coupon-price.md). A product's coupon price is its
// sale price − the extra discount − the single best coupon (a percent coupon floors to 10 won, capped by the
// coupon's max). Each goods keeps the coupon list its own coupon call returned; checkGoodsCoupons rotates those calls
// over the goods, and applyCouponPrices prices every ACTIVE goods locally from the stored lists.
import { floor10 } from '../discovery.js';
import { mapConcurrent } from '../pool.js';

// Raw coupon field names of getUsableCouponsByGoodsNo (§2). No fixed-amount field exists, so `amount` is null.
export const COUPON_FIELDS = {
  id: 'couponNo',
  name: 'couponName',
  kind: 'couponKind',
  rate: 'couponValue',
  amount: null,
  max: 'maxLimitAmount',
  min: 'lowPrice',
  discount: 'salePrice',
  until: 'useToDate',
};

/**
 * A raw coupon as { id, name, type, percent, price, max, min, discount, until }. PERCENT when the rate field is a
 * number (coupon kind '%'), else when the name says "N%"; otherwise PRICE with the discount itself as the amount.
 * max: null = uncapped (the API sends 0), min defaults to 0, until is the date part of the expiry or null.
 */
export function parseCoupon(raw) {
  const F = COUPON_FIELDS;
  const name = raw[F.name] ?? null;
  const discount = Number(raw[F.discount]) || 0;
  const rate = raw[F.kind] === '%' && raw[F.rate] != null && raw[F.rate] !== '' ? Number(raw[F.rate]) : NaN;
  const named = String(name ?? '').match(/(\d+)%/);
  let type = 'PRICE';
  let percent = null;
  let price = discount;
  if (Number.isFinite(rate)) {
    type = 'PERCENT';
    percent = rate;
    price = null;
  } else if (named) {
    type = 'PERCENT';
    percent = Number(named[1]);
    price = null;
  }
  const max = Number(raw[F.max]);
  const min = Number(raw[F.min]);
  const until = String(raw[F.until] ?? '').match(/^\d{4}-\d{2}-\d{2}/);
  return {
    id: String(raw[F.id]),
    name,
    type,
    percent,
    price,
    max: max > 0 ? max : null,
    min: min > 0 ? min : 0,
    discount,
    until: until ? until[0] : null,
  };
}

// What one coupon takes off a price P: nothing below its minimum, a percent floored to 10 won, then its cap.
export function couponDiscountMusinsa(P, c) {
  if (P < (c.min ?? 0)) return 0;
  const base = c.type === 'PERCENT' ? floor10((P * c.percent) / 100) : c.price;
  return Math.min(c.max ?? Infinity, base);
}

// The sale price less the extra discount and the single largest coupon; null when the sale price is unknown.
export function couponPriceMusinsa({ sale_price, extra_discount }, coupons) {
  if (sale_price == null) return null;
  const best = Math.max(0, ...coupons.map((c) => couponDiscountMusinsa(sale_price, c)));
  return sale_price - (extra_discount ?? 0) - best;
}

export const COUPON_CHECKS_PER_DAY = 4000;
// A stored coupon list prices a goods for this many days after the check; older ones are too stale to trust.
export const COUPON_TTL_DAYS = 10;

const dayNumber = (date) => Date.parse(`${date}T00:00:00Z`) / 86400000;

/**
 * Rotating coupon check: up to `limit` goods (store.pickCouponChecks order) each get their own coupon call and keep
 * the parsed, id-deduped list. Goods run `concurrency` at a time, each on a client of its own from `withClient`.
 * Past `deadline` no new goods start. A rejected member session is refreshed once per run (concurrent workers share
 * that one refresh) and the goods retried; a second rejection ends the run as 'expired'. HTTP 429 ends it as
 * 'throttled' with what was checked kept. Any other failure skips just that goods ('error' only when every goods
 * attempted failed). Logs carry goods numbers and statuses only, never the cookie.
 */
export async function checkGoodsCoupons({
  withClient, store, date, sessionProvider, limit = COUPON_CHECKS_PER_DAY, concurrency = 3, deadline = Infinity, log = console.log,
}) {
  const result = { memberStatus: 'none', checked: 0, failed: 0 };
  if (!sessionProvider) return result;
  let cookie;
  try {
    cookie = await sessionProvider();
  } catch {
    log('⚠️ [무신사] 회원 세션 확인 실패 — 쿠폰 조회 생략');
    return { ...result, memberStatus: 'error' };
  }
  if (!cookie) return result;
  result.memberStatus = 'ok';

  const picks = store.pickCouponChecks(limit, date);
  let stop = null; // 'expired' | 'throttled' once the run must end
  let refresh = null; // the run's one refresh: a promise of the new cookie (or null)
  const absorb = (headers) => {
    const absorbed = sessionProvider.absorb?.(headers);
    if (absorbed?.cookie) cookie = absorbed.cookie;
  };
  const renew = (failedCookie) => {
    refresh ??= Promise.resolve()
      .then(() => sessionProvider({ refresh: true, failedCookie }))
      .then((fresh) => {
        if (fresh) cookie = fresh;
        return fresh || null;
      })
      .catch(() => null);
    return refresh;
  };

  async function checkOne(client, goods) {
    let renewed = false; // this goods already went through the run's refresh: another rejection ends the run
    let rotated = false; // this goods already retried on a cookie another response rotated in
    let next = null; // the cookie to retry with, when it is not simply the current one
    for (;;) {
      if (stop) return;
      const used = next ?? cookie;
      next = null;
      try {
        const raw = await client.getUsableCoupons(
          { goodsNo: goods.goods_no, brand: goods.brand, salePrice: goods.sale_price }, used, { onSetCookie: absorb },
        );
        const coupons = [...new Map(raw.map(parseCoupon).map((c) => [c.id, c])).values()];
        store.putGoodsCoupons(goods.goods_no, date, coupons, goods);
        result.checked++;
        return;
      } catch (err) {
        if (err.code === 'MEMBER_AUTH') {
          if (renewed) {
            stop ??= 'expired';
            return;
          }
          // The cookie moved on since this call started (an absorbed Set-Cookie rotated it, possibly on this very
          // 401): try the current one once before spending the run's refresh.
          if (!rotated && used !== cookie) {
            rotated = true;
            continue;
          }
          const fresh = await renew(used);
          renewed = true;
          if (!fresh || fresh === used) {
            stop ??= 'expired';
            return;
          }
          next = fresh;
          continue;
        }
        if (err.status === 429) {
          stop ??= 'throttled';
          return;
        }
        result.failed++;
        log(`⚠️ [무신사] 쿠폰 조회 실패 goods ${goods.goods_no} (HTTP ${err.status ?? '?'})`);
        return;
      }
    }
  }

  await mapConcurrent(picks, concurrency, async (goods) => {
    if (stop || Date.now() > deadline) return;
    try {
      await withClient((client) => checkOne(client, goods));
    } catch {
      result.failed++; // the store or the pool broke for this goods, not the API
      log(`⚠️ [무신사] 쿠폰 저장 실패 goods ${goods.goods_no}`);
    }
  });

  if (stop === 'expired') log('⚠️ [무신사] 회원 세션 만료 — 쿠폰 조회 중단');
  else if (stop === 'throttled') log('⚠️ [무신사] 쿠폰 API 요청 제한(429) — 쿠폰 조회 중단');
  if (stop) result.memberStatus = stop;
  else if (result.checked === 0 && result.failed > 0) result.memberStatus = 'error';
  return result;
}

/**
 * Prices every ACTIVE goods from its stored coupon list, locally (no session needed): a list checked within
 * COUPON_TTL_DAYS of `date` gives couponPriceMusinsa over the coupons not yet expired on `date`; a goods never
 * checked or checked longer ago gets null (stale). Then logs the price changes; drops are biggest first.
 */
export function applyCouponPrices({ store, date }) {
  const today = dayNumber(date);
  const prices = new Map();
  let priced = 0;
  let stale = 0;
  const rows = store.getActivePriceRows();
  for (const row of rows) {
    const fresh = row.coupons != null && row.coupon_checked_date != null && today - dayNumber(row.coupon_checked_date) <= COUPON_TTL_DAYS;
    if (!fresh) stale++;
    const price = fresh ? couponPriceMusinsa(row, row.coupons.filter((c) => !c.until || c.until >= date)) : null;
    if (price != null) priced++;
    prices.set(row.goods_no, price);
  }
  store.setCouponPrices(prices);
  const { drops } = store.logCouponPriceChanges(
    date, rows.map((r) => ({ goods_no: r.goods_no, sale_price: r.sale_price, coupon_price: prices.get(r.goods_no) })),
  );
  return { priced, stale, drops };
}
