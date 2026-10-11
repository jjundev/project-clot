// 4910 coupon price = list price − the best coupon that reaches the listing (docs/verify/4910-member-price.md §2–3).
// Which coupons reach a seller is decided per seller, so once a day each qualified seller's 1–2 sample listings are
// asked for their best coupon, and every ACTIVE listing is then priced locally. The member token is only ever passed
// to the client and never logged.

// A seller-only coupon is not always seller-wide (docs/verify/4910-member-price.md §3): one limited to an event list
// of at most LISTED_COUPON_MAX goods reaches only those goods; one limited to at most SCOPED_MAX_CATEGORIES categories,
// or to visits from Naver, hides the seller's coupon price (we cannot tell which listings it reaches).
export const LISTED_COUPON_MAX = 5000;
export const SCOPED_MAX_CATEGORIES = 3;
const LISTED_MAX_PAGES = 12;

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
 * wallet (once) if any of them is a wallet coupon, plus each seller-only coupon by its own sno — seller-wide ones for
 * every listing, 'listed' ones only for the goods in their list (`listedGoods(couponSno)` → Set). A seller can get
 * both — a seller-only coupon whose minimum only its dearer listings meet, the wallet below that.
 * Returns a function from a listing sno to its coupons, or null when the seller is hidden: a seller-only coupon not
 * seen on `date` (the seller does have it, we just cannot price it), or one scoped to categories or to Naver.
 * Learning and pricing both use this, so the self-check validates exactly what is published.
 */
function couponSetOf(snos, rows, date, listedGoods) {
  const wallet = walletRows(rows);
  const walletSnos = new Set(wallet.map((c) => c.coupon_sno));
  const always = snos.some((sno) => walletSnos.has(sno)) ? [...wallet] : [];
  const listed = [];
  for (const sno of snos) {
    if (walletSnos.has(sno)) continue;
    const [own] = sellerCouponSeen(rows, sno, date);
    if (!own) return null;
    if (own.scope === 'listed') listed.push({ coupon: own, goods: listedGoods(sno) });
    // NULL: a row stored before scopes were classified, priced seller-wide as it was then.
    else if (own.scope === 'seller' || own.scope == null) always.push(own);
    else return null;
  }
  if (!listed.length) return () => always;
  return (goodsSno) => [...always, ...listed.filter((l) => l.goods.has(goodsSno)).map((l) => l.coupon)];
}

// Each listed coupon's goods are read from the store once per run.
function listedGoodsOf(store, date) {
  const cache = new Map();
  return (couponSno) => {
    if (!cache.has(couponSno)) cache.set(couponSno, store.getCouponGoods(couponSno, date));
    return cache.get(couponSno);
  };
}

// Every page of a coupon's goods list, up to LISTED_MAX_PAGES; stops on an empty page or a missing or stuck cursor.
async function fetchCouponGoods(client, couponSno, memberToken) {
  const snos = [];
  let lastSno = null;
  for (let page = 0; page < LISTED_MAX_PAGES; page++) {
    const res = await client.getCouponGoodsPage(couponSno, { memberToken, lastSno });
    snos.push(...res.snos);
    if (!res.snos.length || res.lastSno == null || res.lastSno === lastSno) break;
    lastSno = res.lastSno;
  }
  return snos;
}

/**
 * Classifies a seller-only coupon as 'naver' (by name), 'listed' (storing its goods list for `date`), 'category' or
 * 'seller'. A failed lookup counts as 'category' (hide); only MEMBER_AUTH is thrown.
 */
async function classifyCoupon({ client, store, date, memberToken, best, log }) {
  const name = best.name ?? String(best.couponSno);
  if (/네이버/.test(best.name ?? '')) {
    log(`[4910] 쿠폰 범위: ${name} → naver`);
    return 'naver';
  }
  let scope;
  let total;
  let goods = null;
  try {
    total = (await client.getCouponGoodsPage(best.couponSno, { memberToken, limit: 1 })).totalCount;
    if (total <= LISTED_COUPON_MAX) {
      goods = await fetchCouponGoods(client, best.couponSno, memberToken);
      scope = 'listed';
    } else {
      const categories = await client.getCouponCategories(best.couponSno, { memberToken });
      scope = categories.length <= SCOPED_MAX_CATEGORIES ? 'category' : 'seller';
    }
  } catch (err) {
    if (err.code === 'MEMBER_AUTH') throw err;
    log(`[4910] 쿠폰 범위: ${name} → category (조회 실패 HTTP ${err.status ?? '?'})`);
    return 'category';
  }
  if (goods) store.setCouponGoods(best.couponSno, date, goods);
  if (scope !== 'seller') log(`[4910] 쿠폰 범위: ${name} → ${scope === 'listed' ? `listed(${total})` : scope}`);
  return scope;
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

  const scopes = new Map(); // coupon sno → scope, classified once per run
  const listedGoods = listedGoodsOf(store, date);
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
      if (best && !walletSnos.has(best.couponSno)) {
        if (!scopes.has(best.couponSno)) {
          try {
            scopes.set(best.couponSno, await classifyCoupon({ client, store, date, memberToken, best, log }));
          } catch (err) {
            if (err.code === 'MEMBER_AUTH') return expired();
            throw err;
          }
        }
        store.addMarketCoupon(date, marketSno, { ...sellerCouponFromBest(best), scope: scopes.get(best.couponSno) });
      }
      // best-coupon computes the discount on the detail price, which can differ from the listing's sale_price.
      answers.push({ sno: sample.sno, L: detail.listPrice ?? sample.sale_price, best });
    }
    if (!answers.length) continue;

    const snos = [...new Set(answers.map((a) => a.best?.couponSno).filter((sno) => sno != null))];
    const setFor = couponSetOf(snos, store.getWallet(), date, listedGoods);
    let mismatch = setFor == null;
    for (const { sno, L, best } of answers) {
      if (setFor && Math.abs(L - (best?.discount ?? 0) - couponPrice(L, setFor(sno))) > 10) mismatch = true;
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
 * NULL; otherwise the best of the coupons couponSetOf gives that listing (over coupon_snos; a row from before that
 * column falls back to its coupon_sno), so no coupon → sale price, and a hidden seller (an unpriceable or scoped
 * seller-only coupon) → NULL (never the list price: the seller does have a coupon, we just cannot price it).
 */
export function applyCouponPrices({ store, date }) {
  const today = store.getMarketCoupons(date);
  const rows = store.getWallet();
  const listedGoods = listedGoodsOf(store, date);
  const setOf = new Map();
  for (const [marketSno, row] of today) {
    if (row.mismatch) continue;
    const snos = row.coupon_snos ?? (row.coupon_sno == null ? [] : [row.coupon_sno]);
    const setFor = couponSetOf(snos, rows, date, listedGoods);
    if (setFor) setOf.set(marketSno, setFor);
  }

  const prices = new Map();
  let priced = 0;
  for (const g of store.getActivePriceRows()) {
    const setFor = setOf.get(g.market_sno);
    const price = g.sale_price != null && setFor ? couponPrice(g.sale_price, setFor(g.sno)) : null;
    prices.set(g.sno, price);
    if (price != null) priced++;
  }
  store.setCouponPrices(prices);
  return { priced, nulled: prices.size - priced };
}
