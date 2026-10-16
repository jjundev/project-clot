import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effective4910Price } from '../src/site4910/price-validation.js';
import { Store4910 } from '../src/site4910/store.js';
import { buildScan4910Payload } from '../src/visualizer.js';
const raw = { member_price: 81410, coupon_price: 72420, list_price: 85200 };
test('invalid, unverified and legacy rows cannot fall back to public coupon prices', () => {
  for (const validation of [null,{status:'invalid'},{status:'unverified'}]) assert.equal(effective4910Price({raw,validation}),null);
  assert.equal(effective4910Price({raw,validation:{status:'verified'}}),81410);
  assert.equal(effective4910Price({raw,validation:{status:'corrected',corrected_json:'{"member_price":72110}'}}),72110);
});
test('unvalidated prior prices never generate a drop baseline; updates are idempotent',()=>{
  const s=new Store4910(':memory:');
  s.logLikedPrice({sno:1,date:'2026-10-15',...raw});
  assert.equal(s.getPrevLikedPrice(1,'2026-10-16'),null);
  s.putPriceValidation({kind:'liked',sno:1,date:'2026-10-15',status:'corrected',reason:'fixture',corrected:{member_price:72110}});
  assert.equal(s.getPrevLikedPrice(1,'2026-10-16').member_price,72110);
  s.putPriceValidation({kind:'liked',sno:1,date:'2026-10-15',status:'invalid',reason:'fixture'});
  assert.equal(s.getPrevLikedPrice(1,'2026-10-16'),null);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM price_validations').get().n,1);
  assert.equal(s.db.prepare('SELECT member_price FROM liked_price_logs').get().member_price,81410);
  s.close();
});
test('scan coupon history cannot resurrect invalid prices via carry',()=>{
  const s=new Store4910(':memory:');
  s.applyScan('2026-10-14',[{sno:1,brand_sno:1,brand:'b',name:'a',url:'x',market_sno:1,market_name:null,category:null,image_url:null,sale_price:85200,original_price:null,discount_rate:null}],{completeBrands:[1]});
  s.logCouponPriceChanges('2026-10-14',[{sno:1,sale_price:85200,coupon_price:81410}]);
  s.recordScanRun({date:'2026-10-16',complete:true,brandCounts:[],changed:0,added:0,dropped:0,durationMs:1,couponsOk:true});
  assert.ok(buildScan4910Payload(s.db).r[0][7].every(r=>r[3]===null));
  s.putPriceValidation({kind:'scan',sno:1,date:'2026-10-14',status:'corrected',reason:'fixture',corrected:{coupon_price:72110,sale_price:85200}});
  assert.equal(buildScan4910Payload(s.db).r[0][7][0][3],72110);
  s.putPriceValidation({kind:'scan',sno:1,date:'2026-10-14',status:'invalid',reason:'fixture'});
  assert.ok(buildScan4910Payload(s.db).r[0][7].every(r=>r[3]===null));s.close();
});

test('corrected AGLO scan base survives merging against a different raw basis',()=>{
  const s=new Store4910(':memory:');
  s.applyScan('2026-10-15',[{sno:1,brand_sno:1,brand:'b',name:'a',url:'x',market_sno:1,market_name:null,category:null,image_url:null,sale_price:85200,original_price:90000,discount_rate:null}],{completeBrands:[1]});
  s.logCouponPriceChanges('2026-10-15',[{sno:1,sale_price:85200,coupon_price:81410}]);
  s.putPriceValidation({kind:'scan',sno:1,date:'2026-10-15',status:'corrected',reason:'evidence',corrected:{sale_price:75900,coupon_price:72110}});
  assert.deepEqual(buildScan4910Payload(s.db).r[0][7][0],['2026-10-15',90000,75900,72110]);
  assert.equal(s.getGoods(1).sale_price,85200);s.close();
});
