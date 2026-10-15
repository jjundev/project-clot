import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store4910 } from '../src/site4910/store.js';
import { syncLiked4910 } from '../src/site4910/liked.js';
import { learnMarketCoupons, applyCouponPrices } from '../src/site4910/coupons.js';

const entry = { item: { sno: 57821918, name: 'harrington' }, logging: { analytics: {} } };
test('liked uses AGLO option and only applied coupons; unknown or other option never produces price', async () => {
  for (const [patch, expected] of [[{ isApplied: true },72110], [{ isApplied: false },null], [{ isApplied: null },null], [{ isApplied: true, optionSno: 2 },null]]) {
    const store = new Store4910(':memory:');
    const client = {
      listLikedGoods: async () => ({ entries: [entry], lastSno: null }),
      getGoodsDetail: async () => ({ priceBasis: 'AGLO', listPrice: 75900, optionSno: 1, isOpen: true }),
      getBestCoupon: async () => ({ optionSno: 1, discount: 3790, ...patch }),
    };
    const result = await syncLiked4910({ client, store, date: '2026-10-16', memberToken: 'test', log() {} });
    assert.equal(store.db.prepare('SELECT member_price FROM liked_price_logs').get().member_price, expected);
    assert.equal(result.validation.verified, expected == null ? 0 : 1);
    store.close();
  }
});

test('seller sample does not expand wallet or grant unsampled listings a coupon', async () => {
  const store = new Store4910(':memory:');
  store.applyScan('2026-10-16', [1,2,3].map(sno => ({ sno, brand_sno: 1, brand: 'b', name: 'a', url: 'x', market_sno: 7, market_name: null, category: null, image_url: null, sale_price: sno === 2 ? 15000 : 12850, original_price: null, discount_rate: null })), { completeBrands: [1] });
  const client = {
    getMyCoupons: async () => [{ couponSno: 3, name: '3개 30%', type: 'PERCENT', percent: 30, min: 1, usable: true, conditions: ['상품 3개 이상 구매 시', '1원 이상 구매 시'] }],
    getMe: async () => ({ emoney: 0 }),
    getGoodsDetail: async sno => ({ sno, priceBasis: 'AGLO', listPrice: 12850, optionSno: sno, isOpen: true }),
    getBestCoupon: async optionSno => ({ couponSno: 22, optionSno, isApplied: true, discount: 2820, percent: 22, min: 1 }),
    getCouponGoodsPage: async () => ({ totalCount: 999999, snos: [], lastSno: null }),
  };
  await learnMarketCoupons({ client, store, date: '2026-10-16', marketSnos: [7], memberToken: 'test', log() {} });
  applyCouponPrices({ store, date: '2026-10-16' });
  assert.equal(store.getGoods(1).coupon_price, 10030);
  assert.equal(store.getGoods(3).coupon_price, null);
  // Only highest/lowest distinct samples qualify; no amount can ever become the quantity-3 9,000 price.
  for (const row of store.getActivePriceRows()) assert.notEqual(store.getGoods(row.sno).coupon_price, 9000);
  store.close();
});
