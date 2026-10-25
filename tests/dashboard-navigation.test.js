import './setup-env.js';
import {test} from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {createDashboardModel} from '../src/dashboard-model.js';
import {createDashboardNavigation} from '../src/dashboard-navigation.js';
function createHistoryWindow(initialUrl){
 const listeners=new Set(),entries=[{url:initialUrl,state:{foreign:'kept'}}];let index=0;
 const win={location:{href:initialUrl},addEventListener:(n,f)=>listeners.add(f),removeEventListener:(n,f)=>listeners.delete(f)};
 const move=delta=>{if(index+delta<0||index+delta>=entries.length)return;index+=delta;win.location.href=entries[index].url;for(const fn of listeners)fn({state:entries[index].state});};
 win.history={get state(){return entries[index].state;},pushState(state,_,url){entries.splice(index+1);entries.push({state,url:String(url)});index++;win.location.href=String(url);},replaceState(state,_,url){entries[index]={state,url:String(url)};win.location.href=String(url);},back(){move(-1);},forward(){move(1);}};
 return win;
}
function setup(url,factory=createDashboardNavigation){const w=createHistoryWindow(url),routes=[];const nav=factory({window:w,model:createDashboardModel(),onRoute:r=>routes.push(r)});nav.start();return {w,routes,nav};}
test('list pushes detail, neighbors replace, back and forward preserve foreign URL state',()=>{
 const {w,routes,nav}=setup('https://example.test/project-clot/?keep=1#catalog');
 nav.open({key:'musinsa:1'});assert.equal(routes.at(-1).key,'musinsa:1');
 assert.equal(new URL(w.location.href).pathname,'/project-clot/');assert.equal(new URL(w.location.href).searchParams.get('keep'),'1');assert.equal(new URL(w.location.href).hash,'#catalog');assert.equal(w.history.state.foreign,'kept');
 nav.replace({key:'4910:3',brand:'9'});nav.backToList();assert.equal(routes.at(-1).type,'catalog');
 w.history.forward();assert.deepEqual(routes.at(-1),{type:'detail',key:'4910:3',brand:'9'});
 nav.dispose();w.history.back();assert.equal(routes.at(-1).type,'detail');
});
test('direct detail returns locally without traversing foreign history',()=>{
 const {w,routes,nav}=setup('https://example.test/project-clot/?goods=1&keep=1#x');
 assert.equal(routes.at(-1).key,'musinsa:1');nav.backToList();assert.equal(routes.at(-1).type,'catalog');assert.equal(w.location.href,'https://example.test/project-clot/?keep=1#x');
 const old=setup('https://example.test/project-clot/');old.nav.open({key:'4910:3'});old.nav.dispose();
 const routes2=[];const reload=createDashboardNavigation({window:old.w,model:createDashboardModel(),onRoute:r=>routes2.push(r)});reload.start();reload.backToList();assert.equal(routes2.at(-1).type,'catalog');assert.equal(new URL(old.w.location.href).searchParams.has('goods'),false);
});
test('numeric and canonical goods resolve identically including file URLs',()=>{
 for(const goods of ['1','musinsa:1']){const {routes,nav,w}=setup('file:///tmp/site/index.html?goods='+goods);assert.equal(routes.at(-1).key,'musinsa:1');nav.backToList();assert.equal(w.location.href,'file:///tmp/site/index.html');}
});
test('invalid goods is not a broad catalog query',()=>{
 for(const goods of ['bad','0','', 'https://foreign.test/1']){const {routes}=setup('https://example.test/?goods='+encodeURIComponent(goods));assert.equal(routes.at(-1).type,'invalid');assert.ok(routes.at(-1).message);}
});
test('denied history falls back to in-page navigation',()=>{
 const {nav,w,routes}=setup('file:///tmp/index.html');for(const name of ['pushState','replaceState','back'])w.history[name]=()=>{throw new Error('denied');};
 nav.open({key:'musinsa:1'});assert.equal(routes.at(-1).key,'musinsa:1');nav.replace({key:'4910:3'});assert.equal(routes.at(-1).key,'4910:3');nav.backToList();assert.equal(routes.at(-1).type,'catalog');
});
test('serialized navigation has no module dependencies',()=>{
 const factory=vm.runInNewContext('('+createDashboardNavigation.toString()+')',{URL});
 const {routes,nav}=setup('https://example.test/',factory);nav.open({key:'4910:3'});assert.equal(routes.at(-1).key,'4910:3');
});
