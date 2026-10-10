import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store4910 } from '../src/site4910/store.js';
import { couponDiscount, couponPrice, learnMarketCoupons, applyCouponPrices } from '../src/site4910/coupons.js';

const SECRET = 'SECRET-TOKEN';
const DATE = '2026-10-11';

let dir;
let store;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-4910-coupons-'));
  store = new Store4910(path.join(dir, '4910.db'));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// The wallet measured on 10/11 (docs/verify/4910-member-price.md section 3).
const pct = (couponSno, percent, max, extra = {}) => ({
  couponSno, name: `${percent}% 쿠폰`, type: 'PERCENT', percent, price: null, max, min: 10000,
  finishedAt: '2026-10-31', usable: true, ...extra,
});
const W = [pct(1, 20, 30000), pct(2, 18, 100000), pct(3, 15, 130000)];

const goods = (sno, market_sno, sale_price) => ({
  sno, brand_sno: 2421, brand: '유니클로', name: `listing ${sno}`, market_sno, market_name: `seller ${market_sno}`,
  category: 'cat', sale_price, original_price: sale_price, discount_rate: 0, image_url: null,
  url: `https://4910.kr/goods/${sno}`, closed: false,
});
const seed = (...rows) => store.applyScan(DATE, rows, { completeBrands: [2421] });

const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const authErr = () => Object.assign(new Error('member token rejected'), { code: 'MEMBER_AUTH', status: 401 });

// details: goods sno -> { optionSno } | Error; best: optionSno -> best coupon | null | Error.
function fakeClient({ wallet = W, me = { emoney: 1200 }, details = {}, best = {} } = {}) {
  const calls = { coupons: 0, me: 0, detail: [], best: [] };
  return {
    calls,
    async getMyCoupons({ memberToken }) {
      assert.equal(memberToken, SECRET);
      calls.coupons++;
      if (wallet instanceof Error) throw wallet;
      return wallet;
    },
    async getMe({ memberToken }) {
      assert.equal(memberToken, SECRET);
      calls.me++;
      if (me instanceof Error) throw me;
      return me;
    },
    async getGoodsDetail(sno, opts = {}) {
      assert.equal(opts.memberToken ?? null, null, 'detail must be anonymous');
      calls.detail.push(sno);
      const d = details[sno] ?? { optionSno: sno * 10 };
      if (d instanceof Error) throw d;
      return { sno, listPrice: null, optionSno: null, ...d };
    },
    async getBestCoupon(optionSno, { memberToken }) {
      assert.equal(memberToken, SECRET);
      assert.notEqual(optionSno, null);
      calls.best.push(optionSno);
      const b = best[optionSno];
      if (b instanceof Error) throw b;
      return b ?? null;
    },
  };
}
const learn = (client, marketSnos, logs = [], extra = {}) =>
  learnMarketCoupons({ client, store, date: DATE, marketSnos, memberToken: SECRET, log: (m) => logs.push(m), ...extra });
const wallet20 = (discount) => ({ couponSno: 1, name: '20% 쿠폰', discount, percent: 20, price: null, max: 30000, min: 10000 });

test('couponPrice matches the 4910 page', () => {
  assert.equal(couponPrice(85400, W), 68320);
  assert.equal(couponPrice(212300, W), 174090);
  assert.equal(couponPrice(21700, W), 17360);
  assert.equal(couponPrice(9000, W), 9000);
});

test('couponDiscount honours min, max (null = uncapped) and PRICE coupons', () => {
  assert.equal(couponDiscount(9999, { type: 'PERCENT', percent: 20, max: 30000, min: 10000 }), 0);
  assert.equal(couponDiscount(212300, { type: 'PERCENT', percent: 20, max: 30000, min: 10000 }), 30000);
  assert.equal(couponDiscount(212300, { type: 'PERCENT', percent: 20, max: null, min: 10000 }), 42460);
  assert.equal(couponDiscount(50000, { type: 'PRICE', price: 3000, max: null, min: 0 }), 3000);
  assert.equal(couponDiscount(50000, { type: 'PRICE', price: 3000, max: 2000, min: 0 }), 2000);
  assert.equal(couponPrice(12345, []), 12345);
});

