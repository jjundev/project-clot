import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import {createDashboardModel} from '../src/dashboard-model.js';
import {expandScanHistory} from '../src/dashboard-catalog.js';
export function verifyDashboardBuild(outputPath) {
 const html=fs.readFileSync(outputPath,'utf8'),match=html.match(/window\.__CLOT_DATA__ = ([\s\S]*?);\r?\n/);
 if(!match)throw Error('missing inline data');
 const D=JSON.parse(match[1]),manifest=D.catalog,model=createDashboardModel();
 if(manifest?.v!==1||!manifest.revision||!['complete','partial','unavailable'].includes(manifest.scanState))throw Error('invalid manifest');
 if(manifest.scanState!=='complete'&&(!manifest.notice||manifest.parts.some(p=>p.source!=='musinsa')||manifest.scanCount!==(manifest.musinsaCount||0)))throw Error('partial build requires notice and no scan files');
 const directory=path.dirname(outputPath),window={},all=[...D.items],keys=new Set(),parts=new Set();
 function read(file,label) {
 if(!/^(?:4910\/(?:catalog-\d+|b\d+|index)|musinsa\/(?:catalog-\d+|h\d+))\.js$/.test(file))throw Error('invalid data path');
 const absolute=path.join(directory,file);if(!fs.existsSync(absolute))throw Error('missing '+label+': '+file);
 vm.runInNewContext(fs.readFileSync(absolute,'utf8'),{window},{timeout:1000});
 }
 let count=0;
 for(const ref of manifest.parts) {
 if(parts.has(ref.id))throw Error('duplicate catalog part');parts.add(ref.id);
 read(ref.path,'catalog part');const p=window.__CLOT_CATALOG_PARTS__?.[ref.id];
 if(p?.revision!==manifest.revision)throw Error('catalog revision mismatch');
 if(p.v!==1||p.id!==ref.id||p.items.length!==ref.count)throw Error('catalog count mismatch');
 count+=p.items.length;all.push(...p.items);
 delete window.__CLOT_CATALOG_PARTS__[ref.id];
 }
 if(count!==manifest.scanCount)throw Error('scan count mismatch');
 const details=new Map();
 for(const x of all) {
 if(!['musinsa','4910'].includes(x.src)||x.k!==model.itemKey(x.src,x.n)||keys.has(x.k)||'L' in x)throw Error('invalid summary identity');
 keys.add(x.k);
 let L;
 if(x.detail?.type==='inline')L=D.inlineHistories[x.k];
 else if(x.detail?.type==='brand'){
 const ref=x.detail;
 if(!details.has(ref.path)) {
 read(ref.path,'detail');const P=window.__CLOT_4910_B__?.[ref.brandSno];
 if(P?.revision!==manifest.revision||P.brandSno!==ref.brandSno)throw Error('detail revision mismatch');
 details.set(ref.path,new Map(P.r.map(r=>[model.itemKey('4910',r[0]),expandScanHistory(r[7])])));
 delete window.__CLOT_4910_B__[ref.brandSno];
 }
 L=details.get(ref.path).get(x.k);
 }else if(x.detail?.type==='musinsa') {
 const ref=x.detail;
 if(!details.has(ref.path)) {
 read(ref.path,'detail');const P=window.__CLOT_MUSINSA_H__?.[ref.id];
 if(P?.v!==1||P.revision!==manifest.revision||P.id!==ref.id)throw Error('detail revision mismatch');
 details.set(ref.path,new Map(Object.entries(P.histories)));
 delete window.__CLOT_MUSINSA_H__[ref.id];
 }
 L=details.get(ref.path).get(x.k);
 }else throw Error('invalid detail reference');
 if(!Array.isArray(L))throw Error('missing detail history');
 const derived=model.summarize({...x,L},{kind:x.kind,detail:x.detail});
 for(const f of ['my','sale','normal','newbie','isOut','isLow','lowEligible','dropAmt','rate','coupon','couponName','lowMy','lowDate','tracked','priceSource','observedDate']){
 if(derived[f]!==x[f])throw Error('summary history mismatch: '+f);
 }
 }
 return {totalItems:all.length,total4910:all.filter(x=>x.src==='4910').length,scanState:manifest.scanState};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{console.log(JSON.stringify(verifyDashboardBuild(process.argv[2])));}
 catch(err){console.error(err.message);process.exitCode=1;}
}
