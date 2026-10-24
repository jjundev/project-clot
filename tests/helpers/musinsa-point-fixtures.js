export const AS_OF = Date.parse('2026-10-24T10:00:00Z');
export const CHECKED = '2026-10-24T09:00:00.000Z';
export function rawPointPolicy(overrides = {}) {
  return {meta:{result:'SUCCESS'},data:{goodsNo:2156295,isRestictedUsePoint:false,maxUsePointRate:0.07,
    isLimitedDc:true,isLimitedPoint:false,isOutlet:false,goodsPrice:{salePrice:263200,extraDiscountAmount:0},...overrides}};
}
export function pointPolicy(overrides = {}) {
  return {goodsNo:2156295,restricted:false,maxUseRate:0.07,observedSalePrice:263200,observedExtraDiscount:0,checkedAt:CHECKED,...overrides};
}
export function couponBasis(overrides = {}) {
  return {goodsNo:2156295,status:'ACTIVE',salePrice:263200,extraDiscount:0,couponPrice:248200,couponSource:'ESTIMATED',...overrides};
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MusinsaWideStore} from '../../src/musinsaWide/store.js';
import {PointPolicyStore} from '../../src/musinsaWide/point-store.js';
export function makePointStoreFixture(t, {initialize=true}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clot-points-'));
  const dbPath=path.join(dir,'wide.db'),wide=new MusinsaWideStore(dbPath),db=wide.db;
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  function addGoods(overrides={}) {
    const g={goods_no:2156295,name:'코트',url:'https://www.musinsa.com/products/2156295',status:'ACTIVE',sale_price:263200,
      normal_price:329000,extra_discount:0,coupon_price:248200,coupon_price_source:'ESTIMATED',first_seen_date:'2026-10-24',...overrides};
    const keys=Object.keys(g);db.prepare(`INSERT OR REPLACE INTO goods (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>g[k]));return g;
  }
  return {dir,dbPath,wide,db,points:new PointPolicyStore(db,{initialize}),addGoods};
}
