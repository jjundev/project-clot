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
