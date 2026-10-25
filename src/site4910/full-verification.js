// Whole-catalog option proofs. A partial coupon list prioritizes work; it never proves an optimum.
import {createHash} from 'node:crypto';
import {mapConcurrent,clientPool} from '../pool.js';
import {parseCouponConditions} from './coupon-eligibility.js';
import {resolveMemberPrice} from './member-price.js';
export const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
export function walletFingerprint(wallet){
 return digest(wallet.map(c=>({couponSno:c.couponSno,usable:c.usable,type:c.type,percent:c.percent,price:c.price,max:Number.isFinite(c.max)?c.max:null,min:c.min,finishedAt:c.finishedAt,conditions:c.conditions,appOnly:c.appOnly,hasTargets:c.hasTargets})).sort((a,b)=>a.couponSno-b.couponSno));
}
export function readTargets(db){
 const map=new Map(db.prepare("SELECT sno,sale_price FROM goods WHERE status='ACTIVE' ORDER BY sno").all().map(r=>[r.sno,{sno:r.sno,scan:true,liked:false,base:r.sale_price}]));
 for(const r of db.prepare("SELECT sno FROM liked_goods WHERE status='ACTIVE' ORDER BY sno").all()){
  if(map.has(r.sno))map.get(r.sno).liked=true;else map.set(r.sno,{sno:r.sno,scan:false,liked:true,base:null});
 }
 return [...map.values()].sort((a,b)=>a.sno-b.sno);
}
export function partitionTargets(targets,partition,partitions){
 if(!Number.isInteger(partitions)||partitions<1||!Number.isInteger(partition)||partition<0||partition>=partitions)throw Error('invalid partition');
 return targets.filter(t=>t.sno%partitions===partition);
}
export async function collectPositiveTargets({client,wallet,memberToken,maxPages=12,deadline=Infinity}){
 const snos=new Set(),coupons=[];
 for(const c of wallet){
  const terms=parseCouponConditions(c.conditions);
  if(!c.usable||c.appOnly||terms.minQuantity!==1||terms.minAmount==null||/네이버|유입|경유/.test([c.name,...(c.conditions??[])].join(' ')))continue;
  let cursor=null,total=null,finished=false;const seen=new Set(),cursors=new Set();let error=null;
  try{for(let page=0;page<maxPages&&Date.now()<deadline;page++){
   const p=await client.getCouponGoodsPage(c.couponSno,{memberToken,lastSno:cursor});
   if(total!==null&&total!==p.totalCount){error='count-changed';break;}total=p.totalCount;
   p.snos.forEach(s=>{seen.add(s);snos.add(s);});
   if(p.lastSno==null){finished=true;break;}
   if(cursors.has(p.lastSno)||!p.snos.length){error='cursor';break;}cursors.add(p.lastSno);cursor=p.lastSno;
  }}catch(e){if(e.code==='MEMBER_AUTH')throw e;error='request-failed';}
  coupons.push({couponSno:c.couponSno,total,received:seen.size,complete:finished&&seen.size===total,error});
 }
 return {snos,coupons};
}
export function readExisting(db,date){
 const map=new Map();
 for(const v of db.prepare('SELECT evidence_json FROM price_validations WHERE date=?').all(date)){
  try{const d=JSON.parse(v.evidence_json)?.fullVerification;if(d)map.set(d.sno,d);}catch{}
 }
 return map;
}
export async function verifyPartition({targets,date,fingerprint,sourceHash,partition,partitions,makeClient,memberToken,existing=new Map(),priority=new Set(),deadline=Infinity,concurrency=4,onCheckpoint=()=>{}}){
 const work=partitionTargets(targets,partition,partitions).sort((a,b)=>Number(priority.has(b.sno))-Number(priority.has(a.sno))||a.sno-b.sno);
 const out={version:1,sourceHash,date,fingerprint,partition,partitions,targetCount:work.length,results:[],errors:[],pending:work.length};
 const withClient=clientPool(makeClient);let stopped=false,lastCheckpoint=Date.now();
 await mapConcurrent(work,concurrency,async t=>{
  const old=existing.get(t.sno);
  if(t.base!=null&&old?.date===date&&old.fingerprint===fingerprint&&old.listingBase===t.base){out.results.push(old);out.pending--;return;}
  if(stopped||Date.now()>=deadline)return;
  await withClient(async c=>{
   let detailReceived=false;
   try{
    const detail=await c.getGoodsDetail(t.sno);detailReceived=true;
    // No option or unavailable is an explicit unverified observation, never a no-coupon price.
    const best=detail.optionSno!=null&&!detail.isSoldout&&detail.isOpen!==false?await c.getBestCoupon(detail.optionSno,{memberToken}):null;
    const proof={sno:t.sno,detail,best,date,fingerprint,listingBase:t.base,checkedAt:new Date().toISOString()};
    out.results.push(proof);out.pending--;
   }catch(e){if(e.status===404&&!detailReceived){out.results.push({sno:t.sno,detail:{sno:t.sno,priceBasis:'AGLO',isOpen:false,isSoldout:true,optionSno:null,listPrice:null,originalPrice:null},best:null,date,fingerprint,listingBase:t.base,checkedAt:new Date().toISOString()});out.pending--;return;}out.errors.push({sno:t.sno,reason:e.code==='MEMBER_AUTH'?'member-auth':'request-failed',status:e.status??null});if(e.code==='MEMBER_AUTH')stopped=true;}
  });
  if(Date.now()-lastCheckpoint>5000){lastCheckpoint=Date.now();await onCheckpoint(out);}
 });
 await onCheckpoint(out);return out;
}
function checkProof(r,t,meta){
 if(r.date!==meta.date||r.fingerprint!==meta.fingerprint||r.listingBase!==t.base||!r.detail||!Object.hasOwn(r,'best')||!r.checkedAt||Number.isNaN(Date.parse(r.checkedAt)))throw Error('invalid product proof');
 const d=r.detail;
 if(d.sno!==r.sno||!['AGLO'].includes(d.priceBasis))throw Error('invalid price basis');
 return resolveMemberPrice(d,r.best);
}
export function mergeVerification({store,targets,meta,shards}){
 if(shards.length!==meta.partitions)throw Error('missing partition');
 const all=new Map(targets.map(t=>[t.sno,t])),proofs=new Map(),parts=new Set();
 for(const s of shards){
  if(s.version!==1||s.sourceHash!==meta.sourceHash||s.date!==meta.date||s.fingerprint!==meta.fingerprint||s.partitions!==meta.partitions||parts.has(s.partition))throw Error('foreign or duplicate partition');
  const work=partitionTargets(targets,s.partition,s.partitions);
  if(s.targetCount!==work.length||s.pending!==work.length-s.results.length)throw Error('partition count mismatch');parts.add(s.partition);
  for(const r of s.results){const t=all.get(r.sno);if(!t||r.sno%meta.partitions!==s.partition||proofs.has(r.sno))throw Error('foreign or duplicate product');checkProof(r,t,meta);proofs.set(r.sno,r);}
 }
 const summary={total:targets.length,attempted:proofs.size,verified:0,unverified:0,pending:targets.length-proofs.size,reasons:{}};
 // Validate the entire input before the first write; all publication writes are one transaction.
 store.db.exec('BEGIN IMMEDIATE');
 try{
  const set=store.db.prepare('UPDATE goods SET coupon_price=? WHERE sno=?');
  const history=store.db.prepare('INSERT OR IGNORE INTO coupon_price_changes(sno,date,sale_price,coupon_price) VALUES(?,?,?,?)');
  for(const [sno,r] of proofs){
   const t=all.get(sno),resolved=resolveMemberPrice(r.detail,r.best),price=resolved.price;
   const status=price==null?'unverified':'verified';summary[status]++;summary.reasons[resolved.reason]=(summary.reasons[resolved.reason]??0)+1;
   const evidence={observedDate:meta.date,priceBasis:r.detail.priceBasis,basePrice:r.detail.listPrice,originalPrice:r.detail.originalPrice,optionSno:r.detail.optionSno,bestOptionSno:r.best?.optionSno??null,isApplied:r.best?.isApplied??null,fullVerification:r};
   if(t.scan){
    store.putPriceValidation({kind:'scan',sno,date:meta.date,status,reason:resolved.reason,corrected:price==null?null:{sale_price:r.detail.listPrice,coupon_price:price},evidence,checkedAt:r.checkedAt});
    set.run(price,sno);
    if(Number.isFinite(r.detail.listPrice)){
      store.observations.seen(sno,{at:r.checkedAt,date:meta.date,price:r.detail.listPrice,hasPrice:true});
      if(price!=null)store.observations.price(sno,{date:meta.date,at:r.checkedAt,price,basis:'4910 검증가',verifiedAt:r.checkedAt});
    }
    if(Number.isFinite(r.detail.listPrice)&&r.detail.listPrice>0)history.run(sno,meta.date,r.detail.listPrice,price);
   }
   if(t.liked){
    store.db.prepare('INSERT OR IGNORE INTO liked_price_logs(sno,date,list_price,original_price,coupon_price,member_price,is_soldout) VALUES(?,?,?,?,?,?,?)').run(sno,meta.date,r.detail.listPrice??null,r.detail.originalPrice??null,null,price,r.detail.isSoldout?1:0);
    store.putPriceValidation({kind:'liked',sno,date:meta.date,status,reason:resolved.reason,corrected:price==null?null:{list_price:r.detail.listPrice,original_price:r.detail.originalPrice,member_price:price,coupon_price:null},evidence,checkedAt:r.checkedAt});
   }
  }
  store.db.exec('COMMIT');
 }catch(e){store.db.exec('ROLLBACK');throw e;}
 return summary;
}

