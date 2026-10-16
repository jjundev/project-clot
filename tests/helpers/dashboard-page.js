import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Store4910} from '../../src/site4910/store.js';
import {generateDashboardHtml} from '../../src/visualizer.js';
import path from 'node:path';
import {createDashboardModel} from '../../src/dashboard-model.js';
import {createDashboardRuntime} from '../../src/dashboard-runtime.js';
import {buildDashboardCatalog} from '../../src/dashboard-catalog.js';
import {MusinsaWideStore} from '../../src/musinsaWide/store.js';
import {fixtureRaw} from './dashboard-fixture.js';
export function writeFixture(dir,{scale=false,scanScenario=null,wide=false}={}) {
 const model=createDashboardModel(),raw=fixtureRaw(),scan=raw.find(x=>x.src==='4910all');
 if(!scale) {
   for(const file of ['musinsa.db','fixture.db'])fs.rmSync(path.join(dir,file),{force:true});
   const db=new DatabaseSync(path.join(dir,'musinsa.db'));
   db.exec('CREATE TABLE items(goods_no INTEGER,goods_name TEXT,brand_name TEXT,url TEXT,image_url TEXT,status TEXT,first_seen_at TEXT,last_checked_at TEXT,category TEXT); CREATE TABLE price_logs(id INTEGER PRIMARY KEY,goods_no INTEGER,date TEXT,normal_price INTEGER,sale_price INTEGER,my_price INTEGER,is_sold_out INTEGER,coupon_name TEXT,coupon_discount INTEGER);');
   for(const x of raw.filter(x=>x.src==='musinsa')){
     db.prepare('INSERT INTO items VALUES (?,?,?,?,?,?,?,?,?)').run(x.n,x.g,x.b,x.u,x.i,x.s,x.fs,x.fs,x.c);
     for(const r of x.L)db.prepare('INSERT INTO price_logs(goods_no,date,normal_price,sale_price,my_price,is_sold_out,coupon_name,coupon_discount) VALUES(?,?,?,?,?,?,?,?)').run(x.n,r[0],r[1],r[2],r[3],r[4],r[5],r[6]);
   }
   const db4910Path=path.join(dir,'fixture.db'),store=new Store4910(db4910Path);
   store.syncLiked(raw.filter(x=>x.src==='4910').map(x=>({sno:x.n,brand:x.b,name:x.g,market_name:'',url:x.u,image_url:null})),'2026-10-15');
   for(const x of raw.filter(x=>x.src==='4910'))for(const r of x.L){
     store.logLikedPrice({sno:x.n,date:r[0],list_price:r[2],original_price:r[1],member_price:r[3],coupon_price:null,is_soldout:r[4]});
     store.putPriceValidation({kind:'liked',sno:x.n,date:r[0],status:'verified',reason:'browser-fixture',evidence:{observedDate:r[0],priceBasis:'AGLO',basePrice:r[2],originalPrice:r[1]}});
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
   store.recordScanRun({date:'2026-10-16',brandCounts:{},complete:true,changed:0,added:1,dropped:0,durationMs:1});
   store.close();
   let dbMusinsaPath=null;
   if(wide){
     dbMusinsaPath=path.join(dir,'wide.db');fs.rmSync(dbMusinsaPath,{force:true});
     const W=new MusinsaWideStore(dbMusinsaPath);
     for(const [id,source,price] of [[1,'DIRECT',80],[77,'ESTIMATED',70]]){
       W.db.prepare("INSERT INTO goods(goods_no,cat,name,url,brand_name,sale_price,normal_price,coupon_price,coupon_price_source,first_seen_date) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id,'001','무신사 '+id,'https://www.musinsa.com/products/'+id,'새 브랜드',100,200,price,source,'2026-10-16');
     }
     W.db.prepare('INSERT INTO scan_runs(date,complete,completed_at,category_counts_json,coupon_metrics_json) VALUES(?,?,?,?,?)').run('2026-10-16',1,'2026-10-16T04:50:00Z','[]',JSON.stringify({pricing:{exceptionCoupons:[354317]}}));W.close();
   }
   const result=generateDashboardHtml({db,dbMusinsaPath,db4910Path,outputPath:path.join(dir,'index.html'),openBrowser:false});db.close();return result;
 }
 const n=139501;
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
