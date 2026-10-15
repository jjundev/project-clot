import '../setup-env.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {writeFixture} from '../helpers/dashboard-page.js';
async function fixture(t,options={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clot-browser-'));writeFixture(dir,options);
 const server=http.createServer((req,res)=>{try{const file=path.join(dir,new URL(req.url,'http://localhost').pathname);res.setHeader('Content-Type',file.endsWith('.html')?'text/html':'text/javascript');res.end(fs.readFileSync(file));}catch{res.statusCode=404;res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.CLOT_BROWSER_EXECUTABLE||undefined,headless:true});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(/https:\/\//,route=>route.request().url().includes('chart.umd')?route.fulfill({body:'window.Chart=class {constructor(canvas,config){canvas.dataset.chartConfig=JSON.stringify(config);} destroy(){}}',contentType:'text/javascript'}):route.abort());
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});assert.deepEqual(errors,[]);});
 return {page,dir,url:'http://127.0.0.1:'+server.address().port+'/index.html'};
}
test('all includes every source; search and facets share the complete catalog over HTTP and file',async t=>{
 const {page,dir,url}=await fixture(t);
 for(const location of [url,pathToFileURL(path.join(dir,'index.html')).href]){
 await page.goto(location);
 await page.locator('#shownN').filter({hasText:/^5$/}).waitFor();
 assert.equal(await page.locator('[data-src]').count(),3);
 assert.equal(await page.locator('#sAll').textContent(),'5');
 assert.equal(await page.locator('#sMusinsa').textContent(),'2');
 assert.equal(await page.locator('#s4910').textContent(),'3');
 await page.getByRole('searchbox',{name:'브랜드 또는 상품명 검색'}).fill('나이키');
 await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='3');
 await page.locator('.chip[data-filter=lowest]').click();
 await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='1');
 assert.equal(await page.locator('#cAll').textContent(),'3');
 assert.equal(await page.locator('#sMusinsa').textContent(),'0');
 }
});
test('legacy source and numeric deep link restore with filters cleared',async t=>{
 const {page,url}=await fixture(t);
 await page.goto(url);await page.evaluate(()=>{localStorage.setItem('clot.src','4910all');localStorage.setItem('clot.cat','bag');});
 await page.goto(url+'?goods=1');
 await page.locator('#scrim.open').waitFor();assert.equal(await page.locator('#mName').textContent(),'나이키 상품 1');
 await page.locator('#closeBtn').click();await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='5');
});
test('detail history failure retains summary and can retry without changing counts',async t=>{
 const {page,url}=await fixture(t);let fail=true;
 await page.route('**/4910/b9.js*',r=>fail?r.abort():r.continue());
 await page.goto(url);await page.locator('.card[data-k="4910:3"]').click();
 await page.getByRole('button',{name:'이력 다시 시도'}).waitFor();
 assert.match(await page.locator('#mPrice').textContent(),/120원/);
 fail=false;await page.getByRole('button',{name:'이력 다시 시도'}).click();
 await page.waitForFunction(()=>document.querySelector('#mRows').textContent.includes('2026-10-16'));
 assert.equal(await page.locator('#shownN').textContent(),'5');
});
test('late detail completion and catalog completion never replace the current selection',async t=>{
 const {page,url}=await fixture(t);
 let release;const gate=new Promise(r=>release=r);
 await page.route('**/4910/b9.js*',async r=>{await gate;await r.continue();});
 await page.goto(url);
 await page.locator('.card[data-k="4910:3"]').click();
 await page.locator('#prevBtn').click();
 const selected=await page.locator('#mName').textContent();
 release();await page.waitForTimeout(100);
 assert.equal(await page.locator('#mName').textContent(),selected);
 await page.locator('#closeBtn').click();
 assert.equal(await page.locator('#scrim.open').count(),0);
});
test('catalog failure offers retry; musinsa view works during delayed loading',async t=>{
 const {page,url}=await fixture(t);let fail=true;
 await page.route('**/4910/catalog-0000.js*',r=>fail?r.abort():r.continue());
 await page.goto(url);await page.getByRole('button',{name:'다시 시도',exact:true}).waitFor();
 assert.equal(await page.locator('.card').count(),0);
 await page.locator('[data-src=musinsa]').click();
 assert.equal(await page.locator('#shownN').textContent(),'2');
 fail=false;await page.locator('[data-src=all]').click();
 await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='5');
 assert.equal(await page.locator('[data-src=all]').getAttribute('aria-pressed'),'true');
});
test('common brand picker preserves OR selections and zero-count removals across sources',async t=>{
 const {page,url}=await fixture(t);await page.goto(url);await page.locator('#shownN').filter({hasText:'5'}).waitFor();
 const trigger=page.getByRole('button',{name:'브랜드 선택',exact:true});
 await trigger.click();await page.getByRole('checkbox',{name:'나이키 3',exact:true}).check();
 await page.keyboard.press('Escape');assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
 assert.equal(await page.locator('#shownN').textContent(),'3');
 await trigger.click();await page.getByRole('checkbox',{name:'GU 1',exact:true}).check();
 await page.keyboard.press('Escape');
 await page.locator('[data-src="4910"]').click();assert.equal(await page.locator('#shownN').textContent(),'3');
 await page.locator('[data-src=musinsa]').click();assert.equal(await page.locator('#shownN').textContent(),'1');
 await trigger.click();assert.equal(await page.getByRole('checkbox',{name:'GU 0',exact:true}).isChecked(),true);
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'GU 선택 해제'}).click();
 await page.getByRole('button',{name:'나이키 선택 해제'}).click();assert.equal(await page.locator('#shownN').textContent(),'2');
});
test('brand dialog fits mobile and desktop, scopes slash and restores focus',async t=>{
 const {page,url}=await fixture(t);
 for(const size of [{width:390,height:844},{width:1440,height:1000}]){
 await page.setViewportSize(size);await page.goto(url);
 const trigger=page.getByRole('button',{name:'브랜드 선택',exact:true});await trigger.click();
 const dialog=page.getByRole('dialog',{name:'브랜드 선택',exact:true});
 const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=size.width&&box.y+box.height<=size.height);
 await page.getByRole('searchbox',{name:'브랜드 찾기'}).fill('나이키');
 await page.keyboard.press('/');assert.equal(await page.locator('#q').inputValue(),'');
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await dialog.count(),0);
 assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }
});
test('140129 summaries search the final part while rendering only 120 cards',async t=>{
 const {page,url}=await fixture(t,{scale:true});
 await page.addInitScript(()=>{window.IntersectionObserver=class {observe(){} unobserve(){}};});
 let histories=0;page.on('request',r=>{if(/\/b\d+\.js/.test(r.url()))histories++;});
 await page.goto(url);await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='140,129');
 assert.equal(await page.locator('#sMusinsa').textContent(),'626');
 assert.equal(await page.locator('#s4910').textContent(),'139,503');
 assert.equal(await page.locator('.card').count(),120);
 await page.locator('#q').fill('LAST_SENTINEL');await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='1');
 assert.equal(await page.locator('#cAll').textContent(),'1');
 assert.equal(histories,0);
 const timings=[];
 for(let i=0;i<10;i++){
   const start=performance.now();
   await page.locator('#q').fill(i%2?'LAST_SENTINEL':'');
   await page.waitForFunction(expected=>document.querySelector('#shownN').textContent===expected,i%2?'1':'140,129');
   await page.locator('#sortSel').selectOption(i%2?'priceAsc':'rate');
   timings.push(performance.now()-start);
 }
 timings.sort((a,b)=>a-b);t.diagnostic('scale UI operations ms: '+JSON.stringify({median:timings[5],max:timings.at(-1)}));
 await page.locator('.card').click();await page.waitForFunction(()=>document.querySelector('#mRows').textContent.includes('2026-10-16'));
 assert.equal(await page.locator('#shownN').textContent(),'1');assert.equal(histories,1);
});
test('brand dialog uses the current theme text color',async t=>{
 const {page,url}=await fixture(t);await page.goto(url);
 await page.evaluate(()=>localStorage.setItem('clot.theme','dark'));await page.reload();
 await page.locator('#brandTrigger').click();
 assert.equal(await page.locator('#brandDialog').evaluate(e=>getComputedStyle(e).color),await page.locator('body').evaluate(e=>getComputedStyle(e).color));
});

