import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSearch,parseProduct} from '../lib/parsers.mjs';
const html=queries=>`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{dehydratedState:{queries}}}})}</script>`;
test('empty search is valid, missing shape is not',()=>{
  assert.deepEqual(parseSearch(html([{queryKey:['search','goods'],state:{data:{pages:[{items:[]}]}}}])),[]);
  assert.throws(()=>parseSearch(html([])),{code:'SCHEMA_CHANGED'});
  assert.throws(()=>parseSearch('<html>login</html>'),{code:'SCHEMA_CHANGED'});
});
test('product preserves 0 and unknown',()=>{
  const rows=parseProduct(html([{queryKey:['Detail',12],state:{data:{data:{goodsNm:'셔츠',goodsPrice:{salePrice:19900},goodsReview:{totalCount:0}}}}}]),12);
  assert.equal(rows[0].price,19900);assert.equal(rows[0].reviews,0);
  assert.equal(rows[0].rating,null);assert.equal(rows[0].soldOut,null);
  assert.throws(()=>parseProduct(html([]),12),{code:'SCHEMA_CHANGED'});
});
test('search limit, identity and malformed JSON',()=>{
  const query=items=>html([{queryKey:['search','goods'],state:{data:{pages:[{items}]}}}]);
  const rows=parseSearch(query([{goodsNo:1,goodsName:'a',price:0},{goodsNo:2,goodsName:'b'}]),{limit:1});
  assert.equal(rows.length,1);assert.equal(rows[0].price,0);
  assert.throws(()=>parseSearch(query([{goodsNo:1}])),{code:'SCHEMA_CHANGED'});
  assert.throws(()=>parseSearch('<script id="__NEXT_DATA__">broken</script>'),{code:'SCHEMA_CHANGED'});
  assert.throws(()=>parseProduct(html([{queryKey:['Detail',13],state:{data:{data:{goodsNm:'a'}}}}]),12),{code:'SCHEMA_CHANGED'});
});

test('product descriptive fields survive normalization',()=>{
  const d={goodsNm:'  셔츠  ',goodsPrice:{normalPrice:19900,finalPrice:19900,finalDiscount:0},
    category:{categoryDepth1Title:'상의',categoryDepth2Title:'셔츠'},seasonYear:2026,season:'가을',
    goodsMaterial:{materials:[{name:'핏',items:[{isSelected:true,name:'레귤러|핏'},{isSelected:false,name:'슬림'}]}]},
    deliveryExpectedArrival:{arrivalText:'금요일 도착'},goodsReview:{satisfactionScore:4.8,totalCount:10},isSoldOut:false};
  const r=parseProduct(html([{queryKey:['Detail',12],state:{data:{data:d}}}]),12)[0];
  assert.equal(r.features,'핏: 레귤러핏');assert.equal(r.category,'상의 > 셔츠');
  assert.equal(r.delivery,'금요일 도착');assert.equal(r.season,'2026 가을');
  assert.equal(r.normalPrice,19900);assert.equal(r.soldOut,false);
});
test('malformed optional collections produce a schema error',()=>{
  for(const goodsMaterial of [{materials:{}},{materials:[{name:'핏',items:{}}]}]) {
    const d={goodsNm:'셔츠',goodsMaterial};
    assert.throws(()=>parseProduct(html([{queryKey:['Detail',12],state:{data:{data:d}}}]),12),{code:'SCHEMA_CHANGED'});
  }
});

test('specific login evidence differs from unrecognized HTML',()=>{
  for(const page of [
    '<form action="/auth/login"><input type="password"></form>',
    '<script id="__NEXT_DATA__">{"page":"/auth/login","props":{}}</script>'
  ]) assert.throws(()=>parseSearch(page),{code:'AUTH_REQUIRED'});
  assert.throws(()=>parseSearch('<html><h1>login help</h1></html>'),{code:'SCHEMA_CHANGED'});
});
test('rank is page-local and independent of local output limit',()=>{
  const source=html([{queryKey:['search','goods'],state:{data:{pages:[{items:[
    {goodsNo:1,goodsName:'a'},{goodsNo:2,goodsName:'b'}
  ]}]}}}]);
  assert.equal(parseSearch(source,{page:2,limit:1})[0].rank,1);
  assert.equal(parseSearch(source,{page:2,limit:20})[0].rank,1);
  assert.equal(parseSearch(source,{page:2,limit:20})[1].rank,2);
});

test('requested criteria cannot silently change in server-rendered search',()=>{
  const source=html([{queryKey:['search','goods',{keyword:'셔츠',isUsed:false}],state:{data:{pages:[{items:[]}]}}}]);
  assert.throws(()=>parseSearch(source,{expectedCriteria:{isUsed:'true'}}),{code:'FILTER_NOT_APPLIED'});
});
