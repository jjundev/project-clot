import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effective4910Price, readPriceValidations } from '../src/site4910/price-validation.js';
import { DatabaseSync } from 'node:sqlite';
import { Store4910 } from '../src/site4910/store.js';
import { buildScan4910Payload } from '../src/visualizer.js';
const raw = { member_price: 81410, coupon_price: 72420, list_price: 85200 };

function validationFixture(t) {
  const store = new Store4910(':memory:');
  t.after(() => store.close());
  store.applyScan('2026-10-24', [1, 100000, 50000, 60000].map(sno => ({
    sno, brand_sno: sno === 50000 ? 20 : 10, brand: 'fixture', name: String(sno),
    sale_price: 85200, original_price: 90000, url: 'https://4910.kr',
    market_sno: 1, market_name: null, category: null, image_url: null, discount_rate: null,
  })));
  store.db.exec("UPDATE goods SET status='DROPPED' WHERE sno=60000");
  for (const sno of [1, 100000, 50000, 60000]) store.putPriceValidation({
    kind: 'scan', sno, date: '2026-10-24', status: 'verified', reason: 'fixture',
    corrected: {sale_price: 75900, coupon_price: 72110},
    evidence: {observedDate: '2026-10-24', sentinel: 'keep-evidence'},
  });
  store.putPriceValidation({kind: 'liked', sno: 1, date: '2026-10-24', status: 'verified', reason: 'fixture'});
  return store.db;
}

test('validation filters intersect brand, range, exact ID and single ID', t => {
  const db = validationFixture(t);
  assert.deepEqual([...readPriceValidations(db, 'scan', {
    brandSno: 10, snoFrom: 1, snoTo: 100000,
  }).keys()].sort(), ['100000:2026-10-24', '1:2026-10-24', '60000:2026-10-24'].sort());
  assert.deepEqual([...readPriceValidations(db, 'scan', {
    snos: [1, 100000, 1], brandSno: 10, snoFrom: 1, snoTo: 99999,
  }).keys()], ['1:2026-10-24']);
  assert.equal(readPriceValidations(db, 'scan', {sno: 50000, brandSno: 10}).size, 0);
  assert.equal(readPriceValidations(db, 'scan', {snos: [1], sno: 100000}).size, 0);
});

test('empty validation ID lists never read validation rows', t => {
  const db = validationFixture(t);
  const observed = {prepare(sql) {
    assert.doesNotMatch(sql, /SELECT .* FROM price_validations/i);
    return db.prepare(sql);
  }};
  assert.equal(readPriceValidations(observed, 'scan', {snos: []}).size, 0);
});

test('validation evidence defaults to intact and can be omitted without changing price', t => {
  const db = validationFixture(t);
  const full = readPriceValidations(db, 'scan', {sno: 1}).get('1:2026-10-24');
  const lean = readPriceValidations(db, 'scan', {snos: [1], includeEvidence: false}).get('1:2026-10-24');
  assert.equal(full.evidence_json, JSON.stringify({observedDate: '2026-10-24', sentinel: 'keep-evidence'}));
  assert.equal(Object.hasOwn(lean, 'evidence_json'), false);
  const {evidence_json, ...remaining} = full;
  assert.deepEqual(lean, Object.assign(Object.create(null), remaining));
  for (const validation of [full, lean]) assert.equal(effective4910Price({raw, validation}), 72110);
});

test('lists larger than 200 keep complete coverage without duplicate reads', t => {
  const store = new Store4910(':memory:');
  t.after(() => store.close());
  const ids = Array.from({length: 201}, (_, i) => i + 1);
  for (const sno of ids) store.putPriceValidation({kind: 'scan', sno, date: '2026-10-24', status: 'verified', reason: 'fixture'});
  const batches = [], yielded = [];
  const observed = {prepare(sql) {
    const statement = store.db.prepare(sql);
    if (!/FROM price_validations/i.test(sql)) return statement;
    return {all: statement.all.bind(statement), iterate(...params) {
      batches.push(params.slice(1));
      return (function* () {
        for (const row of statement.iterate(...params)) { yielded.push(row.sno); yield row; }
      })();
    }};
  }};
  const rows = readPriceValidations(observed, 'scan', {snos: [...ids, 1]});
  assert.equal(rows.size, 201);
  assert.deepEqual([...rows.values()].map(r => r.sno).sort((a,b) => a-b), ids);
  assert.equal(batches.length, 2);
  assert.ok(batches.every(batch => batch.length > 0 && batch.length <= 200));
  assert.deepEqual(yielded.sort((a,b) => a-b), ids);
});

