/** Async catalog transaction and separate history cache; serialized into static HTML. */
export function createDashboardRuntime({model,baseItems,inlineHistories,manifest,loadScript,onChange=()=>{}}) {
 let state={status:manifest.parts.length?'idle':'ready',items:baseItems,scanState:manifest.scanState,notice:manifest.notice,error:null},pending=null;
 const histories=new Map(),brands=new Map();
 const notify=()=>onChange(state);
 function ensureCatalog(){
 if(pending)return pending;
 if(state.status==='ready')return Promise.resolve(state);
 state={...state,status:'loading',error:null};
 pending=Promise.resolve().then(async()=>{
 const ids=new Set(),paths=new Set();
 for(const ref of manifest.parts){if(ids.has(ref.id)||paths.has(ref.path))throw Error('중복 요약 파일');ids.add(ref.id);paths.add(ref.path);}
 const loaded=new Array(manifest.parts.length);let next=0,failed=null;
 const worker=async()=>{try{while(!failed&&next<manifest.parts.length){
 const index=next++,ref=manifest.parts[index],part=await loadScript(ref.path);
 if(part?.v!==1||part.revision!==manifest.revision||part.id!==ref.id||!Array.isArray(part.items)||part.items.length!==ref.count)throw Error('요약 파일 불일치: '+ref.id);
 loaded[index]=part.items;
 }}catch(err){failed=err;throw err;}};
 await Promise.allSettled(Array.from({length:Math.min(4,manifest.parts.length)},worker));
 if(failed)throw failed;
 const scan=loaded.flat(),keys=new Set(baseItems.map(x=>x.k));
 if(scan.length!==manifest.scanCount)throw Error('전체 요약 건수 불일치');
 for(const x of scan){
 if(!x||x.src!=='4910'||x.kind!=='scan'||x.k!==model.itemKey(x.src,x.n)||keys.has(x.k)||'L' in x)throw Error('요약 상품 식별 불일치');
 keys.add(x.k);
 }
 state={...state,status:'ready',items:model.mergeSummaries(baseItems,scan),error:null};
 }).catch(err=>{state={...state,status:'error',items:baseItems,error:err.message};}).finally(()=>{pending=null;notify();});
 notify();return pending.then(()=>state);
 }
 // Return the shared public promise, including its resolved state.
 function start(){
 if(pending)return pending;
 const result=ensureCatalog();if(state.status==='loading')pending=result;
 return result;
 }
 function retryCatalog(){if(pending)return pending;state={...state,status:'idle',error:null};return start();}
 async function getHistory(key){
 key=model.resolveKey(key);
 if(Object.hasOwn(inlineHistories,key))return inlineHistories[key];
 if(histories.has(key))return histories.get(key);
 const item=state.items.find(x=>x.k===key);if(!item)throw Error('상품을 찾을 수 없습니다');
 const ref=item.detail;if(ref?.type!=='brand')throw Error('가격 이력 참조 없음');
 let p=brands.get(ref.path);
 if(!p){
 p=Promise.resolve().then(()=>loadScript(ref.path)).then(P=>{
 if(P?.revision!==manifest.revision||P.brandSno!==ref.brandSno||!Array.isArray(P.r))throw Error('이력 파일 불일치');
 return P;
 }).catch(err=>{brands.delete(ref.path);throw err;});brands.set(ref.path,p);
 }
 const result=p.then(P=>{
 const r=P.r.find(r=>model.itemKey('4910',r[0])===key);if(!r)throw Error('상품 이력 없음');
 return r[7].map(h=>[h[0],h[1],h[2],h[3]??h[2],0,h[3]!=null?'쿠폰가':'표시가',h[3]!=null?h[2]-h[3]:0]);
 }).catch(err=>{histories.delete(key);throw err;});
 histories.set(key,result);return result;
 }
 return {getCatalog:()=>state,ensureCatalog:start,retryCatalog,getHistory};
}
