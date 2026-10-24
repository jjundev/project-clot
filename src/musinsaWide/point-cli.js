import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {defaultMusinsaWideDbPath} from './store.js';
import {PointPolicyStore} from './point-store.js';
import {collectPointPolicies} from './point-collector.js';
import {refreshPointEstimates} from './point-pricing.js';
import {verifyPointSnapshot} from '../../scripts/check-musinsa-points.js';
function limitOf(flags) {
  const value=flags.limit??1000;
  if(typeof value==='boolean'||!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>5000)throw new Error('limit must be an integer from 1 to 5000');
  return Number(value);
}
function defaultOpen(dbPath,{readOnly}){
  const db=new DatabaseSync(dbPath,{readOnly});
  return {db,checkpoint:()=>db.exec('PRAGMA wal_checkpoint(TRUNCATE)'),close:()=>db.close()};
}
export async function runPointPolicyStep({flags={},dbPath=defaultMusinsaWideDbPath(),openStore=defaultOpen,fetchPolicy,now=Date.now,sleep,log=console.log}={}) {
  let wide;
  try{
    const dailyCap=limitOf(flags);
    if(process.env.CLOT_MUSINSA_POINTS_ENABLED!=='1')return {ok:true,publishable:false,skipped:true};
    if(!fs.existsSync(dbPath))throw new Error('musinsa-wide.db 없음 — 먼저 musinsa-db pull');
    const dryRun=Boolean(flags['dry-run']);wide=openStore(dbPath,{readOnly:dryRun});
    const store=new PointPolicyStore(wide.db,{initialize:!dryRun});
    if(dryRun){
      const candidates=wide.db.prepare("SELECT count(*) n FROM goods WHERE status='ACTIVE' AND is_sold_out=0 AND typeof(sale_price)='integer' AND sale_price>=0").get().n;
      log(JSON.stringify({dryRun:true,candidates,dailyCap}));return {ok:true,publishable:false,candidates};
    }
    const result=await collectPointPolicies({store,fetchPolicy,now,sleep,dailyCap});
    refreshPointEstimates({db:wide.db,asOfMs:now(),enabled:true});
    verifyPointSnapshot(wide.db);wide.checkpoint();log(JSON.stringify(result));return {ok:true,publishable:true,result};
  }catch(e){log(`적립금 수집 실패: ${e.message}`);return {ok:false,publishable:false,error:e.message};}
  finally{
    if(wide)try{wide.close();}catch(e){log(`적립금 DB 닫기 실패: ${e.message}`);return {ok:false,publishable:false,error:e.message};}
  }
}
export async function runPointPolicyJob({dbPath=defaultMusinsaWideDbPath(),pullFn,stepFn=runPointPolicyStep,checkFn,pushFn,flags={},enabled=process.env.CLOT_MUSINSA_POINTS_ENABLED==='1',log=console.log}) {
  let result;
  try{
    limitOf(flags);
    if(!enabled)return {ok:true,published:false,skipped:true};
    const base=await pullFn({dest:dbPath});
    if(base?.source!=='latest')throw new Error('Point collection requires latest Release snapshot; prev fallback refused');
    const step=await stepFn({dbPath,flags});result=step.result;
    if(!step.ok)throw new Error(step.error??'Point collection failed');
    if(!step.publishable)return {ok:true,published:false,result};
    await checkFn(dbPath);await pushFn({src:dbPath});
    return {ok:true,published:true,result};
  }catch(e){log(e.message);return {ok:false,published:false,...(result?{result}:{}),error:e.message};}
}
