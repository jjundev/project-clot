import './setup-env.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {writeFixture} from './helpers/dashboard-page.js';
import {verifyDashboardBuild} from '../scripts/verify-dashboard-build.js';
test('build verifier rejects missing summaries, revisions, counts and histories',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clot-build-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const output=path.join(dir,'index.html');
 const generate=()=>writeFixture(dir);
 generate();fs.writeFileSync(output,fs.readFileSync(output,'utf8').replace('나이키 상품 1','나이키\u2028상품 1'));assert.deepEqual(verifyDashboardBuild(output),{totalItems:5,total4910:3,scanState:'complete'});
 const manifest=()=>JSON.parse(fs.readFileSync(output,'utf8').match(/window\.__CLOT_DATA__ = ([^\n]+);/)[1]).catalog;
 for(const mode of ['missing','revision','count','history']){
 generate();const m=manifest(),refs=m.indexParts;let ref=refs[0];
 if(mode==='history')ref=m.bootstrap.items.find(x=>x.detail.parts.length).detail.parts[0];
 const target=path.join(dir,ref.path);if(mode==='missing'||mode==='history')fs.unlinkSync(target);else {let text=fs.readFileSync(target,'utf8');text=mode==='revision'?text.replace(m.revision,'old'):text.replace('"rows":[','"rows":[[] ,');fs.writeFileSync(target,text);}
 assert.throws(()=>verifyDashboardBuild(output),/asset|revision|bytes|missing/);
 }
 const run=spawnSync(process.execPath,['scripts/verify-dashboard-build.js',output],{encoding:'utf8'});
 assert.notEqual(run.status,0);
});
test('scoped build verifier rejects wrong partition and route target',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clot-scope-verify-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'index.html');
 function mutate(fn){writeFixture(dir);let html=fs.readFileSync(file,'utf8');const raw=html.match(/window\.__CLOT_DATA__ = ([^\n]+);/)[1],D=JSON.parse(raw);fn(D.catalog);fs.writeFileSync(file,html.replace(raw,JSON.stringify(D)));}
 mutate(m=>m.indexParts[0].source='wrong');assert.throws(()=>verifyDashboardBuild(file),/partition/);
 mutate(m=>{const buckets=Object.keys(m.routes);m.routes[(Number(buckets[0])+1)%256]=m.routes[buckets[0]];delete m.routes[buckets[0]];});assert.throws(()=>verifyDashboardBuild(file),/route/);
});
test('scoped build verifier rejects wrong freshness tier and exact window',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clot-tier-verify-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'index.html');
 function mutate(fn){writeFixture(dir);let html=fs.readFileSync(file,'utf8');const raw=html.match(/window\.__CLOT_DATA__ = ([^\n]+);/)[1],D=JSON.parse(raw);fn(D.catalog);fs.writeFileSync(file,html.replace(raw,JSON.stringify(D)));}
 mutate(()=>{});verifyDashboardBuild(file);
 mutate(m=>{const r=m.indexParts[0];r.tier=r.tier==='history'?'live':'history';});assert.throws(()=>verifyDashboardBuild(file),/index tier mismatch/);
 mutate(m=>{m.exactUntilMs-=1;});assert.throws(()=>verifyDashboardBuild(file),/exactUntilMs mismatch/);
});
test('verifier checks complete histories after cycling through more assets than its cache',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clot-verify-working-set-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'index.html');writeFixture(dir,{scale:true,scaleCount:14000});
 assert.ok(fs.readdirSync(path.join(dir,'assets')).length>32);
 assert.deepEqual(verifyDashboardBuild(file),{totalItems:14628,total4910:14002,scanState:'complete'});
 // A history well outside the bootstrap still has to be read and verified.
 const histories=fs.readdirSync(path.join(dir,'assets')).filter(x=>x.startsWith('history-'));
 fs.unlinkSync(path.join(dir,'assets',histories.at(-1)));
 assert.throws(()=>verifyDashboardBuild(file),/missing asset/);
});
