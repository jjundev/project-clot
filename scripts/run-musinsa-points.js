import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runPointPolicyJob} from '../src/musinsaWide/point-cli.js';
import {defaultMusinsaWideDbPath} from '../src/musinsaWide/store.js';
import {pullDb,pushDb} from '../src/musinsaWide/release.js';
import {checkPointSnapshotFile} from './check-musinsa-points.js';
export async function main(){
  const dbPath=defaultMusinsaWideDbPath();fs.mkdirSync(path.dirname(dbPath),{recursive:true});
  const r=await runPointPolicyJob({dbPath,pullFn:pullDb,checkFn:checkPointSnapshotFile,pushFn:pushDb,flags:{limit:process.env.POINT_LIMIT??'1000'}});
  console.log(JSON.stringify(r));
  if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`적립금 정책 수집: ${r.skipped?'disabled':r.result?.stop??'failed'}\n\n\`\`\`json\n${JSON.stringify(r,null,2)}\n\`\`\`\n`);
  if(!r.ok)process.exitCode=1;return r;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
