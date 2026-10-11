// 4910 coupon price = list price − the best coupon that reaches the listing (docs/verify/4910-member-price.md §2–3).
// Which coupons reach a seller is decided per seller, so once a day each qualified seller's 1–2 sample listings are
// asked for their best coupon, and every ACTIVE listing is then priced locally. The member token is only ever passed
// to the client and never logged.

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
// A seller-only coupon is found by its own sno, whichever seller's row it currently sits on: one coupon can reach
// several sellers, but wallet_coupons keeps one row per coupon. Empty when it was not seen on `date`.
const sellerCouponSeen = (rows, couponSno, date) =>
  rows.filter((c) => c.coupon_sno === couponSno && c.market_sno != null && c.seen_date === date);

/**
 * The coupons that reach a seller, from the snos that were the best coupon of any of its samples: the whole usable
 * wallet (once) if any of them is a wallet coupon, plus each seller-only coupon by its own sno. A seller can get both
 * — a seller-only coupon whose minimum only its dearer listings meet, the wallet below that. null when a seller-only
 * coupon was not seen on `date`: the seller does have it, we just cannot price it. Learning and pricing both use this,
 * so the self-check validates exactly what is published.
 */
function couponSetOf(snos, rows, date) {
  const wallet = walletRows(rows);
  const walletSnos = new Set(wallet.map((c) => c.coupon_sno));
  const set = snos.some((sno) => walletSnos.has(sno)) ? [...wallet] : [];
  for (const sno of snos) {
    if (walletSnos.has(sno)) continue;
    const own = sellerCouponSeen(rows, sno, date);
    if (!own.length) return null;
    set.push(...own);
  }
  return set;
}

// Today's sample listings of a seller: the priciest first, then the cheapest, once each.
function samplesOf(store, marketSno) {
  const { low, high } = store.getQualifiedSamples(marketSno);
  return [high, low].filter((s, i, all) => s && all.findIndex((o) => o?.sno === s.sno) === i);
}

/**
 * Reads the wallet and the e-money balance, then samples each seller's best coupon. Past `deadline` no new seller
 * is sampled: the sellers not reached get no market_coupons row today, so their listings' coupon price is NULL.
 */
export async function learnMarketCoupons({ client, store, date, marketSnos, memberToken, deadline = Infinity, log = console.log }) {
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
  const walletMin = new Map(wallet.map((c) => [c.coupon_sno, c.min]));
  result.wallet = wallet.length;
  result.memberStatus = 'ok';

  try {
    result.emoney = (await client.getMe({ memberToken })).emoney ?? null;
  } catch (err) {
    log(`⚠️ [4910] 포인트 조회 실패 (HTTP ${err.status ?? '?'})`);
  }

  for (const [i, marketSno] of marketSnos.entries()) {
    if (Date.now() > deadline) {
      log(`⚠️ [4910] 실행 예산 초과 — 판매처 ${marketSnos.length - i}곳 쿠폰 확인 생략 (쿠폰가 없음)`);
      break;
    }
    const answers = [];
    for (const sample of samplesOf(store, marketSno)) {
      let detail;
      try {
        detail = await client.getGoodsDetail(sample.sno);
      } catch (err) {
        log(`⚠️ [4910] 판매처 ${marketSno} 표본 ${sample.sno} 상세 조회 실패 (HTTP ${err.status ?? '?'})`);
        continue;
      }
      if (detail.optionSno == null) {
        log(`⚠️ [4910] 판매처 ${marketSno} 표본 ${sample.sno} 옵션 없음`);
        continue;
      }

      let best;
      try {
        best = await client.getBestCoupon(detail.optionSno, { memberToken });
      } catch (err) {
        if (err.code === 'MEMBER_AUTH') return expired();
        log(`⚠️ [4910] 판매처 ${marketSno} 표본 ${sample.sno} 쿠폰 조회 실패 (HTTP ${err.status ?? '?'})`);
        continue;
      }
      if (best && !walletSnos.has(best.couponSno)) store.addMarketCoupon(date, marketSno, sellerCouponFromBest(best));
      // best-coupon computes the discount on the detail price, which can differ from the listing's sale_price.
      answers.push({ L: detail.listPrice ?? sample.sale_price, best });
    }
    if (!answers.length) continue;

    const snos = [...new Set(answers.map((a) => a.best?.couponSno).filter((sno) => sno != null))];
    const set = couponSetOf(snos, store.getWallet(), date);
    let mismatch = set == null;
    for (const { L, best } of answers) {
      if (set && Math.abs(L - (best?.discount ?? 0) - couponPrice(L, set)) > 10) mismatch = true;
      // The wallet's minimum comes from parsed condition text; best-coupon states it directly, so a disagreement
      // means our wallet terms are wrong for this seller even when the sampled prices happen to match.
      if (best && walletSnos.has(best.couponSno) && typeof best.min === 'number' && best.min !== walletMin.get(best.couponSno)) mismatch = true;
    }

    const first = answers[0];
    store.recordMarketCoupon({
      market_sno: Number(marketSno),
      date,
      coupon_sno: first.best?.couponSno ?? null,
      coupon_snos: snos,
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
 * Prices every ACTIVE listing from its seller's market_coupons row for `date`: no row, a mismatch or no sale price →
 * NULL; otherwise the best of the seller's coupon set (couponSetOf over coupon_snos; a row from before that column
 * falls back to its coupon_sno), so no coupon → sale price and an unpriceable seller-only coupon → NULL (never the
 * list price: the seller does have a coupon, we just cannot price it).
 */
export function applyCouponPrices({ store, date }) {
  const today = store.getMarketCoupons(date);
  const rows = store.getWallet();
  const setOf = new Map();
  for (const [marketSno, row] of today) {
    if (row.mismatch) continue;
    const snos = row.coupon_snos ?? (row.coupon_sno == null ? [] : [row.coupon_sno]);
    const set = couponSetOf(snos, rows, date);
    if (set) setOf.set(marketSno, set);
  }

  const prices = new Map();
  let priced = 0;
  for (const g of store.getActivePriceRows()) {
    const set = setOf.get(g.market_sno);
    const price = g.sale_price != null && set ? couponPrice(g.sale_price, set) : null;
    prices.set(g.sno, price);
    if (price != null) priced++;
  }
  store.setCouponPrices(prices);
  return { priced, nulled: prices.size - priced };
}
