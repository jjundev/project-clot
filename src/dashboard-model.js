/** Shared Node/browser domain model. Keep this factory free of module references. */
export function createDashboardModel() {
 const PRICE_TTL_MS=48*60*60*1000;
 const instant=value=>typeof value==='string'&&value.includes('T')?Date.parse(value):NaN;
 function priceSignalEligibility(tracking,{asOfMs=Date.now(),price,basis}={}) {
 const empty=state=>({trackingState:state,fresh:false,canLow:false,dropAmt:0});
 if(!tracking)return empty('UNKNOWN');
 if(tracking.status==='STOPPED')return empty('STOPPED');
 if(tracking.status==='RETAINED')return empty('RETAINED');
 if(tracking.status!=='ACTIVE')return empty('UNKNOWN');
 const samples=Array.isArray(tracking.samples)?tracking.samples:[],last=samples.at(-1),prev=samples.at(-2);
 const at=instant(last?.at),saleAt=instant(tracking.saleAt),age=asOfMs-at;
 if(!last||!Number.isFinite(at)||!Number.isFinite(saleAt)||last.price==null||last.price!==price||(basis&&last.basis!==basis))return empty('UNKNOWN');
 if(age<0||saleAt>asOfMs)return empty('UNKNOWN');
 if(age>PRICE_TTL_MS||asOfMs-saleAt>PRICE_TTL_MS)return empty('STALE');
 const distinct=prev&&prev.date!==last.date&&instant(prev.at)<at;
 const comparable=distinct&&prev.basis===last.basis&&at-instant(prev.at)<=PRICE_TTL_MS&&Number.isFinite(prev.price);
 return {trackingState:'CURRENT',fresh:true,canLow:!!distinct&&prev.basis===last.basis,dropAmt:comparable&&prev.price>price?prev.price-price:0};
 }
 // Every instant t where refresh(x,{asOfMs:t}).fresh holds lies in [from, until].
 function freshWindow(x) {
 const tracking=x.tracking,last=Array.isArray(tracking?.samples)?tracking.samples.at(-1):undefined;
 if(tracking?.status!=='ACTIVE'||!last)return null;
 const at=instant(last.at),saleAt=instant(tracking.saleAt);
 if(!Number.isFinite(at)||!Number.isFinite(saleAt)||last.price==null||last.price!==x.my||(x.priceBasis&&last.basis!==x.priceBasis))return null;
 const from=Math.max(at,saleAt),until=Math.min(at,saleAt)+PRICE_TTL_MS;
 return from<=until?{from,until}:null;
 }
 // Idempotent: keep the historical candidate separate from the expiring signal.
 function refresh(x,{asOfMs=Date.now()}={}) {
 const p=priceSignalEligibility(x.tracking,{asOfMs,price:x.my,basis:x.priceBasis});
 x.trackingState=p.trackingState;x.fresh=p.fresh;
 x.isLow=!!x.lowCandidate&&p.canLow&&p.fresh;
 x.dropAmt=p.fresh&&x.dropEligible?p.dropAmt:0;
 return x;
 }
 const brandKey=name=>String(name||'').normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase();
 // Search normalization is deliberately independent of stable brand identity.
 const normalizeSearchText=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu,'');
 const searchTokens=value=>[...new Set(String(value??'').normalize('NFKC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu)||[])];
 const searchFields=item=>[item.b,item.m,item.g,item.n,...(Array.isArray(item.searchAliases)?item.searchAliases:[])].map(normalizeSearchText).filter(Boolean);
 const matchesSearch=(item,tokens)=>tokens.every(token=>(item._searchFields||searchFields(item)).some(field=>field.includes(token)));
 function parseSearchInput(input) {
 const value=String(input??'').normalize('NFKC').trim();
 const invalid=()=>({type:'invalid',message:'상품번호 또는 지원하는 무신사 상품 URL을 입력해 주세요'});
 const product=(source,digits)=>{
 const n=Number(digits);
 return /^\d+$/.test(digits)&&Number.isSafeInteger(n)&&n>0?{type:'product',key:source+':'+n}:invalid();
 };
 if(!value)return {type:'empty'};
 if(/^[+-]?\d+$/.test(value))return product('musinsa',value);
 const prefix=value.match(/^(musinsa|4910):(.*)$/i);
 if(prefix)return product(prefix[1].toLowerCase(),prefix[2]);
 if(/^www\./i.test(value)||/^[a-z][a-z\d+.-]*:/i.test(value)) {
 try {
 const url=new URL(value),match=url.pathname.match(/^\/products\/(\d+)\/?$/);
 if(!['http:','https:'].includes(url.protocol)||!['musinsa.com','www.musinsa.com','m.musinsa.com'].includes(url.hostname)||url.username||url.password||url.port||!match)return invalid();
 return product('musinsa',match[1]);
 }catch{return invalid();}
 }
 const tokens=searchTokens(value);
 return tokens.length?{type:'text',tokens}:invalid();
 }
 const itemKey=(source,id)=>(source==='musinsa'?'musinsa':'4910')+':'+String(id).split(':').pop();
 const resolveKey=value=>String(value).includes(':')?String(value):itemKey('musinsa',value);
 function summarize(raw,{kind=raw.kind||(raw.src==='musinsa'?'musinsa':raw.src==='4910all'?'scan':'liked'),detail={type:'inline'},asOfMs=Date.now()}={}) {
 const x={...raw,k:itemKey(raw.src,raw.n),src:raw.src==='musinsa'?'musinsa':'4910',kind,detail};
 delete x.L;
 for(const f of ["pointEstimate","pointDiscount","pointState","pointCheckedAt","pointMaxUseRate"])x[f]=raw[f]??null;
 x.searchAliases=[...new Set((Array.isArray(raw.searchAliases)?raw.searchAliases:[]).filter(v=>typeof v==='string').map(v=>v.trim()).filter(Boolean))];
 x.b=raw.b||raw.m||(x.src==='4910'?'4910':'무신사');
 x.c=['top','outer','bottom','shoes','bag'].includes(raw.c)?raw.c:'etc';
 x._searchFields=searchFields(x);x.brandKey=brandKey(x.b);x._hay=brandKey([x.b,x.m,x.g,x.n].join(' '));x._init=x.b.trim().charAt(0).toUpperCase();
 const L=raw.L||[];x.tracked=L.length>0;
 Object.assign(x,{rate:-1,dropAmt:0,isOut:x.s==='SOLDOUT',isLow:false,lowEligible:false,my:null,sale:null,normal:null,newbie:null,coupon:0,couponName:null,lowMy:null,lowDate:null});
 if(!L.length)return refresh(x,{asOfMs});
 const last=L.at(-1),prev=L.at(-2);
 Object.assign(x,{my:last[3],sale:last[2],normal:last[1],newbie:last[7]??null,isOut:last[4]===1||x.isOut,coupon:last[6]>0?last[6]:0,couponName:last[5],priceSource:last[8]??null,observedDate:last[0]});
 x.rate=x.normal&&x.my!=null?Math.round((1-x.my/x.normal)*100):0;
 let first=null,moved=false;
 for(const r of L) {
 if((x.src==='4910'||kind==='wide')&&r[5]!==last[5])continue;
 if(r[3]!=null&&(x.lowMy==null||r[3]<x.lowMy)){x.lowMy=r[3];x.lowDate=r[0];}
 if(r[3]!=null){if(first==null)first=r[3];else if(first!==r[3])moved=true;}
 }
 x.lowEligible=kind==='wide' ? moved&&x.priceSource==='DIRECT' : kind!=='scan'||moved;
 x.lowCandidate=x.lowMy!=null&&x.my!=null&&x.my<=x.lowMy&&x.lowEligible;
 x.priceBasis=raw.priceBasis||((kind==='wide'?x.priceSource:null)||last[5]);
 x.dropEligible=kind!=='wide'||x.priceSource==='DIRECT';
 return refresh(x,{asOfMs});
 }
 function mergeSummaries(base,scan) {
 const map=new Map();
 for(const x of [...base,...scan])if(!map.has(x.k)||x.kind==='liked')map.set(x.k,x);
 return [...map.values()];
 }
 function restoreState(saved={}) {
 const src=saved.src==='4910all'?'4910':saved.src;
 const sort=({coupon:'priceAsc',couponRate:'rate'})[saved.sort]||saved.sort;
 return {q:String(saved.q||''),src:['all','musinsa','4910'].includes(src)?src:'all',cat:['all','top','outer','bottom','shoes','bag','etc'].includes(saved.cat)?saved.cat:'all',brandKeys:Array.isArray(saved.brandKeys)?saved.brandKeys.map(brandKey):[],includeHistory:saved.includeHistory===true,filter:['all','lowest','drop','onsale','out'].includes(saved.filter)?saved.filter:'all',sort:['category','rate','priceAsc','priceDesc','dropAmt','brand','new'].includes(sort)?sort:'dropAmt'};
 }
 const quickMatch=(x,f)=>f==='all'||(f==='lowest'?x.isLow:f==='drop'?x.dropAmt>0:f==='out'?x.isOut:!x.isOut);
 function queryCatalog(items,input,{asOfMs=Date.now()}={}) {
 const s=restoreState(input),tokens=searchTokens(s.q),selected=new Set(s.brandKeys);
 const sources={all:0,musinsa:0,'4910':0},quick={all:0,lowest:0,drop:0,onsale:0,out:0},categories={all:0},brands=new Map(),result=[];
 for(const item of items){
 const x=refresh(item,{asOfMs});
 if(!s.includeHistory&&!x.fresh)continue;
 if(!brands.has(x.brandKey))brands.set(x.brandKey,{key:x.brandKey,label:x.b,count:0});
 if(s.q.trim()&&(!tokens.length||!matchesSearch(x,tokens)))continue;
 const src=s.src==='all'||x.src===s.src,cat=s.cat==='all'||x.c===s.cat,brand=!selected.size||selected.has(x.brandKey),filter=quickMatch(x,s.filter);
 if(cat&&brand&&filter){sources.all++;sources[x.src]++;}
 if(src&&brand&&filter){categories.all++;categories[x.c]=(categories[x.c]||0)+1;}
 if(src&&cat&&filter)brands.get(x.brandKey).count++;
 if(src&&cat&&brand){quick.all++;for(const f of ['lowest','drop','onsale','out'])if(quickMatch(x,f))quick[f]++;}
 if(src&&cat&&brand&&filter)result.push(x);
 }
 for(const key of selected)if(!brands.has(key))brands.set(key,{key,label:key,count:0});
 const catOrder={top:1,outer:2,bottom:3,shoes:4,bag:5,etc:9};
 const sorts={
 category:(a,b)=>catOrder[a.c]-catOrder[b.c]||b.rate-a.rate,
 rate:(a,b)=>b.rate-a.rate,
 priceAsc:(a,b)=>(a.my??Infinity)-(b.my??Infinity),
 priceDesc:(a,b)=>(b.my??-Infinity)-(a.my??-Infinity),
 dropAmt:(a,b)=>b.dropAmt-a.dropAmt||b.rate-a.rate,
 brand:(a,b)=>a.b.localeCompare(b.b,'ko')||String(a.g).localeCompare(String(b.g),'ko'),
 new:(a,b)=>(b.fs||'').localeCompare(a.fs||'')||b.n-a.n};
 result.sort((a,b)=>sorts[s.sort](a,b)||a.k.localeCompare(b.k));
 return {items:result,total:result.length,sources,quick,categories,brands:[...brands.values()].filter(b=>b.count>0||selected.has(b.key)).sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label,'ko'))};
 }
 return {parseSearchInput,normalizeSearchText,searchFields,matchesSearch,itemKey,resolveKey,brandKey,summarize,mergeSummaries,queryCatalog,restoreState,refresh,freshWindow,priceSignalEligibility,PRICE_TTL_MS};
}