test('invalid filters cannot widen a validation read', t => {
  const db = validationFixture(t);
  for (const options of [{snoFrom: 1}, {snoTo: 2}, {snoFrom: 2, snoTo: 1}])
    assert.throws(() => readPriceValidations(db, 'scan', options), RangeError);
  for (const snos of [[0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]])
    assert.throws(() => readPriceValidations(db, 'scan', {snos}), TypeError);
});

test('legacy missing table returns an empty map', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  assert.equal(readPriceValidations(db, 'scan').size, 0);
});
test('invalid, unverified and legacy rows cannot fall back to public coupon prices', () => {
  for (const validation of [null,{status:'invalid'},{status:'unverified'}]) assert.equal(effective4910Price({raw,validation}),null);
  assert.equal(effective4910Price({raw,validation:{status:'verified'}}),81410);
  assert.equal(effective4910Price({raw,validation:{status:'corrected',corrected_json:'{"member_price":72110}'}}),72110);
});
test('unvalidated prior prices never generate a drop baseline; updates are idempotent',()=>{
  const s=new Store4910(':memory:');
  s.logLikedPrice({sno:1,date:'2026-10-15',...raw});
  assert.equal(s.getPrevLikedPrice(1,'2026-10-16'),null);
  s.putPriceValidation({kind:'liked',sno:1,date:'2026-10-15',status:'corrected',reason:'fixture',corrected:{member_price:72110}});
  assert.equal(s.getPrevLikedPrice(1,'2026-10-16').member_price,72110);
  s.putPriceValidation({kind:'liked',sno:1,date:'2026-10-15',status:'invalid',reason:'fixture'});
  assert.equal(s.getPrevLikedPrice(1,'2026-10-16'),null);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM price_validations').get().n,1);
  assert.equal(s.db.prepare('SELECT member_price FROM liked_price_logs').get().member_price,81410);
  s.close();
});
test('scan coupon history cannot resurrect invalid prices via carry',()=>{
  const s=new Store4910(':memory:');
  s.applyScan('2026-10-14',[{sno:1,brand_sno:1,brand:'b',name:'a',url:'x',market_sno:1,market_name:null,category:null,image_url:null,sale_price:85200,original_price:null,discount_rate:null}],{completeBrands:[1]});
  s.logCouponPriceChanges('2026-10-14',[{sno:1,sale_price:85200,coupon_price:81410}]);
  s.recordScanRun({date:'2026-10-16',complete:true,brandCounts:[],changed:0,added:0,dropped:0,durationMs:1,couponsOk:true});
  assert.ok(buildScan4910Payload(s.db).r[0][7].every(r=>r[3]===null));
  s.putPriceValidation({kind:'scan',sno:1,date:'2026-10-14',status:'corrected',reason:'fixture',corrected:{coupon_price:72110,sale_price:85200}});
  assert.equal(buildScan4910Payload(s.db).r[0][7][0][3],72110);
  s.putPriceValidation({kind:'scan',sno:1,date:'2026-10-14',status:'invalid',reason:'fixture'});
  assert.ok(buildScan4910Payload(s.db).r[0][7].every(r=>r[3]===null));s.close();
});

test('corrected AGLO scan base survives merging against a different raw basis',()=>{
  const s=new Store4910(':memory:');
  s.applyScan('2026-10-15',[{sno:1,brand_sno:1,brand:'b',name:'a',url:'x',market_sno:1,market_name:null,category:null,image_url:null,sale_price:85200,original_price:90000,discount_rate:null}],{completeBrands:[1]});
  s.logCouponPriceChanges('2026-10-15',[{sno:1,sale_price:85200,coupon_price:81410}]);
  s.putPriceValidation({kind:'scan',sno:1,date:'2026-10-15',status:'corrected',reason:'evidence',corrected:{sale_price:75900,coupon_price:72110}});
  assert.deepEqual(buildScan4910Payload(s.db).r[0][7][0],['2026-10-15',90000,75900,72110]);
  assert.equal(s.getGoods(1).sale_price,85200);s.close();
});
