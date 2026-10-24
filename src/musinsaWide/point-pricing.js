import {PointPolicyStore,couponBasisFromRow} from './point-store.js';
import {evaluatePointEstimate,POINT_POLICY_VERSION} from './point-policy.js';
import {verifyDailyCoverage} from './coverage.js';
function couponFresh(db,asOfMs) {
  const run=db.prepare('SELECT * FROM scan_runs ORDER BY date DESC LIMIT 1').get();
  if(run?.date!==new Date(asOfMs).toISOString().slice(0,10))return false;
  try{verifyDailyCoverage(run);return true;}catch{return false;}
}
function load(db,enabled) {
  const counts={active:db.prepare("SELECT count(*) n FROM goods WHERE status='ACTIVE'").get().n,eligible:0,restricted:0,unknown:0};
  counts.unknown=counts.active;
  if(!enabled)return {counts};
  const store=new PointPolicyStore(db);
  if(!store.hasTables())return {counts};
  return {counts,store,policies:new Map([...store.iteratePolicies()].map(p=>[p.goodsNo,p])),
    latest:new Map([...store.iterateLatestPrices()].map(p=>[p.goodsNo,p]))};
}
function* subjects(db) {
  yield* db.prepare(`SELECT g.* FROM goods g WHERE EXISTS(SELECT 1 FROM goods_point_policy p WHERE p.goods_no=g.goods_no)
    OR EXISTS(SELECT 1 FROM point_price_changes p WHERE p.goods_no=g.goods_no)`).iterate();
}
function count(counts,g,r){if(g.status==='ACTIVE'&&['ELIGIBLE','RESTRICTED'].includes(r.state)){counts[r.state==='ELIGIBLE'?'eligible':'restricted']++;counts.unknown--;}}
export function refreshPointEstimates({db,asOfMs=Date.now(),enabled=process.env.CLOT_MUSINSA_POINTS_ENABLED==='1'}) {
  const {counts,store,policies}=load(db,enabled);
  if(!store)return {written:0,counts};
  const fresh=couponFresh(db,asOfMs);
  function* rows(){for(const g of subjects(db)){
    const basis=couponBasisFromRow(g),r=evaluatePointEstimate({basis,policy:policies.get(g.goods_no)??null,asOfMs,couponFresh:fresh});
    count(counts,g,r);
    yield {...basis,state:r.state,pointDiscount:r.discount,pointPrice:r.price,policyCheckedAt:r.checkedAt,maxUseRate:r.maxUseRate};
  }}
  const {written}=store.recordPrices({date:new Date(asOfMs).toISOString().slice(0,10),rows:rows()});
  return {written,counts};
}
export function readPointEstimateViews({db,asOfMs=Date.now(),enabled=process.env.CLOT_MUSINSA_POINTS_ENABLED==='1'}) {
  const {counts,store,policies,latest}=load(db,enabled),byGoods=new Map();
  if(!store)return {byGoods,counts};
  const fresh=couponFresh(db,asOfMs);
  for(const g of subjects(db)){
    const basis=couponBasisFromRow(g),saved=latest.get(g.goods_no);
    let r=evaluatePointEstimate({basis,policy:policies.get(g.goods_no)??null,asOfMs,couponFresh:fresh});
    // Builds may invalidate an old amount, but cannot invent an unrecorded current amount.
    if(r.price!==null&&(!saved||saved.policyVersion!==POINT_POLICY_VERSION||saved.state!==r.state||saved.pointPrice!==r.price||
        saved.pointDiscount!==r.discount||saved.salePrice!==basis.salePrice||saved.extraDiscount!==basis.extraDiscount||
        saved.couponPrice!==basis.couponPrice||saved.couponSource!==basis.couponSource||saved.maxUseRate!==r.maxUseRate||
        saved.date>new Date(asOfMs).toISOString().slice(0,10)))r={...r,state:'UNKNOWN',price:null,discount:null};
    byGoods.set(g.goods_no,r);count(counts,g,r);
  }
  return {byGoods,counts};
}
