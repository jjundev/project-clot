import {POINT_TTL_MS,POINT_POLICY_VERSION} from './point-policy.js';
export const quotaDate = ms => new Date(ms + 9*3600000).toISOString().slice(0,10);
export const couponBasisFromRow = g => ({goodsNo:g.goods_no,status:g.status,salePrice:g.sale_price,
  extraDiscount:g.extra_discount,couponPrice:g.coupon_price,couponSource:g.coupon_price_source});
const policyFromRow = p => p?.checked_at == null ? null : ({goodsNo:p.goods_no,restricted:p.restricted===1?true:p.restricted===0?false:null,
  maxUseRate:p.max_use_rate,observedSalePrice:p.observed_sale_price,observedExtraDiscount:p.observed_extra_discount,checkedAt:p.checked_at});
const priceColumns = ['goods_no','date','state','sale_price','extra_discount','coupon_price','coupon_source','point_discount','point_price','policy_checked_at','max_use_rate','policy_version'];
const priceKeys = ['goodsNo','date','state','salePrice','extraDiscount','couponPrice','couponSource','pointDiscount','pointPrice','policyCheckedAt','maxUseRate','policyVersion'];
const priceFromRow = r => Object.fromEntries(priceKeys.map((k,i)=>[k,r[priceColumns[i]]]));
const comparable = r => JSON.stringify(priceKeys.filter(k=>!['goodsNo','date','policyCheckedAt'].includes(k)).map(k=>r[k]??null));
export class PointPolicyStore {
  constructor(db,{initialize=false}={}) {
    this.db=db;
    if(initialize)db.exec(`
      CREATE TABLE IF NOT EXISTS goods_point_policy (
        goods_no INTEGER PRIMARY KEY, restricted INTEGER CHECK(restricted IN (0,1)), max_use_rate REAL,
        observed_sale_price INTEGER, observed_extra_discount INTEGER, checked_at TEXT,
        last_attempt_at INTEGER, next_retry_at INTEGER, last_error_code TEXT, rotation_attempt_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS point_price_changes (
        goods_no INTEGER NOT NULL,date TEXT NOT NULL,state TEXT NOT NULL,sale_price INTEGER,extra_discount INTEGER,
        coupon_price INTEGER,coupon_source TEXT,point_discount INTEGER,point_price INTEGER,policy_checked_at TEXT,
        max_use_rate REAL,policy_version TEXT NOT NULL DEFAULT 'points-max-use-v1',PRIMARY KEY(goods_no,date)
      );
      CREATE INDEX IF NOT EXISTS idx_point_rotation ON goods_point_policy(rotation_attempt_at,goods_no);
    `);
    this.available=db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('goods_point_policy','point_price_changes')").get().n===2;
  }
  hasTables(){return this.available;}
  getPolicy(goodsNo){return this.available?policyFromRow(this.db.prepare('SELECT * FROM goods_point_policy WHERE goods_no=?').get(goodsNo)):null;}
  *iteratePolicies(){if(this.available)for(const r of this.db.prepare('SELECT * FROM goods_point_policy WHERE checked_at IS NOT NULL').iterate())yield policyFromRow(r);}
  pickCandidates({lane,limit,asOfMs,excludeGoodsNos=[]}) {
    if(!this.available || limit<=0)return [];
    if(!['urgent','rotation'].includes(lane))throw new Error('Invalid point candidate lane');
    const condition=lane==='urgent'?'(p.checked_at IS NULL OR p.observed_sale_price!=g.sale_price OR p.observed_extra_discount!=g.extra_discount)':
      '(p.checked_at IS NULL OR julianday(p.checked_at)<=julianday(?) OR julianday(p.checked_at)>julianday(?))';
    const order=lane==='urgent'?'p.last_attempt_at':'p.rotation_attempt_at';
    return this.db.prepare(`SELECT g.* FROM goods g LEFT JOIN goods_point_policy p USING(goods_no)
      WHERE g.status='ACTIVE' AND g.is_sold_out=0 AND typeof(g.sale_price)='integer' AND g.sale_price>=0
      AND typeof(g.extra_discount)='integer' AND g.extra_discount>=0 AND (p.next_retry_at IS NULL OR p.next_retry_at<=?)
      AND g.goods_no NOT IN (SELECT value FROM json_each(?)) AND ${condition}
      ORDER BY ${order} IS NOT NULL,${order},g.first_seen_date,g.goods_no LIMIT ?`)
      .all(asOfMs,JSON.stringify([...excludeGoodsNos]),...(lane==='rotation'?[new Date(asOfMs-POINT_TTL_MS).toISOString(),new Date(asOfMs).toISOString()]:[]),limit).map(couponBasisFromRow);
  }
  getMeta(key){const r=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);return r?JSON.parse(r.value):null;}
  setMeta(key,value){this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  getAttempts(date){return this.getMeta(`point_budget:${date}`)?.attempts??0;}
  getNextStartAtMs(){return this.getMeta('point_pacing:last')?.nextStartAtMs??0;}
  reserveAttempt({goodsNo,lane,atMs,dailyCap}) {
    if(!Number.isInteger(dailyCap)||dailyCap<1||dailyCap>5000)throw new Error('Invalid point daily cap');
    if(!this.available)throw new Error('Point tables unavailable');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const date=quotaDate(atMs),attempts=this.getAttempts(date);
      if(attempts>=dailyCap||atMs<this.getNextStartAtMs()){this.db.exec('ROLLBACK');return false;}
      this.setMeta(`point_budget:${date}`,{attempts:attempts+1});this.setMeta('point_pacing:last',{nextStartAtMs:atMs+1000});
      this.db.prepare(`INSERT INTO goods_point_policy(goods_no,last_attempt_at,rotation_attempt_at) VALUES(?,?,?)
        ON CONFLICT(goods_no) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,rotation_attempt_at=excluded.rotation_attempt_at`).run(goodsNo,atMs,atMs);
      this.db.exec('COMMIT');return true;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  savePolicy(p){
    this.db.prepare(`INSERT INTO goods_point_policy(goods_no,restricted,max_use_rate,observed_sale_price,observed_extra_discount,checked_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(goods_no) DO UPDATE SET restricted=excluded.restricted,max_use_rate=excluded.max_use_rate,
      observed_sale_price=excluded.observed_sale_price,observed_extra_discount=excluded.observed_extra_discount,
      checked_at=excluded.checked_at,next_retry_at=NULL,last_error_code=NULL`)
      .run(p.goodsNo,Number(p.restricted),p.maxUseRate,p.observedSalePrice,p.observedExtraDiscount,p.checkedAt);
  }
  saveFailure({goodsNo,atMs,code}) {
    this.db.prepare(`INSERT INTO goods_point_policy(goods_no,last_attempt_at,rotation_attempt_at,next_retry_at,last_error_code) VALUES(?,?,?,?,?)
      ON CONFLICT(goods_no) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,rotation_attempt_at=excluded.rotation_attempt_at,
      next_retry_at=excluded.next_retry_at,last_error_code=excluded.last_error_code`).run(goodsNo,atMs,atMs,atMs+3600000,code);
  }
  recordPrices({date,rows}) {
    if(!this.available)return {written:0};
    const before=this.db.prepare('SELECT * FROM point_price_changes WHERE goods_no=? AND date<? ORDER BY date DESC LIMIT 1');
    const today=this.db.prepare('DELETE FROM point_price_changes WHERE goods_no=? AND date=?');
    const insert=this.db.prepare(`INSERT INTO point_price_changes(${priceColumns.join(',')}) VALUES(${priceColumns.map(()=>'?').join(',')})
      ON CONFLICT(goods_no,date) DO UPDATE SET ${priceColumns.slice(2).map(k=>`${k}=excluded.${k}`).join(',')}`);
    let written=0;this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const raw of rows){
        const r={policyVersion:POINT_POLICY_VERSION,...raw,date},prior=before.get(r.goodsNo,date);
        if((!prior&&r.state==='UNKNOWN')||(prior&&comparable(priceFromRow(prior))===comparable(r))){written+=Number(today.run(r.goodsNo,date).changes);continue;}
        written+=Number(insert.run(...priceKeys.map(k=>r[k]??null)).changes);
      }
      this.db.exec('COMMIT');return {written};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  *iterateLatestPrices(){if(this.available)for(const r of this.db.prepare(`SELECT p.* FROM point_price_changes p
    WHERE p.date=(SELECT MAX(q.date) FROM point_price_changes q WHERE q.goods_no=p.goods_no)`).iterate())yield priceFromRow(r);}
  recordRun(result){this.setMeta('point_run:last',result);}
}
