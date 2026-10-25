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
async function fixture(t,{basePath='/',...options}={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clot-browser-'));writeFixture(dir,options);
 const server=http.createServer((req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;if(!pathname.startsWith(basePath))throw Error('outside fixture');const file=path.join(dir,pathname.slice(basePath.length)||'index.html');res.setHeader('Content-Type',file.endsWith('.html')?'text/html':'text/javascript');res.end(fs.readFileSync(file));}catch{res.statusCode=404;res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.CLOT_BROWSER_EXECUTABLE||undefined,headless:true});
 const page=await browser.newPage();// Large fixtures include real observation evidence for 440k rows; allow CI to load it.
 const readinessTimeout=options.scale?30000:8000;page.setDefaultTimeout(readinessTimeout);page.setDefaultNavigationTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(/https:\/\//,route=>route.request().url().includes('chart.umd')?route.fulfill({body:'window.Chart=class {constructor(canvas,config){canvas.dataset.chartConfig=JSON.stringify(config);} destroy(){}}',contentType:'text/javascript'}):route.abort());
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});assert.deepEqual(errors,[]);});
 return {page,dir,url:'http://127.0.0.1:'+server.address().port+basePath+'index.html'};
}
async function openFilters(page){if(!await page.locator('#catalogFilters').isVisible())await page.locator('#filterToggle').click();}
test('all includes every source; search and facets share the complete catalog over HTTP and file',async t=>{
 const {page,dir,url}=await fixture(t);
 for(const location of [url,pathToFileURL(path.join(dir,'index.html')).href]){
 await page.goto(location);
 await page.locator('#shownN').filter({hasText:/^5$/}).waitFor();
 assert.equal(await page.locator('[data-src]').count(),3);


 await page.getByRole('searchbox',{name:'브랜드, 상품명, 상품번호 또는 URL 검색'}).fill('나이키');
 await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='3');
 await page.locator('.chip[data-filter=lowest]').click();
 await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='1');

 }
});
test('legacy source and numeric deep link preserve the selected scope',async t=>{
 const {page,url}=await fixture(t);
 await page.goto(url);await page.evaluate(()=>{localStorage.setItem('clot.src','4910all');localStorage.setItem('clot.cat','bag');});
 await page.goto(url+'?goods=1');
 await page.locator('#detailView:not([hidden]) #detailContent:not([hidden])').waitFor();assert.equal(await page.locator('#mName').textContent(),'나이키 상품 1');
 await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});assert.equal(await page.locator('[data-src="4910"]').getAttribute('aria-pressed'),'true');
});
test('detail history failure retains summary and can retry without changing counts',async t=>{
 const {page,url}=await fixture(t);let fail=true;
 await page.route('**/assets/history-*.js*',r=>fail?r.abort():r.continue());
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
 await page.route('**/assets/history-*.js*',async r=>{await gate;await r.continue();});
 await page.goto(url);
 await page.locator('.card[data-k="4910:3"]').click();
 await page.locator('#prevBtn').click();
 await page.waitForFunction(()=>document.querySelector('#mName').textContent!=='나이키 상품 3');
 const selected=await page.locator('#mName').textContent();
 release();await page.waitForTimeout(100);
 assert.equal(await page.locator('#mName').textContent(),selected);
 await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});
 assert.equal(await page.locator('#detailView:not([hidden]) #detailContent:not([hidden])').count(),0);
});
test('bootstrap survives index failure and retry restores exact scoped counts',async t=>{
 const {page,url}=await fixture(t);let fail=true;
 await page.route('**/assets/index-*.js*',r=>fail?r.abort():r.continue());
 await page.goto(url);assert.equal(await page.locator('.card').count(),5);
 await openFilters(page);await page.locator('[data-src=musinsa]').click();await page.getByRole('button',{name:'다시 시도',exact:true}).waitFor();
 assert.equal(await page.locator('.card').count(),2);assert.equal(await page.locator('#shownN').textContent(),'—');
 fail=false;await page.getByRole('button',{name:'다시 시도',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='2');
 await openFilters(page);await page.locator('[data-src=all]').click();await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='5');
});
test('common brand picker preserves OR selections and zero-count removals across sources',async t=>{
 const {page,url}=await fixture(t);await page.goto(url);await page.locator('#shownN').filter({hasText:'5'}).waitFor();
 const trigger=page.getByRole('button',{name:'브랜드 선택',exact:true});
 await openFilters(page);await trigger.click();await page.getByRole('checkbox',{name:'나이키 3',exact:true}).check();
 await page.keyboard.press('Escape');assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
 await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='3');
 await openFilters(page);await trigger.click();await page.getByRole('checkbox',{name:'GU 1',exact:true}).check();
 await page.keyboard.press('Escape');
 await openFilters(page);await page.locator('[data-src="4910"]').click();await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='3');assert.equal(await page.locator('#shownN').textContent(),'3');
 await openFilters(page);await page.locator('[data-src=musinsa]').click();await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='1');assert.equal(await page.locator('#shownN').textContent(),'1');
 await openFilters(page);await trigger.click();assert.equal(await page.getByRole('checkbox',{name:'GU 0',exact:true}).isChecked(),true);
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'GU 선택 해제'}).click();
 await page.getByRole('button',{name:'나이키 선택 해제'}).click();await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='2');assert.equal(await page.locator('#shownN').textContent(),'2');
});
test('brand dialog fits mobile and desktop, scopes slash and restores focus',async t=>{
 const {page,url}=await fixture(t);
 for(const size of [{width:390,height:844},{width:1440,height:1000}]){
 await page.setViewportSize(size);await page.goto(url);
 await openFilters(page);
 const trigger=page.getByRole('button',{name:'브랜드 선택',exact:true});await openFilters(page);await trigger.click();
 const dialog=page.getByRole('dialog',{name:'브랜드 선택',exact:true});
 const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=size.width&&box.y+box.height<=size.height);
 await page.getByRole('searchbox',{name:'브랜드 찾기'}).fill('나이키');
 await page.keyboard.press('/');assert.equal(await page.locator('#q').inputValue(),'');
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await dialog.count(),0);
 assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }
});
test('440129 summaries search the final part while rendering only 120 cards',async t=>{
 const {page,url}=await fixture(t,{scale:true});
 await page.addInitScript(()=>{window.IntersectionObserver=class {observe(){} unobserve(){}};});
 let histories=0;page.on('request',r=>{if(/\/assets\/history-/.test(r.url()))histories++;});
 const readyStart=performance.now();await page.goto(url);await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='440,129');t.diagnostic('scale initial search ready ms: '+Math.round(performance.now()-readyStart));

 assert.equal(await page.locator('.card').count(),120);
 await page.locator('#q').fill('LAST_SENTINEL');await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='1');

 assert.equal(histories,0);
 const timings=[];
 for(let i=0;i<10;i++){
   const start=performance.now();
   await page.locator('#q').fill(i%2?'LAST_SENTINEL':'');
   await page.waitForFunction(expected=>document.querySelector('#shownN').textContent===expected,i%2?'1':'440,129');
   await page.locator('#sortSel').selectOption(i%2?'priceAsc':'rate');
   timings.push(performance.now()-start);
 }
 timings.sort((a,b)=>a-b);t.diagnostic('scale UI operations ms: '+JSON.stringify({median:timings[5],max:timings.at(-1)}));
 // Finish the last sort before asserting exact catalog counts while its DOM is suspended.
 await page.locator('#grid[data-search-status=ready]').waitFor();
 await page.locator('.card').click();await page.waitForFunction(()=>document.querySelector('#mRows').textContent.includes('2026-10-16'));
 assert.equal(await page.locator('#shownN').textContent(),'1');assert.equal(histories,1);
});
test('brand dialog uses the current theme text color',async t=>{
 const {page,url}=await fixture(t);await page.goto(url);
 await page.evaluate(()=>localStorage.setItem('clot.theme','dark'));await page.reload();
 await openFilters(page);await page.locator('#brandTrigger').click();
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
 const card=page.locator('.card[data-k="4910:3"]');await card.click();await page.locator('#prevBtn').click();await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});
 assert.equal(await card.evaluate(e=>e===document.activeElement),true);
 let fail=true;await page.route('**/assets/history-*.js*',r=>fail?r.abort():r.continue());
 // A fresh page ensures there is no cached successful brand history.
 await page.reload();await card.click();await page.getByRole('button',{name:'이력 다시 시도'}).waitFor();
 fail=false;await page.getByRole('button',{name:'이력 다시 시도'}).click();await page.waitForFunction(()=>document.querySelector('#mRows').textContent.includes('2026-10-16'));
 await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});assert.equal(await card.evaluate(e=>e===document.activeElement),true);
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
 await openFilters(page);await page.locator('#brandTrigger').click();await page.getByRole('checkbox',{name:'GU 1',exact:true}).check();await page.keyboard.press('Escape');
 await openFilters(page);await page.locator('[data-src=musinsa]').click();await openFilters(page);await page.locator('#brandTrigger').click();
 await page.getByRole('checkbox',{name:'GU 0',exact:true}).focus();await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('#grid').dataset.searchStatus==='ready');await page.locator('input[data-brand="gu"]').waitFor({state:'hidden'});
 assert.equal(await page.locator('#brandDialog').evaluate(e=>e.contains(document.activeElement)&&document.activeElement.offsetParent!==null),true);
 await page.keyboard.press('Tab');assert.equal(await page.locator('#brandDialog').evaluate(e=>e.contains(document.activeElement)),true);
});
test('a delayed deep link shows loading then focuses the product page',async t=>{
 const {page,url}=await fixture(t,{scale:true});let release;const gate=new Promise(r=>release=r);
 await page.route('**/assets/routes-*.js*',async r=>{await gate;await r.continue();});
 try{await page.goto(url+'?goods=4910:439510',{waitUntil:'domcontentloaded'});await page.locator('#detailStatus').filter({hasText:'상품 조회 중'}).waitFor();
 assert.equal(await page.locator('#catalogView').isVisible(),false);release();await page.locator('#detailContent').waitFor({state:'visible'});
 assert.equal(await page.locator('#mName').evaluate(e=>e===document.activeElement),true);
 }finally{release();}
});

