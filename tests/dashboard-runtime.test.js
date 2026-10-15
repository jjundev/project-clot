import './setup-env.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createDashboardRuntime} from '../src/dashboard-runtime.js';
import {createDashboardModel} from '../src/dashboard-model.js';
import {fixtureRaw} from './helpers/dashboard-fixture.js';
const model=createDashboardModel(),summaries=fixtureRaw().map(x=>model.summarize(x));
function setup(loadScript,parts=[{id:'p',path:'4910/p.js',count:1}]) {
 return createDashboardRuntime({model,baseItems:summaries.filter(x=>x.kind!=='scan'),inlineHistories:{'musinsa:1':fixtureRaw()[0].L},manifest:{v:1,revision:'r',scanState:'complete',scanCount:1,parts},loadScript,onChange:()=>{}});
}
test('failed parts stay nonauthoritative and retry replaces staged data',async()=>{
 let fail=true,calls=0;
 const r=setup(async()=>{calls++;if(fail)throw Error('offline');return {v:1,id:'p',revision:'r',items:[summaries[3]]};});
 assert.equal((await r.ensureCatalog()).status,'error');assert.equal(r.getCatalog().items.length,4);
 fail=false;const a=r.retryCatalog(),b=r.ensureCatalog();assert.equal(a,b);
 assert.equal((await a).items.length,5);assert.equal(calls,2);
});
test('mismatched and duplicate parts cannot masquerade as complete',async()=>{
 for(const mutate of [p=>({...p,revision:'old'}),p=>({...p,id:'wrong'}),p=>({...p,items:[]}),p=>({...p,items:[summaries[0]]})]){
 const r=setup(async()=>mutate({v:1,id:'p',revision:'r',items:[summaries[3]]}));
 assert.equal((await r.ensureCatalog()).status,'error');
 }
});
test('inline and brand histories cache independently without changing summaries',async()=>{
 const x={...summaries[3],detail:{type:'brand',brandSno:9,path:'4910/b9.js'}};
 let calls=0;
 const r=createDashboardRuntime({model,baseItems:[x],inlineHistories:{'musinsa:1':[[1,2]]},manifest:{revision:'r',parts:[],scanCount:0,scanState:'complete'},loadScript:async()=>{calls++;return {revision:'r',brandSno:9,r:[[3,0,0,'','','','',[['day',200,120,null]]]]};}});
 const before=JSON.stringify(r.getCatalog().items);
 assert.deepEqual(await r.getHistory('musinsa:1'),[[1,2]]);
 const [a,b]=await Promise.all([r.getHistory(x.k),r.getHistory(x.k)]);
 assert.equal(a[0][3],120);assert.deepEqual(a,b);assert.equal(calls,1);
 assert.equal(JSON.stringify(r.getCatalog().items),before);
 await assert.rejects(r.getHistory('4910:missing'));
});
test('factory runs in isolated realm',()=>{
 const f=vm.runInNewContext('('+createDashboardRuntime.toString()+')');
 assert.equal(f({model,baseItems:[],inlineHistories:{},manifest:{parts:[],scanCount:0}}).getCatalog().status,'ready');
});
test('duplicate manifest identities are rejected before a complete catalog can appear',async()=>{
 let n=2;
 const refs=[{id:'p',path:'4910/p.js',count:1},{id:'p',path:'4910/q.js',count:1}];
 const r=createDashboardRuntime({model,baseItems:[],inlineHistories:{},manifest:{revision:'r',parts:refs,scanCount:2,scanState:'complete'},loadScript:async()=>({v:1,id:'p',revision:'r',items:[{...summaries[3],n:++n,k:'4910:'+n}]})});
 assert.equal((await r.ensureCatalog()).status,'error');
});
test('summary loading uses at most four concurrent requests',async()=>{
 let active=0,max=0;
 const parts=Array.from({length:9},(_,i)=>({id:'p'+i,path:'4910/p'+i+'.js',count:1}));
 const r=createDashboardRuntime({model,baseItems:[],inlineHistories:{},manifest:{revision:'r',parts,scanCount:9,scanState:'complete'},loadScript:async file=>{
 active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;
 const id=file.split('/').at(-1).replace('.js',''),n=Number(id.slice(1))+10;
 return {v:1,id,revision:'r',items:[{...summaries[3],n,k:'4910:'+n}]};
 }});
 assert.equal((await r.ensureCatalog()).items.length,9);assert.equal(max,4);
});
test('wrong revision and missing IDs reject histories; failed brand request retries',async()=>{
 for(const payload of [{revision:'old',brandSno:9,r:[]},{revision:'r',brandSno:9,r:[]}]){
 const x={...summaries[3],detail:{type:'brand',brandSno:9,path:'4910/b9.js'}};
 const r=createDashboardRuntime({model,baseItems:[x],inlineHistories:{},manifest:{revision:'r',parts:[],scanCount:0},loadScript:async()=>payload});
 await assert.rejects(r.getHistory(x.k));
 }
 let fail=true;
 const x={...summaries[3],detail:{type:'brand',brandSno:9,path:'4910/b9.js'}};
 const r=createDashboardRuntime({model,baseItems:[x],inlineHistories:{},manifest:{revision:'r',parts:[],scanCount:0},loadScript:async()=>{if(fail)throw Error('offline');return {revision:'r',brandSno:9,r:[[3,0,0,'','','','',[['day',200,120,null]]]]};}});
 await assert.rejects(r.getHistory(x.k));fail=false;
 assert.equal((await r.getHistory(x.k))[0][3],120);
});
