import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { MusinsaWideStore } from '../src/musinsaWide/store.js';
import { resumeMusinsaPricing } from '../src/musinsaWide/recover.js';
import { verifyDailyCoverage } from '../src/musinsaWide/coverage.js';
const date='2026-10-16';
test('pricing recovery requires a saved full scan and only reconciled empty exceptions',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clot-recovery-'));const store=new MusinsaWideStore(path.join(dir,'db'));
 try {
 const args={store,date,makeClient:()=>({sleep:async()=>{},getCouponGoodsCount:async()=>0,getCouponGoodsPage:async()=>({items:[],totalCount:0,hasNext:false})}),log:()=>{}};
 await assert.rejects(resumeMusinsaPricing(args),/scan|run/i);
 const cats=['001','002','003','103','004'];
 for(let i=0;i<cats.length;i++)store.applyScan(date,Array.from({length:60000},(_,j)=>({goods_no:i*60000+j+1,cat:cats[i],name:'g',url:'https://www.musinsa.com/products/1',sale_price:10000,normal_price:10000})),{cat:cats[i],complete:true});
 store.setMeta('backfill_done',date);
 store.upsertMemberCoupons(date,[{id:'10',name:'c',type:'PERCENT',percent:10,max:null,min:0,until:'2030-01-01'}]);
 store.putGoodsCoupons(1,date,[{id:'10',type:'PERCENT',percent:10}],{sale_price:10000,extra_discount:0});
 const save=walk=>store.recordScanRun({date,categoryCounts:cats.map(cat=>({cat,scanned:60000,pages:1000,complete:true,problems:[]})),complete:true,changed:0,added:0,outOfScope:0,durationMs:1000,couponMetrics:{walk,sample:{checked:1,exact:0},counts:{usable:1},classify:{calls:0}}});
 store.replaceCouponGoods(10,'2026-10-15',[2]); // retained conflicting map must not hide the exception
 store.upsertMemberCoupons(date,[{id:'20',name:'expired',type:'PERCENT',percent:5,until:'2026-10-15'},{id:'30',name:'retired',type:'PERCENT',percent:5,until:'2030-01-01'}]);
 store.db.prepare("UPDATE coupons SET state='RETIRED' WHERE coupon_no=30").run();
 store.replaceCouponGoods(20,'2026-10-15',[2]);store.replaceCouponGoods(30,'2026-10-15',[3]);
 const w={requested:1,walked:0,failed:1,suspectEmpty:1,remaining:1,complete:false,stop:null};
 save({...w,stop:'deadline'});await assert.rejects(resumeMusinsaPricing(args),/incomplete|recover/i);
 save(w);await assert.rejects(resumeMusinsaPricing({...args,makeClient:()=>({...args.makeClient(),getCouponGoodsCount:async()=>1})}),/reconcile|exception/i);
 save(w);const before=store.getMeta('member_budget');const r=await resumeMusinsaPricing(args);
 assert.equal(r.registry.pricing.direct,1);assert.equal(r.registry.pricing.estimated,299999);
 assert.deepEqual(r.registry.walk.exceptions,[10]);assert.equal(r.registry.walk.complete,false);assert.equal(r.registry.walk.failed,0);
 assert.equal(store.getGoods(1).coupon_price,9000);assert.equal(store.getGoods(1).coupon_price_source,'DIRECT');assert.equal(store.getGoods(2).coupon_price_source,'ESTIMATED');
 assert.equal(store.getMeta('member_budget'),before);
 const run=store.db.prepare('select * from scan_runs where date=?').get(date);assert.equal(verifyDailyCoverage(run).selected,300000);
 assert.equal(r.registry.recovery.sourceDurationMs,1000);
 const again=await resumeMusinsaPricing(args);
 assert.equal(again.registry.recovery.sourceDurationMs,1000);
 assert.equal(again.registry.recovery.sourceCompletedAt,r.registry.recovery.sourceCompletedAt);
 } finally {store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
