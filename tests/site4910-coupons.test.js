import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store4910 } from '../src/site4910/store.js';
import { couponDiscount, couponPrice, learnMarketCoupons, applyCouponPrices } from '../src/site4910/coupons.js';
import { clientPool } from '../src/pool.js';

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
// couponGoods: coupon sno -> { total, pages: [[goods sno, ...], ...] } | Error; couponCats: coupon sno -> names | Error.
// A coupon in neither is seller-wide: a large list in many categories.
const SELLER_WIDE = { total: 100000, pages: [[90001]] };
const MANY_CATS = ['상의', '신발', '아우터', '가방', '바지', '패션잡화', '스포츠/레저'];
function fakeClient({ wallet = W, me = { emoney: 1200 }, details = {}, best = {}, couponGoods = {}, couponCats = {} } = {}) {
  const calls = { coupons: 0, me: 0, detail: [], best: [], goodsPages: [], cats: [] };
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
      return { sno, priceBasis: 'AGLO', listPrice: store.getGoods(sno)?.sale_price ?? null, optionSno: null, ...d };
    },
    async getBestCoupon(optionSno, { memberToken }) {
      assert.equal(memberToken, SECRET);
      assert.notEqual(optionSno, null);
      calls.best.push(optionSno);
      const b = best[optionSno];
      if (b instanceof Error) throw b;
      return b ? { optionSno, isApplied: true, ...b } : null;
    },
    async getCouponGoodsPage(couponSno, { memberToken, lastSno = null, limit = 500 }) {
      assert.equal(memberToken, SECRET);
      calls.goodsPages.push({ couponSno, lastSno, limit });
      const g = couponGoods[couponSno] ?? SELLER_WIDE;
      if (g instanceof Error) throw g;
      const i = lastSno ?? 0;
      const snos = (g.pages[i] ?? []).slice(0, limit);
      return { totalCount: g.total, snos, lastSno: i + 1 < g.pages.length ? i + 1 : null };
    },
    async getCouponCategories(couponSno, { memberToken }) {
      assert.equal(memberToken, SECRET);
      calls.cats.push(couponSno);
      const c = couponCats[couponSno] ?? MANY_CATS;
      if (c instanceof Error) throw c;
      return c;
    },
  };
}
const learn = (client, marketSnos, logs = [], extra = {}) =>
  learnMarketCoupons({ client, store, date: DATE, marketSnos, memberToken: SECRET, log: (m) => logs.push(m), ...extra });
const NONE_HIDDEN = { scope: 0, naver: 0, mismatch: 0 };
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