export function resumeProofs({existing,checkpoint,meta,partition,targets}){
 if(checkpoint.sourceHash!==meta.sourceHash||checkpoint.fingerprint!==meta.fingerprint||checkpoint.date!==meta.date||checkpoint.partition!==partition||checkpoint.partitions!==meta.partitions)throw Error('foreign checkpoint');
 const allowed=new Map(partitionTargets(targets,partition,meta.partitions).map(t=>[t.sno,t]));
 const out=new Map(existing),seen=new Set();
 for(const r of checkpoint.results){const t=allowed.get(r.sno);if(!t||seen.has(r.sno))throw Error('invalid checkpoint product');checkProof(r,t,meta);seen.add(r.sno);out.set(r.sno,r);}
 return out;
}

// A collector may replace same-day validation metadata. Trusted prior workflow artifacts can
// still seed the queue, but never waive current wallet/date/base or product/option checks.
export function reusableProofs({existing,candidates,targets,date,fingerprint}){
 const allowed=new Map(targets.map(t=>[t.sno,t])),out=new Map(existing);
 for(const r of candidates){
  const t=allowed.get(r.sno);if(!t||t.base==null)continue;
  try{checkProof(r,t,{date,fingerprint});}catch{continue;}
  const old=out.get(r.sno);
  if(!old||Date.parse(r.checkedAt)>Date.parse(old.checkedAt))out.set(r.sno,r);
 }
 return out;
}