test('a seller without a coupon keeps the list price; a mismatched seller gets null', () => {
  store.replaceWallet(DATE, W);
  seed(goods(1, 10, 85400), goods(2, 20, 85400), goods(3, 30, 85400), goods(4, 40, 85400), goods(5, 10, null));
  store.recordMarketCoupon({ market_sno: 10, date: DATE, coupon_sno: 1, coupon_name: 'A', checked_price: 85400, coupon_discount: 17080, mismatch: false });
  store.recordMarketCoupon({ market_sno: 20, date: DATE, coupon_sno: null, coupon_name: null, checked_price: 85400, coupon_discount: null, mismatch: false });
  store.recordMarketCoupon({ market_sno: 30, date: DATE, coupon_sno: 1, coupon_name: 'A', checked_price: 85400, coupon_discount: 9000, mismatch: true });
  // seller 40 has no row today (only yesterday's)
  store.recordMarketCoupon({ market_sno: 40, date: '2026-10-10', coupon_sno: 1, coupon_name: 'A', checked_price: 85400, coupon_discount: 17080, mismatch: false });

  assert.deepEqual(applyCouponPrices({ store, date: DATE }), { priced: 2, nulled: 3 });
  assert.equal(store.getGoods(1).coupon_price, 68320);
  assert.equal(store.getGoods(2).coupon_price, 85400);
  assert.equal(store.getGoods(3).coupon_price, null);
  assert.equal(store.getGoods(4).coupon_price, null);
  assert.equal(store.getGoods(5).coupon_price, null);
});

test('applyCouponPrices uses only seller-only coupons seen today', () => {
  store.replaceWallet(DATE, W);
  seed(goods(1, 10, 50150));
  store.addMarketCoupon('2026-10-10', 10, pct(998, 30, Infinity, { min: 0 }));
  store.addMarketCoupon(DATE, 10, pct(999, 5, Infinity, { min: 0 }));
  store.recordMarketCoupon({ market_sno: 10, date: DATE, coupon_sno: 999, coupon_name: 'TNGT', checked_price: 50150, coupon_discount: 2508, mismatch: false });
  applyCouponPrices({ store, date: DATE });
  assert.equal(store.getGoods(1).coupon_price, 47650);
});

test('a seller-only coupon row that is missing or not seen today prices the seller NULL', () => {
  store.replaceWallet(DATE, W);
  seed(goods(1, 10, 50150), goods(2, 20, 50150));
  store.addMarketCoupon('2026-10-10', 10, pct(998, 5, Infinity, { min: 0 }));
  store.recordMarketCoupon({ market_sno: 10, date: DATE, coupon_sno: 998, coupon_name: 'stale', checked_price: 50150, coupon_discount: 2508, mismatch: false });
  store.recordMarketCoupon({ market_sno: 20, date: DATE, coupon_sno: 997, coupon_name: 'gone', checked_price: 50150, coupon_discount: 2508, mismatch: false });
  assert.deepEqual(applyCouponPrices({ store, date: DATE }), { priced: 0, nulled: 2 });
  assert.equal(store.getGoods(1).coupon_price, null);
  assert.equal(store.getGoods(2).coupon_price, null);
});

test('two sellers whose best is the same seller-only coupon both get the discounted price', async () => {
  seed(goods(1, 10, 50150), goods(2, 20, 50150));
  const shared = { couponSno: 999, name: '[4910] 공동 5% 쿠폰', discount: 2507, percent: 5, price: null, max: Infinity, min: 0 };
  const res = await learn(fakeClient({ best: { 10: shared, 20: shared } }), [10, 20]);
  assert.equal(res.eligible, 2);
  assert.equal(res.mismatched, 0);
  assert.deepEqual(applyCouponPrices({ store, date: DATE }), { priced: 2, nulled: 0 });
  assert.equal(store.getGoods(1).coupon_price, 47650);
  assert.equal(store.getGoods(2).coupon_price, 47650);
});

