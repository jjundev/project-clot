// Musinsa coupon math for the wide scan (docs/verify/musinsa-coupon-price.md). A product's coupon price is its
// sale price − the extra discount − the single best coupon (a percent coupon floors to 10 won, capped by the
// coupon's max). Each goods keeps the coupon list its own coupon call returned (createMemberChecker makes those calls),
// and applyCouponPrices prices every ACTIVE goods locally from the coupon registry's goods lists plus those fresh checks.
import { floor10 } from '../discovery.js';
import { mapConcurrent } from '../pool.js';
import { COUPON_STATE } from './store.js';

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
 * does the writing. Past `deadline` (read from `now`) no new goods start. A rejected member session is refreshed once per checker
 * (concurrent workers, and later check() calls, share that one refresh) and the goods retried; a second rejection ends
 * checking as 'expired'. HTTP 429 ends it as 'throttled' with what was checked kept. Any other failure skips just that
 * goods ('error' only when every goods attempted failed). Logs carry goods numbers and statuses only, never the cookie.
 */
export function createMemberChecker({ withClient, sessionProvider, concurrency = 3, log = console.log, now = Date.now }) {
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

  async function checkOne(client, goods, onResult, reserve, deadline) {
    let renewed = false; // this goods already went through the checker's refresh: another rejection ends checking
    let rotated = false; // this goods already retried on a cookie another response rotated in
    let next = null; // the cookie to retry with, when it is not simply the current one
    for (;;) {
      if (stop || now() >= deadline || (reserve && !reserve())) return;
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
      await onResult?.(goods, coupons);
      calls++; // only after onResult resolved: a throwing onResult counts as failed, never as a call
      return;
    }
  }

  async function check(goodsList, { deadline = Infinity, onResult, reserve } = {}) {
    if (base !== 'ok') return;
    await mapConcurrent(goodsList, concurrency, async (goods) => {
      if (stop || now() > deadline) return;
      try {
        await withClient((client) => checkOne(client, goods, onResult, reserve, deadline));
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

// A registry row as the coupon math sees it. The id is the coupon number as a string, the same id parseCoupon gives a
// member-checked coupon, so a coupon on a goods' list and the same one in a direct check dedupe and compare as one.
export function registryCouponToCalc(c) {
  return { id: String(c.coupon_no), type: c.type, percent: c.percent, price: c.price, max: c.max, min: c.min, until: c.until_date };
}

// The coupon taking the most off salePrice, as { id, discount }; null when none takes anything off (or the price is unknown).
// A tie keeps the earlier coupon.
export function bestCoupon(salePrice, coupons) {
  if (salePrice == null) return null;
  let best = null;
  for (const c of coupons) {
    const discount = couponDiscountMusinsa(salePrice, c);
    if (Number.isFinite(discount) && discount > 0 && (!best || discount > best.discount)) best = { id: c.id, discount };
  }
  return best;
}

/**
 * Prices every ACTIVE goods from the coupon registry: sale price − extra discount − the single best coupon, from
 *  1. the usable, unexpired registry coupons whose goods list holds the goods and that have started (start_date NULL or
 *     ≤ date), and
 *  2. the goods' own direct member check, when made within COUPON_TTL_DAYS and for each coupon in it only while it is
 *     started and unexpired (start NULL or ≤ date, until NULL or ≥ date), and the registry has not RETIRED it. A coupon the registry never saw still counts.
 * A coupon that fails any of these is skipped on its own; the goods' other coupons still apply. A goods in no list and
 * with no direct coupon is priced sale − extra.
 * Not `ready` (the registry is still being built) or no coupon list stored yet: every price is null, nothing is
 * logged (an unknown price is not "no coupon") and there are no drops.
 * Returns the changes logged by logCouponPriceChanges, biggest drop first, with the drops whose best coupon was first
 * seen today yet started earlier moved to `lateDrops` (we found it late: it is not news of today). `best` maps every
 * ACTIVE goods to the id of its best coupon, null when none applies.
 */
export function applyCouponPrices({ store, date, ready = false }) {
  const rows = store.getActivePriceRows();
  const best = new Map();
  const prices = new Map();
  if (!ready || store.couponGoodsCount() === 0) {
    for (const row of rows) {
      best.set(row.goods_no, null);
      prices.set(row.goods_no, null);
    }
    store.setCouponPrices(prices);
    return { priced: 0, withCoupon: 0, drops: [], lateDrops: [], best };
  }

  const today = dayNumber(date);
  const calcById = new Map(store.usableCoupons(date).filter((c) => c.start_date == null || c.start_date <= date).map((c) => [c.coupon_no, registryCouponToCalc(c)]));
  const listed = store.couponsByGoods();
  const retired = new Map(); // direct-check coupon id → is it RETIRED in the registry
  const isRetired = (id) => {
    if (!retired.has(id)) retired.set(id, store.getCoupon(Number(id))?.state === COUPON_STATE.RETIRED);
    return retired.get(id);
  };
  let priced = 0;
  let withCoupon = 0;
  for (const row of rows) {
    const byId = new Map();
    for (const no of listed.get(row.goods_no) ?? []) {
      const c = calcById.get(no);
      if (c) byId.set(c.id, c);
    }
    if (row.coupons != null && row.coupon_checked_date != null && today - dayNumber(row.coupon_checked_date) <= COUPON_TTL_DAYS) {
      for (const c of row.coupons) {
        if (byId.has(c.id) || (c.until && c.until < date) || (c.start && c.start > date) || isRetired(c.id)) continue;
        byId.set(c.id, c);
      }
    }
    // A coupon whose discount is not a number (a registry row without its terms) must not poison the whole price.
    const coupons = [...byId.values()].filter((c) => row.sale_price == null || Number.isFinite(couponDiscountMusinsa(row.sale_price, c)));
    const price = couponPriceMusinsa(row, coupons);
    const top = bestCoupon(row.sale_price, coupons);
    if (price != null) priced++;
    if (top) withCoupon++;
    prices.set(row.goods_no, price);
    best.set(row.goods_no, top?.id ?? null);
  }
  store.setCouponPrices(prices);
  const logged = store.logCouponPriceChanges(
    date, rows.map((r) => ({ goods_no: r.goods_no, sale_price: r.sale_price, coupon_price: prices.get(r.goods_no) })),
  );
  const drops = [];
  const lateDrops = [];
  for (const drop of logged.drops) {
    const id = best.get(drop.goods_no);
    const c = id == null ? null : store.getCoupon(Number(id));
    (c && c.first_seen_date === date && c.start_date != null && c.start_date < date ? lateDrops : drops).push(drop);
  }
  return { priced, withCoupon, drops, lateDrops, best };
}

/**
 * How well the registry predicted a day's member-checked sample. For each { goods, coupons } (the coupons a member call
 * returned, parseCoupon results) the prediction is the biggest discount among the goods' listed coupons that were USABLE
 * in `before` (coupon_no → state, taken when classification ended), started and unexpired; the actual is the biggest
 * among the returned started, unexpired coupons. Equal is `exact`, a smaller prediction is `under` (a price too high), a bigger one is
 * `over`. An under is blamed on the state `before` held for the actual best coupon: USABLE → `listGap` (the registry
 * knew it, its goods list did not hold this goods), RETIRED → `retired`, anything else or absent → `unregistered`.
 */
export function sampleAccuracy({ store, date, results, before }) {
  const listed = store.couponsByGoods();
  const out = { checked: 0, exact: 0, under: 0, over: 0, reasons: { unregistered: 0, listGap: 0, retired: 0 } };
  for (const { goods, coupons } of results) {
    if (goods.sale_price == null) continue;
    const predicted = (listed.get(goods.goods_no) ?? []).flatMap((no) => {
      if (before.get(no) !== COUPON_STATE.USABLE) return [];
      const c = store.getCoupon(no);
      return c && (c.until_date == null || c.until_date >= date) && (c.start_date == null || c.start_date <= date) ? [registryCouponToCalc(c)] : [];
    });
    const guess = bestCoupon(goods.sale_price, predicted)?.discount ?? 0;
    const actual = bestCoupon(goods.sale_price, coupons.filter((c) => (c.until == null || c.until >= date) && (c.start == null || c.start <= date)));
    const real = actual?.discount ?? 0;
    out.checked++;
    if (guess === real) out.exact++;
    else if (guess > real) out.over++;
    else {
      out.under++;
      const state = before.get(Number(actual.id));
      if (state === COUPON_STATE.USABLE) out.reasons.listGap++;
      else if (state === COUPON_STATE.RETIRED) out.reasons.retired++;
      else out.reasons.unregistered++;
    }
  }
  return out;
}
