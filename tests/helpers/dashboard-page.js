import {createDashboardNavigation} from '../../src/dashboard-navigation.js';
import {createDashboardScope} from "../../src/dashboard-scope.js";
import {createDashboardBuilder} from '../../src/dashboard-builder.js';import {createDashboardIndex} from '../../src/dashboard-index.js';import {createHistoryLoader} from '../../src/dashboard-history.js';import {createDashboardTransport,runDashboardWorker} from '../../src/dashboard-worker.js';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Store4910} from '../../src/site4910/store.js';
import {generateDashboardHtml} from '../../src/visualizer.js';
import path from 'node:path';
import {createDashboardModel} from '../../src/dashboard-model.js';
import {createDashboardRuntime} from '../../src/dashboard-runtime.js';
import {buildDashboardCatalog} from '../../src/dashboard-catalog.js';
import {MusinsaWideStore} from '../../src/musinsaWide/store.js';
import {PointPolicyStore} from '../../src/musinsaWide/point-store.js';
import {refreshPointEstimates} from '../../src/musinsaWide/point-pricing.js';
import {pointPolicy,validPointScanRun} from './musinsa-point-fixtures.js';
import {fixtureRaw,freshTracking} from './dashboard-fixture.js';
export function writeFixture(dir,{scale=false,scaleCount=439501,scanScenario=null,wide=false,search=false,historyDays=0,pointScenario=null,pointEstimatesEnabled=(pointScenario!==null),asOfMs=Date.now()}={}) {
 if(pointScenario!==null)search=true;
 const model=createDashboardModel(),raw=fixtureRaw(),scan=raw.find(x=>x.src==='4910all');
 if(!scale) {
   for(const file of ['musinsa.db','fixture.db'])fs.rmSync(path.join(dir,file),{force:true});
   const db=new DatabaseSync(path.join(dir,'musinsa.db'));
   db.exec('CREATE TABLE items(goods_no INTEGER,goods_name TEXT,brand_name TEXT,url TEXT,image_url TEXT,status TEXT,first_seen_at TEXT,last_checked_at TEXT,category TEXT,source TEXT DEFAULT \'like\'); CREATE TABLE price_logs(id INTEGER PRIMARY KEY,goods_no INTEGER,date TEXT,normal_price INTEGER,sale_price INTEGER,my_price INTEGER,is_sold_out INTEGER,coupon_name TEXT,coupon_discount INTEGER,created_at TEXT);');
   for(const x of raw.filter(x=>x.src==='musinsa')){
     db.prepare('INSERT INTO items(goods_no,goods_name,brand_name,url,image_url,status,first_seen_at,last_checked_at,category) VALUES (?,?,?,?,?,?,?,?,?)').run(x.n,x.g,x.b,x.u,x.i,x.s,x.fs,x.fs,x.c);
     for(const r of x.L)db.prepare('INSERT INTO price_logs(goods_no,date,normal_price,sale_price,my_price,is_sold_out,coupon_name,coupon_discount,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(x.n,r[0],r[1],r[2],r[3],r[4],r[5],r[6],x.tracking.samples[x.L.indexOf(r)===0&&x.L.length>1?0:1].at);
   }
   if(historyDays){db.prepare('DELETE FROM price_logs WHERE goods_no=1').run();for(let i=0;i<historyDays;i++){const date=new Date(Date.UTC(2026,9,16)-(historyDays-1-i)*86400000).toISOString().slice(0,10);db.prepare('INSERT INTO price_logs(goods_no,date,normal_price,sale_price,my_price,is_sold_out,coupon_name,coupon_discount,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(1,date,200,100,90,0,i===historyDays-1?'쿠폰':'이력'.repeat(500),10,new Date(Date.now()-(historyDays-1-i)*86400000-3600000).toISOString());}}
   const db4910Path=path.join(dir,'fixture.db'),store=new Store4910(db4910Path);
   store.syncLiked(raw.filter(x=>x.src==='4910').map(x=>({sno:x.n,brand:x.b,name:x.g,market_name:'',url:x.u,image_url:null})),'2026-10-15');
   for(const x of raw.filter(x=>x.src==='4910'))for(const r of x.L){
     store.logLikedPrice({sno:x.n,date:r[0],list_price:r[2],original_price:r[1],member_price:r[3],coupon_price:null,is_soldout:r[4]});
     store.putPriceValidation({kind:'liked',sno:x.n,date:r[0],status:'verified',reason:'browser-fixture',checkedAt:x.tracking.samples[x.L.indexOf(r)===0&&x.L.length>1?0:1].at,evidence:{observedDate:r[0],priceBasis:'AGLO',basePrice:r[2],originalPrice:r[1]}});
   }
   const listing={sno:3,brand_sno:9,brand:'나이키',name:'나이키 상품 3',market_sno:1,market_name:'',category:null,sale_price:120,original_price:200,discount_rate:40,image_url:null,url:'',closed:false};
   if(scanScenario){
     store.applyScan('2026-10-13',[{...listing,sale_price:100}],{completeBrands:[9]});
     store.logCouponPriceChanges('2026-10-13',[{sno:3,sale_price:100,coupon_price:80}]);
     if(scanScenario==='changed'){
       store.applyScan('2026-10-14',[listing],{completeBrands:[9]});
       store.applyScan('2026-10-15',[{...listing,sale_price:110}],{completeBrands:[9]});
       for(const [date,price] of [['2026-10-14',120],['2026-10-15',110]])store.putPriceValidation({kind:'scan',sno:3,date,status:'verified',reason:'browser-fixture',corrected:{sale_price:price,coupon_price:price}});
     }
   }
   store.applyScan('2026-10-16',[listing],{completeBrands:[9]});
   store.putPriceValidation({kind:'scan',sno:3,date:'2026-10-16',status:'verified',reason:'browser-fixture',corrected:{sale_price:120,coupon_price:120}});
   store.db.prepare('UPDATE goods SET observation_json=? WHERE sno=3').run(JSON.stringify(freshTracking(120,'4910 검증가')));
   store.recordScanRun({date:'2026-10-16',brandCounts:{},complete:true,changed:0,added:1,dropped:0,durationMs:1});
   store.close();
   let dbMusinsaPath=null;
   if(wide||search){
     dbMusinsaPath=path.join(dir,'wide.db');fs.rmSync(dbMusinsaPath,{force:true});
     const W=new MusinsaWideStore(dbMusinsaPath);
     for(const [id,source,price] of [[1,'DIRECT',80],[77,'ESTIMATED',70]]){
       W.db.prepare("INSERT INTO goods(goods_no,cat,name,url,brand_name,sale_price,normal_price,coupon_price,coupon_price_source,first_seen_date) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id,'001','무신사 '+id,'https://www.musinsa.com/products/'+id,'새 브랜드',100,200,price,source,'2026-10-16');
     }
     if(search){
       const insert=W.db.prepare("INSERT INTO goods(goods_no,cat,name,url,brand,brand_name,sale_price,normal_price,coupon_price,coupon_price_source,first_seen_date) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
       for(let i=0;i<130;i++)insert.run(900000+i,i%2?'001':'002','검색 방해 상품 '+i,'https://www.musinsa.com/products/'+(900000+i),'other','다른 브랜드',10,200,10,'DIRECT','2026-10-16');
       for(const id of [2156295,2156296])insert.run(id,'002','[Drape Wool] 캐시미어블렌드 세미오버핏 발마칸 코트_블랙'+(id===2156296?' 다른 상품':''),'https://www.musinsa.com/products/'+id,'kimuir','키뮤어',263200,329000,248200,'ESTIMATED','2026-10-16');
     }
     W.db.prepare('INSERT INTO scan_runs(date,complete,completed_at,category_counts_json,coupon_metrics_json) VALUES(?,?,?,?,?)').run('2026-10-16',1,'2026-10-16T04:50:00Z','[]',JSON.stringify({pricing:{exceptionCoupons:[354317]}}));
     if(pointScenario!==null){
       const date=new Date(asOfMs).toISOString().slice(0,10);W.db.exec('DELETE FROM scan_runs');validPointScanRun(W.db,{date});
       const points=new PointPolicyStore(W.db,{initialize:true});
       if(pointScenario!=='UNKNOWN')points.savePolicy(pointPolicy({restricted:pointScenario==='RESTRICTED',checkedAt:new Date(asOfMs-(pointScenario==='STALE'?604800000:3600000)).toISOString()}));
       refreshPointEstimates({db:W.db,asOfMs,enabled:true});
     }
     for(const g of W.db.prepare('SELECT goods_no,coupon_price,coupon_price_source FROM goods').all())W.db.prepare('UPDATE goods SET observation_json=? WHERE goods_no=?').run(JSON.stringify(freshTracking(g.coupon_price,g.coupon_price_source)),g.goods_no);
     W.close();
   }
   const result=generateDashboardHtml({db,dbMusinsaPath,db4910Path,pointEstimatesEnabled,asOfMs,outputPath:path.join(dir,'index.html'),openBrowser:false});db.close();return result;
 }
 const n=scaleCount;
 const compact={v:1,brandSno:9,b:['나이키'],m:[''],imgBase:'',r:Array.from({length:n},(_,i)=>[i+3,0,0,i===n-1&&scale?'LAST_SENTINEL':'나이키 상품 '+(i+3),'','',['top','outer','etc'][i%3],[['2026-10-16',200,120,120]],freshTracking(120,'4910 검증가')])};
 // Scale uses IDs outside the liked range so the target total is exact.
 if(scale)for(let i=0;i<n;i++)compact.r[i][0]=i+10;
 const base=raw.filter(x=>x!==scan);
 if(scale)for(let i=3;i<=626;i++)base.push({...raw[0],n:i,k:String(i),g:'무신사 상품 '+i,c:['top','outer','etc'][i%3]});
 const sink=createDashboardBuilder({outDir:dir,revision:'fixture'});
 const legacy=buildDashboardCatalog({sink,baseItems:base,scanIndex:{brands:[[9,'나이키',n]]},readBrand:()=>compact,dir4910:path.join(dir,'4910'),revision:'fixture',scanState:'complete'});
 const packaged=sink.finish({scanState:'complete',notice:null,scanCount:n});
 const payload={generatedAt:'2026-10-16',lastRun:null,...packaged};
 let html=fs.readFileSync(new URL('../../src/dashboard.template.html',import.meta.url),'utf8');
 html=html.replace(/\/\*\s*__CLOT_DATA_PLACEHOLDER__\s*\*\/[\s\S]*?;\s*[\r\n]*/,()=> 'window.__CLOT_DATA__ = '+JSON.stringify(payload).replace(/<\/script/gi,'<\\/script')+';\n');
 html = html.replace('/* __CLOT_NAVIGATION__ */',()=> 'window.__CLOT_NAVIGATION_FACTORY__ = ('+createDashboardNavigation.toString()+');');
html=html.replace('/* __CLOT_MODEL__ */',()=> 'window.__CLOT_MODEL__ = ('+createDashboardModel.toString()+')();');
 html=html.replace('/* __CLOT_RUNTIME__ */',()=> 'window.__CLOT_SCOPE_FACTORY__ = ('+createDashboardScope.toString()+');window.__CLOT_TRANSPORT_FACTORY__ = ('+createDashboardTransport.toString()+');window.__CLOT_INDEX_FACTORY__ = ('+createDashboardIndex.toString()+');window.__CLOT_HISTORY_FACTORY__ = ('+createHistoryLoader.toString()+');window.__CLOT_RUNTIME_FACTORY__ = ('+createDashboardRuntime.toString()+');');
 fs.writeFileSync(path.join(dir,'dashboard-worker.js'),'const model=('+createDashboardModel.toString()+')();const index=('+createDashboardIndex.toString()+')(model);('+runDashboardWorker.toString()+')({model,index,scope:('+createDashboardScope.toString()+')(),transport:('+createDashboardTransport.toString()+')});');
 fs.writeFileSync(path.join(dir,'index.html'),html);
 return {payload,model};
}
