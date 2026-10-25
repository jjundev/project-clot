export const row = (p, day='2026-10-16', basis='회원가', out=0) => [day,200,p,p,out,basis,0];
export function fixtureRaw() {
 const item=(n,src,b,c,L)=>({n,k:src==='musinsa'?String(n):'4910:'+n,src,b,c,g:b+' 상품 '+n,u:'',i:'',s:'ACTIVE',fs:'2026-10-01',L,tracking:freshTracking(L.at(-1)?.[3],L.at(-1)?.[5],{previous:L.at(-2)?.[3]??L.at(-1)?.[3]})});
 return [
 item(1,'musinsa','나이키','shoes',[row(90,'2026-10-15'),row(100)]),
 item(2,'musinsa','아디다스','top',[row(100,'2026-10-15'),row(80)]),
 item(1,'4910','나이키','shoes',[row(100,'2026-10-15'),row(90)]),
 item(3,'4910all','나이키','top',[row(120)]),
 item(4,'4910','GU','outer',[row(80,undefined,undefined,1)])];
}
export const defaultState={q:'',src:'all',cat:'all',brandKeys:[],filter:'all',sort:'rate'};

// Old change-only history can coexist with a recent, unchanged actual observation.
export function freshTracking(price,basis='회원가',{previous=price,at=Date.now(),status='ACTIVE'}={}) {
 const current=new Date(at-3600000).toISOString(),prior=new Date(at-25*3600000).toISOString();
 return {status,seenAt:current,saleAt:current,samples:[
  {date:prior.slice(0,10),at:prior,price:previous,basis},
  {date:current.slice(0,10),at:current,price,basis},
 ]};
}
