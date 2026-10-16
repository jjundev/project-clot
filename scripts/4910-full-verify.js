// Snapshot -> partitioned option checks -> guarded publication. No token is written to files or logs.
import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {createClient} from '../src/site4910/client.js';import {readAblyToken} from '../src/site4910/liked.js';import {Store4910} from '../src/site4910/store.js';
import {resumeProofs,digest,walletFingerprint,readTargets,readExisting,collectPositiveTargets,verifyPartition,mergeVerification} from '../src/site4910/full-verification.js';
const args=process.argv.slice(2),mode=args.shift();
const flag=(key,fallback)=>{const i=args.indexOf('--'+key);return i<0?fallback:args[i+1];};
const dbPath=path.resolve(flag('db','data/4910.db')),dir=path.resolve(flag('dir','verification')),metaPath=path.join(dir,'meta.json');
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const hashFile=p=>digest(fs.readFileSync(p));
const write=(p,value)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p+'.tmp',JSON.stringify(value));fs.renameSync(p+'.tmp',p);};
const memberToken=readAblyToken();if(!memberToken)throw Error('ABLY_JWT_TOKEN missing');
if(!fs.existsSync(dbPath))throw Error('source database missing');
const client=createClient();const wallet=await client.getMyCoupons({memberToken});const fingerprint=walletFingerprint(wallet);
if(mode==='prepare'){
 const db=new DatabaseSync(dbPath,{readOnly:true});const targets=readTargets(db);
 if(!targets.length)throw Error('empty catalog');
 const date=today(),scan=db.prepare('select date from scan_runs order by date desc limit 1').get();
 if(scan?.date!==date)throw Error('full verification requires a current-day catalog scan');db.close();
 const positive=await collectPositiveTargets({client,wallet,memberToken,deadline:Date.now()+4*60_000,maxPages:12});
 const tracked=new Set(targets.map(t=>t.sno));
 const meta={version:1,sourceHash:hashFile(dbPath),date,fingerprint,partitions:32,targetDigest:digest(targets),total:targets.length,priority:[...positive.snos].filter(n=>tracked.has(n)),coupons:positive.coupons};
 write(metaPath,meta);console.log(JSON.stringify({total:meta.total,date,priority:meta.priority.length,coupons:meta.coupons}));
}else{
 const meta=JSON.parse(fs.readFileSync(metaPath));
 if(meta.version!==1||meta.fingerprint!==fingerprint||meta.date!==today()||hashFile(dbPath)!==meta.sourceHash)throw Error('snapshot, date or wallet changed; prepare a fresh run');
 const db=new DatabaseSync(dbPath,{readOnly:true}),targets=readTargets(db);
 if(digest(targets)!==meta.targetDigest)throw Error('target catalog changed');
 if(mode==='worker'){
  const partition=Number(flag('partition','-1')),output=path.join(dir,`part-${partition}.json`);
  let existing=readExisting(db,meta.date);db.close();
  if(fs.existsSync(output))existing=resumeProofs({existing,checkpoint:JSON.parse(fs.readFileSync(output)),meta,partition,targets});
  const seconds=Number(flag('budget-seconds','3000'));if(!Number.isFinite(seconds)||seconds<1||seconds>3000)throw Error('invalid verification budget');
  const result=await verifyPartition({...meta,targets,partition,memberToken,existing,priority:new Set(meta.priority),makeClient:()=>createClient(),concurrency:4,deadline:Date.now()+seconds*1000,onCheckpoint:r=>write(output,r)});
  write(output,result);console.log(JSON.stringify({partition,target:result.targetCount,checked:result.results.length,pending:result.pending,errors:result.errors.length}));
 }else if(mode==='merge'){
  db.close();const shards=Array.from({length:meta.partitions},(_,i)=>JSON.parse(fs.readFileSync(path.join(dir,`part-${i}.json`))));
  const store=new Store4910(dbPath);let summary;try{summary=mergeVerification({store,targets,meta,shards});store.checkpoint();}finally{store.close();}
  write(path.join(dir,'summary.json'),{...summary,date:meta.date,fingerprint,sourceHash:meta.sourceHash});console.log(JSON.stringify(summary));
 }else{db.close();throw Error('use prepare, worker or merge');}
}
