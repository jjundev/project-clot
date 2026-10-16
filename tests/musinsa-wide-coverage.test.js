import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDailyCoverage } from '../src/musinsaWide/coverage.js';
const run = () => ({ complete: 1, category_counts_json: JSON.stringify(['001','002','003','103','004'].map(cat=>({cat,scanned:60000,complete:true}))), coupon_metrics_json: JSON.stringify({walk:{requested:3,walked:3,remaining:0,failed:0,complete:true,stop:null},pricing:{policy:'confirmed-benefits-estimate-v1',priced:300000,direct:2,estimated:299998,active:300000,unpriced:0,exceptionCoupons:[]}}) });
test('daily coverage requires a full unique scope and all coupon lists completed',()=>{
  assert.equal(verifyDailyCoverage(run()).selected,300000);
  for(const patch of [{complete:0},{category_counts_json:'[]'},{coupon_metrics_json:null},{coupon_metrics_json:JSON.stringify({walk:{requested:3,walked:2,remaining:1,failed:0,complete:false,stop:'deadline'}})}])assert.throws(()=>verifyDailyCoverage({...run(),...patch}));
});
test('daily coverage rejects duplicate roots, a short target and failed lists',()=>{
  const counts=JSON.parse(run().category_counts_json);counts[4].cat='001';
  assert.throws(()=>verifyDailyCoverage({...run(),category_counts_json:JSON.stringify(counts)}));
  const short=JSON.parse(run().category_counts_json);short[0].scanned--;
  assert.throws(()=>verifyDailyCoverage({...run(),category_counts_json:JSON.stringify(short)}));
  assert.throws(()=>verifyDailyCoverage({...run(),coupon_metrics_json:JSON.stringify({walk:{requested:3,walked:3,complete:true,failed:1,remaining:0}})}));
});

test('only reconciled terminal-empty exceptions may qualify estimate coverage',async()=>{
 const {pricingCoverage}=await import('../src/musinsaWide/coverage.js');
 const w={requested:3,walked:2,failed:0,remaining:1,complete:false,suspectEmpty:1,exceptions:[10],stop:null};
 assert.deepEqual(pricingCoverage(w),{coverage:'estimate-with-exceptions',exceptionCoupons:[10]});
 for(const patch of [{failed:1},{stop:'deadline'},{requested:4},{exceptions:[10,10]},{exceptions:[NaN]},{exceptions:[]},{complete:true},{failedCoupons:[10]}])assert.throws(()=>pricingCoverage({...w,...patch}));
});
