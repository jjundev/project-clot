/** Read-only adapter: only public product fields and price provenance leave the DB. */
import fs from 'node:fs';
import path from 'node:path';
import {createDashboardModel} from './dashboard-model.js';
const json=x=>JSON.stringify(x).replace(/<\/script/gi,'<\\/script');
const label=s=>s==='DIRECT'?'직접 확인 가격':s==='ESTIMATED'?'확인된 혜택 기준 추정가':'출처 미확인 가격';
const source=s=>['DIRECT','ESTIMATED'].includes(s)?s:null;
const category={'001':'top','002':'outer','003':'bottom','103':'shoes','004':'bag'};
function group(rows){const map=new Map();for(const r of rows){if(!map.has(r.goods_no))map.set(r.goods_no,[]);map.get(r.goods_no).push(r);}return map;}
export function buildMusinsaCatalog(db,{outDir,revision}) {
 const run=db.prepare('SELECT * FROM scan_runs ORDER BY date DESC LIMIT 1').get();
 if(!run)throw Error('무신사 수집 기록 없음');
 const pricedDates=new Set(db.prepare('SELECT date FROM scan_runs WHERE coupons_ok=1').all().map(r=>r.date));
 const metrics=JSON.parse(run.coupon_metrics_json||'{}');
 const goods=db.prepare("SELECT goods_no,cat,brand_name,brand,name,url,image_url,status,sale_price,normal_price,coupon_price,coupon_price_source,is_sold_out,first_seen_date,misses FROM goods WHERE status='ACTIVE' ORDER BY goods_no").all();
 const changes=group(db.prepare("SELECT p.goods_no,p.date,p.sale_price,p.normal_price FROM price_changes p JOIN goods g USING(goods_no) WHERE g.status='ACTIVE' ORDER BY p.date,p.id").all());
 const coupons=group(db.prepare("SELECT c.goods_no,c.date,c.sale_price,c.coupon_price,c.source FROM coupon_price_changes c JOIN goods g USING(goods_no) WHERE g.status='ACTIVE' ORDER BY c.date").all());
 const metadata={date:run.date,completedAt:run.completed_at,selected:JSON.parse(run.category_counts_json||'[]').reduce((n,c)=>n+c.scanned,0),active:goods.length,direct:0,estimated:0,unknown:0,exceptionCoupons:metrics.pricing?.exceptionCoupons||[],retained:goods.filter(g=>g.misses>0).length};
 const dir=path.join(outDir,'musinsa');fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});
 const parts=[],goodsIds=new Set(),model=createDashboardModel();
 for(let offset=0;offset<goods.length;offset+=2000){
 const id='musinsa-'+String(offset/2000).padStart(4,'0'),historyId='h'+String(offset/2000),historyPath='musinsa/'+historyId+'.js',histories={},items=[];
 for(const g of goods.slice(offset,offset+2000)){
 goodsIds.add(g.goods_no);
 const P=changes.get(g.goods_no)||[],C=coupons.get(g.goods_no)||[];
 const dates=[...new Set([...P.map(p=>p.date),...C.map(c=>c.date),run.date])].sort();
 let pi=-1,ci=-1;const L=[];
 for(const d of dates){
 while(pi+1<P.length&&P[pi+1].date<=d)pi++;
 while(ci+1<C.length&&C[ci+1].date<=d)ci++;
 const current=d===run.date,p=current?g:P[pi];if(!p)continue;
 const c=C[ci],valid=c&&c.sale_price===p.sale_price;
 const cp=current?g.coupon_price:valid?c.coupon_price:null;
 const s=current?source(g.coupon_price_source):valid&&cp!=null?(c.date===d||pricedDates.has(d)?source(c.source):source(c.source)?'ESTIMATED':null):null;
 const price=cp??p.sale_price;
 L.push([d,p.normal_price??null,p.sale_price??null,price??null,current&&g.is_sold_out?1:0,label(s),price!=null?Math.max(0,p.sale_price-price):0,null,s]);
 }
 const summary=model.summarize({n:g.goods_no,src:'musinsa',kind:'wide',b:g.brand_name||g.brand||'무신사',g:g.name,u:g.url,i:g.image_url||'',s:g.is_sold_out?'SOLDOUT':'ACTIVE',c:category[g.cat]||'etc',fs:g.first_seen_date,retained:g.misses>0,L},{kind:'wide',detail:{type:'musinsa',id:historyId,path:historyPath}});
 items.push(summary);histories[summary.k]=L;
 metadata[summary.priceSource==='DIRECT'?'direct':summary.priceSource==='ESTIMATED'?'estimated':'unknown']++;
 }
 fs.writeFileSync(path.join(outDir,historyPath),'(window.__CLOT_MUSINSA_H__ = window.__CLOT_MUSINSA_H__ || {})['+json(historyId)+'] = '+json({v:1,revision,id:historyId,histories})+';\n');
 const file='musinsa/catalog-'+String(offset/2000).padStart(4,'0')+'.js';
 fs.writeFileSync(path.join(outDir,file),'(window.__CLOT_CATALOG_PARTS__ = window.__CLOT_CATALOG_PARTS__ || {})['+json(id)+'] = '+json({v:1,revision,id,items})+';\n');
 parts.push({id,path:file,count:items.length,source:'musinsa'});
 }
 return {parts,goodsIds,metadata};
}