test('explicit watched prices take precedence and wide estimates retain lazy histories on HTTP and file',async t=>{
 const {page,dir,url}=await fixture(t,{wide:true});
 for(const location of [url,pathToFileURL(path.join(dir,'index.html')).href]){
 await page.goto(location);await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='6');
 assert.match(await page.locator('.card[data-k="musinsa:1"]').textContent(),/100원/);
 assert.match(await page.locator('.card[data-k="musinsa:77"]').textContent(),/추정가/);
 assert.equal(await page.locator('.card[data-k="musinsa:77"] .price-source').evaluate(e=>getComputedStyle(e).textDecorationLine),'none');
 await page.locator('.card[data-k="musinsa:77"]').click();
 await page.waitForFunction(()=>document.querySelector('#mRows').textContent.includes('2026-10-16'));
 assert.match(await page.locator('#mFacts').textContent(),/추정가/);assert.match(await page.locator('#musinsaExplanation').textContent(),/354317/);
 assert.doesNotMatch(await page.locator('#mFacts').textContent(),/수집 이력 최저가/);
 assert.match(await page.locator('#mRows').textContent(),/추정가/);
 assert.equal(await page.locator('#mPrice').textContent().then(s=>s.includes('70원')),true);
 await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});
 }
});

test('recent 90 defaults and archived all-history failure retries without changing price',async t=>{
 const {page,url}=await fixture(t,{historyDays:365});let requested=[];page.on('request',r=>{if(r.url().includes('/assets/history-'))requested.push(r.url());});
 await page.goto(url+'?goods=1');await page.waitForFunction(()=>document.querySelectorAll('#mRows tr').length===90);
 assert.equal(await page.locator('[data-range="90"]').getAttribute('aria-pressed'),'true');assert.ok(!(await page.locator('#mRows').textContent()).includes('2025-10-17'));
 const recentRequests=requested.length,seen=new Set(requested);let fail=true;await page.route('**/assets/history-*.js*',r=>fail&&!seen.has(r.request().url())?r.abort():r.continue());await page.locator('[data-range="0"]').click();await page.getByRole('button',{name:'이력 다시 시도'}).waitFor();fail=false;await page.getByRole('button',{name:'이력 다시 시도'}).click();await page.waitForFunction(()=>document.querySelectorAll('#mRows tr').length===365);assert.ok(requested.length>recentRequests);
 await page.locator('[data-range="90"]').click();await page.waitForFunction(()=>document.querySelectorAll('#mRows tr').length===90);assert.equal(await page.locator('[data-range="90"]').getAttribute('aria-pressed'),'true');
});
test('default cards do not wait for index and saved filters do not show default counts',async t=>{
 const {page,url}=await fixture(t);let release;const gate=new Promise(r=>release=r);await page.route('**/assets/index-*.js*',async r=>{await gate;await r.continue();});
 await page.goto(url);assert.equal(await page.locator('.card').count(),5);assert.equal(await page.locator('#shownN').textContent(),'—');await openFilters(page);await page.locator('[data-src=musinsa]').click();assert.equal(await page.locator('#shownN').textContent(),'—');assert.equal(await page.locator('.card').count(),2);release();await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='2');
});

test('bounded card window reloads previous pages without losing the result order',async t=>{
 const {page,url}=await fixture(t,{scale:true});await page.addInitScript(()=>{window.IntersectionObserver=class {observe(){} unobserve(){}};});await page.goto(url);await page.locator('#q').fill('LAST_SENTINEL');await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='1');await page.locator('#q').fill('');await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='440,129');const first=await page.locator('.card').first().getAttribute('data-k');
 for(let i=0;i<4;i++){await page.locator('#gridMore').click();await page.waitForTimeout(100);assert.ok(await page.locator('.card').count()<=360);}
 assert.notEqual(await page.locator('.card').first().getAttribute('data-k'),first);await page.evaluate(()=>window.scrollTo(0,0));await page.waitForTimeout(300);assert.ok(await page.locator('.card').count()<=360);assert.equal(await page.locator('.card').first().getAttribute('data-k'),first);
});
test('late all-history reply cannot replace a newer 30-day selection',async t=>{
 const {page,url}=await fixture(t,{historyDays:365});const seen=new Set();page.on('request',r=>{if(r.url().includes('/assets/history-'))seen.add(r.url());});await page.goto(url+'?goods=1');await page.waitForFunction(()=>document.querySelectorAll('#mRows tr').length===90);
 let release;const gate=new Promise(r=>release=r);await page.route('**/assets/history-*.js*',async r=>{if(!seen.has(r.request().url()))await gate;await r.continue();});
 // Request listener records synchronously, so preserve the already-loaded list for the gate.
 const loaded=new Set(seen);await page.unroute('**/assets/history-*.js*');await page.route('**/assets/history-*.js*',async r=>{if(!loaded.has(r.request().url()))await gate;await r.continue();});
 await page.locator('[data-range="0"]').click();await page.locator('[data-range="30"]').click();await page.waitForFunction(()=>document.querySelectorAll('#mRows tr').length===30);release();await page.waitForTimeout(200);assert.equal(await page.locator('#mRows tr').count(),30);assert.equal(await page.locator('[data-range="30"]').getAttribute('aria-pressed'),'true');
});
test('neighbor beyond loaded first page preserves source filter and result position',async t=>{
 const {page,url}=await fixture(t,{scale:true});await page.addInitScript(()=>{window.IntersectionObserver=class {observe(){} unobserve(){}};});await page.goto(url);await openFilters(page);await page.locator('[data-src="4910"]').click();await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='439,503');await page.locator('.card').last().click();await page.waitForFunction(()=>document.querySelector('#mPos').textContent==='120 / 439503');await page.locator('#nextBtn').click();await page.waitForFunction(()=>document.querySelector('#mPos').textContent.startsWith('121 /'));assert.equal(await page.locator('[data-src="4910"]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#mPos').textContent(),'121 / 439503');
});
test('worker startup failure keeps bootstrap visible and offers retry immediately',async t=>{
 const {page,url,dir}=await fixture(t);let fail=true;const script=fs.readFileSync(path.join(dir,'dashboard-worker.js'),'utf8');await page.route('**/dashboard-worker.js*',r=>r.fulfill({contentType:'text/javascript',body:fail?'throw Error("test-worker-failure")':script}));await page.goto(url);assert.equal(await page.locator('.card').count(),5);await page.getByRole('button',{name:'다시 시도',exact:true}).waitFor();fail=false;await page.getByRole('button',{name:'다시 시도',exact:true}).click();await page.locator('#q').fill('나이키');await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='3');
});
test('focus arriving during a pending page keeps both focus and the 360-card bound',async t=>{
 const {page,url,dir}=await fixture(t,{scale:true});await page.addInitScript(()=>{window.IntersectionObserver=class {observe(){} unobserve(){}};});const script=fs.readFileSync(path.join(dir,'dashboard-worker.js'),'utf8');await page.route('**/dashboard-worker.js*',r=>r.fulfill({contentType:'text/javascript',body:script+';const original=onmessage;onmessage=e=>{if(e.data.method==="page"&&e.data.args[1]>=360)setTimeout(()=>original(e),400);else original(e);};'}));await page.goto(url);await page.locator('#q').fill('LAST_SENTINEL');await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='1');await page.locator('#q').fill('');await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='440,129');
 for(const n of [240,360]){await page.locator('#gridMore').click();await page.waitForFunction(n=>document.querySelectorAll('.card').length===n,n);}
 await page.locator('#gridMore').click();const focused=await page.locator('.card').first().getAttribute('data-k');await page.locator('.card').first().focus();await page.waitForTimeout(600);assert.ok(await page.locator('.card').count()<=360);assert.equal(await page.evaluate(()=>document.activeElement.dataset.k),focused);
});
test('delayed deep lookup never resets a newer search',async t=>{
 const {page,url,dir}=await fixture(t,{scale:true});const script=fs.readFileSync(path.join(dir,'dashboard-worker.js'),'utf8');await page.route('**/dashboard-worker.js*',r=>r.fulfill({contentType:'text/javascript',body:script+';const original=onmessage;onmessage=e=>{if(e.data.method==="lookup")setTimeout(()=>original(e),1500);else original(e);};'}));await page.goto(url+'?goods=4910:439510');await page.locator('#detailStatus').filter({hasText:'상품 조회 중'}).waitFor();await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});await page.locator('#q').fill('GU 상품');await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='1');await page.waitForTimeout(1800);assert.equal(await page.locator('#detailView:not([hidden]) #detailContent:not([hidden])').count(),0);assert.equal(await page.locator('#q').inputValue(),'GU 상품');assert.equal(await page.locator('#shownN').textContent(),'1');
});

