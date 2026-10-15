import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Store4910 } from '../src/site4910/store.js';
import { revalidate4910, runRevalidationCli } from '../scripts/4910-price-revalidate.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const DATE='2026-10-15', NOW='2026-10-16T03:00:00Z';
function fixture(dbPath=':memory:') {
  const s=new Store4910(dbPath);
  s.syncLiked([{sno:1,name:'a',url:'x'}],DATE);
  s.logLikedPrice({sno:1,date:DATE,list_price:85200,member_price:81410,coupon_price:72420});return s;
}
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
test('empty input and invalid date range fail instead of claiming successful audit',async()=>{
  const db=new DatabaseSync(':memory:');
  await assert.rejects(revalidate4910({db,from:DATE,to:DATE,now:NOW}),/empty|missing/);
  await assert.rejects(revalidate4910({db,from:'bad',to:DATE,now:NOW}),/range/);db.close();
});
test('live observations never correct a historical price and authentication errors are sanitized',async()=>{
  const s=fixture();let calls=0;
  const client={getGoodsDetail:async()=>{calls++;throw Object.assign(new Error('SECRET'),{code:'MEMBER_AUTH'});}};
  const r=await revalidate4910({db:s.db,client,from:DATE,to:DATE,now:NOW});
  assert.equal(r.affected,1);assert.equal(r.unverified,1);assert.equal(r.corrected,0);assert.equal(calls,1);
  assert.equal(r.errors.length,1);assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.equal(s.db.prepare('SELECT member_price FROM liked_price_logs').get().member_price,81410);s.close();
});
test('apply only writes validation evidence and repeated application has the same classification and row count',async()=>{
  const s=fixture();
  const args={db:s.db,from:DATE,to:DATE,now:NOW,apply:true};
  const a=await revalidate4910(args), b=await revalidate4910(args);
  assert.equal(a.unverified,1);assert.equal(b.unverified,1);assert.equal(a.corrected,0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM price_validations').get().n,1);
  assert.equal(s.db.prepare('SELECT member_price FROM liked_price_logs').get().member_price,81410);s.close();
});
test('only contemporaneous AGLO option and applied discount evidence can correct a row',async()=>{
  const s=fixture();
  s.putPriceValidation({kind:'liked',sno:1,date:DATE,status:'unverified',reason:'recheck',
    evidence:{observedDate:DATE,priceBasis:'AGLO',optionSno:42,bestOptionSno:42,basePrice:75900,discount:3790,isApplied:true}});
  const r=await revalidate4910({db:s.db,from:DATE,to:DATE,now:NOW,apply:true});
  assert.equal(r.corrected,1);
  assert.equal(JSON.parse(s.db.prepare('SELECT corrected_json FROM price_validations').get().corrected_json).member_price,72110);s.close();
});
test('CLI dry run preserves DB hash; apply makes a verified backup and leaves raw history unchanged',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clot-revalidate-')),dbPath=path.join(dir,'4910.db'),out=path.join(dir,'report.json');
  try {
    const s=fixture(dbPath);s.close();const before=sha(dbPath);
    const args=['--db',dbPath,'--from',DATE,'--to',DATE,'--out',out];
    await runRevalidationCli(args);assert.equal(sha(dbPath),before);
    await runRevalidationCli([...args,'--apply']);
    const report=JSON.parse(fs.readFileSync(out));assert.equal(sha(report.backup.path),before);
    const read=new DatabaseSync(dbPath,{readOnly:true});assert.equal(read.prepare('SELECT member_price FROM liked_price_logs').get().member_price,81410);read.close();
    await assert.rejects(runRevalidationCli(['--db',path.join(dir,'missing'),'--from',DATE,'--to',DATE,'--out',out]));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
