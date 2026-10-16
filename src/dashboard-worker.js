/** Identical transport for a Worker and file fallback. No DOM or module dependencies. */
export async function createDashboardTransport({manifest,index,loadAsset,yieldTask=()=>Promise.resolve()}) {
 function validate(ref,p,bytes){if(p?.v!==2||p.id!==ref.id||p.revision!==manifest.revision||bytes!==ref.bytes)throw Error('데이터 파일 버전/크기 불일치');}
 const chunks=new Array(manifest.indexParts.length);let next=0;
 await Promise.all(Array.from({length:Math.min(4,manifest.indexParts.length)},async()=>{while(next<manifest.indexParts.length){const i=next++,ref=manifest.indexParts[i],v=await loadAsset(ref);validate(ref,v.payload,v.bytes);chunks[i]=index.unpackIndex(v.payload);await yieldTask();}}));
 const rows=chunks.flat(),byKey=new Map(rows.map(x=>[x.k,x]));if(byKey.size!==rows.length||(manifest.totalItems!=null&&rows.length!==manifest.totalItems))throw Error('전체 상품 건수 불일치');
 const cache=new Map(),inflight=new Map();
 async function cardPart(ref){if(cache.has(ref.id)){const v=cache.get(ref.id);cache.delete(ref.id);cache.set(ref.id,v);return v;}if(inflight.has(ref.id))return inflight.get(ref.id);const p=(async()=>{const v=await loadAsset(ref);validate(ref,v.payload,v.bytes);const items=v.payload.items;if(!Array.isArray(items)||items.length!==ref.count)throw Error('카드 건수 불일치');const map=new Map(items.map(x=>[x.k,x]));cache.set(ref.id,map);while(cache.size>8)cache.delete(cache.keys().next().value);return map;})();inflight.set(ref.id,p);try{return await p;}finally{inflight.delete(ref.id);}}
 const engine=index.createDashboardQueryEngine({rows,loadCards:async keys=>{const parts=new Map();for(const key of keys){const ref=byKey.get(key)?.card;if(!ref)throw Error('카드 참조 없음');parts.set(ref.id,ref);}const loaded=new Map();for(const ref of parts.values())loaded.set(ref.id,await cardPart(ref));return keys.map(key=>{const x=loaded.get(byKey.get(key).card.id).get(key);if(!x)throw Error('카드 상품 없음');return x;});}});
 return engine;
}
export function runDashboardWorker({model,index,transport}) {
 let enginePromise=null;const revisionAssets=new Map();
 async function loadAsset(ref){if(!/^assets\/[a-z-]+-\d+\.js$/.test(ref.path))throw Error('잘못된 파일 경로');const response=await fetch(ref.path+'?v='+encodeURIComponent(revisionAssets.get('revision')));if(!response.ok)throw Error('파일 요청 실패: '+response.status);const text=await response.text();(0,eval)(text);const payload=globalThis.__CLOT_ASSETS__?.[ref.id];delete globalThis.__CLOT_ASSETS__[ref.id];return {payload,bytes:new TextEncoder().encode(text).length};}
 onmessage=async({data})=>{const {requestId,method,args}=data;try{let result;if(method==='init'){const manifest=args[0];revisionAssets.set('revision',manifest.revision);enginePromise=transport({manifest,index,loadAsset});await enginePromise;result=true;}else {const engine=await enginePromise;if(!engine||!['query','page','lookup','neighbor'].includes(method))throw Error('Unknown method');result=await engine[method](...args);}postMessage({requestId,ok:true,result,error:null});}catch(error){postMessage({requestId,ok:false,result:null,error:{code:error.code||'DATA_ERROR',message:error.message}});}};
}