test('blocked indexes still show first cards with restored filters',async t=>{
 const {page,url}=await fixture(t);await page.addInitScript(()=>{localStorage.setItem('clot.src','musinsa');localStorage.setItem('clot.cat','top');localStorage.setItem('clot.sort','priceAsc');});
 await page.context().route('**/assets/index-*.js*',r=>r.abort());await page.goto(url);
 await page.locator('.card').first().waitFor();assert.ok(await page.locator('.card').count()>0);assert.ok(await page.locator('.card').count()<=120);
 assert.match(await page.locator('#catalogNotice').textContent(),/검색 준비 중.*기본 상품 미리보기|다시 시도/);assert.equal(await page.locator('#shownN').textContent(),'—');
});
test('restored scope loads only its own index partitions',async t=>{
 const {page,url}=await fixture(t);await page.addInitScript(()=>{localStorage.setItem('clot.src','musinsa');localStorage.setItem('clot.cat','top');});const paths=[];page.context().on('request',r=>{if(/\/assets\/index-/.test(r.url()))paths.push(r.url());});await page.goto(url);
 await page.waitForFunction(()=>document.querySelector('#grid').dataset.searchStatus==='ready');

 const parts=await page.evaluate(()=>window.__CLOT_DATA__.catalog.indexParts.filter(x=>x.source==='musinsa'&&x.category==='top').map(x=>x.path));assert.equal(paths.length,parts.length);assert.ok(paths.every(p=>parts.some(x=>p.includes(x))));
});
test('missing direct link reports missing product',async t=>{const {page,url}=await fixture(t);await page.goto(url+'?goods=musinsa:99999');await page.locator('#detailStatus').filter({hasText:'상품을 찾을 수 없습니다'}).waitFor();});
test('scoped performance sample distinguishes preview from search readiness',async t=>{
 const {url}=await fixture(t);const {measureDashboard}=await import('../../scripts/measure-dashboard-loading.js');const report=await measureDashboard(url,{runs:1,isolateExternal:true});const sample=report.results[0];assert.equal(sample.scenario,'musinsa-top');assert.ok(sample.firstCardsMs<=sample.searchReadyMs);assert.equal(sample.indexParts.length,1);assert.equal(sample.errors.length,0);
});
test('direct link outside previews opens while all search indexes are blocked',async t=>{
 const {page,url,dir}=await fixture(t,{scale:true,scaleCount:600});const D=JSON.parse(fs.readFileSync(path.join(dir,'index.html'),'utf8').match(/window\.__CLOT_DATA__ = ([^\n]+);/)[1]);assert.ok(!D.catalog.previewItems.some(x=>x.k==='4910:609'));
 await page.context().route('**/assets/index-*.js*',r=>r.abort());for(const location of [url,pathToFileURL(path.join(dir,'index.html')).href]){await page.goto(location+'?goods=4910:609');await page.locator('#detailView:not([hidden]) #detailContent:not([hidden])').waitFor();assert.match(await page.locator('#mName').textContent(),/LAST_SENTINEL/);}
});
test('rapid scope changes retain newest results after delayed old downloads',async t=>{
 const {page,url,dir}=await fixture(t);const D=JSON.parse(fs.readFileSync(path.join(dir,'index.html'),'utf8').match(/window\.__CLOT_DATA__ = ([^\n]+);/)[1]);const oldParts=new Set(D.catalog.indexParts.filter(x=>x.source==='4910').map(x=>x.path));let release;const gate=new Promise(r=>release=r);
 await page.addInitScript(()=>{localStorage.setItem('clot.src','4910');localStorage.setItem('clot.cat','top');});
 await page.context().route('**/assets/index-*.js*',async r=>{if([...oldParts].some(p=>r.request().url().includes(p)))await gate;await r.continue();});
 try{await page.goto(url);await openFilters(page);await page.locator('[data-src=musinsa]').click();await page.waitForFunction(()=>document.querySelector('#grid').dataset.searchStatus==='ready');assert.equal(await page.locator('#shownN').textContent(),'1');release();await page.waitForTimeout(100);assert.equal(await page.locator('.card').first().getAttribute('data-k'),'musinsa:2');}finally{release();}
});
test('a deferred chart that arrives after deep-link history redraws the current detail page',async t=>{
 const {page,url}=await fixture(t);let release;const gate=new Promise(r=>release=r);
 await page.route('**/chart.umd.min.js',async r=>{await gate;await r.fulfill({contentType:'text/javascript',body:'window.Chart=class {constructor(canvas,config){canvas.dataset.chartConfig=JSON.stringify(config);} destroy(){}}'});});
 try{await page.goto(url+'?goods=1',{waitUntil:'commit'});await page.waitForFunction(()=>document.querySelector('#mRows')?.textContent.includes('2026-10-16'));release();await page.waitForFunction(()=>document.querySelector('#chart').dataset.chartConfig);assert.equal(await page.locator('#chartFallback').isVisible(),false);}finally{release();}
});
test('unconfirmed brand counts are dash while restored scoped search is blocked',async t=>{
 const {page,url}=await fixture(t);await page.addInitScript(()=>{localStorage.setItem('clot.src','musinsa');localStorage.setItem('clot.cat','top');});await page.context().route('**/assets/index-*.js*',r=>r.abort());await page.goto(url);await openFilters(page);await page.locator('#brandTrigger').click();const counts=await page.locator('#brandOptions .num').allTextContents();assert.ok(counts.length);assert.ok(counts.every(x=>x==='—'));
});
test('pending empty brand choices become a confirmed empty result after scope readiness',async t=>{
 const {page,url}=await fixture(t);let release;const gate=new Promise(r=>release=r);await page.addInitScript(()=>{localStorage.setItem('clot.src','musinsa');localStorage.setItem('clot.cat','top');});await page.context().route('**/assets/index-*.js*',async r=>{await gate;await r.continue();});
 try{await page.goto(url);await openFilters(page);await page.locator('#brandTrigger').click();await page.locator('#brandSearch').fill('NEVER_EXISTS');assert.match(await page.locator('#brandOptions').textContent(),/준비 중/);release();await page.waitForFunction(()=>document.querySelector('#grid').dataset.searchStatus==='ready');assert.match(await page.locator('#brandOptions').textContent(),/조건에 맞는 브랜드가 없습니다/);}finally{release();}
});

