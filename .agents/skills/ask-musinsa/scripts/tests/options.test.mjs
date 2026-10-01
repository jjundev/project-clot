import test from 'node:test';
import assert from 'node:assert/strict';
import {options} from '../lib/commands.mjs';
const fixture={data:{basic:[{optionValues:[{no:1,name:'M'},{no:2,name:'L'}]}],optionItems:[
  {no:10,optionValueNos:[1],activated:true,price:0},
  {no:11,optionValueNos:[2],activated:false,price:1000}
]}};
test('missing inventory does not infer stock',async()=>{
  const r=await options('12',{}, {fetchImpl:async(u,o)=>o.method==='POST'
    ?Response.json({data:[{productVariantId:10,outOfStock:true,remainQuantity:0}]})
    :Response.json(fixture)});
  assert.equal(r.status,'partial');assert.equal(r.data[0].soldOut,true);
  assert.equal(r.data[0].remain,0);assert.equal(r.data[1].soldOut,null);
  assert.equal(r.warnings[0].code,'INVENTORY_MISSING');
});
test('inventory failure preserves option data',async()=>{
  const r=await options('12',{}, {fetchImpl:async(u,o)=>o.method==='POST'
    ?new Response('',{status:403}):Response.json(fixture)});
  assert.equal(r.status,'partial');assert.equal(r.data.length,2);
  assert.equal(r.data[0].soldOut,null);assert.equal(r.data[0].activated,true);
  assert.equal(r.warnings[0].code,'INVENTORY_UNAVAILABLE');
});
test('unknown option value is a schema error',async()=>{
  const bad={data:{basic:[],optionItems:[{no:10,optionValueNos:[999],activated:true}]}};
  await assert.rejects(options('12',{}, {fetchImpl:async()=>Response.json(bad)}),{code:'SCHEMA_CHANGED'});
});
test('inventory body deduplicates and full inventory succeeds',async()=>{
  const r=await options('12',{}, {fetchImpl:async(u,o)=>{
    if(o.method!=='POST') return Response.json(fixture);
    assert.deepEqual(JSON.parse(o.body),{optionValueNos:[1,2]});
    return Response.json({data:[{productVariantId:10,outOfStock:false},{productVariantId:11,outOfStock:true}]});
  }});
  assert.equal(r.status,'ok');assert.equal(r.data[0].soldOut,false);
});
test('empty options requires no inventory request',async()=>{
  let calls=0;
  const r=await options('12',{}, {fetchImpl:async()=>{calls++;return Response.json({data:{basic:[],optionItems:[]}});}});
  assert.equal(calls,1);assert.equal(r.status,'ok');assert.deepEqual(r.data,[]);
});

test('schema errors never masquerade as empty option lists',async()=>{
  for(const data of [{},{basic:[],optionItems:[{no:'10',optionValueNos:[1]}]},
    {basic:[{optionValues:{}}],optionItems:[]},
    {basic:[],optionItems:[{no:10,optionValueNos:['1']}]}])
    await assert.rejects(options('12',{}, {fetchImpl:async()=>Response.json({data})}),{code:'SCHEMA_CHANGED'});
});
test('shared values are posted once across variants',async()=>{
  const repeated=structuredClone(fixture);
  repeated.data.optionItems[1].optionValueNos=[1];
  await options('12',{}, {fetchImpl:async(u,o)=>{
    if(o.method!=='POST') return Response.json(repeated);
    assert.deepEqual(JSON.parse(o.body),{optionValueNos:[1]});
    return Response.json({data:[]});
  }});
});
