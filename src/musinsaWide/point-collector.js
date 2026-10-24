import {fetchPointPolicy} from './point-policy.js';
import {quotaDate} from './point-store.js';
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
export async function collectPointPolicies({store,fetchPolicy=fetchPointPolicy,now=Date.now,sleep=wait,dailyCap=1000,budgetMs=5100000}) {
  if(!Number.isInteger(dailyCap)||dailyCap<1||dailyCap>5000)throw new Error('Invalid point daily cap');
  if(!Number.isFinite(budgetMs)||budgetMs<0||budgetMs>5100000)throw new Error('Invalid point execution budget');
  const deadline=now()+budgetMs,seen=new Set();
  const result={quotaDate:quotaDate(now()),attempted:0,succeeded:0,failed:0,stop:'complete'};
  let allocationDate,remaining;
  function allocate(){
    const date=quotaDate(now());
    if(date!==allocationDate){const n=Math.max(0,dailyCap-store.getAttempts(date));remaining={urgent:Math.ceil(n/2),rotation:Math.floor(n/2)};allocationDate=date;}
  }
  function pick(lane){return store.pickCandidates({lane,limit:1,asOfMs:now(),excludeGoodsNos:seen})[0];}
  function borrow(lane){const other=lane==='urgent'?'rotation':'urgent';if(remaining[lane]===0&&remaining[other]>0&&!pick(other)){remaining[lane]+=remaining[other];remaining[other]=0;}}
  async function prepare(){
    const delay=Math.max(0,store.getNextStartAtMs()-now());
    if(now()+delay>=deadline){result.stop='deadline';return false;}
    if(delay)await sleep(delay);
    allocate();
    if(now()>=deadline){result.stop='deadline';return false;}
    if(store.getAttempts(quotaDate(now()))>=dailyCap){result.stop='quota';return false;}
    return true;
  }
  outer: while(await prepare()){
    let lane,candidate;
    for(const name of ['urgent','rotation']){
      borrow(name);if(remaining[name]>0){const found=pick(name);if(found){lane=name;candidate=found;break;}}
    }
    if(!candidate)break;
    seen.add(candidate.goodsNo);
    for(let attempt=0;attempt<3;attempt++){
      if(attempt && !(await prepare()))break outer;
      borrow(lane);
      if(remaining[lane]<=0)break;
      const atMs=now();
      if(!store.reserveAttempt({goodsNo:candidate.goodsNo,lane,atMs,dailyCap}))continue outer;
      remaining[lane]--;result.attempted++;result.quotaDate=quotaDate(atMs);
      try {
        const policy=await fetchPolicy(candidate.goodsNo,{now,timeoutMs:Math.min(15000,deadline-now())});
        store.savePolicy(policy);result.succeeded++;break;
      }catch(e){
        result.failed++;
        store.saveFailure({goodsNo:candidate.goodsNo,atMs:now(),code:e.code==='HTTP'?`HTTP_${e.status}`:(e.code??'ERROR')});
        if(e.status===429){result.stop='rate_limited';break outer;}
        if(e.status===401||e.status===403){result.stop='blocked';break outer;}
        if(e.code==='SCHEMA_CHANGED'){result.stop='error';break outer;}
        const retry=['NETWORK','TIMEOUT'].includes(e.code)||(e.code==='HTTP'&&e.status>=500&&e.status<600);
        if(!retry||attempt===2)break;
        const delay=1000*(attempt+1);
        if(now()+delay>=deadline){result.stop='deadline';break outer;}
        await sleep(delay);
      }
    }
  }
  store.recordRun(result);return result;
}