const coatSelector='.card[data-k="musinsa:2156295"]';
test('product search bypasses blocked indexes over HTTP and file',async t=>{
 const {page,dir,url}=await fixture(t,{search:true});
 await page.route('**/assets/index-*.js*',r=>r.abort());
 for(const location of [url,pathToFileURL(path.join(dir,'index.html')).href]){
  await page.goto(location);await page.locator('#q').fill('https://www.musinsa.com/products/2156295?utm_content='+'x'.repeat(4096));
  await page.locator(coatSelector).waitFor();assert.equal(await page.locator('.card').count(),1);
  assert.equal(await page.locator('#gridMore').isVisible(),false);
  assert.match(await page.locator('#catalogNotice').textContent(),/상품번호 조회/);
  await page.locator(coatSelector).click();await page.locator('#detailView:not([hidden]) #detailContent:not([hidden])').waitFor();assert.equal(await page.locator('#prevBtn').isEnabled(),false);assert.equal(await page.locator('#nextBtn').isEnabled(),false);
  await page.locator('#mRows').filter({hasText:'2026-10-16'}).waitFor({state:'attached'});await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});
 }
});
test('product search preserves saved filters',async t=>{
 const {page,dir,url}=await fixture(t,{search:true});
 for(const location of [url,pathToFileURL(path.join(dir,'index.html')).href]){
  await page.goto(location);await page.evaluate(()=>{localStorage.setItem('clot.src','4910');localStorage.setItem('clot.cat','top');localStorage.setItem('clot.filter','drop');});await page.reload();
  await page.locator('#q').fill('2156295');await page.locator(coatSelector).waitFor();
  assert.equal(await page.locator('.price-tabs').isVisible(),false);
  assert.deepEqual(await page.evaluate(()=>['src','cat','filter'].map(k=>localStorage.getItem('clot.'+k))),['4910','top','drop']);
  await page.locator('#q').fill('');await page.waitForFunction(()=>document.querySelector('#grid').dataset.searchStatus==='ready');
  assert.equal(await page.locator('[data-src="4910"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('[data-cat="top"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('.chip[data-filter="drop"]').getAttribute('aria-pressed'),'true');
 }
});
test('invalid, missing and failed lookup are separate screens',async t=>{
 const {page,dir,url}=await fixture(t,{search:true});let fail=false,calls=0;
 await page.route('**/assets/routes-*.js*',r=>{calls++;return fail?r.abort():r.continue();});
 for(const location of [url,pathToFileURL(path.join(dir,'index.html')).href]){
  await page.goto(location);await page.locator('#q').fill('https://musinsa.com.evil.test/products/2156295');
  await page.locator('#grid[data-search-status=invalid]').waitFor();assert.equal(calls,0);
  await page.locator('#q').fill('99999999');await page.getByText('현재 대시보드에 등록된 상품이 없습니다',{exact:true}).waitFor();
  fail=true;await page.locator('#q').fill('2156295');await page.getByText('상품을 조회하지 못했습니다',{exact:true}).waitFor();
  assert.equal(await page.getByText('현재 대시보드에 등록된 상품이 없습니다',{exact:true}).count(),0);
  fail=false;await page.getByRole('button',{name:'다시 시도',exact:true}).click();await page.locator(coatSelector).waitFor();calls=0;
 }
});
test('late lookup cannot replace newer text or invalid input',async t=>{
 const {page,dir,url}=await fixture(t,{search:true});
 for(const location of [url,pathToFileURL(path.join(dir,'index.html')).href]){
  let release;const gate=new Promise(r=>release=r);let entered;const started=new Promise(r=>entered=r);
  await page.route('**/assets/routes-*.js*',async r=>{entered();await gate;await r.continue();});
  await page.goto(location);await page.locator('#q').fill('2156295');await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(Error('product route not requested')),8000))]);
  await page.locator('#q').fill('https://evil.test/products/2156295');await page.locator('#grid[data-search-status=invalid]').waitFor();release();
  await page.waitForTimeout(300);assert.equal(await page.locator('.card').count(),0);assert.equal(await page.locator('#grid').getAttribute('data-search-status'),'invalid');
  await page.unroute('**/assets/routes-*.js*');
  await page.locator('#q').fill('kimuir 캐시미어');await page.waitForFunction(()=>document.querySelector('#grid').dataset.searchStatus==='ready');assert.equal(await page.locator('.card').count(),2);
 }
});
test('clear filters preserves query and sorting',async t=>{
 const {page,dir,url}=await fixture(t,{search:true});
 for(const location of [url,pathToFileURL(path.join(dir,'index.html')).href]){
  await page.goto(location);await page.waitForFunction(()=>document.querySelector('#grid').dataset.searchStatus==='ready');
  await openFilters(page);await page.locator('#brandTrigger').click();await page.getByRole('checkbox',{name:/^다른 브랜드 /}).check();await page.keyboard.press('Escape');
  await openFilters(page);await page.locator('[data-src="4910"]').click();await openFilters(page);await page.locator('[data-cat="top"]').click();await page.locator('.chip[data-filter="drop"]').click();
  await page.locator('#sortSel').selectOption('priceAsc');await page.locator('#q').fill('키뮤어 캐시미어');
  assert.match(await page.locator('#activeFilters').textContent(),/4910/);
  await page.getByRole('button',{name:'초기화',exact:true}).click();await page.locator(coatSelector).waitFor();
  assert.equal(await page.locator('#q').inputValue(),'키뮤어 캐시미어');assert.equal(await page.locator('#sortSel').inputValue(),'priceAsc');
  assert.deepEqual(await page.evaluate(()=>['src','cat','filter'].map(k=>localStorage.getItem('clot.'+k))),['all','all','all']);
  assert.equal(await page.locator('.card').count(),2);
 }
});
test('composition searches only committed input',async t=>{
 const {page,dir,url}=await fixture(t,{search:true});
 await page.addInitScript(()=>{window.queryMessages=[];const Base=window.Worker;window.Worker=class extends Base{postMessage(message,...args){if(message.method==='query')window.queryMessages.push(message.args[0].q);return super.postMessage(message,...args);}};});
 for(const location of [url,pathToFileURL(path.join(dir,'index.html')).href]){
  await page.goto(location);await page.waitForFunction(()=>document.querySelector('#grid').dataset.searchStatus==='ready');
  await page.evaluate(()=>{window.queryMessages=[];const q=document.querySelector('#q');q.dispatchEvent(new CompositionEvent('compositionstart'));for(const value of ['ㅋ','키','키뮤어 캐시미어']){q.value=value;q.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));}});
  await page.waitForTimeout(250);
  assert.deepEqual(await page.evaluate(()=>window.queryMessages),[]);
  assert.equal(await page.locator('#grid').getAttribute('data-search-status'),'ready');
  await page.evaluate(()=>{const q=document.querySelector('#q');q.dispatchEvent(new CompositionEvent('compositionend'));q.dispatchEvent(new InputEvent('input',{bubbles:true}));});
  await page.locator(coatSelector).waitFor();await page.waitForTimeout(250);
  if(location===url)assert.deepEqual(await page.evaluate(()=>window.queryMessages),['키뮤어 캐시미어']);
  assert.equal(await page.locator('#q').inputValue(),'키뮤어 캐시미어');assert.equal(await page.locator('.card').count(),2);
 }
});
test('filter reset keeps the current pending input across consecutive searches',async t=>{
 const {page,url}=await fixture(t,{search:true});await page.goto(url);
 await openFilters(page);await page.locator('[data-src="4910"]').click();
 await page.evaluate(()=>{const q=document.querySelector('#q');q.value='키뮤어 캐시미어';q.dispatchEvent(new InputEvent('input',{bubbles:true}));document.querySelector('#resetBtn').click();});
 await page.locator(coatSelector).waitFor();assert.equal(await page.locator('#q').inputValue(),'키뮤어 캐시미어');
 await page.evaluate(()=>{const q=document.querySelector('#q');q.value='존재하지않음';q.dispatchEvent(new InputEvent('input',{bubbles:true}));document.querySelector('#resetBtn').click();});
 await page.waitForTimeout(300);await page.waitForFunction(()=>document.querySelector('#grid').dataset.searchStatus==='ready');
 assert.equal(await page.locator('#q').inputValue(),'존재하지않음');assert.equal(await page.locator('#shownN').textContent(),'0');
});
test('query failure marks counts unknown and labels previous cards',async t=>{
 const {page,url}=await fixture(t,{search:true});await page.goto(url);
 await page.evaluate(()=>{localStorage.setItem('clot.src','musinsa');localStorage.setItem('clot.cat','outer');});await page.reload();
 await page.waitForFunction(()=>document.querySelector('#grid').dataset.searchStatus==='ready');
 const manifest=await page.evaluate(()=>window.__CLOT_DATA__.catalog);
 const blocked=new Set(manifest.indexParts.filter(x=>x.source==='musinsa'&&x.category==='top').map(x=>'/'+x.path));
 await page.route('**/assets/index-*.js*',r=>blocked.has(new URL(r.request().url()).pathname)?r.abort():r.continue());
 await openFilters(page);await page.locator('[data-cat="all"]').click();await page.getByRole('button',{name:'다시 시도',exact:true}).waitFor();
 assert.equal(await page.locator('#shownN').textContent(),'—');
 assert.match(await page.locator('#catalogNotice').textContent(),/이전 검색 결과 표시/);assert.ok(await page.locator('.card').count()>0);
});
test('estimated drop exclusion has an explanation',async t=>{
 const {page,url}=await fixture(t,{search:true});await page.goto(url);await page.locator('#q').fill('키뮤어 캐시미어');await page.locator(coatSelector).waitFor();
 await page.locator('.chip[data-filter="drop"]').click();await page.waitForFunction(()=>document.querySelector('#grid').dataset.searchStatus==='ready'&&document.querySelector('#shownN').textContent==='0');
 assert.equal(await page.locator('.card').count(),0);await page.locator('#grid').getByText(/최근 48시간 안에 같은 기준으로/).waitFor();
 await page.getByText('현재 조건에 맞는 상품이 없습니다',{exact:true}).waitFor();
});
test('normalized search variants find the same coat over HTTP and file',async t=>{
 const {page,dir,url}=await fixture(t,{search:true});
 for(const location of [url,pathToFileURL(path.join(dir,'index.html')).href]){
  await page.goto(location);
  for(const value of ['키뮤어 캐시미어','캐시미어 키뮤어','캐시미어 블렌드','발마칸 코트 블랙','Ｄｒａｐｅ','kimuir','musinsa:2156295']){
   await page.locator('#q').fill(value);await page.waitForTimeout(200);await page.locator('#grid[data-search-status=ready]').waitFor();await page.locator(coatSelector).waitFor();
  }
 }
});
test('product card failure stays retryable over HTTP and file',async t=>{
 const {page,dir,url}=await fixture(t,{search:true});let fail=true;
 await page.route('**/assets/cards-*.js*',r=>fail?r.abort():r.continue());
 for(const location of [url,pathToFileURL(path.join(dir,'index.html')).href]){
  fail=true;await page.goto(location);await page.locator('#q').fill('2156295');await page.getByText('상품을 조회하지 못했습니다',{exact:true}).waitFor();
  assert.equal(await page.locator('.card').count(),0);
  fail=false;await page.getByRole('button',{name:'다시 시도',exact:true}).click();await page.locator(coatSelector).waitFor();
 }
});
test('legacy product failure stops until explicit retry over HTTP and file',async t=>{
 const {page,dir,url}=await fixture(t);
 const {createDashboardModel}=await import('../../src/dashboard-model.js');
 const item=createDashboardModel().summarize({src:'musinsa',kind:'wide',n:2156295,b:'키뮤어',g:'Legacy coat',c:'outer',L:[]});
 const file=path.join(dir,'index.html'),html=fs.readFileSync(file,'utf8');
 const data=JSON.parse(html.match(/window\.__CLOT_DATA__ = ([^\n]+);/)[1]);
 data.items=[];data.inlineHistories={};data.musinsa=null;
 data.catalog={v:1,revision:'legacy',scanState:'complete',scanCount:1,musinsaCount:1,parts:[{id:'legacy',path:'musinsa/search.js',count:1}]};
 fs.writeFileSync(file,html.replace(/window\.__CLOT_DATA__ = [^\n]+;/,()=> 'window.__CLOT_DATA__ = '+JSON.stringify(data)+';'));
 let fail=true,attempts=0;
 await page.route('**/musinsa/search.js*',async r=>{
  attempts++;
  if(fail){if(attempts>2)await new Promise(resolve=>setTimeout(resolve,500));return r.abort();}
  return r.fulfill({contentType:'text/javascript',body:'window.__CLOT_CATALOG_PARTS__ = '+JSON.stringify({legacy:{v:1,id:'legacy',revision:'legacy',items:[item]}})+';'});
 });
 for(const location of [url,pathToFileURL(file).href]){
  fail=true;attempts=0;await page.goto(location);await page.getByRole('button',{name:'다시 시도',exact:true}).waitFor();
  assert.equal(attempts,1);await page.locator('#q').fill('2156295');await page.waitForTimeout(400);
  assert.equal(attempts,2,'failed direct lookup must not automatically restart');
  await page.getByText('상품을 조회하지 못했습니다',{exact:true}).waitFor();await page.waitForTimeout(200);assert.equal(attempts,2);
  fail=false;await page.getByRole('button',{name:'다시 시도',exact:true}).click();await page.locator(coatSelector).waitFor();assert.equal(attempts,3);
 }
});

