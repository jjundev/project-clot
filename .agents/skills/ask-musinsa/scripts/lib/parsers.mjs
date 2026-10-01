import {isLoginHtml} from './html.mjs';
import {fail,numberOrNull as num,booleanOrNull as bool} from './result.mjs';
const text=v=>v==null||!String(v).trim()?null:String(v).trim().replace(/\s+/g,' ');
const schema=()=>{throw fail('SCHEMA_CHANGED','예상 데이터 구조 없음');};
const array=v=>v==null?[]:Array.isArray(v)?v:schema();
const object=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:schema();
export function nextQueries(html) {
  if(isLoginHtml(html)) throw fail('AUTH_REQUIRED','로그인 페이지 응답');
  const m=html.match(/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/);
  if(!m) return schema();
  let j;try {j=JSON.parse(m[1]);}catch{return schema();}
  const q=j?.props?.pageProps?.dehydratedState?.queries;
  if(!Array.isArray(q)) return schema();return q;
}
function row(id,name,brand,price,normalPrice,discount,rating,reviews,soldOut) {
  if(!Number.isSafeInteger(Number(id))||Number(id)<1||!text(name)) return schema();
  return {goodsNo:Number(id),goodsName:text(name),brand:text(brand),price:num(price),normalPrice:num(normalPrice),
    discount:num(discount),rating:num(rating),reviews:num(reviews),soldOut:bool(soldOut),url:`https://www.musinsa.com/products/${Number(id)}`};
}
export function parseSearch(html,{page=1,limit=20,expectedCriteria}={}) {
  const q=nextQueries(html).find(q=>q?.queryKey?.[0]==='search'&&q.queryKey?.[1]==='goods');
  if(expectedCriteria) {
    const applied=q?.queryKey?.[2];
    if(!applied||typeof applied!=='object'||Array.isArray(applied)) return schema();
    for(const [key,value] of Object.entries(expectedCriteria))
      if(String(applied[key])!==String(value)) throw fail('FILTER_NOT_APPLIED',`${key} 요청 조건이 서버 결과에 적용되지 않았습니다`);
  }
  const items=q?.state?.data?.pages?.[0]?.items;
  if(!Array.isArray(items)) return schema();
  return items.slice(0,limit).map((x,i)=>({...row(object(x).goodsNo,x.goodsName,x.brandName,
    x.finalPrice??x.price,x.normalPrice,x.finalDiscount??x.saleRate,x.reviewScore,x.reviewCount,x.isSoldOut),rank:i+1}));
}
export function parseProduct(html,id) {
  const d=nextQueries(html).find(q=>q?.queryKey?.[0]==='Detail'&&Number(q.queryKey?.[1])===id)?.state?.data?.data;
  if(!d||typeof d!=='object'||Array.isArray(d)) return schema();
  const p=d.goodsPrice??{},r=d.goodsReview??{};
  const features=array(d.goodsMaterial?.materials).map(m=>{
    object(m);
    const chosen=array(m.items).filter(x=>object(x).isSelected).map(x=>text(x.name)?.replace(/\|/g,''));
    return chosen.length?`${m.name}: ${chosen.join(', ')}`:null;
  }).filter(Boolean).join(' | ');
  return [{...row(id,d.goodsNm,d.brandInfo?.brandName??d.brand,p.finalPrice??p.salePrice??p.normalPrice,
    p.normalPrice,p.finalDiscount??p.discountRate,r.satisfactionScore,r.totalCount,d.isSoldOut),
    category:text([d.category?.categoryDepth1Title,d.category?.categoryDepth2Title].filter(Boolean).join(' > ')),
    features:text(features),season:text([d.seasonYear,d.season].filter(Boolean).join(' ')),
    delivery:text(d.deliveryExpectedArrival?.arrivalText)}];
}

export function parseRecommend(json,limit=20) {
  const modules=json?.data?.modules;if(!Array.isArray(modules)) return schema();
  const rows=[];
  for(const module of modules) {
    object(module);
    if(module.items===undefined&&['QUICKMENU','QUICKMENU_HIGHLIGHT','QUICKMENU_ONEROW','BANNER_PROMOTION','BANNER_BIG_PROMOTION'].includes(module.type)) continue;
    let items=module.items;
    if(items===undefined&&module.type==='CAROUSEL_TWOROW_TAB') {
      if(!Array.isArray(module.tabs)) return schema();
      const tab=module.tabs.find(tab=>tab?.key===module.defaultTabKey)??module.tabs[0];
      items=tab?.items;
    }
    if(!Array.isArray(items)) return schema();
    for(const item of items) {
      object(item);
      const ga=item.onClick?.eventLog?.ga4?.payload??item.impressionEventLog?.ga4?.payload??{};
      const info=item.info??{};
      let id=info.productId??item.onClick?.productId??ga.item_id;
      if(id==null&&item.onClick?.url) {
        try {
          const url=new URL(item.onClick.url);
          if(url.protocol==='https:'&&url.hostname==='www.musinsa.com'&&!url.username&&!url.password&&!url.port)
            id=url.pathname.match(/^\/products\/(\d+)\/?$/)?.[1];
        } catch {}
      }
      const name=info.productName??ga.item_name??info.title?.text;
      // 모듈에 상품 외 배너도 섞인다. 상품 ID가 없는 항목은 배너로 제외한다.
      if(id==null) {
        if(info.productName||ga.item_name) return schema();
        continue;
      }
      rows.push(row(id,name,info.brandName??ga.brand_name??ga.item_brand,
        info.finalPrice??ga.price??ga.best_price,info.originalPrice??ga.original_price,
        info.discountRatio??ga.discount_rate,null,null,info.isSoldOut));
    }
  }
  return rows.slice(0,limit).map((x,i)=>({...x,rank:i+1}));
}

export function parseOptions(json,id) {
  const d=json?.data;if(!Array.isArray(d?.optionItems)||!Array.isArray(d?.basic)) return schema();
  const names=new Map(d.basic.flatMap(g=>array(object(g).optionValues).map(v=>[object(v).no,v.name])));
  const valueNos=new Set();
  const rows=d.optionItems.map(item=>{
    object(item);
    if(!Number.isSafeInteger(item.no)||!Array.isArray(item.optionValueNos)) return schema();
    item.optionValueNos.forEach(v=>valueNos.add(v));
    if(item.optionValueNos.some(v=>!Number.isSafeInteger(v)||!text(names.get(v)))) return schema();
    const size=item.optionValueNos.map(v=>text(names.get(v))).join(' / ')||text(item.managedCode);
    if(!size) return schema();
    return {goodsNo:id,variantId:item.no,size,activated:bool(item.activated),soldOut:null,
      remain:null,priceExtra:num(item.price),delivery:null};
  });
  return {rows,valueNos:[...valueNos]};
}
export function mergeInventory(rows,json) {
  if(!Array.isArray(json?.data)) return schema();
  const map=new Map(json.data.map(x=>[x.productVariantId,x]));const warnings=[];
  const data=rows.map(row=>{
    const inv=map.get(row.variantId);
    if(!inv||typeof inv.outOfStock!=='boolean') {
      warnings.push({code:'INVENTORY_MISSING',message:'옵션 재고 미확인',variantId:row.variantId});return row;
    }
    return {...row,soldOut:inv.outOfStock,remain:num(inv.remainQuantity),delivery:text(inv.domesticDelivery?.guideWillReleaseAtText)};
  });
  return {data,warnings};
}
