import './setup-env.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {buildDashboardCatalog} from '../src/dashboard-catalog.js';
import {fixtureRaw} from './helpers/dashboard-fixture.js';
const compact=(n)=>({v:1,brandSno:9,b:['나이키'],m:[''],imgBase:'',r:Array.from({length:n},(_,i)=>[i+3,0,0,'상품 </script> $', '', '', 'top',[['2026-10-16',200,120,null]]])});
test('catalog shards all summaries and separates revision-matched histories',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clot-cat-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const result=buildDashboardCatalog({baseItems:fixtureRaw().filter(x=>x.src!=='4910all'),scanIndex:{brands:[[9,'나이키',2001]]},readBrand:()=>compact(2001),dir4910:path.join(dir,'4910'),revision:'rev',scanState:'complete'});
 assert.equal(result.items.length,4);assert.equal(result.catalog.scanCount,2000); // duplicate liked 4 is excluded
 assert.deepEqual(result.catalog.parts.map(p=>p.count),[2000]);
 const w={};for(const p of result.catalog.parts)vm.runInNewContext(fs.readFileSync(path.join(dir,p.path),'utf8'),{window:w});
 const summaries=Object.values(w.__CLOT_CATALOG_PARTS__).flatMap(p=>p.items);
 assert.equal(summaries.some(x=>'L' in x),false);
 assert.equal(summaries[0].g,'상품 </script> $');
 assert.equal(result.inlineHistories['4910:1'].at(-1)[3],90);
 const detail={};vm.runInNewContext(fs.readFileSync(path.join(dir,'4910/b9.js'),'utf8'),{window:detail});
 assert.equal(detail.__CLOT_4910_B__[9].revision,'rev');
});
test('2001 unique scan rows split 2000/1; failed build publishes none',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clot-cat-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const opts={baseItems:[],scanIndex:{brands:[[9,'x',2001]]},readBrand:()=>compact(2001),dir4910:path.join(dir,'4910'),revision:'r',scanState:'complete'};
 assert.deepEqual(buildDashboardCatalog(opts).catalog.parts.map(p=>p.count),[2000,1]);
 const bad=buildDashboardCatalog({...opts,scanIndex:{brands:[[9],[10]]},readBrand:id=>{if(id===10)throw Error('bad');return compact(1);}});
 assert.equal(bad.catalog.scanState,'partial');assert.equal(bad.catalog.scanCount,0);
 assert.ok(bad.catalog.notice);assert.equal(fs.existsSync(opts.dir4910),false);
});
test('a short or wrong-brand extraction is partial, never a plausible complete subtotal',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clot-short-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const payload of [compact(1),{...compact(2),brandSno:99}]){
 const result=buildDashboardCatalog({baseItems:[],scanIndex:{brands:[[9,'나이키',2]]},readBrand:()=>payload,dir4910:path.join(dir,'4910'),revision:'r'});
 assert.equal(result.catalog.scanState,'partial');
 assert.equal(result.catalog.scanCount,0);
 }
});

test('catalog never promotes an unverified scan base to a confirmed price',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clot-cat-proof-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const result=buildDashboardCatalog({baseItems:[],scanIndex:{brands:[[9,'나이키',1]]},readBrand:()=>compact(1),dir4910:path.join(dir,'4910'),revision:'r'});
 const w={};vm.runInNewContext(fs.readFileSync(path.join(dir,result.catalog.parts[0].path),'utf8'),{window:w});
 const item=w.__CLOT_CATALOG_PARTS__[result.catalog.parts[0].id].items[0];
 assert.equal(item.my,null);assert.equal(item.isLow,false);assert.equal(item.couponName,'가격 재검증 필요');
});