test('learnMarketCoupons records a seller-only coupon from best-coupon', async () => {
  seed(goods(1, 10, 50150), goods(2, 10, 12000));
  const tngt = (discount) => ({ couponSno: 999, name: '[4910] TNGT 5% 쿠폰', discount });
  const client = fakeClient({ best: { 10: tngt(2508), 20: tngt(600) } });
  const res = await learn(client, [10]);
  assert.deepEqual(res, {
    memberStatus: 'ok', wallet: 3, walletChanges: { added: ['20% 쿠폰', '18% 쿠폰', '15% 쿠폰'], removed: [] },
    emoney: 1200, eligible: 1, mismatched: 0,
  });
  const row = store.getWallet().find((c) => c.coupon_sno === 999);
  assert.equal(row.market_sno, 10);
  assert.equal(row.seen_date, DATE);
  assert.equal(row.type, 'PERCENT');
  assert.equal(row.percent, 5);
  const sellerOnly = store.getWallet().filter((c) => c.market_sno === 10);
  assert.equal(couponPrice(50150, sellerOnly), 47650);
  const mc = store.getMarketCoupons(DATE).get(10);
  assert.equal(mc.coupon_sno, 999);
  assert.equal(mc.coupon_name, '[4910] TNGT 5% 쿠폰');
  assert.equal(mc.checked_price, 50150);
  assert.equal(mc.coupon_discount, 2508);
  assert.equal(mc.mismatch, 0);
  // the 20% wallet coupon does not reach this seller
  applyCouponPrices({ store, date: DATE });
  assert.equal(store.getGoods(1).coupon_price, 47650);
  assert.equal(store.getGoods(2).coupon_price, 11400);
});

test('a seller-only coupon takes its terms from best-coupon fields; the wallet does not apply to that seller', async () => {
  seed(goods(1, 10, 50150));
  const best = { couponSno: 999, name: '판매처 쿠폰', discount: 2507, percent: 5, price: null, max: Infinity, min: 0 };
  const res = await learn(fakeClient({ best: { 10: best } }), [10]);
  assert.equal(res.eligible, 1);
  assert.equal(res.mismatched, 0);
  const row = store.getWallet().find((c) => c.coupon_sno === 999);
  assert.deepEqual({ type: row.type, percent: row.percent, max: row.max, min: row.min }, { type: 'PERCENT', percent: 5, max: null, min: 0 });
  applyCouponPrices({ store, date: DATE });
  assert.equal(store.getGoods(1).coupon_price, 47650);
});

test('a seller-only PRICE coupon is stored as PRICE', async () => {
  seed(goods(1, 10, 50150));
  const best = { couponSno: 999, name: '3천원 쿠폰', discount: 3000, percent: null, price: 3000, max: Infinity, min: 30000 };
  await learn(fakeClient({ best: { 10: best } }), [10]);
  const row = store.getWallet().find((c) => c.coupon_sno === 999);
  assert.deepEqual({ type: row.type, price: row.price, min: row.min }, { type: 'PRICE', price: 3000, min: 30000 });
  applyCouponPrices({ store, date: DATE });
  assert.equal(store.getGoods(1).coupon_price, 47150);
});

test('a wallet best coupon applies the whole wallet and adds no seller-only row', async () => {
  seed(goods(1, 10, 212300), goods(2, 10, 85400), goods(3, 10, 9000));
  const client = fakeClient({ best: { 10: { ...wallet20(38214), couponSno: 2, percent: 18, max: 100000 }, 20: wallet20(17080) } });
  const res = await learn(client, [10]);
  assert.equal(res.eligible, 1);
  assert.equal(res.mismatched, 0);
  assert.equal(store.getWallet().filter((c) => c.market_sno != null).length, 0);
  // high first, then low
  assert.deepEqual(client.calls.detail, [1, 2]);
  assert.equal(store.getMarketCoupons(DATE).get(10).checked_price, 212300);
  assert.deepEqual(applyCouponPrices({ store, date: DATE }), { priced: 3, nulled: 0 });
  assert.equal(store.getGoods(1).coupon_price, 174090);
  assert.equal(store.getGoods(2).coupon_price, 68320);
  assert.equal(store.getGoods(3).coupon_price, 9000);
});

