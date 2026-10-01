import test from 'node:test';
import assert from 'node:assert/strict';
import {recommend,product} from '../lib/commands.mjs';
import {parseRecommend} from '../lib/parsers.mjs';
test('recommend valid empty and data',()=>{
  assert.deepEqual(parseRecommend({data:{modules:[]}}),[]);
  assert.throws(()=>parseRecommend({data:{}}),{code:'SCHEMA_CHANGED'});
  const rows=parseRecommend({data:{modules:[{items:[{info:{productId:12,productName:'셔츠',finalPrice:19900}}]}]}});
  assert.equal(rows[0].goodsNo,12);assert.equal(rows[0].price,19900);
  assert.equal(rows[0].rating,null);
});
test('recommend request and time envelope',async()=>{
  const r=await recommend({gender:'F',limit:1},{clock:()=> '2026-10-01T00:00:00Z',fetchImpl:async u=>{
    assert.equal(new URL(u).searchParams.get('gf'),'F');
    return Response.json({data:{modules:[]}});
  }});
  assert.equal(r.status,'ok');assert.equal(r.fetchedAt,'2026-10-01T00:00:00Z');
});
test('product bad input never requests',async()=>{
  await assert.rejects(product('https://evil.test/products/12',{}, {fetchImpl:async()=>assert.fail('no fetch')}),{code:'INVALID_ARGUMENT'});
});
test('known non-product modules do not break recommendations',()=>{
  assert.deepEqual(parseRecommend({data:{modules:[{type:'QUICKMENU_HIGHLIGHT',menus:[]},{type:'BANNER_BIG_PROMOTION',bannerBigPromotion:{}}]}}),[]);
  assert.throws(()=>parseRecommend({data:{modules:[{type:'CAROUSEL_ONEROW'}]}}),{code:'SCHEMA_CHANGED'});
});

test('recommend mixed banner and product payload, missing identity is error',()=>{
  const modules=[{type:'BANNER_MAIN',items:[{id:'banner1',info:{title:{text:'배너'}},onClick:{url:'https://www.musinsa.com/brand/x'}}]},
    {type:'CAROUSEL_ONEROW',items:[{info:{productName:'셔츠',finalPrice:19900},onClick:{url:'https://www.musinsa.com/products/12'}}]}];
  assert.equal(parseRecommend({data:{modules}})[0].goodsNo,12);
  assert.throws(()=>parseRecommend({data:{modules:[{items:[{info:{productName:'셔츠',finalPrice:19900}}]}]}}),{code:'SCHEMA_CHANGED'});
});

test('recommend extra banners, quick menu, and default-tab products',()=>{
  const json={data:{modules:[
    {type:'QUICKMENU',menus:[]},{type:'BANNER_PROMOTION',imageUrl:'x',onClick:{url:'/event'}},
    {type:'CAROUSEL_TWOROW_TAB',defaultTabKey:'best',tabs:[
      {key:'best',items:[{info:{productId:12,productName:'셔츠',finalPrice:19900}}]},
      {key:'other',items:[{info:{productId:13,productName:'바지',finalPrice:29000}}]}
    ]}
  ]}};
  assert.deepEqual(parseRecommend(json).map(x=>x.goodsNo),[12]);
});