test('일반 검색의 간결한 쿠폰가와 상세 적립금 기준, 정렬 보존 HTTP/file',async t=>{
 const {page,dir,url}=await fixture(t,{pointScenario:'ELIGIBLE'});
 for(const location of [url,pathToFileURL(path.join(dir,'index.html')).href]){
  await page.goto(location);await page.locator('#q').fill('kimuir 캐시미어');await page.locator(coatSelector).waitFor();
  const card=await page.locator(coatSelector).textContent();assert.match(card,/248,200원/);assert.doesNotMatch(card,/230,830원/);await page.locator(coatSelector).click();await page.locator('#priceDetails>summary').click();const basis=await page.locator('#mPriceDetails').textContent();assert.match(basis,/230,830원/);assert.match(basis,/적립금 17,370원 이상 보유 가정 · 등급·카드 할인 제외/);assert.match(basis,/확인 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} KST/);await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});
  await page.locator('#sortSel').selectOption('priceAsc');await page.waitForFunction(()=>document.querySelector('#grid').dataset.searchStatus==='ready');
  assert.deepEqual(await page.locator('.card').evaluateAll(xs=>xs.map(x=>x.dataset.k)),['musinsa:2156295','musinsa:2156296']);
 }
});
test('독립 상품 조회의 적립금 병기, 필터 보존과 상세 재열기 HTTP/file',async t=>{
 const {page,dir,url}=await fixture(t,{pointScenario:'ELIGIBLE'});await page.route('**/assets/index-*.js*',r=>r.abort());
 const D=JSON.parse(fs.readFileSync(path.join(dir,'index.html'),'utf8').match(/window\.__CLOT_DATA__ = ([^\n]+);/)[1]);assert.ok(!D.catalog.previewItems.some(x=>x.k==='musinsa:2156295'));
 for(const location of [url,pathToFileURL(path.join(dir,'index.html')).href]){
  await page.goto(location);await page.evaluate(()=>{for(const [k,v] of [['src','4910'],['cat','top'],['filter','drop']])localStorage.setItem('clot.'+k,v);});await page.reload();
  for(const q of ['2156295','https://www.musinsa.com/products/2156295']){
   await page.locator('#q').fill(q);await page.locator(coatSelector).waitFor();assert.match(await page.locator(coatSelector).textContent(),/248,200원/);
   for(let i=0;i<2;i++){
    await page.locator(coatSelector).click();await page.locator('#detailView:not([hidden]) #detailContent:not([hidden])').waitFor();await page.locator('#mRows').filter({hasText:new Date().toISOString().slice(0,10)}).waitFor({state:'attached'});
    assert.match(await page.locator('#mPrice').textContent(),/248,200원/);assert.match(await page.locator('#mPriceDetails').textContent(),/230,830원.*적립금 17,370원 이상 보유 가정/);
    assert.equal(await page.locator('#prevBtn').isEnabled(),false);assert.equal(await page.locator('#nextBtn').isEnabled(),false);await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});
   }
   assert.deepEqual(await page.evaluate(()=>['src','cat','filter'].map(k=>localStorage.getItem('clot.'+k))),['4910','top','drop']);
  }
 }
});
for(const [scenario,enabled,message] of [['RESTRICTED',true,'적립금 사용 불가'],['UNKNOWN',true,'적립금 사용 조건 미확인'],['STALE',true,'적립금 사용 조건 미확인'],['ELIGIBLE',false,null]]){
 test('적립금 상태 '+scenario+' enabled='+enabled+' HTTP/file',async t=>{
  const {page,dir,url}=await fixture(t,{pointScenario:scenario,pointEstimatesEnabled:enabled});
  for(const location of [url,pathToFileURL(path.join(dir,'index.html')).href]){
   await page.goto(location);await page.locator('#q').fill('2156295');await page.locator(coatSelector).waitFor();
   const text=await page.locator(coatSelector).textContent();assert.ok(!text.includes('적립금'));
   assert.ok(!text.includes('230,830원'));await page.locator(coatSelector).click();await page.locator('#mRows').filter({hasText:new Date().toISOString().slice(0,10)}).waitFor({state:'attached'});
   const detail=await page.locator('#mPriceDetails').textContent();if(message)assert.ok(detail.includes(message));else assert.ok(!detail.includes('적립금'));
   await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});
  }
 });
}

test('prices expire in an open tab and historical records remain explicitly accessible',async t=>{
 const {page,url}=await fixture(t);
 await page.clock.install();await page.goto(url);
 await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='5');
 await page.clock.fastForward(49*3600000);
 await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='0');
 await openFilters(page);await page.getByRole('checkbox',{name:'과거 기록 포함',exact:true}).check();
 await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='5');

 await page.locator('.card').first().click();
 assert.match(await page.locator('#mFacts').textContent(),/갱신 지연/);
});