// Replaces the former seller-wide/whole-wallet expectations: those assumptions caused the incident.
test('only directly checked samples are priced when scope is unknown', async () => {
  seed(goods(1,7,12850),goods(2,7,20000),goods(3,7,15000));
  const c = fakeClient({ best: { 10: { discount: 2820 }, 20: { discount: 4400 } } });
  await learn(c,[7]);
  const r = applyCouponPrices({store,date:DATE});
  assert.equal(store.getGoods(1).coupon_price,10030);
  assert.equal(store.getGoods(2).coupon_price,15600);
  assert.equal(store.getGoods(3).coupon_price,null);
  assert.equal(r.validation.unverified,1);
});
test('no coupon response verifies only the checked product, not seller', async () => {
  seed(goods(1,7,50000),goods(2,7,15000),goods(3,7,20000));
  await learn(fakeClient(),[7]);
  applyCouponPrices({store,date:DATE});
  assert.equal(store.getGoods(1).coupon_price,50000);
  assert.equal(store.getGoods(3).coupon_price,null);
});
test('complete owned coupon list prices included goods only', async () => {
  seed(goods(1,7,50000),goods(2,7,15000),goods(3,7,20000),goods(4,7,25000));
  const c=fakeClient({ wallet:[pct(1,20,30000,{conditions:['10,000원 이상 구매 시 할인']})],
    best:{10:wallet20(10000),20:wallet20(3000)},couponGoods:{1:{total:3,pages:[[1,2,3]]}} });
  await learn(c,[7]);
  applyCouponPrices({store,date:DATE});
  assert.equal(store.getGoods(3).coupon_price,16000);
  assert.equal(store.getGoods(4).coupon_price,null);
  assert.equal(c.calls.goodsPages.length,2);
});
for (const [label,config] of [
  ['cut list',{couponGoods:{1:{total:4,pages:[[1,2]]}}}],
  ['large category list',{}],
  ['scope request failure',{couponGoods:{1:httpErr(500)}}],
]) test(label+' never grants unsampled products a price',async()=>{
  seed(goods(1,7,50000),goods(2,7,15000),goods(3,7,20000));
  const c=fakeClient({wallet:[pct(1,20,30000,{conditions:['10,000원 이상 구매 시 할인']})],best:{10:wallet20(10000),20:wallet20(3000)},...config});
  await learn(c,[7]);applyCouponPrices({store,date:DATE});
  assert.equal(store.getGoods(3).coupon_price,null);
});
test('quantity wallet coupon never overrides best single-option price',async()=>{
  seed(goods(1,7,12850));
  const c=fakeClient({wallet:[pct(3,30,100000,{min:1,conditions:['상품 3개 이상 구매 시','1원 이상 구매 시']})],best:{10:{couponSno:22,discount:2820}}});
  await learn(c,[7]);applyCouponPrices({store,date:DATE});assert.equal(store.getGoods(1).coupon_price,10030);
});
test('old seller-scope rows and cached prices do not establish current proof',()=>{
  seed(goods(1,7,50000));store.addMarketCoupon(DATE,7,pct(1,20,30000,{scope:'seller'}));
  store.recordMarketCoupon({market_sno:7,date:DATE,coupon_sno:1,mismatch:false});
  applyCouponPrices({store,date:DATE});assert.equal(store.getGoods(1).coupon_price,null);
});
test('market filter leaves other sellers history untouched',()=>{
  seed(goods(1,7,50000),goods(2,8,50000));store.setCouponPrices(new Map([[2,40000]]));
  applyCouponPrices({store,date:DATE,marketSnos:[7]});assert.equal(store.getGoods(2).coupon_price,40000);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM coupon_price_changes WHERE sno=2').get().n,0);
});
test('no token calls nothing; wallet authentication rejection stops safely',async()=>{
  const c=fakeClient();const r=await learnMarketCoupons({client:c,store,date:DATE,marketSnos:[7],memberToken:null});
  assert.equal(r.memberStatus,'none');assert.equal(c.calls.coupons,0);
  assert.equal((await learn(fakeClient({wallet:authErr()}),[7])).memberStatus,'expired');
});
test('wallet server failure rejects and points failure leaves prices independently verifiable',async()=>{
  await assert.rejects(learn(fakeClient({wallet:httpErr(500)}),[7]));
  seed(goods(1,7,50000));const r=await learn(fakeClient({me:httpErr(500)}),[7]);
  assert.equal(r.emoney,null);assert.equal(r.validation.verified,1);
});
test('optionless and failed detail cannot create verified prices',async()=>{
  seed(goods(1,7,50000),goods(2,7,15000));const c=fakeClient({details:{1:httpErr(500),2:{optionSno:null}}});
  const r=await learn(c,[7]);assert.equal(r.validation.verified,0);assert.equal(c.calls.best.length,0);
});
test('deadline prevents new detail requests',async()=>{
  seed(goods(1,7,50000));const c=fakeClient();await learn(c,[7],[],{deadline:0});assert.equal(c.calls.detail.length,0);
});
test('authentication loss in a sample stops later sellers and never logs token',async()=>{
  seed(goods(1,7,50000),goods(2,8,15000));const c=fakeClient({best:{10:authErr()}}),logs=[];
  const r=await learn(c,[7,8],logs);assert.equal(r.memberStatus,'expired');assert.deepEqual(c.calls.detail,[1]);assert.ok(!logs.join('').includes(SECRET));
});
test('concurrency stays bounded and wallet is fetched once',async()=>{
  seed(...[1,2,3,4,5,6].map(n=>goods(n,n,50000)));
  let active=0,peak=0;const c=fakeClient(),original=c.getGoodsDetail;
  c.getGoodsDetail=async sno=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));const d=await original(sno);active--;return d;};
  await learn(c,[1,2,3,4,5,6],[],{concurrency:3});assert.ok(peak<=3);assert.ok(peak>1);assert.equal(c.calls.coupons,1);
});
