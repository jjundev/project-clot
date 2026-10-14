// Musinsa coupon math for the wide scan (docs/verify/musinsa-coupon-price.md). A product's coupon price is its
// sale price − the extra discount − the single best coupon (a percent coupon floors to 10 won, capped by the
// coupon's max). Each goods keeps the coupon list its own coupon call returned (createMemberChecker makes those calls),
// and applyCouponPrices prices every ACTIVE goods locally from the stored lists.
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
  start: 'useFromDate',
};

/**
 * A raw coupon as { id, name, type, percent, price, max, min, discount, until, start }. PERCENT when the rate field is a
 * number (coupon kind '%'), else when the name says "N%"; otherwise PRICE with the discount itself as the amount.
 * max: null = uncapped (the API sends 0), min defaults to 0, until/start are the date part of the expiry/first-use
 * date or null.
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
  const start = String(raw[F.start] ?? '').match(/^\d{4}-\d{2}-\d{2}/);
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
    start: start ? start[0] : null,
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

// Per-run caps on member coupon calls: the daily classify of PENDING coupons, the daily liveness sample, and the
// one-off backfill classify.
export const CLASSIFY_CAP = 200;
export const SAMPLE_PER_DAY = 200;
export const BACKFILL_CLASSIFY_CAP = 1500;
// A stored coupon list prices a goods for this many days after the check; older ones are too stale to trust.
export const COUPON_TTL_DAYS = 10;

const dayNumber = (date) => Date.parse(`${date}T00:00:00Z`) / 86400000;

/**
 * A member coupon checker shared by everything in one run that calls getUsableCoupons. `start()` reads the session once;
 * `check(goodsList, { deadline, onResult })` gives each goods its own coupon call (`concurrency` at a time, each on a
 * client of its own from `withClient`) and hands `onResult(goods, coupons)` the parsed, id-deduped list; the caller
 * does the writing. Past `deadline` no new goods start. A rejected member session is refreshed once per checker
 * (concurrent workers, and later check() calls, share that one refresh) and the goods retried; a second rejection ends
 * checking as 'expired'. HTTP 429 ends it as 'throttled' with what was checked kept. Any other failure skips just that
 * goods ('error' only when every goods attempted failed). Logs carry goods numbers and statuses only, never the cookie.
 */
export function createMemberChecker({ withClient, sessionProvider, concurrency = 3, log = console.log }) {
  let base = 'none'; // what start() found: 'ok' | 'none' | 'error'
  let cookie = null;
  let stop = null; // 'expired' | 'throttled' once checking must end
  let refresh = null; // the checker's one refresh: a promise of the new cookie (or null)
  let calls = 0;
  let failed = 0;
  let logged = false;

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

  async function start() {
    if (!sessionProvider) return base;
    try {
      cookie = await sessionProvider();
    } catch {
      log('⚠️ [무신사] 회원 세션 확인 실패 — 쿠폰 조회 생략');
      base = 'error';
      return base;
    }
    base = cookie ? 'ok' : 'none';
    return base;
  }

  async function checkOne(client, goods, onResult) {
    let renewed = false; // this goods already went through the checker's refresh: another rejection ends checking
    let rotated = false; // this goods already retried on a cookie another response rotated in
    let next = null; // the cookie to retry with, when it is not simply the current one
    for (;;) {
      if (stop) return;
      const used = next ?? cookie;
      next = null;
      let coupons;
      try {
        const raw = await client.getUsableCoupons(
          { goodsNo: goods.goods_no, brand: goods.brand, salePrice: goods.sale_price }, used, { onSetCookie: absorb },
        );
        coupons = [...new Map(raw.map(parseCoupon).map((c) => [c.id, c])).values()];
      } catch (err) {
        if (err.code === 'MEMBER_AUTH') {
          if (renewed) {
            stop ??= 'expired';
            return;
          }
          // The cookie moved on since this call started (an absorbed Set-Cookie rotated it, possibly on this very
          // 401): try the current one once before spending the checker's refresh.
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
        failed++;
        log(`⚠️ [무신사] 쿠폰 조회 실패 goods ${goods.goods_no} (HTTP ${err.status ?? '?'})`);
        return;
      }
      calls++;
      await onResult?.(goods, coupons);
      return;
    }
  }

  async function check(goodsList, { deadline = Infinity, onResult } = {}) {
    if (base !== 'ok') return;
    await mapConcurrent(goodsList, concurrency, async (goods) => {
      if (stop || Date.now() > deadline) return;
      try {
        await withClient((client) => checkOne(client, goods, onResult));
      } catch {
        failed++; // onResult or the pool broke for this goods, not the API
        log(`⚠️ [무신사] 쿠폰 저장 실패 goods ${goods.goods_no}`);
      }
    });
    if (stop && !logged) {
      logged = true;
      log(stop === 'expired' ? '⚠️ [무신사] 회원 세션 만료 — 쿠폰 조회 중단' : '⚠️ [무신사] 쿠폰 API 요청 제한(429) — 쿠폰 조회 중단');
    }
  }

  return {
    start,
    check,
    get status() {
      if (stop) return stop;
      if (base === 'ok' && calls === 0 && failed > 0) return 'error';
      return base;
    },
    get calls() { return calls; },
    get failed() { return failed; },
  };
}

/**
 * Prices every ACTIVE goods from its stored coupon list, locally (no session needed): a list checked within
 * COUPON_TTL_DAYS of `date` gives couponPriceMusinsa; a goods never checked, checked longer ago, or whose stored list
 * holds a coupon that has since expired (monthly coupons all lapse together: pricing the rest would inflate the price
 * and fake a drop at the re-check) gets null (stale) until it is re-checked. Then logs the price changes; drops are
 * biggest first.
 */
export function applyCouponPrices({ store, date }) {
  const today = dayNumber(date);
  const prices = new Map();
  let priced = 0;
  let stale = 0;
  const rows = store.getActivePriceRows();
  for (const row of rows) {
    const fresh = row.coupons != null && row.coupon_checked_date != null && today - dayNumber(row.coupon_checked_date) <= COUPON_TTL_DAYS &&
      !row.coupons.some((c) => c.until && c.until < date);
    if (!fresh) stale++;
    const price = fresh ? couponPriceMusinsa(row, row.coupons) : null;
    if (price != null) priced++;
    prices.set(row.goods_no, price);
  }
  store.setCouponPrices(prices);
  const { drops } = store.logCouponPriceChanges(
    date, rows.map((r) => ({ goods_no: r.goods_no, sale_price: r.sale_price, coupon_price: prices.get(r.goods_no) })),
  );
  return { priced, stale, drops };
}