test('first visit uses dropAmt while filter reset preserves a saved sort',async t=>{
 const {page,url}=await fixture(t);await page.goto(url);
 await page.locator('#shownN').filter({hasText:/^5$/}).waitFor();
 assert.equal(await page.locator('.card').first().getAttribute('data-k'),'musinsa:2');
 assert.equal(await page.locator('#sortSel').inputValue(),'dropAmt');
 await page.locator('#sortSel').selectOption('priceDesc');await page.reload();
 assert.equal(await page.locator('#sortSel').inputValue(),'priceDesc');
 await openFilters(page);await page.locator('[data-src=musinsa]').click();
 await page.locator('#resetBtn').click();
 assert.equal(await page.locator('#sortSel').inputValue(),'priceDesc');
});

test('catalog shows one price-filter group without duplicate KPI cards',async t=>{
 const {page,url}=await fixture(t);await page.goto(url);await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='5');
 assert.equal(await page.locator('.kpi').count(),0);
 for(const filter of ['all','drop','lowest'])assert.equal(await page.locator(`[data-filter="${filter}"]`).count(),1);
 assert.equal(await page.locator('[data-src]').count(),3);
 const card=page.locator('.card[data-k="musinsa:2"]');
 assert.equal(await card.locator('.mine').textContent(),'80원');
 assert.match(await card.locator('.pin.drop').textContent(),/20원/);
});
test('catalog fits 390 768 1440 with the specified column counts',async t=>{
 const {page,url}=await fixture(t);await page.goto(url);
 for(const [width,columns] of [[390,2],[768,3],[1440,6]]){
  await page.setViewportSize({width,height:1000});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(await page.locator('#grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length),columns);
  const box=await page.locator('.thumb').first().boundingBox();assert.ok(Math.abs(box.width/box.height-5/6)<.01);
 }
});
test('unstored theme defaults light even under dark OS preference',async t=>{
 const {page,url}=await fixture(t);await page.emulateMedia({colorScheme:'dark'});await page.goto(url);
 assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
 await page.locator('#themeBtn').click();await page.reload();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
});
test('collection explanation stays available inside the product price basis',async t=>{
 const {page,url}=await fixture(t,{wide:true});await page.goto(url+'?goods=77');await page.locator('#detailContent').waitFor({state:'visible'});
 const details=page.locator('#priceDetails');assert.equal(await details.evaluate(el=>el.open),false);
 await details.locator('summary').click();assert.equal(await page.locator('#musinsaExplanation').isVisible(),true);assert.match(await page.locator('#musinsaExplanation').textContent(),/추정가는 확인된 혜택 기준/);
});
test('missing product image preserves accessible card',async t=>{
 const {page,url}=await fixture(t);await page.goto(url);const card=page.getByRole('button',{name:'아디다스 아디다스 상품 2 가격 추이 보기',exact:true});
 await card.waitFor();assert.equal(await card.locator('.ph').count(),1);assert.match(await card.textContent(),/80원/);await card.click();assert.equal(await page.locator('#mName').textContent(),'아디다스 상품 2');
});
test('mobile catalog exposes a price in the first viewport with expandable filters',async t=>{
 const {page,url}=await fixture(t,{search:true});await page.setViewportSize({width:390,height:844});await page.goto(url);
 await page.waitForFunction(()=>document.querySelector('#grid').dataset.searchStatus==='ready');
 const box=await page.locator('.mine').first().boundingBox();assert.ok(box.y+box.height<=844);
 assert.equal(await page.locator('#filterToggle').getAttribute('aria-expanded'),'false');
 await page.locator('#filterToggle').click();await page.locator('#brandTrigger').click();await page.getByRole('dialog',{name:'브랜드 선택',exact:true}).waitFor();
 await page.keyboard.press('Escape');await page.locator('[data-src=musinsa]').click();await page.locator('#grid[data-search-status=ready]').waitFor();
 await page.locator('#filterToggle').click();assert.equal(await page.locator('#catalogFilters').isVisible(),false);assert.equal(await page.locator('#filterToggle').getAttribute('aria-expanded'),'false');assert.match(await page.locator('#activeFilters').textContent(),/무신사/);
 await page.locator('#filterToggle').click();assert.equal(await page.locator('[data-src=musinsa]').getAttribute('aria-pressed'),'true');
});

test('detail is a page and browser back restores catalog',async t=>{
 const {page,url}=await fixture(t);await page.goto(url);await page.waitForFunction(()=>document.querySelector('#grid').dataset.searchStatus==='ready');
 const card=page.locator('.card[data-k="musinsa:2"]');await card.click();await page.locator('#detailView').waitFor({state:'visible'});
 assert.equal(await page.locator('#catalogView').isVisible(),false);assert.notEqual(await page.locator('#detailView').getAttribute('role'),'dialog');
 await page.waitForFunction(()=>document.querySelector('#mRows').textContent.includes('2026-10-16'));
 assert.equal(await page.locator('[data-range="90"]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('body').evaluate(el=>el.style.overflow),'');
 assert.equal(await page.locator('#mName').evaluate(el=>el===document.activeElement),true);
 await page.goBack();await page.locator('#catalogView').waitFor({state:'visible'});assert.equal(await page.locator('#detailView').isVisible(),false);assert.equal(await card.evaluate(el=>el===document.activeElement),true);
 await page.goForward();await page.locator('#mName').filter({hasText:'아디다스 상품 2'}).waitFor();await page.keyboard.press('Escape');await page.locator('#catalogView').waitFor({state:'visible'});
});
test('direct and reloaded detail return to local catalog HTTP/file',async t=>{
 const {page,dir,url}=await fixture(t,{basePath:'/project-clot/'});
 for(const base of [url,pathToFileURL(path.join(dir,'index.html')).href])for(const [goods,name,link] of [['1','나이키 상품 1','https://www.musinsa.com/products/1'],['4910:3','나이키 상품 3','https://4910.kr/goods/3']]){
  const direct=base+'?goods='+goods+'&keep=1#x';await page.goto(direct);await page.locator('#mName').filter({hasText:name}).waitFor();
  assert.equal(await page.locator('#mLink').getAttribute('href'),link);await page.reload();await page.locator('#mName').filter({hasText:name}).waitFor();
  await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});await page.locator('#catalogView').waitFor({state:'visible'});
  const u=new URL(page.url());assert.equal(u.pathname,new URL(base).pathname);assert.equal(u.searchParams.get('keep'),'1');assert.equal(u.searchParams.has('goods'),false);assert.equal(u.hash,'#x');
 }
});
test('late history after back or product change cannot reopen detail',async t=>{
 const {page,url}=await fixture(t);let release;const gate=new Promise(r=>release=r);await page.route('**/assets/history-*.js*',async r=>{await gate;await r.continue();});
 try{await page.goto(url);await page.waitForFunction(()=>document.querySelector('#grid').dataset.searchStatus==='ready');await page.locator('.card[data-k="4910:3"]').click();await page.locator('#detailView').waitFor({state:'visible'});await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});await page.locator('#catalogView').waitFor({state:'visible'});release();await page.waitForTimeout(100);assert.equal(await page.locator('#detailView').isVisible(),false);await page.locator('.card[data-k="musinsa:2"]').click();await page.locator('#mName').filter({hasText:'아디다스 상품 2'}).waitFor();assert.equal(new URL(page.url()).searchParams.get('goods'),'musinsa:2');}finally{release();}
});
test('chart failure retains history table',async t=>{
 const {page,url}=await fixture(t);await page.route('**/*chart.umd*',r=>r.abort());await page.goto(url+'?goods=1');await page.waitForFunction(()=>document.querySelector('#mRows').textContent.includes('2026-10-16'));
 assert.equal(await page.locator('#chartFallback').isVisible(),true);assert.match(await page.locator('#mPrice').textContent(),/100원/);
});
test('detail lookup failure is visible and retryable',async t=>{
 const {page,url}=await fixture(t,{search:true});let fail=true;await page.route('**/assets/routes-*.js*',r=>fail?r.abort():r.continue());
 await page.goto(url+'?goods=2156295');await page.getByRole('button',{name:'상품 다시 시도',exact:true}).waitFor();assert.equal(await page.locator('#detailBack').isVisible(),true);
 fail=false;await page.getByRole('button',{name:'상품 다시 시도',exact:true}).click();await page.locator('#mName').filter({hasText:'캐시미어'}).waitFor();
});
test('detail expires without rebuilding the hidden list',async t=>{
 const {page,url}=await fixture(t);await page.clock.install();await page.goto(url);await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='5');
 const keys=await page.locator('.card').evaluateAll(xs=>xs.map(x=>x.dataset.k));await page.locator('.card[data-k="musinsa:2"]').click();await page.waitForFunction(()=>document.querySelector('#mRows').textContent.includes('2026-10-16'));
 await page.clock.fastForward(49*3600000);assert.match(await page.locator('#mFacts').textContent(),/갱신 지연/);assert.deepEqual(await page.locator('.card').evaluateAll(xs=>xs.map(x=>x.dataset.k)),keys);
 await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='0');
 await openFilters(page);await page.getByRole('checkbox',{name:'과거 기록 포함',exact:true}).check();await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='5');
});
test('detail layout fits mobile tablet desktop and mobile chart follows summary',async t=>{
 const {page,url}=await fixture(t);for(const width of [390,768,1440]){
 await page.setViewportSize({width,height:1000});await page.goto(url+'?goods=1');await page.waitForFunction(()=>document.querySelector('#mRows').textContent.includes('2026-10-16'));
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const info=await page.locator('.detail-summary').boundingBox(),chart=await page.locator('.detail-history').boundingBox();
 if(width<900){assert.ok(chart.y>info.y);if(width===390)assert.ok(chart.y<900);}else assert.ok(info.x>chart.x);
 }
});
test('invalid direct goods has a local return and no product lookup',async t=>{
 const {page,url}=await fixture(t);let lookups=0;page.on('request',r=>{if(/assets\/routes-/.test(r.url()))lookups++;});await page.goto(url+'?goods=bad&keep=1');
 await page.locator('#detailStatus').filter({hasText:'상품번호'}).waitFor();assert.equal(lookups,0);await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});await page.locator('#catalogView').waitFor({state:'visible'});assert.equal(new URL(page.url()).searchParams.get('keep'),'1');
});

