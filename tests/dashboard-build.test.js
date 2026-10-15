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
 for(const [file,change,expected] of [
 ['4910/catalog-0000.js',null,/missing catalog part/],
 ['4910/catalog-0000.js',s=>s.replace(/"revision":"[^"]+"/,'"revision":"old"'),/revision/],
 ['4910/catalog-0000.js',s=>s.replace('"n":3','"n":99'),/identity/],
 ['4910/b9.js',null,/missing detail/],
 ['4910/b9.js',s=>s.replace(/"revision":"[^"]+"/,'"revision":"old"'),/revision/]
 ]){
 generate();const target=path.join(dir,file);if(change)fs.writeFileSync(target,change(fs.readFileSync(target,'utf8')));else fs.unlinkSync(target);
 assert.throws(()=>verifyDashboardBuild(output),expected);
 }
 const run=spawnSync(process.execPath,['scripts/verify-dashboard-build.js',output],{encoding:'utf8'});
 assert.notEqual(run.status,0);
});
