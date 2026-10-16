export function createHistoryExporter({writer}) {
 let buffer=[],size=400,pending=[];
 function flush(){if(!buffer.length)return;const asset=writer.writeRecord('history',{rows:buffer});for(const p of pending)p.ref.parts.push({...asset,from:p.from,to:p.to});buffer=[];pending=[];size=400;}
 return {
 add(key,iterableRows){const ref={firstDate:null,lastDate:null,parts:[]};let segment=null;
 for(const row of iterableRows){const entry=[key,row],bytes=new TextEncoder().encode(JSON.stringify(entry)).length+1;if(size+bytes>writer.maxBytes-128){flush();segment=null;}if(!segment){segment={ref,from:row[0],to:row[0]};pending.push(segment);}buffer.push(entry);size+=bytes;segment.to=row[0];ref.firstDate??=row[0];ref.lastDate=row[0];}
 return ref;},finish:flush
 };
}
/** Browser-safe factory: raw-byte bounded LRU, independently deduplicated in-flight requests. */
export function createHistoryLoader({revision,loadAsset,maxBytes=16777216}) {
 const cache=new Map(),inflight=new Map();let cacheBytes=0;
 async function load(ref){
 if(!/^assets\/[a-z-]+-\d+\.js$/.test(ref.path)&&!/^assets\/h\.js$/.test(ref.path))throw Error('Invalid history asset path');
 if(cache.has(ref.id)){const v=cache.get(ref.id);cache.delete(ref.id);cache.set(ref.id,v);return v.payload;}
 if(inflight.has(ref.id))return inflight.get(ref.id);
 const promise=(async()=>{const v=await loadAsset(ref),p=v.payload;if(p?.v!==2||p.revision!==revision||p.id!==ref.id||!Array.isArray(p.rows)||v.bytes!==ref.bytes)throw Error('Invalid history asset');
 if(v.bytes<=maxBytes){while(cacheBytes+v.bytes>maxBytes&&cache.size){const [key,old]=cache.entries().next().value;cache.delete(key);cacheBytes-=old.bytes;}cache.set(ref.id,v);cacheBytes+=v.bytes;}return p;})();
 inflight.set(ref.id,promise);try{return await promise;}finally{inflight.delete(ref.id);}
 }
 return {
 async get(key,ref,{days=90}={}){const to=ref.lastDate;const from=days&&to?new Date(Date.parse(to+'T00:00:00Z')-(days-1)*86400000).toISOString().slice(0,10):ref.firstDate;
 const parts=ref.parts||[],selected=days?parts.filter(p=>p.to>=from):parts;const previous=days?parts.filter(p=>p.to<from).at(-1):null;
 const rows=[];let anchor=null;
 for(const part of previous?[previous,...selected]:selected){const p=await load(part);for(const entry of p.rows){const row=Array.isArray(entry[1])?(entry[0]===key?entry[1]:null):entry;if(!row)continue;if(days&&row[0]<from){if(!anchor||row[0]>anchor[0])anchor=row;}else rows.push(row);}}
 rows.sort((a,b)=>a[0].localeCompare(b[0]));return {key,from,to,rows,anchor,complete:!days};},
 stats:()=>({cacheBytes,cacheEntries:cache.size,inflight:inflight.size}),clear(){cache.clear();cacheBytes=0;}
 };
}