for(const filtered of [false,true])test('virtual catalog detail round trip preserves window scroll focus and history budget'+(filtered?' with filters and freshness refresh':''),async t=>{
 const {page,url}=await fixture(t,{scale:true,...(filtered?{scaleCount:1500}:{})});
 await page.addInitScript(()=>{window.IntersectionObserver=class{observe(){}unobserve(){}};});
 if(filtered)await page.clock.install();
 let historyRequests=0;page.on('request',r=>{if(/\/assets\/history-/.test(r.url()))historyRequests++;});
 await page.goto(url);await page.waitForFunction(total=>document.querySelector('#shownN').textContent===total,filtered?'2,128':'440,129');
 assert.equal(await page.locator('.card').count(),120);assert.equal(historyRequests,0);
 if(filtered){
  await openFilters(page);await page.locator('[data-src="4910"]').click();await page.locator('#grid[data-search-status=ready]').waitFor();await openFilters(page);await page.locator('#brandTrigger').click();await page.getByRole('checkbox',{name:/^나이키 /}).check();await page.keyboard.press('Escape');await page.locator('#q').fill('나이키 상품');await page.clock.fastForward(200);await page.locator('#grid[data-search-status=ready]').waitFor();await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='1,500');
 }
 const initialKey=await page.locator('.card').first().getAttribute('data-k');
 for(let i=0;i<4;i++){
  const before=await page.locator('.card').last().getAttribute('data-k');await page.locator('#gridMore').click();
  await page.waitForFunction(k=>document.querySelector('.card:last-child').dataset.k!==k,before);assert.ok(await page.locator('.card').count()<=360);
 }
 assert.notEqual(await page.locator('.card').first().getAttribute('data-k'),initialKey);assert.equal(historyRequests,0);
 const card=page.locator('.card').nth(30);await card.scrollIntoViewIfNeeded();
 const key=await card.getAttribute('data-k'),keys=await page.locator('.card').evaluateAll(xs=>xs.map(x=>x.dataset.k)),scrollY=await page.evaluate(()=>scrollY),sort=await page.locator('#sortSel').inputValue();
 await card.click();await page.locator('#detailContent').waitFor({state:'visible'});
 await page.locator('#nextBtn').click();await page.waitForFunction(k=>new URLSearchParams(location.search).get('goods')!==k,key);
 if(filtered)await page.clock.fastForward(60000);
 await page.goBack();await page.locator('#catalogView').waitFor({state:'visible'});
 if(filtered)await page.locator('#grid[data-search-status=ready]').waitFor();
 await page.waitForFunction(k=>document.activeElement.dataset.k===k,key);
 assert.deepEqual(await page.locator('.card').evaluateAll(xs=>xs.map(x=>x.dataset.k)),keys);assert.equal(await page.locator('#sortSel').inputValue(),sort);
 assert.ok(Math.abs(await page.evaluate(()=>scrollY)-scrollY)<=2);assert.ok(await page.locator('.card').count()<=360);
 if(filtered){assert.equal(await page.locator('#q').inputValue(),'나이키 상품');assert.equal(await page.locator('[data-src="4910"]').getAttribute('aria-pressed'),'true');assert.match(await page.locator('#brandSummary').textContent(),/나이키/);}
});
test('late catalog page cannot mutate hidden detail or expand the restored window',async t=>{
 const {page,url,dir}=await fixture(t,{scale:true,scaleCount:1500});
 await page.addInitScript(()=>{window.IntersectionObserver=class{observe(){}unobserve(){}};});
 const script=fs.readFileSync(path.join(dir,'dashboard-worker.js'),'utf8');await page.route('**/dashboard-worker.js*',r=>r.fulfill({contentType:'text/javascript',body:script+';const original=onmessage;onmessage=e=>{if(e.data.method==="page"&&e.data.args[1]>=360)setTimeout(()=>original(e),400);else original(e);};'}));
 await page.goto(url);await page.locator('#grid[data-search-status=ready]').waitFor();
 for(const n of [240,360]){await page.locator('#gridMore').click();await page.waitForFunction(n=>document.querySelectorAll('.card').length===n,n);}
 await page.locator('#gridMore').click();const card=page.locator('.card').nth(30);await card.scrollIntoViewIfNeeded();const key=await card.getAttribute('data-k'),keys=await page.locator('.card').evaluateAll(xs=>xs.map(x=>x.dataset.k));
 await card.click();await page.locator('#detailContent').waitFor({state:'visible'});await page.waitForTimeout(500);assert.deepEqual(await page.locator('.card').evaluateAll(xs=>xs.map(x=>x.dataset.k)),keys);
 await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});await page.waitForFunction(k=>document.activeElement.dataset.k===k,key);
 assert.deepEqual(await page.locator('.card').evaluateAll(xs=>xs.map(x=>x.dataset.k)),keys);assert.ok(await page.locator('.card').count()<=360);
});
test('expired entry returns focus to an adjacent surviving product',async t=>{
 const {page,url,dir}=await fixture(t);const file=path.join(dir,'index.html'),html=fs.readFileSync(file,'utf8');
 const data=JSON.parse(html.match(/window\.__CLOT_DATA__ = ([^\n]+);/)[1]);
 const old=data.items.find(x=>x.k==='4910:4').tracking,next=structuredClone(old),at=Date.now()-47*3600000;
 next.seenAt=next.saleAt=new Date(at).toISOString();next.samples.forEach((sample,i)=>{sample.at=new Date(at-(next.samples.length-1-i)*24*3600000).toISOString();sample.date=sample.at.slice(0,10);});
 const before=JSON.stringify(old),after=JSON.stringify(next);assert.equal(Buffer.byteLength(before),Buffer.byteLength(after));
 // Fixed-width timestamps keep the fixture's asset byte contract valid.
 for(const f of [file,...fs.readdirSync(path.join(dir,'assets')).map(name=>path.join(dir,'assets',name))])fs.writeFileSync(f,fs.readFileSync(f,'utf8').replaceAll(before,after));
 await page.clock.install();await page.goto(url);await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='5');
 assert.deepEqual(await page.locator('.card').evaluateAll(xs=>xs.map(x=>x.dataset.k)),['musinsa:2','4910:1','4910:4','musinsa:1','4910:3']);
 await page.locator('.card[data-k="4910:4"]').click();await page.locator('#detailContent').waitFor({state:'visible'});await page.clock.fastForward(2*3600000);
 await page.locator('#detailBack').click();await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='4');
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.k),'musinsa:1');
});
test('denied browser storage and history keep detail return usable',async t=>{
 const {page,url}=await fixture(t);await page.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw Error('denied');}});for(const name of ['pushState','replaceState'])history[name]=()=>{throw Error('denied');};});
 await page.goto(url);await page.locator('.card[data-k="musinsa:2"]').click();await page.locator('#detailContent').waitFor({state:'visible'});await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});assert.equal(await page.locator('#detailView').isVisible(),false);
});
test('legacy targetGoodsNo opens without adding a foreign back destination',async t=>{
 const {page,url,dir}=await fixture(t),file=path.join(dir,'index.html');let html=fs.readFileSync(file,'utf8');const data=JSON.parse(html.match(/window\.__CLOT_DATA__ = ([^\n]+);/)[1]);data.targetGoodsNo=1;fs.writeFileSync(file,html.replace(/window\.__CLOT_DATA__ = [^\n]+;/,()=> 'window.__CLOT_DATA__ = '+JSON.stringify(data)+';'));
 await page.goto(url+'?keep=1');await page.locator('#mName').filter({hasText:'나이키 상품 1'}).waitFor();await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});assert.equal(new URL(page.url()).searchParams.get('keep'),'1');assert.equal(new URL(page.url()).searchParams.has('goods'),false);
});

