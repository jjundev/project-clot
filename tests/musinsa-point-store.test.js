import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PointPolicyStore,quotaDate} from '../src/musinsaWide/point-store.js';
import {makePointStoreFixture,pointPolicy,AS_OF} from './helpers/musinsa-point-fixtures.js';
const row=(overrides={})=>({goodsNo:2156295,state:'ELIGIBLE',salePrice:263200,extraDiscount:0,couponPrice:248200,couponSource:'ESTIMATED',pointDiscount:17370,pointPrice:230830,policyCheckedAt:'2026-10-24T09:00:00.000Z',maxUseRate:.07,policyVersion:'points-max-use-v1',...overrides});
test('실패는 정책 확인 시각을 연장하지 않는다 / cooldown과 순환 공정성',t=>{
  const {points,addGoods}=makePointStoreFixture(t);addGoods();addGoods({goods_no:2});
  points.savePolicy(pointPolicy());points.saveFailure({goodsNo:2156295,atMs:AS_OF,code:'NETWORK'});
  assert.equal(points.getPolicy(2156295).checkedAt,'2026-10-24T09:00:00.000Z');
  assert.deepEqual(points.pickCandidates({lane:'rotation',limit:1,asOfMs:AS_OF}).map(g=>g.goodsNo),[2]);
  points.saveFailure({goodsNo:2,atMs:AS_OF,code:'NETWORK'});
  assert.equal(points.pickCandidates({lane:'urgent',limit:2,asOfMs:AS_OF}).length,0);
});
test('재실행 공유 한도와 KST 자정, 간격 예약',t=>{
  const {points,db}=makePointStoreFixture(t);
  const a=Date.parse('2026-10-24T14:59:59.500Z'), b=a+1000;
  assert.equal(quotaDate(a),'2026-10-24');assert.equal(quotaDate(b),'2026-10-25');
  assert.equal(points.reserveAttempt({goodsNo:1,lane:'urgent',atMs:a,dailyCap:1}),true);
  const reopened=new PointPolicyStore(db);
  assert.equal(reopened.reserveAttempt({goodsNo:2,lane:'urgent',atMs:a,dailyCap:1}),false);
  assert.equal(reopened.reserveAttempt({goodsNo:2,lane:'urgent',atMs:b-1,dailyCap:1}),false);
  assert.equal(reopened.reserveAttempt({goodsNo:2,lane:'rotation',atMs:b,dailyCap:1}),true);
  assert.equal(reopened.getAttempts('2026-10-24'),1);assert.equal(reopened.getAttempts('2026-10-25'),1);
  assert.equal(reopened.getNextStartAtMs(),b+1000);
});
test('lane 중복·미품절 ACTIVE·유효 판매가만 선택',t=>{
  const {points,addGoods}=makePointStoreFixture(t);
  addGoods();addGoods({goods_no:2,is_sold_out:1});addGoods({goods_no:3,status:'OUT_OF_SCOPE'});addGoods({goods_no:4,sale_price:null});
  assert.deepEqual(points.pickCandidates({lane:'urgent',limit:5,asOfMs:AS_OF}).map(g=>g.goodsNo),[2156295]);
  assert.equal(points.pickCandidates({lane:'rotation',limit:5,asOfMs:AS_OF,excludeGoodsNos:[2156295]}).length,0);
});
test('read-only 구형 DB는 DDL 없이 빈값을 반환',t=>{
  const {points,db}=makePointStoreFixture(t,{initialize:false});
  const before=db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
  assert.equal(points.hasTables(),false);assert.equal(points.getPolicy(1),null);assert.deepEqual([...points.iteratePolicies()],[]);
  assert.deepEqual([...points.iterateLatestPrices()],[]);assert.deepEqual(points.pickCandidates({lane:'urgent',limit:1,asOfMs:AS_OF}),[]);
  assert.deepEqual(db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(),before);
});
test('당일 되돌림과 checkedAt만 변경은 변경 이력을 늘리지 않는다',t=>{
  const {points,db}=makePointStoreFixture(t);
  assert.equal(points.recordPrices({date:'2026-10-23',rows:[row()]}).written,1);
  points.recordPrices({date:'2026-10-24',rows:[row({policyCheckedAt:'2026-10-24T10:00:00Z'})]});
  assert.equal(db.prepare('SELECT count(*) n FROM point_price_changes').get().n,1);
  points.recordPrices({date:'2026-10-24',rows:[row({state:'STALE',pointPrice:null,pointDiscount:null})]});
  assert.equal([...points.iterateLatestPrices()][0].state,'STALE');
  points.recordPrices({date:'2026-10-24',rows:[row()]});assert.equal(db.prepare('SELECT count(*) n FROM point_price_changes').get().n,1);
  points.recordPrices({date:'2026-10-24',rows:[row({goodsNo:2,state:'UNKNOWN',pointPrice:null,pointDiscount:null})]});
  assert.equal(db.prepare('SELECT count(*) n FROM point_price_changes').get().n,1);
});
test('추가 스키마는 기존 데이터에 손대지 않는다 / 30만 후보 SQL LIMIT',t=>{
  const {db,points,addGoods}=makePointStoreFixture(t);addGoods();
  const before=db.prepare('SELECT * FROM goods').all();new PointPolicyStore(db,{initialize:true});
  assert.deepEqual(db.prepare('SELECT * FROM goods').all(),before);
  db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300000)
    INSERT INTO goods(goods_no,name,url,status,sale_price,extra_discount,first_seen_date) SELECT x,'상품','https://www.musinsa.com','ACTIVE',1000,0,'2026-10-24' FROM n`);
  let queries=0;
  const spy=new Proxy(db,{get(target,key){if(key==='prepare')return sql=>{queries++;return target.prepare(sql);};const v=target[key];return typeof v==='function'?v.bind(target):v;}});
  const s=new PointPolicyStore(spy);queries=0;
  assert.equal(s.pickCandidates({lane:'urgent',limit:3,asOfMs:AS_OF}).length,3);assert.ok(queries<=2);
  points.reserveAttempt({goodsNo:1,lane:'rotation',atMs:AS_OF,dailyCap:1000});
  assert.equal(points.pickCandidates({lane:'rotation',limit:1,asOfMs:AS_OF+3600001}).at(0).goodsNo,2);
});
