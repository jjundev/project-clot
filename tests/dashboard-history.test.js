import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';
import {createAssetWriter} from '../src/dashboard-assets.js';
import {createHistoryExporter,createHistoryLoader} from '../src/dashboard-history.js';
test('bounded history preserves window, anchor, all and cache',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'history-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const writer=createAssetWriter({outDir:dir,revision:'r',maxBytes:600});const exporter=createHistoryExporter({writer});
 const rows=Array.from({length:365},(_,i)=>[new Date(Date.UTC(2025,9,17+i)).toISOString().slice(0,10),100,90,i,0,'직접',0,null,'DIRECT']);
 const ref=exporter.add('musinsa:1',rows);exporter.finish();let calls=[];
 const loader=createHistoryLoader({revision:'r',maxBytes:1200,loadAsset:async r=>{calls.push(r.id);const s=fs.readFileSync(path.join(dir,r.path),'utf8'),c={};vm.runInNewContext(s,c);return {payload:c.__CLOT_ASSETS__[r.id],bytes:Buffer.byteLength(s)};}});
 for(const p of ref.parts)assert.ok(p.bytes<=600);
 const [recent,shared]=await Promise.all([loader.get('musinsa:1',ref,{days:90}),loader.get('musinsa:1',ref,{days:90})]);
 assert.deepEqual(recent,shared);assert.equal(recent.from,'2026-07-19');assert.equal(recent.rows.length,90);assert.equal(recent.anchor[0],'2026-07-18');assert.equal(recent.to,'2026-10-16');assert.equal(new Set(calls).size,calls.length);assert.ok(calls.length<ref.parts.length);assert.ok(loader.stats().cacheBytes<=1200);
 const all=await loader.get('musinsa:1',ref,{days:0});assert.deepEqual(JSON.parse(JSON.stringify(all.rows)),rows);assert.equal(all.anchor,null);assert.ok(loader.stats().cacheBytes<=1200);
});
test('history failures retry and invalid assets reject',async()=>{
 let n=0;const ref={firstDate:'2026-10-16',lastDate:'2026-10-16',parts:[{id:'h',path:'assets/h.js',bytes:1,count:1,from:'2026-10-16',to:'2026-10-16'}]};
 const loader=createHistoryLoader({revision:'r',loadAsset:async()=>{if(++n===1)throw Error('network');return {bytes:1,payload:{v:2,revision:'r',id:'h',rows:[['2026-10-16',1]]}};}});
 await assert.rejects(loader.get('k',ref),/network/);assert.equal((await loader.get('k',ref)).rows.length,1);
 const bad=createHistoryLoader({revision:'x',loadAsset:async()=>({bytes:1,payload:{v:2,revision:'r',id:'h',rows:[]}})});await assert.rejects(bad.get('k',ref),/asset/i);
});
