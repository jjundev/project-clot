import {createDashboardModel} from './dashboard-model.js';

export const {priceSignalEligibility}=createDashboardModel();
export function appendPriceSample(samples=[],sample) {
  return [...samples.filter(s=>s.date!==sample.date),sample].sort((a,b)=>a.date.localeCompare(b.date)).slice(-2);
}
export function readObservation(value) {
  if(!value)return {};
  try {const x=JSON.parse(value);return x&&typeof x==='object'&&!Array.isArray(x)?x:{};}catch{return {};}
}
export function publicTracking(value,status) {
  const x=typeof value==='string'?readObservation(value):(value||{});
  return {status,seenAt:x.seenAt??null,saleAt:x.saleAt??null,samples:Array.isArray(x.samples)?x.samples.slice(-2).map(({at,date,price,basis})=>({at,date,price,basis})):[]};
}
export function trackingFromLogs(rows,{status='ACTIVE',priceOf,basisOf}={}) {
  let samples=[];
  for(const r of rows) {
    const price=priceOf(r);
    if(!Number.isFinite(price))continue;
    // Daily logs are actual observations; midnight UTC is a conservative fallback
    // for older logs without a timestamp, never the latest whole-catalog run.
    const at=r.created_at||r.checked_at||`${r.date}T00:00:00.000Z`;
    samples=appendPriceSample(samples,{date:r.date,at,price,basis:basisOf(r)});
  }
  return {status,seenAt:samples.at(-1)?.at??null,saleAt:samples.at(-1)?.at??null,samples};
}

// Real sightings live separately from change-only histories. No historical backfill.
export function createObservationStore(db,{table='goods',key}) {
  if(!['goods'].includes(table)||!['goods_no','sno'].includes(key))throw Error('Invalid observation table');
  if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='observation_json'))db.exec(`ALTER TABLE ${table} ADD COLUMN observation_json TEXT`);
  const select=db.prepare(`SELECT observation_json FROM ${table} WHERE ${key}=?`);
  const update=db.prepare(`UPDATE ${table} SET observation_json=? WHERE ${key}=?`);
  const get=id=>readObservation(select.get(Number(id))?.observation_json);
  const put=(id,x)=>update.run(JSON.stringify(x),Number(id));
  return {
    get,
    seen(id,{at,date,price,hasPrice,reset=false}) {
      const x=get(id);
      if(reset){x.samples=[];x.saleSamples=[];}
      x.seenAt=at;
      if(hasPrice){x.saleAt=at;x.saleSamples=appendPriceSample(x.saleSamples,{date,at,price,basis:'SALE'});}
      put(id,x);
    },
    checked(id,at) {const x=get(id);x.checkedAt=at;put(id,x);},
    price(id,{date,at,price,basis,verifiedAt=null}) {
      const x=get(id);x.computedAt=at;
      // Recalculation cannot make the older of its required inputs younger.
      const stamps=[x.saleAt,verifiedAt].filter(Boolean).map(Date.parse);
      const observed=stamps.length&&stamps.every(Number.isFinite)?Math.min(...stamps):NaN;
      if(x.saleAt&&(!verifiedAt||Number.isFinite(Date.parse(verifiedAt)))&&Number.isFinite(observed)&&Number.isFinite(price)) {
        const sample={date,at:new Date(observed).toISOString(),price,basis};
        x.samples=appendPriceSample(x.samples,sample);
      }
      put(id,x);
      return x;
    },
  };
}