test('a seller with no best coupon keeps sale prices', async () => {
  seed(goods(1, 10, 85400));
  const res = await learn(fakeClient(), [10]);
  assert.equal(res.eligible, 0);
  const mc = store.getMarketCoupons(DATE).get(10);
  assert.equal(mc.coupon_sno, null);
  assert.equal(mc.coupon_discount, null);
  assert.equal(mc.mismatch, 0);
  applyCouponPrices({ store, date: DATE });
  assert.equal(store.getGoods(1).coupon_price, 85400);
});

test('one listing that is both high and low is sampled once', async () => {
  seed(goods(1, 10, 85400));
  const client = fakeClient({ best: { 10: wallet20(17080) } });
  await learn(client, [10]);
  assert.deepEqual(client.calls.detail, [1]);
  assert.deepEqual(client.calls.best, [10]);
});

test('no token returns none and calls nothing; MEMBER_AUTH returns expired and stops', async () => {
  seed(goods(1, 10, 85400), goods(2, 20, 85400), goods(3, 30, 85400));
  const none = fakeClient();
  const r0 = await learnMarketCoupons({ client: none, store, date: DATE, marketSnos: [10], memberToken: null, log: () => {} });
  assert.deepEqual(r0, { memberStatus: 'none', wallet: 0, walletChanges: { added: [], removed: [] }, emoney: null, eligible: 0, mismatched: 0 });
  assert.equal(none.calls.coupons + none.calls.me + none.calls.detail.length + none.calls.best.length, 0);

  const walletAuth = fakeClient({ wallet: authErr() });
  const r1 = await learn(walletAuth, [10]);
  assert.deepEqual(r1, { memberStatus: 'expired', wallet: 0, walletChanges: { added: [], removed: [] }, emoney: null, eligible: 0, mismatched: 0 });
  assert.equal(walletAuth.calls.me + walletAuth.calls.detail.length + walletAuth.calls.best.length, 0);
  assert.equal(store.getWallet().length, 0);

  const bestAuth = fakeClient({ best: { 10: wallet20(17080), 20: authErr(), 30: wallet20(17080) } });
  const r2 = await learn(bestAuth, [10, 20, 30]);
  assert.equal(r2.memberStatus, 'expired');
  assert.equal(r2.wallet, 3);
  assert.equal(r2.emoney, 1200);
  assert.equal(r2.eligible, 1);
  assert.deepEqual(bestAuth.calls.best, [10, 20]);
  assert.deepEqual([...store.getMarketCoupons(DATE).keys()], [10]);
  applyCouponPrices({ store, date: DATE });
  assert.equal(store.getGoods(1).coupon_price, 68320);
  assert.equal(store.getGoods(2).coupon_price, null);
  assert.equal(store.getGoods(3).coupon_price, null);
});

test('a non-auth wallet failure rejects without the token', async () => {
  await assert.rejects(learn(fakeClient({ wallet: httpErr(500) }), [10]), (err) => err.status === 500 && !err.message.includes(SECRET));
});

test('getMe failing leaves emoney null and learning continues', async () => {
  seed(goods(1, 10, 85400));
  for (const me of [httpErr(500), authErr()]) {
    const res = await learn(fakeClient({ me, best: { 10: wallet20(17080) } }), [10]);
    assert.equal(res.memberStatus, 'ok');
    assert.equal(res.emoney, null);
    assert.equal(res.eligible, 1);
  }
});

