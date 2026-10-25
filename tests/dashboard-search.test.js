import './setup-env.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createDashboardModel} from '../src/dashboard-model.js';
const model=createDashboardModel();
const raw={src:'musinsa',n:2156295,b:'키뮤어',g:'[Drape Wool] 캐시미어블렌드 세미오버핏 발마칸 코트_블랙',c:'outer',L:[]};
const coat=model.summarize(raw);
test('multi-term search ignores order, spaces and punctuation without joining fields',()=>{
 for(const q of ['키뮤어 캐시미어','캐시미어 키뮤어','캐시미어 블렌드','발마칸 코트 블랙','Ｄｒａｐｅ']) {
  assert.deepEqual(model.queryCatalog([coat],{q,includeHistory:true}).items.map(x=>x.k),['musinsa:2156295']);
  assert.equal(model.matchesSearch(coat,model.parseSearchInput(q).tokens),true);
 }
 assert.equal(model.queryCatalog([coat],{includeHistory:true,q:'키뮤어 존재하지않는단어'}).total,0);
 assert.equal(model.queryCatalog([model.summarize({src:'musinsa',n:1,b:'ab',g:'cd',L:[]})],{includeHistory:true,q:'bc'}).total,0);
 assert.equal(model.queryCatalog([coat],{includeHistory:true,q:'---'}).total,0);
 const before=JSON.stringify(coat);model.queryCatalog([coat],{includeHistory:true,q:'발마칸 블랙'});assert.equal(JSON.stringify(coat),before);
 assert.equal(model.queryCatalog([{...coat,_searchFields:undefined}],{includeHistory:true,q:'블랙 코트'}).total,1);
});
test('product URL parsing is strict and ignores long tracking data',()=>{
 const parse=model.parseSearchInput;
 for(const host of ['musinsa.com','www.musinsa.com','m.musinsa.com'])
 assert.deepEqual(parse('https://'+host+'/products/2156295/?utm_content='+'x'.repeat(4096)+'#foo'),{type:'product',key:'musinsa:2156295'});
 for(const value of ['https://musinsa.com.evil.test/products/2156295','https://user@www.musinsa.com/products/2156295','https://www.musinsa.com:8443/products/2156295','https://www.musinsa.com/products/nope','javascript:alert(1)','https://musinsa.onelink.me/abc','www.musinsa.com/products/2156295','https://musinsa.com/products/2156295/extra'])
 assert.equal(parse(value).type,'invalid',value);
});
test('IDs remain positive safe integers',()=>{
 const parse=model.parseSearchInput;
 for(const q of ['0002156295','2156295','ＭＵＳＩＮＳＡ:２１５６２９５'])assert.deepEqual(parse(q),{type:'product',key:'musinsa:2156295'});
 assert.deepEqual(parse('4910:2156295'),{type:'product',key:'4910:2156295'});
 for(const value of ['0','-1','+1','9007199254740992','musinsa:','4910:abc','musinsa:1.2'])assert.equal(parse(value).type,'invalid',value);
 assert.equal(parse('---').type,'invalid');assert.equal(parse('  ').type,'empty');
});
test('search normalization does not merge brand identity',()=>{
 assert.notEqual(model.brandKey('A-B'),model.brandKey('AB'));
 assert.equal(model.normalizeSearchText('Ａ-Ｂ'),'ab');
 const items=['A-B','AB'].map((b,i)=>model.summarize({...raw,b,n:i+1}));
 assert.equal(model.queryCatalog(items,{includeHistory:true,q:'ab',brandKeys:['A-B']}).total,1);
});
test('serialized factory preserves parsing and token search without imports',()=>{
 const m=vm.runInNewContext('('+createDashboardModel.toString()+')()', {URL});
 assert.equal(m.parseSearchInput('2156295').key,'musinsa:2156295');
 assert.equal(m.queryCatalog([m.summarize(raw)],{includeHistory:true,q:'블랙 키뮤어'}).total,1);
});
