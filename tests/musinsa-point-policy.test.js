import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePointPolicy,fetchPointPolicy,evaluatePointEstimate} from '../src/musinsaWide/point-policy.js';
import {rawPointPolicy,pointPolicy,couponBasis,AS_OF} from './helpers/musinsa-point-fixtures.js';
const evaluate = (changes={}) => evaluatePointEstimate({basis:couponBasis(),policy:pointPolicy(),asOfMs:AS_OF,couponFresh:true,...changes});
test('키뮤어: 등급 제한과 무관하게 적립금만 차감',()=>{
  const policy=parsePointPolicy(rawPointPolicy(),2156295,AS_OF-3600000);
  assert.deepEqual(evaluate({policy}),{state:'ELIGIBLE',price:230830,discount:17370,checkedAt:policy.checkedAt,maxUseRate:0.07});
});
test('일반 비아울렛 제한 상품 및 고정 정책 사례',()=>{
  for(const [goodsNo,restricted,isOutlet] of [[2156295,false,false],[595039,false,false],[3982118,true,true],[1108007,true,false]]) {
    const policy=parsePointPolicy(rawPointPolicy({goodsNo,isRestictedUsePoint:restricted,isOutlet}),goodsNo,AS_OF);
    const r=evaluate({policy,basis:couponBasis({goodsNo})});
    assert.equal(r.state,restricted?'RESTRICTED':'ELIGIBLE');assert.equal(r.price,restricted?248200:230830);assert.equal(r.discount,restricted?0:17370);
  }
});
test('정상가 0과 사용률 0, 쿠폰가 0은 유효',()=>{
  const p=parsePointPolicy(rawPointPolicy({maxUsePointRate:0,goodsPrice:{salePrice:0,extraDiscountAmount:0}}),2156295,AS_OF);
  assert.equal(evaluate({policy:p,basis:couponBasis({salePrice:0,couponPrice:0})}).price,0);
});
test('누락·상충 철자·다른 goodsNo·문자열 boolean·NaN·1 초과 비율 거절',()=>{
  for(const data of [{isRestictedUsePoint:undefined},{isRestrictedUsePoint:true},{goodsNo:1},{isRestictedUsePoint:'false'},
    {maxUsePointRate:NaN},{maxUsePointRate:1.01},{goodsPrice:{salePrice:263200}},{goodsPrice:{salePrice:-1,extraDiscountAmount:0}}])
    assert.throws(()=>parsePointPolicy(rawPointPolicy(data),2156295,AS_OF),{code:'SCHEMA_CHANGED'});
  assert.throws(()=>parsePointPolicy({meta:{result:'FAIL'},data:{}},2156295,AS_OF),{code:'SCHEMA_CHANGED'});
  assert.throws(()=>parsePointPolicy(rawPointPolicy(),2156295,NaN),{code:'SCHEMA_CHANGED'});
  assert.equal(parsePointPolicy(rawPointPolicy({isRestictedUsePoint:undefined,isRestrictedUsePoint:false}),2156295,AS_OF).restricted,false);
});
test('판정 우선순위, 만료 경계와 현재 가격 불일치',()=>{
  assert.equal(evaluate({basis:couponBasis({status:'OUT_OF_SCOPE'}),couponFresh:false}).state,'OUT_OF_SCOPE');
  assert.equal(evaluate({couponFresh:false,policy:null}).state,'COUPON_UNAVAILABLE');
  assert.equal(evaluate({policy:null}).state,'UNKNOWN');
  for(const [age,want] of [[604799999,'ELIGIBLE'],[604800000,'STALE'],[-1,'STALE']]) {
    const r=evaluate({policy:pointPolicy({checkedAt:new Date(AS_OF-age).toISOString()})});
    assert.equal(r.state,want);if(want==='STALE')assert.equal(r.price,null);
  }
  assert.equal(evaluate({basis:couponBasis({extraDiscount:10})}).state,'POLICY_BASE_MISMATCH');
  assert.equal(evaluate({basis:couponBasis({couponPrice:null})}).price,null);
});
test('fetch는 익명 고정 URL로 한 번 요청하고 HTTP 본문을 노출하지 않는다',async()=>{
  let calls=0;
  const p=await fetchPointPolicy(2156295,{now:()=>AS_OF,fetchFn:async(url,opts)=>{
    calls++;assert.equal(url,'https://goods-detail.musinsa.com/api2/goods/2156295');
    assert.equal(new Headers(opts.headers).has('cookie'),false);return new Response(JSON.stringify(rawPointPolicy()));
  }});assert.equal(calls,1);assert.equal(p.goodsNo,2156295);
  await assert.rejects(fetchPointPolicy(2156295,{fetchFn:async()=>new Response('PRIVATE BODY',{status:429})}),e=>e.code==='HTTP'&&e.status===429&&!e.message.includes('PRIVATE'));
  await assert.rejects(fetchPointPolicy(2156295,{fetchFn:async()=>{throw new Error('secret');}}),{code:'NETWORK'});
  await assert.rejects(fetchPointPolicy(2156295,{fetchFn:async()=>new Response('{')}),{code:'SCHEMA_CHANGED'});
});
test('timeout과 잘못된 상품번호는 재시도하지 않는다',async()=>{
  let calls=0;
  await assert.rejects(fetchPointPolicy(1,{timeoutMs:1,fetchFn:async(_,o)=>{
    calls++;await new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(o.signal.reason),{once:true}));
  }}),{code:'TIMEOUT'});assert.equal(calls,1);
  await assert.rejects(fetchPointPolicy('2156295',{fetchFn:()=>{calls++;}}),{code:'SCHEMA_CHANGED'});assert.equal(calls,1);
});
