import './setup-env.js';
import {freshTracking} from './helpers/dashboard-fixture.js';
import {createDashboardScope} from "../src/dashboard-scope.js";
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';
import {MusinsaWideStore} from '../src/musinsaWide/store.js';
import {buildMusinsaCatalog} from '../src/dashboard-musinsa.js';
import {createDashboardIndex} from '../src/dashboard-index.js';import {createHistoryLoader} from '../src/dashboard-history.js';import {createDashboardTransport} from '../src/dashboard-worker.js';
import {createDashboardModel} from '../src/dashboard-model.js';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'web-musinsa-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new MusinsaWideStore(path.join(dir,'wide.db'));t.after(()=>store.close());
for(const [n,source,price] of [[1,'DIRECT',80],[2,'ESTIMATED',70]]){
store.db.prepare("INSERT INTO goods(goods_no,cat,name,url,brand_name,sale_price,normal_price,coupon_price,coupon_price_source,first_seen_date,coupons_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(n,'001','상품 '+n,'https://www.musinsa.com/products/'+n,'브랜드',100,200,price,source,'2026-10-15','SECRET_PRIVATE_RESPONSE');
store.db.prepare("INSERT INTO price_changes(goods_no,date,sale_price,normal_price,event) VALUES(?,?,?,?,?)").run(n,'2026-10-15',100,200,'NEW');
store.db.prepare('INSERT INTO coupon_price_changes VALUES(?,?,?,?,?)').run(n,'2026-10-15',90,50,'DIRECT');
}
store.db.prepare('INSERT INTO scan_runs(date,complete,completed_at,category_counts_json,coupon_metrics_json) VALUES(?,?,?,?,?)').run('2026-10-16',1,'2026-10-16T04:50:00Z','[]',JSON.stringify({pricing:{exceptionCoupons:[354317]}}));
for(const g of store.db.prepare('SELECT goods_no,coupon_price,coupon_price_source FROM goods').all())store.db.prepare('UPDATE goods SET observation_json=? WHERE goods_no=?').run(JSON.stringify(freshTracking(g.coupon_price,g.coupon_price_source)),g.goods_no);
return {dir,store};}
test('wide catalog exports current prices, dated source and separate private-free history shards',t=>{
const {dir,store}=fixture(t);const p=buildMusinsaCatalog(store.db,{outDir:dir,revision:'rev'});
assert.equal(p.metadata.active,2);assert.deepEqual(p.metadata.exceptionCoupons,[354317]);assert.deepEqual([...p.goodsIds],[1,2]);
const w={};for(const ref of p.parts)vm.runInNewContext(fs.readFileSync(path.join(dir,ref.path),'utf8'),{window:w});
const items=Object.values(w.__CLOT_CATALOG_PARTS__).flatMap(p=>p.items);assert.equal(items.length,2);
assert.equal(items[0].my,80);assert.equal(items[0].priceSource,'DIRECT');assert.equal(items[0].observedDate,'2026-10-16');
assert.equal(items[1].my,70);assert.equal(items[1].priceSource,'ESTIMATED');assert.equal(items[1].isLow,false);assert.equal(items[1].dropAmt,0);
assert.equal(items[0].detail.type,'musinsa');assert.equal(JSON.stringify(items).includes('SECRET'),false);
const ref=items[0].detail;vm.runInNewContext(fs.readFileSync(path.join(dir,ref.path),'utf8'),{window:w});const L=w.__CLOT_MUSINSA_H__[ref.id].histories['musinsa:1'];
assert.equal(L[0][3],100); // historical coupon sale basis differs: do not use stale 50
assert.equal(L.at(-1)[3],80);assert.equal(L.at(-1)[8],'DIRECT');assert.equal(JSON.stringify(L).includes('SECRET'),false);
});
test('wide estimates cannot become confirmed lows or drops across source transitions',()=>{
const model=createDashboardModel();const raw={n:1,src:'musinsa',kind:'wide',L:[['2026-10-15',200,100,90,0,'직접 확인 가격',10,null,'DIRECT'],['2026-10-16',200,100,70,0,'추정가',30,null,'ESTIMATED']]};
const x=model.summarize(raw);assert.equal(x.priceSource,'ESTIMATED');assert.equal(x.isLow,false);assert.equal(x.dropAmt,0);
});
test('generated dashboard replaces duplicate watched Musinsa price and loads wide histories',async t=>{
const {dir,store}=fixture(t);const {DatabaseSync}=await import('node:sqlite');const {generateDashboardHtml}=await import('../src/visualizer.js');const {verifyDashboardBuild}=await import('../scripts/verify-dashboard-build.js');const {createDashboardRuntime}=await import('../src/dashboard-runtime.js');
const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("CREATE TABLE items(goods_no INTEGER,goods_name TEXT,brand_name TEXT,url TEXT,image_url TEXT,status TEXT,first_seen_at TEXT,last_checked_at TEXT);CREATE TABLE price_logs(id INTEGER,goods_no INTEGER,date TEXT,normal_price INTEGER,sale_price INTEGER,my_price INTEGER,is_sold_out INTEGER,coupon_name TEXT,coupon_discount INTEGER);INSERT INTO items VALUES(1,'old','old','','','ACTIVE','','');INSERT INTO price_logs VALUES(1,1,'2026-10-15',200,100,99,0,'old',1)");
const output=path.join(dir,'index.html');generateDashboardHtml({db,db4910Path:null,dbMusinsaPath:path.join(dir,'wide.db'),outputPath:output,openBrowser:false});
const html=fs.readFileSync(output,'utf8'),D=JSON.parse(html.match(/window\.__CLOT_DATA__ = ([^\n]+);/)[1]);
assert.equal(D.items.find(x=>x.k==='musinsa:1').my,80);assert.equal(D.musinsa.active,2);assert.equal(D.catalog.scanCount,2);
const runtime=createDashboardRuntime({model:createDashboardModel(),manifest:D.catalog,indexFactory:createDashboardIndex,scopeFactory:createDashboardScope,historyFactory:createHistoryLoader,transportFactory:createDashboardTransport,loadAsset:async ref=>{const w={};const text=fs.readFileSync(path.join(dir,ref.path),'utf8');vm.runInNewContext(text,w);return {payload:w.__CLOT_ASSETS__[ref.id],bytes:Buffer.byteLength(text)};}});
await runtime.start();assert.equal(runtime.getState().status,'ready');assert.equal((await runtime.lookup('1')).my,80);assert.equal((await runtime.getHistory('1')).rows.at(-1)[3],80);
assert.equal(verifyDashboardBuild(output).totalItems,2);
});
test('change-only source persists across a successful pricing day without inventing provenance on failed days',t=>{
const {dir,store}=fixture(t);
store.db.prepare("UPDATE goods SET coupon_price=80,coupon_price_source='DIRECT' WHERE goods_no=1").run();
store.db.prepare("DELETE FROM coupon_price_changes WHERE goods_no=1").run();
store.db.prepare('INSERT INTO coupon_price_changes VALUES(?,?,?,?,?)').run(1,'2026-10-12',100,80,'DIRECT');
for(const date of ['2026-10-12','2026-10-13','2026-10-14'])store.db.prepare("INSERT INTO price_changes(goods_no,date,sale_price,normal_price,event) VALUES(?,?,?,?,?)").run(1,date,100,200,'PRICE');
store.db.prepare('INSERT INTO scan_runs(date,complete,completed_at,coupons_ok) VALUES(?,?,?,?)').run('2026-10-13',1,'2026-10-13',1);
const p=buildMusinsaCatalog(store.db,{outDir:dir,revision:'rev'}),w={};vm.runInNewContext(fs.readFileSync(path.join(dir,'musinsa/h0.js'),'utf8'),{window:w});
const L=w.__CLOT_MUSINSA_H__.h0.histories['musinsa:1'];
assert.equal(L.find(r=>r[0]==='2026-10-13')[8],'DIRECT');
assert.notEqual(L.find(r=>r[0]==='2026-10-14')[8],'DIRECT');
});
test('public brand code survives adapter, builder, card and compact search',async t=>{
 const {dir,store}=fixture(t);
 store.db.prepare("UPDATE goods SET brand='kimuir',brand_name='키뮤어',name='캐시미어블렌드 코트' WHERE goods_no=1").run();
 const {createDashboardBuilder}=await import('../src/dashboard-builder.js');
 const builder=createDashboardBuilder({outDir:dir,revision:'alias'});
 buildMusinsaCatalog(store.db,{outDir:dir,revision:'alias',sink:builder});
 const data=builder.finish({scanState:'complete'}),model=createDashboardModel(),idx=createDashboardIndex(model);
 const read=ref=>{const ctx={};vm.runInNewContext(fs.readFileSync(path.join(dir,ref.path),'utf8'),ctx);return JSON.parse(JSON.stringify(ctx.__CLOT_ASSETS__[ref.id]));};
 const rows=data.catalog.indexParts.flatMap(ref=>idx.unpackIndex(read(ref)));
 const result=model.queryCatalog(rows,{q:'kimuir 캐시미어'});
 assert.equal(result.total,1);assert.equal(result.items[0].b,'키뮤어');assert.equal(result.items[0].my,80);assert.equal(result.items[0].priceSource,'DIRECT');
 const card=read(result.items[0].card).items.find(x=>x.k==='musinsa:1');
 assert.deepEqual(card.searchAliases,['kimuir']);assert.equal(JSON.stringify(data).includes('SECRET'),false);
});

