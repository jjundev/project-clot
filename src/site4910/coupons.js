// 4910 single-item prices: direct option evidence or owned coupon with complete goods scope.
import { mapConcurrent } from '../pool.js';

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

// Pricing is proved per product. A seller sample never grants the whole wallet to a seller.
import { resolveMemberPrice } from './member-price.js';
import { evaluateCouponEligibility } from './coupon-eligibility.js';

function samplesOf(store, marketSno) {
  const { low, high } = store.getQualifiedSamples(marketSno);
  return [high, low].filter((s, i, all) => s && all.findIndex(o => o?.sno === s.sno) === i);
}

async function completeGoods(client, couponSno, memberToken, deadline) {
  const first = await client.getCouponGoodsPage(couponSno, { memberToken, limit: 1 });
  if (first.totalCount > LISTED_COUPON_MAX || first.totalCount < 0) return null;
  const snos = new Set();
  let lastSno = null;
  for (let page = 0; page < LISTED_MAX_PAGES; page++) {
    if (Date.now() > deadline) return null;
    const res = await client.getCouponGoodsPage(couponSno, { memberToken, lastSno });
    if (res.totalCount !== first.totalCount) return null;
    res.snos.forEach(sno => snos.add(sno));
    if (res.lastSno == null) return snos.size === first.totalCount ? snos : null;
    if (!res.snos.length || res.lastSno === lastSno) return null;
    lastSno = res.lastSno;
  }
  return null;
}

export async function learnMarketCoupons({ client, withClient = fn => fn(client), concurrency = 1, store, date,
  marketSnos, memberToken, deadline = Infinity, log = console.log }) {
  const result = { memberStatus: 'none', wallet: 0, walletChanges: { added: [], removed: [] }, emoney: null,
    eligible: 0, mismatched: 0, hidden: { scope: 0, naver: 0, mismatch: 0 },
    validation: { verified: 0, unverified: 0, reasons: {} } };
  if (!memberToken) return result;
  let wallet;
  try {
    wallet = await withClient(async c => {
      const rows = await c.getMyCoupons({ memberToken });
      result.walletChanges = store.replaceWallet(date, rows);
      result.wallet = rows.filter(r => r.usable).length;
      result.memberStatus = 'ok';
      try { result.emoney = (await c.getMe({ memberToken })).emoney; }
      catch { log('⚠️ [4910] 포인트 조회 실패'); }
      return rows;
    });
  } catch (err) {
    if (err.code !== 'MEMBER_AUTH') throw err;
    return { ...result, memberStatus: 'expired' };
  }
  const scopes = new Map();
  let stopped = false;
  await mapConcurrent(marketSnos, concurrency, async marketSno => {
    if (stopped || Date.now() > deadline) return;
    await withClient(async c => {
      let answered = 0, verified = 0;
      for (const sample of samplesOf(store, marketSno)) {
        if (stopped || Date.now() > deadline) break;
        let detail, best, resolved = { price: null, reason: 'request-failed' };
        try {
          detail = await c.getGoodsDetail(sample.sno);
          if (detail.optionSno != null && Date.now() <= deadline) {
            best = await c.getBestCoupon(detail.optionSno, { memberToken });
            resolved = resolveMemberPrice(detail, best);
            answered++;
          } else resolved.reason = 'option-or-budget';
          // Only wallet-owned terms + a complete product list can authorize other products.
          const own = best?.isApplied === true && wallet.find(w => w.couponSno === best.couponSno && w.usable);
          if (own) {
            if (!scopes.has(own.couponSno)) scopes.set(own.couponSno, completeGoods(c, own.couponSno, memberToken, deadline));
            const goods = await scopes.get(own.couponSno);
            if (goods) {
              store.setCouponGoods(own.couponSno, date, goods);
              // Preserve wallet ownership and conditions; never replace with a seller's inferred terms.
              store.db.prepare("UPDATE wallet_coupons SET scope = 'listed' WHERE coupon_sno = ?").run(own.couponSno);
            }
          }
        } catch (err) {
          if (err.code === 'MEMBER_AUTH') { stopped = true; result.memberStatus = 'expired'; }
          log(`⚠️ [4910] 판매처 ${marketSno} 표본 ${sample.sno} 검증 실패 (HTTP ${err.status ?? '?'})`);
        }
        const ok = resolved.price != null;
        result.validation[ok ? 'verified' : 'unverified']++;
        result.validation.reasons[resolved.reason] = (result.validation.reasons[resolved.reason] ?? 0) + 1;
        if (ok) verified++;
        store.putPriceValidation({ kind: 'scan', sno: sample.sno, date, status: ok ? 'verified' : 'unverified',
          reason: resolved.reason, corrected: ok ? { sale_price: detail.listPrice, coupon_price: resolved.price } : null,
          evidence: { observedDate: date, bestOptionSno: best?.optionSno ?? null, priceBasis: detail?.priceBasis ?? null, optionSno: detail?.optionSno ?? null,
            basePrice: detail?.listPrice ?? null, couponSno: best?.couponSno ?? null,
            discount: best?.discount ?? null, isApplied: best?.isApplied ?? null } });
      }
      if (answered) store.recordMarketCoupon({ market_sno: marketSno, date, mismatch: verified === 0 });
      if (verified) result.eligible++;
      else { result.mismatched++; result.hidden.scope++; }
    });
  });
  if (Date.now() > deadline) log('⚠️ [4910] 실행 예산 초과 — 미확인 쿠폰가 없음');
  return result;
}

