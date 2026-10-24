import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runPointPolicyJob} from '../src/musinsaWide/point-cli.js';
function job(overrides={}){
 const order=[],result={quotaDate:'2026-10-24',attempted:2,succeeded:1,failed:1,stop:'rate_limited'};
 const args={dbPath:'wide.db',enabled:true,flags:{limit:1000},log:()=>{},pullFn:async({dest})=>{assert.equal(dest,'wide.db');order.push('pull');return {source:'latest'};},stepFn:async({dbPath,flags})=>{assert.equal(dbPath,'wide.db');assert.equal(flags.limit,1000);order.push('step');return {ok:true,publishable:true,result};},checkFn:async p=>{assert.equal(p,'wide.db');order.push('check');return {valid:1};},pushFn:async({src})=>{assert.equal(src,'wide.db');order.push('push');},...overrides};return {order,result,args};
}
test('latest pull→step→check→push는 부분 완료 상태를 보존',async()=>{const {args,order,result}=job();const r=await runPointPolicyJob(args);assert.deepEqual(order,['pull','step','check','push']);assert.equal(r.ok,true);assert.equal(r.published,true);assert.deepEqual(r.result,result);});
test('prev fallback·pull 실패는 step/push 차단',async()=>{
 for(const pullFn of [async()=>({source:'prev'}),async()=>{throw Error('pull failed');}]){const {args,order}=job({pullFn});const r=await runPointPolicyJob(args);assert.equal(r.ok,false);assert.equal(r.published,false);assert.deepEqual(order,[]);}
});
test('구조 오류·step 오류·publishable=false는 push 차단, push 실패는 job 실패',async()=>{
 for(const override of [{checkFn:async()=>{throw Error('bad snapshot');}},{stepFn:async()=>({ok:false,publishable:false,error:'db'})},{stepFn:async()=>({ok:true,publishable:false})},{pushFn:async()=>{throw Error('upload failed');}}]){
 const {args}=job(override);const r=await runPointPolicyJob(args);assert.equal(r.published,false);assert.equal(r.ok,Boolean(override.stepFn&&(await override.stepFn()).ok));
 }
});
test('off는 pull도 생략',async()=>{const {args,order}=job({enabled:false});assert.equal((await runPointPolicyJob(args)).skipped,true);assert.deepEqual(order,[]);});
test('workflow는 성공한 main wide 실행만 구독하고 공유 lock·opt-in·100분 제한 사용',()=>{
 const y=fs.readFileSync(new URL('../.github/workflows/musinsa-points.yml',import.meta.url),'utf8');
 for(const re of [/name: Musinsa point policies/,/workflows: \['Musinsa wide scan'\]/,/branches: \[main\]/,/conclusion == 'success'/,/head_branch == 'main'/,/group: clot-daily/,/cancel-in-progress: false/,/timeout-minutes: 100/,/default: '1000'/,/vars.CLOT_MUSINSA_POINTS_ENABLED/,/node scripts\/run-musinsa-points.js/])assert.match(y,re);
 assert.doesNotMatch(y,/MUSINSA_COOKIE|TELEGRAM|allow-fresh/);
 for(const f of ['musinsa-wide.yml','pages.yml'])assert.match(fs.readFileSync(new URL('../.github/workflows/'+f,import.meta.url),'utf8'),/vars.CLOT_MUSINSA_POINTS_ENABLED/);
 assert.match(fs.readFileSync(new URL('../.github/workflows/pages.yml',import.meta.url),'utf8'),/'Musinsa point policies'/);
});