test('constant scan price has no lowest annotation in details or chart',async t=>{
 const {page,url}=await fixture(t);await page.goto(url);
 await page.locator('.card[data-k="4910:3"]').click();
 await page.waitForFunction(()=>document.querySelector('#mRows').textContent.includes('2026-10-16'));
 assert.equal(await page.locator('#mRows .st.on').count(),0);
 assert.equal(await page.locator('#chart').evaluate(e=>JSON.parse(e.dataset.chartConfig).options.plugins.lowestPin.at),null);
});
test('closing after detail navigation or history retry restores the visible product card',async t=>{
 const {page,url}=await fixture(t);await page.goto(url);
 const card=page.locator('.card[data-k="4910:3"]');await card.click();await page.locator('#prevBtn').click();await page.locator('#closeBtn').click();
 assert.equal(await card.evaluate(e=>e===document.activeElement),true);
 let fail=true;await page.route('**/4910/b9.js*',r=>fail?r.abort():r.continue());
 // A fresh page ensures there is no cached successful brand history.
 await page.reload();await card.click();await page.getByRole('button',{name:'이력 다시 시도'}).waitFor();
 fail=false;await page.getByRole('button',{name:'이력 다시 시도'}).click();await page.waitForFunction(()=>document.querySelector('#mRows').textContent.includes('2026-10-16'));
 await page.locator('#closeBtn').click();assert.equal(await card.evaluate(e=>e===document.activeElement),true);
});

