import './setup-env.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MusinsaWideStore} from '../src/musinsaWide/store.js';
import {Store4910} from '../src/site4910/store.js';
import {createDashboardModel} from '../src/dashboard-model.js';
import {createObservationStore} from '../src/price-observation.js';
import {ClotDatabase} from '../src/db.js';
import {exportDashboardBase} from '../src/dashboard-base.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateDashboardHtml} from '../src/visualizer.js';
import {verifyDashboardBuild} from '../scripts/verify-dashboard-build.js';

const model=createDashboardModel(), now=Date.parse('2026-10-25T10:00:00Z');
const evidence=(status='ACTIVE')=>({status,seenAt:'2026-10-25T09:00:00Z',saleAt:'2026-10-25T09:00:00Z',samples:[
 {date:'2026-10-24',at:'2026-10-24T09:00:00Z',price:100,basis:'DIRECT'},
 {date:'2026-10-25',at:'2026-10-25T09:00:00Z',price:80,basis:'DIRECT'},
]});
const raw=(tracking=evidence())=>({n:1,src:'musinsa',kind:'wide',s:'ACTIVE',tracking,L:[
 ['2026-10-24',200,100,100,0,'직접 확인가',0,null,'DIRECT'],
 ['2026-10-25',200,80,80,0,'직접 확인가',0,null,'DIRECT'],
]});
test('fresh prices signal; retained, expired and unknown evidence fail closed',()=>{
 for(const [tracking,low,drop] of [[evidence(),true,20],[evidence('RETAINED'),false,0],[null,false,0]]){
  const x=model.summarize(raw(tracking),{asOfMs:now});
  assert.equal(x.isLow,low);assert.equal(x.dropAmt,drop);
 }
 const x=model.summarize(raw(),{asOfMs:now+49*3600000});
 assert.equal(x.isLow,false);assert.equal(x.dropAmt,0);
});
test('queries hide history by default and expire signals without rebuilding',()=>{
 const x=model.summarize(raw(),{asOfMs:now});
 assert.equal(model.queryCatalog([x],{}, {asOfMs:now}).total,1);
 assert.equal(model.queryCatalog([x],{}, {asOfMs:now+49*3600000}).total,0);
 const q=model.queryCatalog([x],{includeHistory:true},{asOfMs:now+49*3600000});
 assert.equal(q.total,1);assert.equal(q.quick.lowest,0);assert.equal(q.quick.drop,0);
});
test('new, mismatched and distant price samples cannot produce drop/lowest signals',()=>{
 for(const change of [t=>t.samples.splice(0,1),t=>t.samples[0].basis='ESTIMATED',t=>t.samples[0].at='2026-10-20T09:00:00Z',t=>t.samples[1].price=70]){
  const t=evidence();change(t);const x=model.summarize(raw(t),{asOfMs:now});assert.equal(x.dropAmt,0);
 }
 const t=evidence();t.samples.splice(0,1);assert.equal(model.summarize(raw(t),{asOfMs:now}).isLow,false);
 const transition=evidence();transition.samples[0].basis='ESTIMATED';assert.equal(model.summarize(raw(transition),{asOfMs:now}).isLow,false);
});
test('wide scans persist sightings independently of change-only history',()=>{
 const s=new MusinsaWideStore(':memory:');
 const row={goods_no:1,cat:'001',name:'test',url:'u',sale_price:100,normal_price:200};
 s.applyScan('2026-10-24',[row],{cat:'001',complete:true,observedAt:'2026-10-24T09:00:00Z'});
 s.applyScan('2026-10-25',[row],{cat:'001',complete:true,observedAt:'2026-10-25T09:00:00Z'});
 let t=JSON.parse(s.getGoods(1).observation_json);
 assert.equal(t.seenAt,'2026-10-25T09:00:00Z');assert.equal(t.saleAt,t.seenAt);
 assert.equal(s.db.prepare('select count(*) n from price_changes').get().n,1);
 s.applyScan('2026-10-25',[{...row,sale_price:null}],{cat:'001',observedAt:'2026-10-25T10:00:00Z'});
 t=JSON.parse(s.getGoods(1).observation_json);
 assert.equal(t.seenAt,'2026-10-25T10:00:00Z');assert.equal(t.saleAt,'2026-10-25T09:00:00Z');
 s.close();
});
test('4910 unchanged listings persist actual price sightings too',()=>{
 const s=new Store4910(':memory:');
 const row={sno:1,brand_sno:1,brand:'b',name:'test',market_sno:1,market_name:'m',category:'top',url:'u',image_url:'',sale_price:100,original_price:200,discount_rate:50};
 s.applyScan('2026-10-24',[row],{completeBrands:[1],observedAt:'2026-10-24T09:00:00Z'});
 s.applyScan('2026-10-25',[row],{completeBrands:[1],observedAt:'2026-10-25T09:00:00Z'});
 const t=JSON.parse(s.getGoods(1).observation_json);
 assert.equal(t.saleAt,'2026-10-25T09:00:00Z');
 assert.equal(s.db.prepare('select count(*) n from price_changes').get().n,1);
 s.close();
});
test('same-day prices replace the sample and recalculation cannot refresh evidence',()=>{
 const s=new MusinsaWideStore(':memory:');
 const r={goods_no:1,cat:'001',name:'test',url:'u',sale_price:100,normal_price:200};
 const o=createObservationStore(s.db,{key:'goods_no'});
 for(const [date,at,price] of [['2026-10-24','2026-10-24T09:00:00Z',100],['2026-10-25','2026-10-25T09:00:00Z',90],['2026-10-25','2026-10-25T10:00:00Z',80]]){
  s.applyScan(date,[r],{cat:'001',complete:true,observedAt:at});o.price(1,{date,at,price,basis:'DIRECT',verifiedAt:at});
 }
 let t=o.get(1);assert.equal(t.samples.length,2);assert.equal(t.samples[0].price,100);assert.equal(t.samples[1].price,80);
 t=o.price(1,{date:'2026-10-26',at:'2026-10-26T10:00:00Z',price:80,basis:'ESTIMATED'});
 assert.equal(t.saleAt,'2026-10-25T10:00:00Z');assert.equal(t.samples.at(-1).at,'2026-10-25T10:00:00.000Z');
 assert.equal(model.priceSignalEligibility(t,{price:80,asOfMs:now+72*3600000}).fresh,false);
 s.close();
});
test('a return after a missed scan resets comparison evidence',()=>{
 const s=new MusinsaWideStore(':memory:');
 const r={goods_no:1,cat:'001',name:'test',url:'u',sale_price:100,normal_price:200};
 s.applyScan('2026-10-23',[r],{cat:'001',complete:true,observedAt:'2026-10-23T09:00:00Z'});
 s.applyScan('2026-10-24',[],{cat:'001',complete:true,observedAt:'2026-10-24T09:00:00Z'});
 const d=s.applyScan('2026-10-25',[{...r,sale_price:80}],{cat:'001',complete:true,observedAt:'2026-10-25T09:00:00Z'});
 assert.equal(d.drops.length,0);assert.equal(s.observations.get(1).saleSamples.length,1);s.close();
});
test('base retries timestamp new prices without renewing a carried member price',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-25T09:00:00Z')});
 const db=new ClotDatabase(':memory:');
 db.upsertItem({goods_no:1,goods_name:'test',url:'u',source:'like'});
 db.recordPriceLog({goods_no:1,date:'2026-10-25',sale_price:100,my_price:80});
 const first=db.getLatestPrice(1);t.mock.timers.tick(3600000);
 db.recordPriceLog({goods_no:1,date:'2026-10-25',sale_price:100,my_price:null});
 let row=db.getLatestPrice(1);assert.equal(row.my_observed_at,first.my_observed_at);assert.notEqual(row.sale_observed_at,first.sale_observed_at);
 t.mock.timers.tick(3600000);db.recordPriceLog({goods_no:1,date:'2026-10-25',sale_price:100,my_price:70});
 row=db.getLatestPrice(1);assert.equal(row.my_observed_at,'2026-10-25T11:00:00.000Z');db.close();
});
test('inactive likes cannot shadow a currently tracked 4910 listing',()=>{
 const db=new ClotDatabase(':memory:'),s=new Store4910(':memory:');
 s.syncLiked([{sno:1,name:'test',brand:'b',url:'u'}],'2026-10-24');
 s.db.prepare("UPDATE liked_goods SET status='UNLIKED'").run();
 s.applyScan('2026-10-25',[{sno:1,brand_sno:1,brand:'b',name:'test',market_sno:1,market_name:'m',category:'top',url:'u',image_url:'',sale_price:100,original_price:200,discount_rate:50}],{completeBrands:[1]});
 const items=[];exportDashboardBase(db,{db4910:s.db,sink:{add:x=>items.push(x)}});
 assert.equal(items.length,0);db.close();s.close();
});
test('production build preserves explicit tracking and archives obsolete discovery without duplicates',t=>{
 t.mock.timers.enable({apis:['Date'],now});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clot-fresh-build-')),base=new ClotDatabase(':memory:'),wide=new MusinsaWideStore(path.join(dir,'wide.db'));
 t.after(()=>{base.close();wide.close();fs.rmSync(dir,{recursive:true,force:true});});
 for(const [goods_no,source] of [[1,'like'],[2,'discovery'],[3,'discovery']]){
  base.upsertItem({goods_no,goods_name:'item '+goods_no,url:'u',source});
  base.recordPriceLog({goods_no,date:'2026-10-25',normal_price:200,sale_price:100,my_price:70});
 }
 wide.applyScan('2026-10-25',[1,2].map(goods_no=>({goods_no,cat:'001',name:'wide '+goods_no,url:'u',sale_price:100,normal_price:200})),{cat:'001',complete:true,observedAt:'2026-10-25T09:00:00Z'});
 wide.db.prepare("UPDATE goods SET status='OUT_OF_SCOPE' WHERE goods_no=2").run();
 const internal={...wide.observations.get(2),privateDebug:'SHOULD_NOT_EXPORT'};
 wide.db.prepare('UPDATE goods SET observation_json=? WHERE goods_no=2').run(JSON.stringify(internal));
 wide.recordScanRun({date:'2026-10-25',categoryCounts:[],complete:true,changed:0,added:2,outOfScope:1,durationMs:1,couponsOk:false,couponChecks:0});
 generateDashboardHtml({db:base,dbMusinsaPath:path.join(dir,'wide.db'),db4910Path:null,outputPath:path.join(dir,'index.html'),openBrowser:false,asOfMs:now});
 const html=fs.readFileSync(path.join(dir,'index.html'),'utf8'),D=JSON.parse(html.match(/window\.__CLOT_DATA__ = ([^\n]+);/)[1]);
 assert.equal(D.catalog.totalItems,3);assert.deepEqual(D.items.map(x=>[x.k,x.my]),[['musinsa:1',70]]);
 assert.equal(D.catalog.bootstrap.quick.lowest,0);assert.equal(D.catalog.bootstrap.quick.drop,0);
 for(const file of fs.readdirSync(path.join(dir,'assets')))assert.equal(fs.readFileSync(path.join(dir,'assets',file),'utf8').includes('SHOULD_NOT_EXPORT'),false);
 t.mock.timers.tick(49*3600000);
 assert.equal(verifyDashboardBuild(path.join(dir,'index.html')).totalItems,3);
});
test('scan sale alerts compare with the previous day across same-day retries',()=>{
 for(const kind of ['musinsa','4910']){
  const s=kind==='musinsa'?new MusinsaWideStore(':memory:'):new Store4910(':memory:');
  const row=price=>kind==='musinsa'?{goods_no:1,cat:'001',name:'test',url:'u',sale_price:price,normal_price:20000}:{sno:1,brand_sno:1,brand:'b',name:'test',market_sno:1,market_name:'m',category:'top',url:'u',image_url:'',sale_price:price,original_price:20000,discount_rate:0};
  const scan=(date,price,at)=>s.applyScan(date,[row(price)],{cat:'001',complete:true,completeBrands:[1],observedAt:at});
  scan('2026-10-24',10000,'2026-10-24T09:00:00Z');
  assert.equal(scan('2026-10-25',9500,'2026-10-25T09:00:00Z').drops.length,0);
  for(const [intermediate,at] of [[9000,'10'],[12000,'11'],[9000,'12']]){
   const d=scan('2026-10-25',intermediate,`2026-10-25T${at}:00:00Z`);
   if(intermediate===12000)assert.equal(d.drops.length,0);
   else {assert.equal(d.drops.length,1);assert.equal(d.drops[0].prevPrice,10000);assert.equal(d.drops[0].dropRate,10);}
  }
  s.close();
 }
});
