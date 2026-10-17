import './setup-env.js';
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
