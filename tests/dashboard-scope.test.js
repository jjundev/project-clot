import './setup-env.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createDashboardBuilder} from '../src/dashboard-builder.js';
import {createDashboardModel} from '../src/dashboard-model.js';
import {createDashboardIndex} from '../src/dashboard-index.js';
const model=createDashboardModel(), index=createDashboardIndex(model);
function fixture(t, count=260) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scope-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const b=createDashboardBuilder({outDir:dir,revision:'scope-test'});
 for(let n=0;n<count;n++) b.add({src:n%2?'4910':'musinsa',n,b:'Brand '+n%3,g:'Product '+n,c:n%3?'top':'etc',L:[['2026-10-16',200,100,n%5?90:0,n%7?0:1,null,0]]});
 const data=b.finish({scanState:'complete'});
 const read=ref=>{const s=fs.readFileSync(path.join(dir,ref.path),'utf8'),ctx={};vm.runInNewContext(s,ctx);return {payload:JSON.parse(JSON.stringify(ctx.__CLOT_ASSETS__[ref.id])),bytes:Buffer.byteLength(s)};};
 return {dir,data,read};
}
test('scoped build preserves every identity and partitions by source and category',t=>{
 const {data,read}=fixture(t);assert.equal(data.catalog.loadingMode,'scoped');
 const keys=[];for(const ref of data.catalog.indexParts){const rows=index.unpackIndex(read(ref).payload);assert.equal(rows.length,ref.count);for(const x of rows){assert.equal(x.src,ref.source);assert.equal(x.c,ref.category);keys.push(x.k);}}
 assert.equal(keys.length,260);assert.equal(new Set(keys).size,260);assert.ok(data.catalog.indexParts.some(r=>r.category==='etc'));
});
test('previews share cards and preserve exact first-page order',t=>{
 const {data,read}=fixture(t);const all=data.catalog.indexParts.flatMap(r=>index.unpackIndex(read(r).payload));
 assert.ok(data.catalog.previews);for(const src of ['all','musinsa','4910'])assert.deepEqual(data.catalog.previews[src].keys,model.queryCatalog(all,{src}).items.slice(0,120).map(x=>x.k));
 assert.equal(new Set(data.catalog.previewItems.map(x=>x.k)).size,data.catalog.previewItems.length);
});
test('routes find offscreen products without search indexes',async t=>{
 const {data,read}=fixture(t);assert.ok(data.catalog.routes);const {createDashboardScope}=await import('../src/dashboard-scope.js');const scope=createDashboardScope();assert.equal(scope.routeBucket(''),197);
 const entries=Object.values(data.catalog.routes).flatMap(refs=>refs.flatMap(r=>read(r).payload.entries));assert.equal(entries.length,260);
 for(const [key,ref]of entries){assert.ok(read(ref).payload.items.some(x=>x.k===key));assert.ok(data.catalog.routes[scope.routeBucket(key)]);}
});
test('empty scopes and oversized route buckets stay valid',async t=>{
 const {data,dir}=fixture(t,0);assert.deepEqual(data.catalog.routes,{});assert.deepEqual(data.catalog.previews.musinsa.keys,[]);assert.equal(data.catalog.indexParts.length,0);
 for(const f of fs.readdirSync(path.join(dir,'assets')))assert.ok(fs.statSync(path.join(dir,'assets',f)).size<=262144);
});
export {fixture,model,index};
import {createDashboardTransport} from '../src/dashboard-worker.js';
async function transportFixture(t,options={}) {
 const f=fixture(t,options.count??520), scope=(await import('../src/dashboard-scope.js')).createDashboardScope(); const calls=[];
 const engine=await createDashboardTransport({manifest:f.data.catalog,index,scope,loadAsset:async ref=>{calls.push(ref);return options.load?options.load(ref,f.read):f.read(ref);}});
 return {...f,engine,calls,scope};
}
test('scoped init does not fetch indexes',async t=>{const {calls}=await transportFixture(t);assert.equal(calls.length,0);});
test('musinsa top query fetches only matching parts and incomplete cross facets are null',async t=>{
 const {engine,calls,data}=await transportFixture(t);const r=await engine.query({src:'musinsa',cat:'top'},1);
 assert.equal(r.total,173);assert.equal(r.sources.musinsa,173);assert.equal(r.sources['4910'],null);assert.equal(r.sources.all,null);assert.equal(r.categories.etc,null);assert.equal(r.categories.shoes,0);
 assert.deepEqual(calls.filter(x=>x.id.startsWith('index')).map(x=>x.id),data.catalog.indexParts.filter(x=>x.source==='musinsa'&&x.category==='top').map(x=>x.id));
 assert.ok(calls.every(x=>!x.id.startsWith('history')));
});
test('scope widening reuses loaded files and complete results preserve all sorts',async t=>{
 const {engine,calls,data,read}=await transportFixture(t);await engine.query({src:'musinsa',cat:'top'});await engine.query({src:'musinsa'});
 for(const sort of ['category','rate','priceAsc','priceDesc','dropAmt','brand','new']) {
  const state={src:'all',sort,q:'product',filter:'all'},r=await engine.query(state),all=data.catalog.indexParts.flatMap(ref=>index.unpackIndex(read(ref).payload));
  const expected=model.queryCatalog(all,state);assert.equal(r.total,expected.total);assert.deepEqual(r.items.map(x=>x.k),expected.items.slice(0,120).map(x=>x.k));assert.deepEqual(r.sources,expected.sources);
 }
 const ids=calls.filter(x=>x.id.startsWith('index')).map(x=>x.id);assert.equal(new Set(ids).size,ids.length);
});
test('lookup uses only route and card files',async t=>{
 const {engine,calls}=await transportFixture(t);assert.equal((await engine.lookup('musinsa:518')).k,'musinsa:518');assert.equal(await engine.lookup('musinsa:999999'),null);assert.ok(calls.every(x=>!x.id.startsWith('index')&&!x.id.startsWith('history')));
});
test('failed part is retryable and never counted as complete',async t=>{
 let fail=true;const {engine,calls}=await transportFixture(t,{load:(ref,read)=>{if(fail&&ref.id.startsWith('index')){fail=false;throw Error('offline');}return read(ref);}});
 await assert.rejects(engine.query({src:'musinsa',cat:'top'}),/offline/);assert.equal((await engine.query({src:'musinsa',cat:'top'})).total,173);assert.equal(calls.filter(x=>x.id.startsWith('index')).length,2);
});
test('latest scope bypasses obsolete queued downloads',async t=>{
 let release;const gate=new Promise(r=>release=r);let active=0,max=0;
 const {engine,calls,data}=await transportFixture(t,{count:12000,load:async(ref,read)=>{max=Math.max(max,++active);if(ref.id.startsWith('index'))await gate;active--;return read(ref);}});
 const old=engine.query({src:'all'},1);const rejected=assert.rejects(old,{code:'STALE_RESULT'});await new Promise(r=>setImmediate(r));
 const newest=engine.query({src:'4910',cat:'etc'},2);release();await rejected;const result=await newest;assert.ok(result.items.every(x=>x.src==='4910'&&x.c==='etc'));assert.ok(max<=4);
 const wanted=new Set(data.catalog.indexParts.filter(x=>x.source==='4910'&&x.category==='etc').map(x=>x.id));assert.ok(calls.filter(x=>x.id.startsWith('index')).slice(4).every(x=>wanted.has(x.id)));
});