test('mismatch is flagged when the high sample disagrees by more than 10 won', async () => {
  seed(goods(1, 10, 85400), goods(2, 20, 85400));
  // seller 10: 17080 expected, 17070 off by 10 → fine; seller 20: 17000 → off by 80 → mismatch
  const res = await learn(fakeClient({ best: { 10: wallet20(17070), 20: wallet20(17000) } }), [10, 20]);
  assert.equal(res.eligible, 2);
  assert.equal(res.mismatched, 1);
  const mc = store.getMarketCoupons(DATE);
  assert.equal(mc.get(10).mismatch, 0);
  assert.equal(mc.get(20).mismatch, 1);
  applyCouponPrices({ store, date: DATE });
  assert.equal(store.getGoods(1).coupon_price, 68320);
  assert.equal(store.getGoods(2).coupon_price, null);
});

test('a failed or optionless sample is skipped; a seller with no answered sample gets no row', async () => {
  seed(goods(1, 10, 85400), goods(2, 10, 21700), goods(3, 20, 85400), goods(4, 30, 85400), goods(5, 30, 21700));
  const logs = [];
  const client = fakeClient({
    details: { 1: httpErr(404), 3: { optionSno: null }, 4: { optionSno: 40 }, 5: { optionSno: 50 } },
    best: { 20: wallet20(4340), 40: httpErr(500), 50: wallet20(4340) },
  });
  const res = await learn(client, [10, 20, 30], logs);
  assert.equal(res.memberStatus, 'ok');
  assert.deepEqual(client.calls.best, [20, 40, 50]);
  const mc = store.getMarketCoupons(DATE);
  assert.equal(mc.get(10).checked_price, 21700);
  assert.equal(mc.has(20), false);
  assert.equal(mc.get(30).checked_price, 21700);
  assert.ok(logs.some((l) => l.includes('404')));
  assert.ok(logs.some((l) => l.includes('500')));
});

test('the token never appears in logs', async () => {
  seed(goods(1, 10, 85400), goods(2, 10, 21700), goods(3, 20, 85400));
  const logs = [];
  await learn(fakeClient({ me: authErr(), details: { 1: httpErr(404) }, best: { 20: httpErr(500), 30: authErr() } }), [10, 20], logs);
  await learn(fakeClient({ wallet: authErr() }), [10], logs);
  assert.ok(logs.length > 0);
  assert.ok(logs.every((l) => !String(l).includes(SECRET)));
});

test('a wallet best coupon whose minimum differs from the stored wallet row marks the seller mismatched', async () => {
  seed(goods(1, 10, 85400), goods(2, 20, 85400));
  // Seller 10: same discount, but best-coupon says the minimum is 30,000 (the wallet text parsed as 10,000).
  // Seller 20: best-coupon gives no minimum at all, which is not a disagreement.
  const client = fakeClient({ best: { 10: { ...wallet20(17080), min: 30000 }, 20: { ...wallet20(17080), min: null } } });
  const res = await learn(client, [10, 20]);
  assert.equal(res.mismatched, 1);
  assert.equal(store.getMarketCoupons(DATE).get(10).mismatch, 1);
  assert.equal(store.getMarketCoupons(DATE).get(20).mismatch, 0);
  applyCouponPrices({ store, date: DATE });
  assert.equal(store.getGoods(1).coupon_price, null);
  assert.equal(store.getGoods(2).coupon_price, 68320);
});

test('past the deadline the wallet is still read but no seller is sampled', async () => {
  seed(goods(1, 10, 85400));
  const client = fakeClient({ best: { 10: wallet20(17080) } });
  const logs = [];
  const res = await learn(client, [10, 20], logs, { deadline: Date.now() - 1 });
  assert.equal(client.calls.coupons, 1);
  assert.equal(res.memberStatus, 'ok');
  assert.equal(res.wallet, 3);
  assert.deepEqual(client.calls.detail, []);
  assert.deepEqual(client.calls.best, []);
  assert.equal(store.getMarketCoupons(DATE).size, 0);
  assert.equal(logs.filter((l) => /예산/.test(l)).length, 1);
  assert.doesNotMatch(logs.join('\n'), new RegExp(SECRET));
  applyCouponPrices({ store, date: DATE });
  assert.equal(store.getGoods(1).coupon_price, null);
});
