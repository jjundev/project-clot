import {createDashboardModel} from './dashboard-model.js';
const {PRICE_TTL_MS}=createDashboardModel();
export const COVERAGE_KEYS=['musinsa-wide','musinsa-watched','4910'];
const instant=value=>typeof value==='string'&&value.includes('T')?Date.parse(value):NaN;
export function coverageGroup(x){return x.src==='4910'?'4910':x.kind==='wide'?'musinsa-wide':'musinsa-watched';}
export function countCoverage(items,asOfMs,isLive){
 const groups=new Map(COVERAGE_KEYS.map(key=>[key,{active:0,live:0}]));
 for(const x of items){if(x.tracking?.status!=='ACTIVE')continue;const g=groups.get(coverageGroup(x));g.active++;if(isLive(x))g.live++;}
 return groups;
}
// A group is checked only when its source finished a complete run within the price TTL: then most ACTIVE goods must be live.
export function evaluateFreshnessCoverage(groups,asOfMs,{ttlMs=PRICE_TTL_MS,minShare=0.25,minActive=100}={}){
 return groups.filter(g=>{const age=asOfMs-instant(g.lastRunAt);return age>=0&&age<=ttlMs&&g.active>=minActive&&g.live/g.active<minShare;})
  .map(g=>`freshness coverage collapse: ${g.key} live ${g.live}/${g.active} (last run ${g.lastRunAt})`);
}
