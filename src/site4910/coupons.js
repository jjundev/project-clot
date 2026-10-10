// 4910 coupon price = list price − the best coupon that reaches the listing (docs/verify/4910-member-price.md §2–3).
// Whether a coupon reaches a seller is all-or-nothing per seller, so once a day each qualified seller's 1–2 sample
// listings are asked for their best coupon, and every ACTIVE listing is then priced locally. The member token is
// only ever passed to the client and never logged.

// A coupon in the client shape ({ type, percent, price, max, min }) or a wallet_coupons row (max null = uncapped).
export function couponDiscount(L, c) {
  if (L < c.min) return 0;
  if (c.type === 'PERCENT') return Math.min(c.max ?? Infinity, Math.floor((L * c.percent) / 100));
  return Math.min(c.max ?? Infinity, c.price);
}

// 4910 shows the price rounded up to 10 won after the single largest discount.
export function couponPrice(L, coupons) {
  const discount = Math.max(0, ...coupons.map((c) => couponDiscount(L, c)));
  return Math.min(L, Math.ceil((L - discount) / 10) * 10);
}

// A seller-only coupon's terms come from best-coupon; when it gives neither rate nor amount, the name's "N%" or
// else the discount itself stands in.
function sellerCouponFromBest(best) {
  const base = { couponSno: best.couponSno, name: best.name ?? null, max: best.max ?? Infinity, min: best.min ?? 0, finishedAt: null };
  if (best.percent != null) return { ...base, type: 'PERCENT', percent: best.percent, price: null };
  if (best.price != null) return { ...base, type: 'PRICE', percent: null, price: best.price };
  const named = String(best.name ?? '').match(/(\d+)%/);
  if (named) return { ...base, type: 'PERCENT', percent: Number(named[1]), price: null };
  return { ...base, type: 'PRICE', percent: null, price: best.discount ?? 0 };
}

const walletRows = (rows) => rows.filter((c) => c.market_sno == null);
const sellerRowsSeen = (rows, marketSno, date) => rows.filter((c) => c.market_sno === Number(marketSno) && c.seen_date === date);

// Today's sample listings of a seller: the priciest first, then the cheapest, once each.
function samplesOf(store, marketSno) {
  const { low, high } = store.getQualifiedSamples(marketSno);
  return [high, low].filter((s, i, all) => s && all.findIndex((o) => o?.sno === s.sno) === i);
}

export async function learnMarketCoupons({ client, store, date, marketSnos, memberToken, log = console.log }) {
  const result = { memberStatus: 'none', wallet: 0, walletChanges: { added: [], removed: [] }, emoney: null, eligible: 0, mismatched: 0 };
  if (!memberToken) return result;
  const expired = () => {
    log('⚠️ [4910] 회원 토큰 만료 — 쿠폰 학습 중단');
    return { ...result, memberStatus: 'expired' };
  };

  let coupons;
  try {
    coupons = await client.getMyCoupons({ memberToken });
  } catch (err) {
    if (err.code === 'MEMBER_AUTH') return expired();
    throw err;
  }
  result.walletChanges = store.replaceWallet(date, coupons);
  const wallet = walletRows(store.getWallet());
  const walletSnos = new Set(wallet.map((c) => c.coupon_sno));
  result.wallet = wallet.length;
  result.memberStatus = 'ok';

  try {
    result.emoney = (await client.getMe({ memberToken })).emoney ?? null;
  } catch (err) {
    log(`⚠️ [4910] 포인트 조회 실패 (HTTP ${err.status ?? '?'})`);
  }

  for (const marketSno of marketSnos) {
    let first = null;
    let set = null;
    let mismatch = false;
    for (const sample of samplesOf(store, marketSno)) {
      const L = sample.sale_price;
      let optionSno;
      try {
        optionSno = (await client.getGoodsDetail(sample.sno)).optionSno;
      } catch (err) {
        log(`⚠️ [4910] 판매처 ${marketSno} 표본 ${sample.sno} 상세 조회 실패 (HTTP ${err.status ?? '?'})`);
        continue;
      }
      if (optionSno == null) {
        log(`⚠️ [4910] 판매처 ${marketSno} 표본 ${sample.sno} 옵션 없음`);
        continue;
      }

      let best;
      try {
        best = await client.getBestCoupon(optionSno, { memberToken });
      } catch (err) {
        if (err.code === 'MEMBER_AUTH') return expired();
        log(`⚠️ [4910] 판매처 ${marketSno} 표본 ${sample.sno} 쿠폰 조회 실패 (HTTP ${err.status ?? '?'})`);
        continue;
      }

      // The first answer decides which coupons reach this seller: the whole wallet, only its own coupons, or none.
      if (!first) {
        first = { L, best };
        if (!best) set = [];
        else if (walletSnos.has(best.couponSno)) set = wallet;
        else {
          store.addMarketCoupon(date, marketSno, sellerCouponFromBest(best));
          set = sellerRowsSeen(store.getWallet(), marketSno, date);
        }
      }
      if (Math.abs(L - (best?.discount ?? 0) - couponPrice(L, set)) > 10) mismatch = true;
    }

    if (!first) continue;
    store.recordMarketCoupon({
      market_sno: Number(marketSno),
      date,
      coupon_sno: first.best?.couponSno ?? null,
      coupon_name: first.best?.name ?? null,
      checked_price: first.L,
      coupon_discount: first.best?.discount ?? null,
      mismatch,
    });
    if (first.best) result.eligible++;
    if (mismatch) result.mismatched++;
  }
  return result;
}

/**
 * Prices every ACTIVE listing from its seller's market_coupons row for `date`: no row or a mismatch → NULL, no coupon
 * → sale price, a wallet coupon → the whole wallet, a seller-only coupon → that seller's coupons seen on `date`.
 */
export function applyCouponPrices({ store, date }) {
  const today = store.getMarketCoupons(date);
  const all = store.getWallet();
  const wallet = walletRows(all);
  const walletSnos = new Set(wallet.map((c) => c.coupon_sno));
  const setOf = new Map();
  for (const [marketSno, row] of today) {
    if (row.mismatch || row.coupon_sno == null) continue;
    setOf.set(marketSno, walletSnos.has(row.coupon_sno) ? wallet : sellerRowsSeen(all, marketSno, date));
  }

  const prices = new Map();
  let priced = 0;
  for (const g of store.getActivePriceRows()) {
    const row = today.get(g.market_sno);
    let price = null;
    if (g.sale_price != null && row && !row.mismatch) {
      price = row.coupon_sno == null ? g.sale_price : couponPrice(g.sale_price, setOf.get(g.market_sno));
    }
    prices.set(g.sno, price);
    if (price != null) priced++;
  }
  store.setCouponPrices(prices);
  return { priced, nulled: prices.size - priced };
}
