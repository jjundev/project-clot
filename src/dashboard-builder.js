import fs from 'node:fs';import path from 'node:path';
import {createAssetWriter} from './dashboard-assets.js';import {createHistoryExporter} from './dashboard-history.js';import {createDashboardModel} from './dashboard-model.js';import {packIndex} from './dashboard-index.js';
/** Build-time sink: retains current summaries, never the whole archive. */
export function createDashboardBuilder({outDir,revision}) {
 const writer=createAssetWriter({outDir,revision}),history=createHistoryExporter({writer}),model=createDashboardModel(),summaries=[];let cards=[],size=400;
 fs.rmSync(path.join(outDir,'assets'),{recursive:true,force:true});fs.mkdirSync(path.join(outDir,'assets'),{recursive:true});
 function splitWrite(kind,items,record){try{return [{ref:writer.writeRecord(kind,record(items)),items}];}catch(error){if(!error.message.includes('exceeds byte limit')||items.length<2)throw error;const mid=Math.ceil(items.length/2);return [...splitWrite(kind,items.slice(0,mid),record),...splitWrite(kind,items.slice(mid),record)];}}
 function flush(){if(!cards.length)return;history.finish();for(const {ref,items} of splitWrite('cards',cards,items=>({items})))for(const x of items)summaries.push({...x,card:ref});cards=[];size=400;}

 return {
 add(raw,options){const detail=history.add(model.itemKey(raw.src,raw.n),raw.L||[]),x=model.summarize(raw,{...options,detail});const bytes=Buffer.byteLength(JSON.stringify(x))+1;if(cards.length&&size+bytes>230000)flush();cards.push(x);size+=bytes;},
 finish({scanState,notice,musinsaCount=0,scanCount=0}){history.finish();flush();const indexParts=[];for(let i=0;i<summaries.length;i+=700){for(const {ref} of splitWrite('index',summaries.slice(i,i+700),items=>{const {v,revision:r,id,...data}=packIndex(items,{revision,id:'pending'});return data;}))indexParts.push(ref);}
 const state=model.restoreState({}),q=model.queryCatalog(summaries,state),{items,...facets}=q;const first=items.slice(0,120).map(({card,...x})=>x);
 return {catalog:{v:2,revision,scanState,notice,totalItems:summaries.length,indexParts,bootstrap:{state,...facets,items:first},workerPath:'dashboard-worker.js',musinsaCount,scanCount},items:first,inlineHistories:{}};
 }
 };
}