// Delay real Worker replies at the browser boundary, preserving all query/page side effects.
async function gateWorkerReplies(page,{noObserver=false}={}){
 await page.addInitScript(noObserver=>{
  if(noObserver)window.IntersectionObserver=class{observe(){}unobserve(){}};
  const Base=Worker,g=window.__workerGate={queries:false,pageFrom:Infinity,requests:new Map(),held:[],delivered:[]};
  g.releaseAt=index=>g.held.splice(index,1)[0]?.deliver();
  g.releaseAll=()=>{g.queries=false;g.pageFrom=Infinity;for(const x of g.held.splice(0))x.deliver();};
  window.Worker=class extends Base{
   postMessage(message,...args){g.requests.set(message.requestId,{message,hold:message.method==='query'?g.queries:message.method==='page'&&message.args[1]>=g.pageFrom});super.postMessage(message,...args);}
   set onmessage(fn){super.onmessage=event=>{const id=event.data.requestId,request=g.requests.get(id);g.requests.delete(id);const deliver=()=>{fn.call(this,event);g.delivered.push(id);};if(request?.hold)g.held.push({message:request.message,deliver});else deliver();};}
  };
 },noObserver);
}
test('reopening detail during pending freshness restore cannot revive expired catalog',async t=>{
 const {page,url}=await fixture(t);await gateWorkerReplies(page);await page.clock.install();await page.goto(url);await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='5');
 await page.locator('.card[data-k="musinsa:2"]').click();await page.locator('#detailContent').waitFor({state:'visible'});await page.clock.fastForward(49*3600000);await page.evaluate(()=>__workerGate.queries=true);
 await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});await page.waitForFunction(()=>__workerGate.held.length===1);
 await page.locator('.card[data-k="musinsa:2"]').click();await page.locator('#detailContent').waitFor({state:'visible'});await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});
 await page.evaluate(()=>__workerGate.releaseAll());await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='0',null,{timeout:1500});assert.equal(await page.locator('.card').count(),0);
});
test('filter changes cancel a pending restoration before painting ready cards',async t=>{
 const {page,url}=await fixture(t);await gateWorkerReplies(page);await page.clock.install();await page.goto(url);await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='5');
 await page.locator('.card').first().click();await page.locator('#detailContent').waitFor({state:'visible'});await page.clock.fastForward(60000);await page.evaluate(()=>__workerGate.queries=true);
 try{
  await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});await page.waitForFunction(()=>__workerGate.held.length===1);await page.evaluate(()=>__workerGate.queries=false);
  await openFilters(page);await page.locator('[data-src=musinsa]').click();await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='2'&&document.querySelector('#grid').dataset.searchStatus==='ready');assert.equal(await page.locator('.card').count(),2);
 }finally{await page.evaluate(()=>__workerGate.releaseAll());}
});
test('canceled page cleanup cannot unlock a newer page and append duplicate keys',async t=>{
 const {page,url}=await fixture(t,{scale:true,scaleCount:1500});await gateWorkerReplies(page,{noObserver:true});await page.goto(url);await page.locator('#grid[data-search-status=ready]').waitFor();
 for(const n of [240,360]){await page.locator('#gridMore').click();await page.waitForFunction(n=>document.querySelectorAll('.card').length===n,n);}
 await page.evaluate(()=>__workerGate.pageFrom=360);await page.locator('#gridMore').click();await page.waitForFunction(()=>__workerGate.held.length===1);
 const card=page.locator('.card').nth(3),key=await card.getAttribute('data-k');await card.click();await page.locator('#detailContent').waitFor({state:'visible'});await page.locator('#detailBack').click();await page.waitForFunction(k=>document.activeElement.dataset.k===k,key);
 await page.locator('#gridMore').click();await page.waitForFunction(()=>__workerGate.held.length===2);const oldId=await page.evaluate(()=>__workerGate.held[0].message.requestId);await page.evaluate(()=>__workerGate.releaseAt(0));await page.waitForFunction(id=>__workerGate.delivered.includes(id),oldId);
 await page.locator('#gridMore').click();await page.waitForFunction(()=>Array.from(__workerGate.requests.values()).every(x=>x.message.method!=='page'||x.message.args[1]<360));const ids=await page.evaluate(()=>__workerGate.held.map(x=>x.message.requestId));await page.evaluate(()=>__workerGate.releaseAll());await page.waitForFunction(ids=>ids.every(id=>__workerGate.delivered.includes(id)),ids);
 const keys=await page.locator('.card').evaluateAll(xs=>xs.map(x=>x.dataset.k));assert.equal(keys.length,360);assert.equal(new Set(keys).size,360);
});
test('freshness return preserves independent product search and focus',async t=>{
 const {page,url}=await fixture(t);await page.clock.install();await page.goto(url);await openFilters(page);await page.locator('[data-src=musinsa]').click();await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='2');
 await page.locator('#q').fill('4910:1');await page.locator('.card[data-k="4910:1"]').waitFor();await page.locator('.card').click();await page.locator('#detailContent').waitFor({state:'visible'});await page.clock.fastForward(60000);
 await page.locator('#detailBack').click();await page.locator('#catalogView').waitFor({state:'visible'});await page.locator('.card[data-k="4910:1"]').waitFor({timeout:1500});
 assert.equal(await page.locator('[data-src=musinsa]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#q').inputValue(),'4910:1');assert.match(await page.locator('#catalogNotice').textContent(),/상품번호 조회/);assert.equal(await page.evaluate(()=>document.activeElement.dataset.k),'4910:1');
});

test('unified filter reset preserves pending search and sort while clearing historical scope',async t=>{
 const {page,url}=await fixture(t);await page.goto(url);await page.locator('#grid[data-search-status=ready]').waitFor();
 await openFilters(page);
 await openFilters(page);await page.locator('[data-src=musinsa]').click();await page.locator('#includeHistory').check();await page.locator('#sortSel').selectOption('priceDesc');
 await page.evaluate(()=>{const q=document.querySelector('#q');q.value='나이키';q.dispatchEvent(new InputEvent('input',{bubbles:true}));document.querySelector('#resetBtn').click();});
 await page.locator('#grid[data-search-status=ready]').waitFor();
 assert.equal(await page.locator('#q').inputValue(),'나이키');assert.equal(await page.locator('#sortSel').inputValue(),'priceDesc');assert.equal(await page.locator('#includeHistory').isChecked(),false);
 assert.equal(await page.locator('#shownN').textContent(),'3');assert.equal(await page.locator('[data-src=all]').getAttribute('aria-pressed'),'true');
 await page.waitForTimeout(250);assert.equal(await page.locator('#shownN').textContent(),'3');
});
test('price comparison reveals reference series without changing the current price or route',async t=>{
 const {page,url}=await fixture(t,{search:true});await page.goto(url+'?goods=2156295');await page.waitForFunction(()=>document.querySelector('#chart').dataset.chartConfig);
 const config=()=>page.locator('#chart').evaluate(el=>JSON.parse(el.dataset.chartConfig));
 assert.deepEqual((await config()).data.datasets.slice(0,3).map(x=>!!x.hidden),[true,true,false]);
 const before=await page.locator('#mPrice').textContent(),route=page.url(),soloMax=(await config()).options.scales.y.max;
 await page.getByRole('checkbox',{name:'다른 가격 비교',exact:true}).check();
 assert.deepEqual((await config()).data.datasets.slice(0,3).map(x=>!!x.hidden),[false,false,false]);assert.ok((await config()).options.scales.y.max>soloMax);
 assert.equal(await page.locator('#mPrice').textContent(),before);assert.equal(page.url(),route);
 await page.getByRole('checkbox',{name:'다른 가격 비교',exact:true}).uncheck();assert.deepEqual((await config()).data.datasets.slice(0,3).map(x=>!!x.hidden),[true,true,false]);
});
test('price records remain folded until requested and open automatically when the chart fails',async t=>{
 const {page,url}=await fixture(t);await page.goto(url+'?goods=1');await page.waitForFunction(()=>document.querySelector('#chart').dataset.chartConfig);
 assert.equal(await page.locator('#mRows').isVisible(),false);
 await page.locator('#historyDisclosure>summary').click();assert.equal(await page.locator('#mRows').isVisible(),true);
 await page.route('**/*chart.umd*',r=>r.abort());await page.reload();await page.waitForFunction(()=>document.querySelector('#mRows').textContent.includes('2026-10-16'));
 assert.equal(await page.locator('#chartFallback').isVisible(),true);assert.equal(await page.locator('#mRows').isVisible(),true);assert.equal(await page.locator('#historyDisclosure').evaluate(el=>el.open),true);
});
