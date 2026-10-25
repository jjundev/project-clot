import './setup-env.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createDashboardModel} from '../src/dashboard-model.js';
import {fixtureRaw,defaultState,row} from './helpers/dashboard-fixture.js';
const m=createDashboardModel(), items=fixtureRaw().map(x=>m.summarize(x));
test('union keeps retailer identity and prefers liked over scan in either order',()=>{
 const dup=m.summarize({...fixtureRaw()[2],src:'4910all',L:[row(70)]});
 for(const seq of [[...items,dup],[dup,...items]]) {
 const merged=m.mergeSummaries([],seq);assert.equal(merged.length,5);
 assert.equal(merged.find(x=>x.k==='4910:1').my,90);
 }
 assert.equal(m.resolveKey('1'),'musinsa:1');
});
test('facets exclude only their own dimension',()=>{
 let r=m.queryCatalog(items,defaultState);
 assert.deepEqual(r.sources,{all:5,musinsa:2,'4910':3});
 assert.deepEqual(r.quick,{all:5,lowest:3,drop:2,onsale:4,out:1});
 r=m.queryCatalog(items,{...defaultState,q:'나이키',filter:'lowest'});
 assert.deepEqual(r.items.map(x=>x.k),['4910:1']);
 assert.deepEqual(r.sources,{all:1,musinsa:0,'4910':1});
 assert.deepEqual(r.quick,{all:3,lowest:1,drop:1,onsale:3,out:0});
});
test('crossed facets match independent fixture predicates',()=>{
 for(const src of ['all','musinsa','4910']) for(const filter of ['all','lowest','drop','onsale','out'])
 for(const cat of ['all','top','shoes','outer']) for(const brands of [[],['나이키'],['나이키','gu']])
 for(const q of ['','나이키','absent']) {
 const s={...defaultState,src,filter,cat,brandKeys:brands,q};
 const accepts=(x,skip)=> (skip==='src'||src==='all'||x.src===src)&&
 (skip==='cat'||cat==='all'||x.c===cat)&&(skip==='brand'||!brands.length||brands.includes(x.brandKey))&&
 (skip==='filter'||filter==='all'||(filter==='lowest'?x.isLow:filter==='drop'?x.dropAmt>0:filter==='out'?x.isOut:!x.isOut))&&
 (!q||x.b.toLowerCase().includes(q));
 const r=m.queryCatalog(items,s);
 assert.equal(r.total,items.filter(x=>accepts(x)).length);
 assert.equal(r.quick.all,items.filter(x=>accepts(x,'filter')).length);
 assert.equal(r.sources.all,items.filter(x=>accepts(x,'src')).length);
 for(const b of r.brands) assert.equal(b.count,items.filter(x=>accepts(x,'brand')&&x.brandKey===b.key).length);
 }
});
test('price bases, no history, zero and brand normalization survive summaries',()=>{
 assert.equal(m.summarize({...fixtureRaw()[3],L:[row(100,'a','A'),row(80,'b','B')]}).dropAmt,0);
 assert.equal(items[3].isLow,false);
 assert.equal(m.summarize({...fixtureRaw()[0],L:[]}).my,null);
 assert.equal(m.summarize({...fixtureRaw()[0],L:[row(0)]}).my,0);
 assert.equal(m.brandKey('  나이키  '),m.brandKey('나이키'.normalize('NFD')));
 for(const sort of ['category','rate','priceAsc','priceDesc','dropAmt','brand','new'])
 assert.equal(m.queryCatalog(items,{...defaultState,sort}).total,5);
});
test('legacy state and serialized factory work without free variables',()=>{
 assert.equal(m.restoreState({src:'4910all',sort:'coupon'}).src,'4910');
 assert.equal(m.restoreState({src:'invalid',sort:'invalid'}).sort,'rate');
 const factory=vm.runInNewContext('('+createDashboardModel.toString()+')()');
 assert.equal(factory.resolveKey('3'),'musinsa:3');
});
test('sorts order actual prices, categories and ties without mutating input',()=>{
 const want={
 category:['musinsa:2','4910:3','4910:4','4910:1','musinsa:1'],
 rate:['4910:4','musinsa:2','4910:1','musinsa:1','4910:3'],
 priceAsc:['4910:4','musinsa:2','4910:1','musinsa:1','4910:3'],
 priceDesc:['4910:3','musinsa:1','4910:1','4910:4','musinsa:2'],
 dropAmt:['musinsa:2','4910:1','4910:4','musinsa:1','4910:3'],
 brand:['4910:1','musinsa:1','4910:3','musinsa:2','4910:4'],
 new:['4910:4','4910:3','musinsa:2','4910:1','musinsa:1']};
 const before=JSON.stringify(items);
 for(const [sort,keys] of Object.entries(want))assert.deepEqual(m.queryCatalog(items,{...defaultState,sort}).items.map(x=>x.k),keys);
 assert.equal(JSON.stringify(items),before);
 const missing=m.summarize({...fixtureRaw()[0],n:99,L:[]});
 for(const sort of ['priceAsc','priceDesc'])assert.equal(m.queryCatalog([...items,missing],{...defaultState,sort,includeHistory:true}).items.at(-1).k,'musinsa:99');
});
