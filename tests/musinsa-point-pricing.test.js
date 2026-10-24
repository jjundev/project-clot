import './setup-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshPointEstimates,readPointEstimateViews} from '../src/musinsaWide/point-pricing.js';
import {makePointStoreFixture,pointPolicy,validPointScanRun,AS_OF} from './helpers/musinsa-point-fixtures.js';
function fixture(t){const f=makePointStoreFixture(t);f.addGoods();f.points.savePolicy(pointPolicy());validPointScanRun(f.db);return f;}
const options=db=>({db,asOfMs:AS_OF,enabled:true});
const legacyDump=db=>['price_changes','coupon_price_changes','scan_runs'].map(table=>db.prepare(`SELECT * FROM ${table}`).all());
test('오늘 유효 snapshot·7일미만 cache와 기존 기록 보존',t=>{
  const {db}=fixture(t),before=legacyDump(db);assert.equal(readPointEstimateViews(options(db)).byGoods.get(2156295)?.price??null,null);
  assert.equal(refreshPointEstimates(options(db)).written,1);
  assert.equal(readPointEstimateViews(options(db)).byGoods.get(2156295).price,230830);
  assert.deepEqual(legacyDump(db),before);
  assert.equal(db.prepare('SELECT min(date) d FROM point_price_changes').get().d,'2026-10-24');
});
test('실패한 오늘의 쿠폰 수집·어제 run만 존재하면 예상가 무효',t=>{
  for(const yesterday of [false,true]){
    const {db}=fixture(t);refreshPointEstimates(options(db));
    db.exec(yesterday?"UPDATE scan_runs SET date='2026-10-23'":"UPDATE scan_runs SET complete=0");
    const r=readPointEstimateViews(options(db)).byGoods.get(2156295);assert.equal(r.state,'COUPON_UNAVAILABLE');assert.equal(r.price,null);
  }
});
test('coupon extra만 변경, 현재 쿠폰가 변경은 저장 예상가 무효',t=>{
  const {db}=fixture(t);refreshPointEstimates(options(db));db.exec('UPDATE goods SET extra_discount=10');
  assert.equal(readPointEstimateViews(options(db)).byGoods.get(2156295).state,'POLICY_BASE_MISMATCH');
  db.exec('UPDATE goods SET extra_discount=0,coupon_price=200000');assert.equal(readPointEstimateViews(options(db)).byGoods.get(2156295).price,null);
});
test('가격 동일 TTL 만료는 null 전환행 / OUT_OF_SCOPE 무효',t=>{
  const {db}=fixture(t);refreshPointEstimates(options(db));
  const later=AS_OF+604800000;validPointScanRun(db,{date:new Date(later).toISOString().slice(0,10)});
  refreshPointEstimates({db,asOfMs:later,enabled:true});
  assert.equal([...db.prepare('SELECT state,point_price FROM point_price_changes ORDER BY date').iterate()].at(-1).state,'STALE');
  assert.equal(readPointEstimateViews({db,asOfMs:later,enabled:true}).byGoods.get(2156295).price,null);
  db.exec("UPDATE goods SET status='OUT_OF_SCOPE'");refreshPointEstimates({db,asOfMs:later,enabled:true});
  assert.equal(db.prepare('SELECT state FROM point_price_changes ORDER BY date DESC LIMIT 1').get().state,'OUT_OF_SCOPE');
});
test('처음 UNKNOWN은 이력 0행, counts 분모는 ACTIVE 전체',t=>{
  const {db,addGoods}=makePointStoreFixture(t);addGoods();addGoods({goods_no:2});validPointScanRun(db);
  refreshPointEstimates(options(db));assert.equal(db.prepare('SELECT count(*) n FROM point_price_changes').get().n,0);
  assert.deepEqual(readPointEstimateViews(options(db)).counts,{active:2,eligible:0,restricted:0,unknown:2});
});
test('같은 날 재실행은 최대 1행 / 확인 시각 갱신은 새 이력 없음',t=>{
  const {db,points}=fixture(t);refreshPointEstimates(options(db));points.savePolicy(pointPolicy({checkedAt:new Date(AS_OF).toISOString()}));refreshPointEstimates(options(db));
  assert.equal(db.prepare('SELECT count(*) n FROM point_price_changes').get().n,1);
  assert.equal(readPointEstimateViews(options(db)).byGoods.get(2156295).checkedAt,new Date(AS_OF).toISOString());
});
test('기능 off/구형 DB는 DDL·신규행 없음',t=>{
  const {db,addGoods}=makePointStoreFixture(t,{initialize:false});addGoods();const before=db.prepare('SELECT sql FROM sqlite_master').all();
  assert.equal(refreshPointEstimates(options(db)).written,0);assert.equal(readPointEstimateViews(options(db)).byGoods.size,0);
  assert.deepEqual(db.prepare('SELECT sql FROM sqlite_master').all(),before);
  const f=fixture(t);refreshPointEstimates({...options(f.db),enabled:false});assert.equal(f.db.prepare('SELECT count(*) n FROM point_price_changes').get().n,0);
});
