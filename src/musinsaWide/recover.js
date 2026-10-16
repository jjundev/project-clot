import { clientPool } from '../pool.js';
import { anonCall } from './client.js';
import { verifyProductCoverage, pricingCoverage } from './coverage.js';
import { refreshCouponPrices } from './pricing.js';

// Resume pricing from today's already collected snapshot, never reinterpret a transport failure as an API exception.
export async function resumeMusinsaPricing({store,date,makeClient,now=Date.now,log=console.log}) {
  const started=now();
  const run=store.db.prepare('SELECT * FROM scan_runs WHERE date=?').get(date);
  const {selected}=verifyProductCoverage(run);
  if (store.getMeta('backfill_done')==null || store.db.prepare("SELECT COUNT(*) n FROM goods WHERE status='ACTIVE'").get().n<selected) throw new Error('Cannot recover incomplete scan');
  const registry=JSON.parse(run.coupon_metrics_json??'null');
  const old=registry?.walk;
  const exceptions=old?.exceptions??[];
  if (!old || old.stop || !Number.isSafeInteger(old.suspectEmpty) || old.suspectEmpty<0 ||
      old.failed!==old.suspectEmpty && !(old.failed===0&&exceptions.length===old.suspectEmpty) ||
      old.walked+old.suspectEmpty!==old.requested || old.remaining!==old.suspectEmpty ||
      store.usableCoupons(date).length!==old.requested) throw new Error('Cannot recover incomplete coupon walk');

  const candidates=store.db.prepare(`SELECT c.coupon_no FROM coupons c
    WHERE c.state='USABLE' AND (c.until_date IS NULL OR c.until_date>=?)
      AND NOT EXISTS(SELECT 1 FROM coupon_goods m WHERE m.coupon_no=c.coupon_no AND m.date=?)
      AND EXISTS(SELECT 1 FROM goods g,json_each(g.coupons_json) j WHERE CAST(json_extract(j.value,'$.id') AS TEXT)=CAST(c.coupon_no AS TEXT))
    ORDER BY c.coupon_no`).all(date,date);
  const confirmed=[];let calls=0;
  const withClient=clientPool(makeClient);
  for (const {coupon_no:no} of candidates) {
    const result=await withClient(async client=>{
      const invoke=fn=>anonCall(()=>{calls++;return fn();},{sleep:client.sleep});
      const count=await invoke(()=>client.getCouponGoodsCount(no));
      const page=await invoke(()=>client.getCouponGoodsPage(no));
      if (count===0 && page.totalCount===0 && !page.hasNext && page.items.length===0) return true;
      if (count===0 || page.items.length===0) throw new Error('Cannot reconcile coupon exception response');
      return false;
    });
    if (result) confirmed.push(no);
  }
  if (confirmed.length!==old.suspectEmpty || exceptions.length && JSON.stringify(exceptions)!==JSON.stringify(confirmed)) throw new Error('Cannot reconcile saved coupon exceptions');
  const fresh=store.db.prepare(`SELECT COUNT(*) n FROM coupon_goods m JOIN coupons c ON c.coupon_no=m.coupon_no
    WHERE c.state='USABLE' AND (c.until_date IS NULL OR c.until_date>=?)
      AND c.coupon_no NOT IN (SELECT value FROM json_each(?)) AND (m.date IS NULL OR m.date<>?)`).get(date,JSON.stringify(confirmed),date).n;
  if (fresh) throw new Error('Cannot recover stale coupon mappings');
  registry.walk={...old,failed:0,failedCoupons:[],exceptions:confirmed,remaining:confirmed.length,complete:confirmed.length===0};
  pricingCoverage(registry.walk);
  const {prices,refreshDeferred,pricing}=refreshCouponPrices({store,date,ready:true,registry});
  if (refreshDeferred || !pricing) throw new Error('Cannot recover pricing');
  registry.pricing=pricing;
  const priorRecovery=registry.recovery;
  registry.recovery={kind:'pricing-only',sourceCompletedAt:priorRecovery?.sourceCompletedAt??run.completed_at,
    sourceDurationMs:priorRecovery?.sourceDurationMs??run.duration_ms,confirmationCalls:calls,
    attempts:(priorRecovery?.attempts??0)+1,totalConfirmationCalls:(priorRecovery?.totalConfirmationCalls??0)+calls};
  const durationMs=now()-started;
  store.recordScanRun({date,categoryCounts:JSON.parse(run.category_counts_json),complete:true,
    changed:run.changed,added:run.added,outOfScope:run.out_of_scope,durationMs:run.duration_ms+durationMs,
    couponsOk:false,couponChecks:0,couponMetrics:registry});
  log(`[무신사] 기존 ${selected}개 스냅샷 가격 복구: 추정 ${prices.estimated}, 직접 확인 ${prices.direct}, API 예외 ${confirmed.length}, 확인 호출 ${calls}`);
  return {date,categoryCounts:JSON.parse(run.category_counts_json),registry,durationMs,recovery:registry.recovery,
    diff:{initial:false,added:[],priceChanged:0,drops:[],revived:[],outOfScope:0},
    coupons:{memberStatus:'skipped',refreshDeferred:false,checked:0,failed:0,priced:prices.priced,withCoupon:prices.withCoupon,
      direct:prices.direct,estimated:prices.estimated,pricingPolicy:pricing.policy,exceptionCoupons:confirmed,stale:pricing.unpriced,
      drops:[],lateDrops:0,dropsSuppressed:true,ready:true}};
}
