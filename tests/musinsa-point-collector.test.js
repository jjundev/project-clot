import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPointPolicies} from '../src/musinsaWide/point-collector.js';
import {makePointStoreFixture,pointPolicy,AS_OF} from './helpers/musinsa-point-fixtures.js';
function clock(at=AS_OF){let ms=at;return {now:()=>ms,sleep:async n=>{ms+=n;},advance:n=>{ms+=n;}};}
const failure=(code='HTTP',status=503)=>Object.assign(new Error('test'),{code,status});
test('실패·재시도까지 quota에 포함하고 직렬 간격 보장',async t=>{
  const {points,addGoods}=makePointStoreFixture(t);addGoods({goods_no:1});addGoods({goods_no:2});const c=clock(),starts=[];let concurrent=0,maxConcurrent=0;
  const result=await collectPointPolicies({store:points,...c,dailyCap:3,fetchPolicy:async(n)=>{
    starts.push(c.now());maxConcurrent=Math.max(maxConcurrent,++concurrent);await Promise.resolve();concurrent--;
    if(starts.length===1)throw failure();return pointPolicy({goodsNo:n,checkedAt:new Date(c.now()).toISOString()});
  }});
  assert.equal(result.attempted,3);assert.equal(points.getAttempts(result.quotaDate),3);assert.equal(result.succeeded,2);
  assert.ok(starts.every((ms,i)=>i===0||ms-starts[i-1]>=1000));assert.equal(maxConcurrent,1);
});
test('429·401·403·schema 오류 즉시 중단하고 성공분 보존',async t=>{
  for(const [err,stop] of [[failure('HTTP',429),'rate_limited'],[failure('HTTP',401),'blocked'],[failure('HTTP',403),'blocked'],[failure('SCHEMA_CHANGED'),'error']]){
    const {points,addGoods}=makePointStoreFixture(t);for(let i=1;i<=5;i++)addGoods({goods_no:i});let calls=0;
    const result=await collectPointPolicies({store:points,...clock(),dailyCap:10,fetchPolicy:async n=>{if(++calls===2)throw err;return pointPolicy({goodsNo:n});}});
    assert.equal(result.stop,stop);assert.equal(calls,2);assert.equal([...points.iteratePolicies()].length,1);
  }
});
test('5xx 세 번 상한, 1초·2초 backoff와 1시간 대기',async t=>{
  const {points,addGoods,db}=makePointStoreFixture(t);addGoods({goods_no:1});const c=clock(),starts=[];
  const result=await collectPointPolicies({store:points,...c,dailyCap:10,fetchPolicy:async()=>{starts.push(c.now());throw failure();}});
  assert.equal(result.attempted,3);assert.deepEqual(starts,[AS_OF,AS_OF+1000,AS_OF+3000]);assert.equal(result.failed,3);
  assert.equal(db.prepare('SELECT next_retry_at FROM goods_point_policy').get().next_retry_at,AS_OF+3000+3600000);
});
test('deadline 전에만 시작하고 timeout은 남은 예산 이하',async t=>{
  const {points,addGoods}=makePointStoreFixture(t);addGoods({goods_no:1});addGoods({goods_no:2});const c=clock();let calls=0;
  const result=await collectPointPolicies({store:points,...c,budgetMs:500,fetchPolicy:async(n,o)=>{calls++;assert.equal(o.timeoutMs,500);c.advance(500);return pointPolicy({goodsNo:n});}});
  assert.equal(result.stop,'deadline');assert.equal(calls,1);
});
test('재시작해도 앞선 실패 시도 한도를 보존',async t=>{
  const {points,addGoods}=makePointStoreFixture(t);for(let i=1;i<=3;i++)addGoods({goods_no:i});const c=clock();
  await collectPointPolicies({store:points,...c,dailyCap:1,fetchPolicy:async()=>{throw failure('HTTP',404);}});
  const result=await collectPointPolicies({store:points,...c,dailyCap:1,fetchPolicy:async()=>{throw Error('must not call');}});
  assert.equal(result.attempted,0);assert.equal(result.stop,'quota');
});
test('lane 반분과 빈 lane 차용',async t=>{
  const {points,addGoods}=makePointStoreFixture(t);for(let i=1;i<=4;i++)addGoods({goods_no:i});
  for(let i=3;i<=4;i++)points.savePolicy(pointPolicy({goodsNo:i,checkedAt:'2026-10-01T00:00:00Z'}));
  const lanes=[],reserve=points.reserveAttempt.bind(points);points.reserveAttempt=o=>{lanes.push(o.lane);return reserve(o);};
  const result=await collectPointPolicies({store:points,...clock(),dailyCap:4,fetchPolicy:async n=>pointPolicy({goodsNo:n})});
  assert.equal(result.attempted,4);assert.equal(lanes.filter(x=>x==='urgent').length,2);assert.equal(lanes.filter(x=>x==='rotation').length,2);
});
test('KST 자정 통과에도 날짜별 cap과 간격 유지',async t=>{
  const {points,addGoods}=makePointStoreFixture(t);for(let i=1;i<=3;i++)addGoods({goods_no:i});const at=Date.parse('2026-10-24T14:59:59.500Z'),c=clock(at),starts=[];
  const result=await collectPointPolicies({store:points,...c,dailyCap:2,fetchPolicy:async n=>{starts.push(c.now());return pointPolicy({goodsNo:n});}});
  assert.equal(points.getAttempts('2026-10-24'),1);assert.equal(points.getAttempts('2026-10-25'),2);assert.equal(result.quotaDate,'2026-10-25');
  assert.ok(starts.every((n,i)=>!i||n-starts[i-1]>=1000));
});
test('잘못된 한도는 호출 전에 거절',async()=>{
  for(const dailyCap of [0,5001,1.5,NaN])await assert.rejects(collectPointPolicies({dailyCap}),/cap/);
});