test('detail lowest annotations use the latest basis and retain eligible historical lows',async t=>{
 for(const scenario of ['basis','changed']){
 const {page,url}=await fixture(t,{scanScenario:scenario});await page.goto(url);
 const card=page.locator('.card[data-k="4910:3"]');assert.equal(await card.locator('.pin.low').count(),0);
 await card.click();await page.waitForFunction(()=>document.querySelector('#mRows').textContent.includes('2026-10-16'));
 const pin=await page.locator('#chart').evaluate(e=>JSON.parse(e.dataset.chartConfig).options.plugins.lowestPin);
 if(scenario==='basis'){assert.equal(pin.at,null);assert.equal(await page.locator('#mRows .st.on').count(),0);}
 else {assert.equal(pin.val,110);assert.equal(pin.at,2);assert.equal(await page.locator('#mRows .st.on').count(),1);assert.match(await page.locator('#mFacts').textContent(),/110원/);}
 }
});
test('removing a zero-count brand keeps keyboard focus inside the open dialog',async t=>{
 const {page,url}=await fixture(t);await page.goto(url);
 await page.locator('#brandTrigger').click();await page.getByRole('checkbox',{name:'GU 1',exact:true}).check();await page.keyboard.press('Escape');
 await page.locator('[data-src=musinsa]').click();await page.locator('#brandTrigger').click();
 await page.getByRole('checkbox',{name:'GU 0',exact:true}).focus();await page.keyboard.press('Space');
 assert.equal(await page.locator('#brandDialog').evaluate(e=>e.contains(document.activeElement)&&document.activeElement.offsetParent!==null),true);
 await page.keyboard.press('Tab');assert.equal(await page.locator('#brandDialog').evaluate(e=>e.contains(document.activeElement)),true);
});
test('a delayed deep link closes the brand dialog and transfers focus to the product',async t=>{
 const {page,url}=await fixture(t);
 let release;const gate=new Promise(r=>release=r);
 await page.route('**/4910/catalog-0000.js*',async r=>{await gate;await r.continue();});
 await page.goto(url+'?goods=4910:3',{waitUntil:'domcontentloaded'});
 await page.locator('#brandTrigger').click();await page.getByRole('dialog',{name:'브랜드 선택',exact:true}).waitFor();
 release();await page.locator('#scrim.open').waitFor();
 assert.equal(await page.getByRole('dialog',{name:'브랜드 선택',exact:true}).count(),0);
 assert.equal(await page.locator('#closeBtn').evaluate(e=>e===document.activeElement),true);
});
