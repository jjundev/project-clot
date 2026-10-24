import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PointPolicyStore} from '../src/musinsaWide/point-store.js';
import {POINT_POLICY_VERSION} from '../src/musinsaWide/point-policy.js';
import {defaultMusinsaWideDbPath} from '../src/musinsaWide/store.js';
const money=n=>Number.isSafeInteger(n)&&n>=0;
const rate=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1;
const time=s=>typeof s==='string'&&Number.isFinite(Date.parse(s));
const states=new Set(['ELIGIBLE','RESTRICTED','UNKNOWN','STALE','POLICY_BASE_MISMATCH','COUPON_UNAVAILABLE','OUT_OF_SCOPE']);
function requireValid(ok,what){if(!ok)throw new Error(`Invalid point snapshot: ${what}`);}
export function verifyPointSnapshot(db) {
  requireValid(db.prepare('PRAGMA quick_check').get().quick_check==='ok','SQLite integrity');
  const store=new PointPolicyStore(db);requireValid(store.hasTables(),'missing tables');
  for(const table of ['goods_point_policy','point_price_changes'])requireValid(!db.prepare(`SELECT 1 FROM ${table} p LEFT JOIN goods g USING(goods_no) WHERE g.goods_no IS NULL LIMIT 1`).get(),'unknown goods reference');
  let policies=0,prices=0,valid=0,unknown=0;
  for(const p of db.prepare('SELECT * FROM goods_point_policy').iterate()){
    requireValid(Number.isSafeInteger(p.goods_no)&&p.goods_no>0,'goods number');
    const values=[p.restricted,p.max_use_rate,p.observed_sale_price,p.observed_extra_discount];
    if(p.checked_at===null)requireValid(values.every(v=>v===null),'partial policy');
    else {requireValid([0,1].includes(p.restricted)&&rate(p.max_use_rate)&&money(p.observed_sale_price)&&money(p.observed_extra_discount)&&time(p.checked_at),'policy');policies++;}
    for(const key of ['last_attempt_at','rotation_attempt_at','next_retry_at'])requireValid(p[key]===null||money(p[key]),'attempt time');
  }
  for(const p of db.prepare('SELECT * FROM point_price_changes').iterate()){
    prices++;
    requireValid(states.has(p.state)&&p.policy_version===POINT_POLICY_VERSION,'state/version');
    requireValid(/^\d{4}-\d{2}-\d{2}$/.test(p.date)&&new Date(p.date).toISOString().slice(0,10)===p.date,'date');
    for(const key of ['sale_price','extra_discount','coupon_price'])requireValid(p[key]===null||money(p[key]),key);
    requireValid(p.coupon_source===null||['DIRECT','ESTIMATED'].includes(p.coupon_source),'coupon source');
    requireValid(p.policy_checked_at===null||time(p.policy_checked_at),'checked time');
    requireValid(p.max_use_rate===null||rate(p.max_use_rate),'rate');
    if(['ELIGIBLE','RESTRICTED'].includes(p.state)){
      requireValid(money(p.sale_price)&&money(p.extra_discount)&&money(p.coupon_price)&&['DIRECT','ESTIMATED'].includes(p.coupon_source)&&time(p.policy_checked_at)&&rate(p.max_use_rate),'priced basis');
      const discount=p.state==='RESTRICTED'?0:10*Math.floor(p.coupon_price*p.max_use_rate/10);
      requireValid(money(p.point_discount)&&p.point_discount===discount&&p.point_price===p.coupon_price-discount,'amount');
    }else requireValid(p.point_price===null&&p.point_discount===null,'unpriced amount');
  }
  for(const p of store.iterateLatestPrices())if(['ELIGIBLE','RESTRICTED'].includes(p.state))valid++;else unknown++;
  const run=store.getMeta('point_run:last');
  return {policies,prices,valid,unknown,lastStop:run?.stop??null};
}
export function checkPointSnapshotFile(dbPath=defaultMusinsaWideDbPath()) {
  const db=new DatabaseSync(dbPath,{readOnly:true});try{return verifyPointSnapshot(db);}finally{db.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(checkPointSnapshotFile(process.argv[2])));}catch(e){console.error(e.message);process.exitCode=1;}
}
