/** Shared Node/browser domain model. Keep this factory free of module references. */
export function createDashboardModel() {
 const brandKey=name=>String(name||'').normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase();
 const itemKey=(source,id)=>(source==='musinsa'?'musinsa':'4910')+':'+String(id).split(':').pop();
 const resolveKey=value=>String(value).includes(':')?String(value):itemKey('musinsa',value);
 function summarize(raw,{kind=raw.kind||(raw.src==='musinsa'?'musinsa':raw.src==='4910all'?'scan':'liked'),detail={type:'inline'}}={}) {
 const x={...raw,k:itemKey(raw.src,raw.n),src:raw.src==='musinsa'?'musinsa':'4910',kind,detail};
 delete x.L;
 x.b=raw.b||raw.m||(x.src==='4910'?'4910':'무신사');
 x.c=['top','outer','bottom','shoes','bag'].includes(raw.c)?raw.c:'etc';
 x.brandKey=brandKey(x.b);x._hay=brandKey([x.b,x.m,x.g,x.n].join(' '));x._init=x.b.trim().charAt(0).toUpperCase();
 const L=raw.L||[];x.tracked=L.length>0;
 Object.assign(x,{rate:-1,dropAmt:0,isOut:x.s==='SOLDOUT',isLow:false,my:null,sale:null,normal:null,newbie:null,coupon:0,couponName:null,lowMy:null,lowDate:null});
 if(!L.length)return x;
 const last=L.at(-1),prev=L.at(-2);
 Object.assign(x,{my:last[3],sale:last[2],normal:last[1],newbie:last[7]??null,isOut:last[4]===1||x.isOut,coupon:last[6]>0?last[6]:0,couponName:last[5]});
 x.rate=x.normal&&x.my!=null?Math.round((1-x.my/x.normal)*100):0;
 let first=null,moved=false;
 for(const r of L) {
 if(x.src==='4910'&&r[5]!==last[5])continue;
 if(r[3]!=null&&(x.lowMy==null||r[3]<x.lowMy)){x.lowMy=r[3];x.lowDate=r[0];}
 if(r[3]!=null){if(first==null)first=r[3];else if(first!==r[3])moved=true;}
 }
 x.isLow=x.lowMy!=null&&x.my!=null&&x.my<=x.lowMy&&(kind!=='scan'||moved);
 x.dropAmt=prev&&(x.src!=='4910'||prev[5]===last[5])&&prev[3]!=null&&x.my!=null&&x.my<prev[3]?prev[3]-x.my:0;
 return x;
 }
 function mergeSummaries(base,scan) {
 const map=new Map();
 for(const x of [...base,...scan])if(!map.has(x.k)||x.kind==='liked')map.set(x.k,x);
 return [...map.values()];
 }
 function restoreState(saved={}) {
 const src=saved.src==='4910all'?'4910':saved.src;
 const sort=({coupon:'priceAsc',couponRate:'rate'})[saved.sort]||saved.sort;
 return {q:String(saved.q||''),src:['all','musinsa','4910'].includes(src)?src:'all',cat:['all','top','outer','bottom','shoes','bag','etc'].includes(saved.cat)?saved.cat:'all',brandKeys:Array.isArray(saved.brandKeys)?saved.brandKeys.map(brandKey):[],filter:['all','lowest','drop','onsale','out'].includes(saved.filter)?saved.filter:'all',sort:['category','rate','priceAsc','priceDesc','dropAmt','brand','new'].includes(sort)?sort:'rate'};
 }
 const quickMatch=(x,f)=>f==='all'||(f==='lowest'?x.isLow:f==='drop'?x.dropAmt>0:f==='out'?x.isOut:!x.isOut);
 function queryCatalog(items,input) {
 const s=restoreState(input),q=brandKey(s.q),selected=new Set(s.brandKeys);
 const sources={all:0,musinsa:0,'4910':0},quick={all:0,lowest:0,drop:0,onsale:0,out:0},categories={all:0},brands=new Map(),result=[];
 for(const x of items){
 if(!brands.has(x.brandKey))brands.set(x.brandKey,{key:x.brandKey,label:x.b,count:0});
 if(q&&!x._hay.includes(q))continue;
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
 return {itemKey,resolveKey,brandKey,summarize,mergeSummaries,queryCatalog,restoreState};
}
