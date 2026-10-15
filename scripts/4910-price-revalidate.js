#!/usr/bin/env node
// Read-only by default. Applying writes validation metadata, never rewrites raw prices.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readPriceValidations } from '../src/site4910/price-validation.js';
import { resolveMemberPrice } from '../src/site4910/member-price.js';
import { createClient } from '../src/site4910/client.js';
import { readAblyToken } from '../src/site4910/liked.js';

function validateRange(from, to) {
  const valid = d => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '') && !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0,10) === d;
  if (!valid(from) || !valid(to) || from > to) throw new Error('invalid date range');
}
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

export async function revalidate4910({ db, client = null, from, to, now = new Date().toISOString(), apply = false }) {
  validateRange(from,to);
  const report = { from, to, checkedAt: now, affected: 0, correctable: 0, corrected: 0, verified: 0, unverified: 0, invalid: 0,
    byKind: {}, byReason: {}, liveChecks: [], errors: [], missing: 0 };
  const updates = [];
  for (const [kind, table] of [['liked','liked_price_logs'],['scan','coupon_price_changes']]) {
    if (!hasTable(db,table)) continue;
    const validations = readPriceValidations(db,kind);
    const rows = db.prepare(`SELECT * FROM ${table} WHERE date >= ? AND date <= ? ORDER BY sno,date`).all(from,to);
    report.byKind[kind] = rows.length;
    for (const raw of rows) {
      report.affected++;
      const existing = validations.get(`${raw.sno}:${raw.date}`);
      let status = 'unverified', reason = 'legacy-missing-platform-option-conditions', corrected = null, evidence = null;
      try { evidence = existing?.evidence_json ? JSON.parse(existing.evidence_json) : null; } catch { /* corrupt evidence cannot authorize a price */ }
      // A captured date and matching option are mandatory: present-day responses are never historical evidence.
      if (evidence?.observedDate === raw.date && evidence.priceBasis === 'AGLO' && evidence.optionSno != null &&
          evidence.bestOptionSno === evidence.optionSno && evidence.isApplied === true &&
          Number.isFinite(evidence.basePrice) && evidence.basePrice > 0 && Number.isFinite(evidence.discount) &&
          evidence.discount >= 0 && evidence.discount <= evidence.basePrice) {
        const price = Math.min(evidence.basePrice, Math.ceil((evidence.basePrice-evidence.discount)/10)*10);
        const key = kind === 'liked' ? 'member_price' : 'coupon_price';
        corrected = { [key]: price, ...(kind === 'scan' ? { sale_price:evidence.basePrice } : {}) };
        status = price === raw[key] ? 'verified' : 'corrected'; reason = 'contemporaneous-option-discount';
      } else if (existing && ['verified','corrected','invalid'].includes(existing.status)) {
        // Preserve earlier explicit decisions rather than upgrade or erase them on a second run.
        status=existing.status; reason=existing.reason;
        corrected=existing.corrected_json ? JSON.parse(existing.corrected_json) : null;
      }
      report[status]++;
      if (status === 'corrected') report.correctable++;
      report.byReason[reason]=(report.byReason[reason]??0)+1;
      updates.push({kind,sno:raw.sno,date:raw.date,status,reason,corrected,evidence});
    }
  }
  if (!report.affected) throw new Error('empty or missing price history in date range');
  if (client) {
    const targets = new Map();
    if (hasTable(db,'liked_goods')) for (const row of db.prepare("SELECT sno FROM liked_goods WHERE status='ACTIVE' ORDER BY sno").all()) targets.set(row.sno,{...row,source:'liked'});
    if (hasTable(db,'goods')) {
      for (const row of db.prepare(`SELECT MIN(sno) AS sno,market_sno FROM goods WHERE status='ACTIVE' AND sale_price>=10000 AND market_sno IS NOT NULL
        GROUP BY market_sno ORDER BY market_sno LIMIT 30`).all()) if (!targets.has(row.sno)) targets.set(row.sno,{...row,source:'seller-sample'});
    }
    if (!targets.size) report.errors.push({code:'EMPTY_LIVE_TARGETS'});
    for (const target of targets.values()) {
      try {
        const detail=await client.getGoodsDetail(target.sno);
        const best=detail.optionSno == null ? undefined : await client.getBestCoupon(detail.optionSno);
        let resolved=resolveMemberPrice(detail,best);
        if (client.getMemberGoodsDetail) {
          const member=await client.getMemberGoodsDetail(target.sno);
          if (member.priceBasis !== 'AGLO' || member.optionSno !== detail.optionSno || member.listPrice !== detail.listPrice) resolved={price:null,reason:'member-detail-mismatch'};
        }
        report.liveChecks.push({...target,observedAt:now,priceBasis:detail.priceBasis,optionSno:detail.optionSno,
          basePrice:detail.listPrice,couponSno:best?.couponSno??null,discount:best?.discount??null,isApplied:best?.isApplied??null,
          candidate:best && Number.isFinite(detail.listPrice) ? Math.ceil((detail.listPrice-best.discount)/10)*10 : null,
          price:resolved.price,reason:resolved.reason,status:resolved.price == null ? 'unverified':'verified'});
      } catch (err) {
        const code=err.code === 'MEMBER_AUTH' ? 'MEMBER_AUTH':'LIVE_REQUEST_FAILED';
        report.errors.push({sno:target.sno,code});
        report.liveChecks.push({...target,observedAt:now,status:'unverified',price:null,reason:code});
        if (code === 'MEMBER_AUTH') break;
      }
    }
  }
  if (apply) {
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS price_validations (kind TEXT NOT NULL,sno INTEGER NOT NULL,date TEXT NOT NULL,status TEXT NOT NULL,
        corrected_json TEXT,reason TEXT NOT NULL,evidence_json TEXT,checked_at TEXT NOT NULL,PRIMARY KEY(kind,sno,date))`);
      const put=db.prepare(`INSERT OR REPLACE INTO price_validations (kind,sno,date,status,corrected_json,reason,evidence_json,checked_at) VALUES (?,?,?,?,?,?,?,?)`);
      for (const r of updates) put.run(r.kind,r.sno,r.date,r.status,r.corrected?JSON.stringify(r.corrected):null,r.reason,r.evidence?JSON.stringify(r.evidence):null,now);
      db.exec('COMMIT');
    } catch (err) {db.exec('ROLLBACK');throw err;}
  }
  report.missing=report.affected-report.verified-report.corrected-report.unverified-report.invalid;
  return report;
}

export async function runRevalidationCli(argv) {
  const flags = {};
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if (arg==='--apply'||arg==='--live') flags[arg.slice(2)]=true;
    else if (['--db','--from','--to','--out'].includes(arg)) {
      if (!argv[i+1] || argv[i+1].startsWith('--')) throw new Error('missing CLI argument');
      flags[arg.slice(2)]=argv[++i];
    } else throw new Error('unknown CLI argument');
  }
  validateRange(flags.from,flags.to);
  if (!flags.db || !flags.out || !fs.statSync(flags.db).isFile()) throw new Error('existing --db and --out required');
  const dbPath=path.resolve(flags.db),out=path.resolve(flags.out);
  if (dbPath===out || out===dbPath+'-wal' || out===dbPath+'-shm') throw new Error('report path overlaps DB');
  // A standalone Release copy is the intended input. Never copy a live, uncheckpointed database.
  if (fs.existsSync(dbPath+'-wal') && fs.statSync(dbPath+'-wal').size>0) throw new Error('checkpoint or copy live WAL database first');
  const before=sha(dbPath);
  let backup=null;
  if (flags.apply) {
    const backupPath=dbPath+'.before-revalidation-'+Date.now()+'.bak';
    fs.copyFileSync(dbPath,backupPath,fs.constants.COPYFILE_EXCL);
    if (sha(backupPath)!==before) throw new Error('backup SHA256 mismatch');
    backup={path:backupPath,sha256:before};
  }
  let client=null;
  if (flags.live) {
    const token=readAblyToken();
    if (!token) throw new Error('live checks require member token');
    const api=createClient();
    client={getGoodsDetail:sno=>api.getGoodsDetail(sno),getMemberGoodsDetail:sno=>api.getGoodsDetail(sno,{memberToken:token}),
      getBestCoupon:option=>api.getBestCoupon(option,{memberToken:token})};
  }
  const db=new DatabaseSync(dbPath,{readOnly:!flags.apply});
  let report;
  try {report=await revalidate4910({db,client,from:flags.from,to:flags.to,apply:!!flags.apply});} finally {db.close();}
  if (!flags.apply && sha(dbPath)!==before) throw new Error('dry-run modified database');
  report={...report,db:dbPath,inputSha256:before,outputSha256:sha(dbPath),backup,applied:!!flags.apply};
  fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const r=await runRevalidationCli(process.argv.slice(2));
    console.log(JSON.stringify({affected:r.affected,corrected:r.corrected,unverified:r.unverified,invalid:r.invalid,liveChecks:r.liveChecks.length,errors:r.errors.length}));
    if (r.errors.length || r.missing) process.exitCode=1;
  } catch (err) {console.error(`4910 revalidation failed: ${err.code??err.name}`);process.exitCode=1;}
}