export function applyCouponPrices({ store, date, marketSnos = null }) {
  const learned = marketSnos == null ? null : new Set(marketSnos.map(Number));
  const rows = store.getWallet().filter(c => c.market_sno == null && c.seen_date === date && c.scope === 'listed');
  const scopes = new Map(rows.map(c => [c.coupon_sno, { kind: 'goods', complete: true, goodsSnos: store.getCouponGoods(c.coupon_sno, date) }]));
  const direct = new Map(store.db.prepare("SELECT * FROM price_validations WHERE kind='scan' AND date=?").all(date).map(r => [r.sno, r]));
  const prices = new Map(), pairs = [];
  const validation = { verified: 0, unverified: 0, reasons: {} };
  for (const g of store.getActivePriceRows()) {
    if (learned && !learned.has(Number(g.market_sno))) continue;
    const observed = direct.get(g.sno);
    let price = null, reason = 'scope';
    if (observed?.status === 'verified') {
      const corrected = JSON.parse(observed.corrected_json);
      // The listing may be stale relative to today's detail: keep the observation's own base price.
      if (corrected.sale_price === g.sale_price) { price = corrected.coupon_price; reason = observed.reason; }
      else reason = 'listing-detail-mismatch';
    } else if (!observed) {
      const eligible = rows.filter(c => evaluateCouponEligibility({ coupon: c, goodsSno: g.sno, quantity: 1,
        basePrice: g.sale_price, scopeEvidence: scopes.get(c.coupon_sno) }).status === 'eligible');
      if (eligible.length) { price = couponPrice(g.sale_price, eligible); reason = 'complete-goods-list'; }
    } else reason = observed.reason;
    prices.set(g.sno, price);
    pairs.push({ sno: g.sno, sale_price: g.sale_price, coupon_price: price });
    validation[price == null ? 'unverified' : 'verified']++;
    validation.reasons[reason] = (validation.reasons[reason] ?? 0) + 1;
    store.putPriceValidation({ kind: 'scan', sno: g.sno, date, status: price == null ? 'unverified' : 'verified', reason,
      corrected: price == null ? null : { sale_price: g.sale_price, coupon_price: price },
      evidence: observed ? JSON.parse(observed.evidence_json) : { priceBasis: 'AGLO', basePrice: g.sale_price, scope: 'complete-goods-list' } });
  }
  store.setCouponPrices(prices);
  store.logCouponPriceChanges(date, pairs);
  return { priced: validation.verified, nulled: validation.unverified, validation };
}
