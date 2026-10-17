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
