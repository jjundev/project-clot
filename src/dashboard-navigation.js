/** URL/history only; serializable into the standalone dashboard. */
export function createDashboardNavigation({window:win,model,onRoute}) {
 const session=String(Date.now())+':'+Math.random().toString(36).slice(2);
 let current={type:'catalog'},ownedDetail=false,started=false;
 function read(){
  const url=new URL(win.location.href);
  if(!url.searchParams.has('goods'))return {type:'catalog'};
  const parsed=model.parseSearchInput(url.searchParams.get('goods'));
  return parsed.type==='product'?{type:'detail',key:parsed.key,brand:url.searchParams.get('brand')}:{type:'invalid',message:parsed.message||'올바른 상품번호를 입력해 주세요'};
 }
 function emit(route){current=route;onRoute(route);}
 function write(route,push,owned){
  const url=new URL(win.location.href);url.searchParams.delete('goods');url.searchParams.delete('brand');
  if(route.type==='detail'){url.searchParams.set('goods',route.key);if(route.brand)url.searchParams.set('brand',route.brand);}
  const prior=win.history.state;
  const state={...(prior&&typeof prior==='object'?prior:{}),__clotNavigation:{session,owned}};
  try{win.history[push?'pushState':'replaceState'](state,'',url.href);return true;}catch{return false;}
 }
 function pop(){const marker=win.history.state?.__clotNavigation;ownedDetail=marker?.session===session&&marker.owned===true;emit(read());}
 function detail({key,brand=null}){const parsed=model.parseSearchInput(key);return parsed.type==='product'?{type:'detail',key:parsed.key,brand:brand==null?null:String(brand)}:{type:'invalid',message:parsed.message||'올바른 상품번호를 입력해 주세요'};}
 function open(input){const route=detail(input);if(route.type!=='detail'){emit(route);return;}
  const push=current.type==='catalog';const owned=push||ownedDetail;
  ownedDetail=write(route,push,owned)&&owned;emit(route);
 }
 function replace(input){const route=detail(input);if(route.type==='detail')ownedDetail=write(route,false,ownedDetail)&&ownedDetail;emit(route);}
 function backToList(){
  if(ownedDetail){try{win.history.back();return;}catch{}}
  ownedDetail=false;write({type:'catalog'},false,false);emit({type:'catalog'});
 }
 return {start(){if(started)return;started=true;win.addEventListener('popstate',pop);emit(read());},open,replace,backToList,dispose(){win.removeEventListener('popstate',pop);started=false;}};
}