import {makePointStoreFixture,pointPolicy,validPointScanRun,AS_OF} from './helpers/musinsa-point-fixtures.js';
import {refreshPointEstimates} from '../src/musinsaWide/point-pricing.js';
test('별도 예상가는 기본 가격 판정을 바꾸지 않는다 / read-only build와 만료',t=>{
 const {dir,db,points,addGoods}=makePointStoreFixture(t);addGoods({observation_json:JSON.stringify(freshTracking(248200,'ESTIMATED',{at:AS_OF}))});points.savePolicy(pointPolicy());validPointScanRun(db);
 refreshPointEstimates({db,asOfMs:AS_OF,enabled:true});
 const build=options=>{let item;const p=buildMusinsaCatalog(db,{outDir:dir,revision:'point',asOfMs:AS_OF,sink:{add(x){item=x;}},...options});return {item,p};};
 const old=build({pointEstimatesEnabled:false}).item,before=db.prepare('SELECT * FROM point_price_changes').all();
 const {item,p}=build({pointEstimatesEnabled:true});assert.equal(item.my,248200);assert.equal(item.pointEstimate,230830);assert.equal(item.pointDiscount,17370);
 for(const key of ['L','my','dropAmt','isLow','rate','priceSource'])assert.deepEqual(item[key],old[key]);
 assert.deepEqual(p.metadata.points,{enabled:true,active:1,eligible:1,restricted:0,unknown:0,attemptedToday:0,lastStop:null});
 assert.deepEqual(db.prepare('SELECT * FROM point_price_changes').all(),before);assert.equal(old.pointEstimate,null);
 assert.equal(build({pointEstimatesEnabled:true,asOfMs:AS_OF+604800000}).item.pointEstimate,null);
});
test('summary 전달 경로 일치: card asset·preview·route',async t=>{
 const {dir,db,points,addGoods}=makePointStoreFixture(t);addGoods({observation_json:JSON.stringify(freshTracking(248200,'ESTIMATED',{at:AS_OF}))});points.savePolicy(pointPolicy());validPointScanRun(db);refreshPointEstimates({db,asOfMs:AS_OF,enabled:true});
 const {createDashboardBuilder}=await import('../src/dashboard-builder.js');const builder=createDashboardBuilder({outDir:dir,revision:'points',asOfMs:AS_OF});
 buildMusinsaCatalog(db,{outDir:dir,revision:'points',sink:builder,pointEstimatesEnabled:true,asOfMs:AS_OF});
 const data=builder.finish({scanState:'complete'}),read=ref=>{const ctx={};vm.runInNewContext(fs.readFileSync(path.join(dir,ref.path),'utf8'),ctx);return JSON.parse(JSON.stringify(ctx.__CLOT_ASSETS__[ref.id]));};
 const index=createDashboardIndex(createDashboardModel()),indexed=data.catalog.indexParts.flatMap(ref=>index.unpackIndex(read(ref)))[0];
 const card=read(indexed.card).items[0],preview=data.catalog.previewItems[0];
 const route=Object.values(data.catalog.routes).flat().flatMap(ref=>read(ref).entries).find(([key])=>key===card.k);
 const routed=read(route[1]).items.find(x=>x.k===card.k);
 for(const key of ['pointEstimate','pointDiscount','pointState','pointCheckedAt','pointMaxUseRate']){assert.equal(card[key],preview[key]);assert.equal(card[key],routed[key]);assert.equal(card[key],indexed[key]);}
 assert.equal(card.pointEstimate,230830);
});
test('30만 ACTIVE build의 적립금 읽기는 상품 수만큼 SQL을 만들지 않는다',t=>{
 const {dir,db,points}=makePointStoreFixture(t);validPointScanRun(db);points.savePolicy(pointPolicy({goodsNo:1}));
 db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300000)
 INSERT INTO goods(goods_no,name,url,cat,status,sale_price,normal_price,extra_discount,coupon_price,coupon_price_source,first_seen_date)
 SELECT x,'상품','https://www.musinsa.com','001','ACTIVE',263200,329000,0,248200,'ESTIMATED','2026-10-24' FROM n`);
 refreshPointEstimates({db,asOfMs:AS_OF,enabled:true});let queries=0,count=0;
 const spy=new Proxy(db,{get(target,key){if(key==='prepare')return sql=>{if(/goods_point_policy|point_price_changes|sqlite_master/.test(sql))queries++;return target.prepare(sql);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 const result=buildMusinsaCatalog(spy,{outDir:dir,revision:'scale',pointEstimatesEnabled:true,asOfMs:AS_OF,sink:{add(){count++;}}});
 assert.equal(count,300000);assert.equal(result.metadata.points.active,300000);assert.equal(result.metadata.points.eligible,1);assert.ok(queries<=10,`${queries} point SQL statements`);
});
async function buildCoverage(t,dir,extraSql=''){const {DatabaseSync}=await import('node:sqlite');const {generateDashboardHtml}=await import('../src/visualizer.js');
const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("CREATE TABLE items(goods_no INTEGER,goods_name TEXT,brand_name TEXT,url TEXT,image_url TEXT,status TEXT,first_seen_at TEXT,last_checked_at TEXT);CREATE TABLE price_logs(id INTEGER,goods_no INTEGER,date TEXT,normal_price INTEGER,sale_price INTEGER,my_price INTEGER,is_sold_out INTEGER,coupon_name TEXT,coupon_discount INTEGER);INSERT INTO items VALUES(1,'old','old','','','ACTIVE','','');INSERT INTO price_logs VALUES(1,1,'2026-10-15',200,100,99,0,'old',1)");if(extraSql)db.exec(extraSql);
const output=path.join(dir,'index.html');generateDashboardHtml({db,db4910Path:null,dbMusinsaPath:path.join(dir,'wide.db'),outputPath:output,openBrowser:false});
return {output,m:JSON.parse(fs.readFileSync(output,'utf8').match(/window\.__CLOT_DATA__ = ([^\n]+);/)[1]).catalog};}
test('generated manifest records per-group freshness coverage',async t=>{
const {dir}=fixture(t);const {m}=await buildCoverage(t,dir);
assert.deepEqual(m.coverage.map(r=>r.key),['musinsa-wide','musinsa-watched','4910']);
assert.deepEqual(m.coverage[0],{key:'musinsa-wide',active:2,live:2,lastRunAt:'2026-10-16T04:50:00Z'});
assert.equal(m.coverage[2].lastRunAt,null);
});
test('wide coverage ignores incomplete scan runs',async t=>{
const {dir,store}=fixture(t);store.db.prepare('UPDATE scan_runs SET complete=0').run();const {m}=await buildCoverage(t,dir);
assert.equal(m.coverage[0].lastRunAt,null);
});
test('verifier blocks a build that hides a freshly scanned wide catalog',async t=>{
const {dir,store}=fixture(t);const {verifyDashboardBuild}=await import('../scripts/verify-dashboard-build.js');
// 120 ACTIVE goods without observation evidence, scan finished one hour before the build.
for(let n=10;n<130;n++)store.db.prepare("INSERT INTO goods(goods_no,cat,name,url,brand_name,sale_price,normal_price,coupon_price,coupon_price_source,first_seen_date) VALUES(?,?,?,?,?,?,?,?,?,?)").run(n,'001','상품 '+n,'https://www.musinsa.com/products/'+n,'브랜드',100,200,90,'ESTIMATED','2026-10-15');
store.db.prepare('UPDATE scan_runs SET complete=1,completed_at=?').run(new Date(Date.now()-3600000).toISOString());
const {output}=await buildCoverage(t,dir);
assert.throws(()=>verifyDashboardBuild(output),/freshness coverage collapse: musinsa-wide live 2\/122/);
});
test('watched coverage ignores manually skipped days',async t=>{
const {dir}=fixture(t);const {m}=await buildCoverage(t,dir,"CREATE TABLE daily_runs(date TEXT,total_tracked INTEGER,price_dropped_count INTEGER,restocked_count INTEGER,duration_ms INTEGER,completed_at TEXT,mode TEXT);INSERT INTO daily_runs VALUES('2026-10-20',1,0,0,1,'2026-10-20T05:00:00Z','full'),('2026-10-21',0,0,0,0,'2026-10-22T01:00:00Z','skipped')");
assert.equal(m.coverage[1].lastRunAt,'2026-10-20T05:00:00Z');
});
