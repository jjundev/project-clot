import {request,requestJson} from './http.mjs';
import {envelope} from './result.mjs';
import {goodsNo,validateOptions,searchUrl} from './input.mjs';
import {parseSearch,parseProduct,parseRecommend,parseOptions,mergeInventory} from './parsers.mjs';
const time=deps=>(deps.clock??(()=>new Date().toISOString()))();
export async function search(query,options={},deps={}) {
  const o=validateOptions('search',options),url=searchUrl(query,o);
  return envelope(parseSearch(await request(url,deps),{...o,expectedCriteria:Object.fromEntries(new URL(url).searchParams)}),[],[url],time(deps));
}
export async function product(input,options={},deps={}) {
  validateOptions('product',options);
  const id=goodsNo(input),url=`https://www.musinsa.com/products/${id}`;
  return envelope(parseProduct(await request(url,deps),id),[],[url],time(deps));
}
export async function recommend(options={},deps={}) {
  const o=validateOptions('recommend',options);
  const u=new URL('https://api.musinsa.com/api2/hm/web/v14/pans/recommend');
  u.search=new URLSearchParams({storeCode:o.store,gf:o.gender});
  return envelope(parseRecommend(await requestJson(u.href,deps),o.limit),[],[u.href],time(deps));
}

export async function options(input,opts={},deps={}) {
  validateOptions('options',opts);const id=goodsNo(input);
  const url=`https://goods-detail.musinsa.com/api2/goods/${id}/options`;
  const {rows,valueNos}=parseOptions(await requestJson(url,deps),id);
  if(!rows.length) return envelope([],[],[url],time(deps));
  const inventoryUrl=`${url}/v2/prioritized-inventories`;
  let merged;
  try {
    merged=mergeInventory(rows,await requestJson(inventoryUrl,{
      ...deps,method:'POST',body:JSON.stringify({optionValueNos:valueNos})
    }));
  } catch(error) {
    merged={data:rows,warnings:[{code:'INVENTORY_UNAVAILABLE',message:'재고 조회 실패',cause:error.code??'HTTP_ERROR'}]};
  }
  return envelope(merged.data,merged.warnings,[url,inventoryUrl],time(deps));
}
