// Bounded continuation is part of the collector pipeline, not a separate schedule.
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {spawnSync} from 'node:child_process';
export function continueVerification({summary,attempt=0,today,run=spawnSync}){
 if(!Number.isInteger(attempt)||attempt<0||attempt>4||!Number.isInteger(summary.total)||summary.total<=0||!Number.isInteger(summary.pending)||summary.pending<0||summary.pending>summary.total)throw Error('invalid continuation counters');
 if(summary.pending===0)return{queued:false};
 if(summary.date!==today)throw Error('verification date changed; start a new catalog scan');
 if(attempt>=4)throw Error('verification still pending after continuation budget');
 const r=run('gh',['workflow','run','4910-full.yml','--ref','main','-f',`continuation=${attempt+1}`],{encoding:'utf8'});
 if(r.status!==0)throw Error('unable to queue verification continuation: '+(r.stderr||r.error?.message||'unknown error'));
 return{queued:true,attempt:attempt+1,pending:summary.pending};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const summary=JSON.parse(fs.readFileSync('verification/summary.json'));
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 console.log(JSON.stringify(continueVerification({summary,today,attempt:Number(process.env.CLOT_VERIFICATION_CONTINUATION||0)})));
}
