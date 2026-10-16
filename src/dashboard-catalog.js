import fs from 'node:fs';
import path from 'node:path';
import {createDashboardModel} from './dashboard-model.js';
const json=x=>JSON.stringify(x).replace(/<\/script/gi,'<\\/script');
/** Compact scan history → common price basis. Also serialized into the browser runtime. */
export function expandScanHistory(rows) {
 return rows.map(h=>[h[0],h[1],h[2],h[3]??null,0,h[3]!=null?'4910 검증가':'가격 재검증 필요',h[3]!=null?h[2]-h[3]:0]);
}
export function buildDashboardCatalog({baseItems,scanIndex={brands:[]},readBrand,dir4910,revision,scanState='complete',notice=null}) {
 const model=createDashboardModel(),items=model.mergeSummaries([],baseItems.map(x=>model.summarize(x))),inlineHistories={};
 for(const x of baseItems)inlineHistories[model.itemKey(x.src,x.n)]=x.L||[];
 const catalog={v:1,revision,scanState,scanCount:0,parts:[],notice};
 const keys=new Set(items.map(x=>x.k)),stage=dir4910+'.staging';
 fs.rmSync(stage,{recursive:true,force:true});fs.rmSync(dir4910,{recursive:true,force:true});
 let buffer=[],partNo=0;
 function flush(){
 if(!buffer.length)return;
 const id='catalog-'+String(partNo++).padStart(4,'0'),file=id+'.js';
 const part={v:1,revision,id,items:buffer};
 fs.writeFileSync(path.join(stage,file),'(window.__CLOT_CATALOG_PARTS__ = window.__CLOT_CATALOG_PARTS__ || {})['+json(id)+'] = '+json(part)+';\n');
 catalog.parts.push({id,path:'4910/'+file,count:buffer.length});catalog.scanCount+=buffer.length;buffer=[];
 }
 try {
 if(scanState!=='complete')return {items,inlineHistories,catalog};
 fs.mkdirSync(stage,{recursive:true});
 for(const [bs,,expected] of scanIndex.brands){
 const P=readBrand(bs);
 if(P.brandSno!==Number(bs)||!Array.isArray(P.r)||(expected!=null&&P.r.length!==expected))throw Error("브랜드 추출 건수 불일치: "+bs);
 P.revision=revision;
 fs.writeFileSync(path.join(stage,'b'+bs+'.js'),'(window.__CLOT_4910_B__ = window.__CLOT_4910_B__ || {})['+Number(bs)+'] = '+json(P)+';\n');
 for(const r of P.r){
 const k=model.itemKey('4910',r[0]);if(keys.has(k))continue;keys.add(k);
 buffer.push(model.summarize({n:r[0],src:'4910all',bs:Number(bs),b:P.b[r[1]],m:P.m[r[2]],g:r[3],u:'https://4910.kr/goods/'+r[0],i:!r[4]?'':/^https?:/.test(r[4])?r[4]:P.imgBase+r[4],s:'ACTIVE',c:r[6],fs:r[5],L:expandScanHistory(r[7])},{kind:'scan',detail:{type:'brand',brandSno:Number(bs),path:'4910/b'+bs+'.js'}}));
 if(buffer.length===2000)flush();
 }
 }
 flush();
 fs.writeFileSync(path.join(stage,'index.js'),'window.__CLOT_4910_INDEX__ = '+json({...scanIndex,revision})+';\n');
 fs.renameSync(stage,dir4910);
 }catch(err){
 fs.rmSync(stage,{recursive:true,force:true});catalog.parts=[];catalog.scanCount=0;catalog.scanState='partial';catalog.notice='4910 데이터 일부 미포함: '+err.message;
 }finally{fs.rmSync(stage,{recursive:true,force:true});}
 return {items,inlineHistories,catalog};
}
