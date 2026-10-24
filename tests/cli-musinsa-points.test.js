import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {runPointPolicyStep} from '../src/musinsaWide/point-cli.js';
import {verifyPointSnapshot} from '../scripts/check-musinsa-points.js';
import {makePointStoreFixture,pointPolicy,validPointScanRun,AS_OF} from './helpers/musinsa-point-fixtures.js';
import {refreshPointEstimates} from '../src/musinsaWide/point-pricing.js';
const on=t=>{const old=process.env.CLOT_MUSINSA_POINTS_ENABLED;process.env.CLOT_MUSINSA_POINTS_ENABLED='1';t.after(()=>{if(old===undefined)delete process.env.CLOT_MUSINSA_POINTS_ENABLED;else process.env.CLOT_MUSINSA_POINTS_ENABLED=old;});};
test('없는 DB는 만들지 않고 feature off는 open/fetch 없음',async t=>{
 const {dir}=makePointStoreFixture(t);const dbPath=path.join(dir,'missing.db');on(t);
 const openStore=()=>{throw Error('must not open');};
 assert.equal((await runPointPolicyStep({dbPath,openStore,log:()=>{}})).ok,false);assert.equal(fs.existsSync(dbPath),false);
 process.env.CLOT_MUSINSA_POINTS_ENABLED='0';assert.equal((await runPointPolicyStep({dbPath,openStore})).publishable,false);
});
test('dry-run은 구형 DB도 read-only이며 fetch·DDL 없음',async t=>{
 on(t);const {db,dbPath,addGoods}=makePointStoreFixture(t,{initialize:false});addGoods();db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 const before=db.prepare('SELECT sql FROM sqlite_master').all();
 const r=await runPointPolicyStep({dbPath,flags:{'dry-run':true},fetchPolicy:()=>{throw Error('network forbidden');},now:()=>AS_OF,log:()=>{}});
 assert.equal(r.ok,true);assert.equal(r.publishable,false);assert.equal(r.candidates,1);assert.deepEqual(db.prepare('SELECT sql FROM sqlite_master').all(),before);
});
test('잘못된 limit는 실행 전 거절 / CLI dispatch 실패 exit 1',async t=>{
 on(t);for(const limit of [0,5001,'1.5','abc',true])assert.equal((await runPointPolicyStep({flags:{limit},openStore:()=>{throw Error('must not open');},log:()=>{}})).ok,false);
 const child=spawnSync(process.execPath,['src/cli.js','musinsa-point-policies','--limit','5001'],{encoding:'utf8'});assert.equal(child.status,1);
});
test('429 부분완료는 성공분 보존·검증·checkpoint·close 후 publishable',async t=>{
 on(t);const {db,dbPath,addGoods}=makePointStoreFixture(t,{initialize:false});for(let i=1;i<=3;i++)addGoods({goods_no:i});validPointScanRun(db);
 let ms=AS_OF,calls=0;
 const r=await runPointPolicyStep({dbPath,flags:{limit:5},now:()=>ms,sleep:async n=>{ms+=n;},log:()=>{},fetchPolicy:async n=>{
   if(++calls===2)throw Object.assign(Error('rate'),{code:'HTTP',status:429});return pointPolicy({goodsNo:n});
 }});
 assert.equal(r.ok,true);assert.equal(r.publishable,true);assert.equal(r.result.stop,'rate_limited');assert.equal(r.result.succeeded,1);
 const check=verifyPointSnapshot(db);assert.equal(check.policies,1);assert.equal(check.valid,1);assert.equal(check.lastStop,'rate_limited');
});
test('DB 오류는 publishable=false, 읽기 전용 검사도 구조적 오류를 거절',async t=>{
 on(t);const {dbPath}=makePointStoreFixture(t);assert.equal((await runPointPolicyStep({dbPath,openStore:()=>{throw Error('broken database');},log:()=>{}})).publishable,false);
});
test('check는 상품 참조·금액·상태·정책버전·NULL 일관성 위반 거절',t=>{
 for(const sql of ["UPDATE point_price_changes SET goods_no=999","UPDATE point_price_changes SET point_price=-1","UPDATE point_price_changes SET state='BAD'","UPDATE point_price_changes SET policy_version='v0'","UPDATE point_price_changes SET point_discount=NULL","UPDATE goods_point_policy SET max_use_rate=2","UPDATE goods_point_policy SET restricted=NULL"]){
  const {db,points,addGoods}=makePointStoreFixture(t);addGoods();points.savePolicy(pointPolicy());validPointScanRun(db);refreshPointEstimates({db,asOfMs:AS_OF,enabled:true});
  assert.equal(verifyPointSnapshot(db).valid,1);db.exec(sql);assert.throws(()=>verifyPointSnapshot(db));
 }
 const {db}=makePointStoreFixture(t,{initialize:false});assert.throws(()=>verifyPointSnapshot(db));
});
test('DB close 오류도 업로드 가능한 성공으로 보고하지 않는다',async t=>{
 on(t);const {db,dbPath,addGoods}=makePointStoreFixture(t);addGoods();validPointScanRun(db);
 const r=await runPointPolicyStep({dbPath,flags:{limit:1},now:()=>AS_OF,sleep:async()=>{},fetchPolicy:async()=>pointPolicy(),log:()=>{},
   openStore:()=>({db,checkpoint(){},close(){throw Error('close failed');}})});
 assert.equal(r.ok,false);assert.equal(r.publishable,false);
});
