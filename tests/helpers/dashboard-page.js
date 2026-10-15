import fs from 'node:fs';
import path from 'node:path';
import {createDashboardModel} from '../../src/dashboard-model.js';
import {createDashboardRuntime} from '../../src/dashboard-runtime.js';
import {buildDashboardCatalog} from '../../src/dashboard-catalog.js';
import {fixtureRaw} from './dashboard-fixture.js';
export function writeFixture(dir,{scale=false}={}) {
 const model=createDashboardModel(),raw=fixtureRaw(),scan=raw.find(x=>x.src==='4910all');
 const n=scale?139501:1;
 const compact={v:1,brandSno:9,b:['나이키'],m:[''],imgBase:'',r:Array.from({length:n},(_,i)=>[i+3,0,0,i===n-1&&scale?'LAST_SENTINEL':'나이키 상품 '+(i+3),'','','top',[['2026-10-16',200,120,null]]])};
 // Scale uses IDs outside the liked range so the target total is exact.
 if(scale)for(let i=0;i<n;i++)compact.r[i][0]=i+10;
 const base=raw.filter(x=>x!==scan);
 if(scale)for(let i=3;i<=626;i++)base.push({...raw[0],n:i,k:String(i),g:'무신사 상품 '+i});
 const packaged=buildDashboardCatalog({baseItems:base,scanIndex:{brands:[[9,'나이키',n]]},readBrand:()=>compact,dir4910:path.join(dir,'4910'),revision:'fixture',scanState:'complete'});
 const payload={generatedAt:'2026-10-16',lastRun:null,...packaged};
 let html=fs.readFileSync(new URL('../../src/dashboard.template.html',import.meta.url),'utf8');
 html=html.replace(/\/\*\s*__CLOT_DATA_PLACEHOLDER__\s*\*\/[\s\S]*?;\s*[\r\n]*/,()=> 'window.__CLOT_DATA__ = '+JSON.stringify(payload).replace(/<\/script/gi,'<\\/script')+';\n');
 html=html.replace('/* __CLOT_MODEL__ */',()=> 'window.__CLOT_MODEL__ = ('+createDashboardModel.toString()+')();');
 html=html.replace('/* __CLOT_RUNTIME__ */',()=> 'window.__CLOT_RUNTIME_FACTORY__ = ('+createDashboardRuntime.toString()+');');
 fs.writeFileSync(path.join(dir,'index.html'),html);
 return {payload,model};
}
