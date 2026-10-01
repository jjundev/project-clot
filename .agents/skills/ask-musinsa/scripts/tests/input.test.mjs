import test from 'node:test';
import assert from 'node:assert/strict';
import {goodsNo,searchUrl,validateOptions} from '../lib/input.mjs';
test('strict product identity',()=>{
  assert.equal(goodsNo('6596166'),6596166);
  assert.equal(goodsNo('https://www.musinsa.com/products/6596166?x=1'),6596166);
  for(const s of ['https://evil.test/products/6596166','https://x@www.musinsa.com/products/6596166','6596166abc','0'])
    assert.throws(()=>goodsNo(s),{code:'INVALID_ARGUMENT'});
});
test('filters and encoding preserved',()=>{
  const u=new URL(searchUrl('티셔츠 & 셔츠',{size:'M,L',measure:'기장:70-75,가슴:55-60',sort:'price_low'}));
  assert.equal(u.pathname,'/search/goods');
  assert.equal(u.searchParams.get('keyword'),'티셔츠 & 셔츠');
  assert.equal(u.searchParams.get('sortCode'),'PRICE_LOW');
  assert.equal(u.searchParams.get('standardSize'),'M,L');
  assert.equal(u.searchParams.get('measurement'),'총장^70^75,가슴단면^55^60');
});
test('invalid pieces never disappear',()=>{
  for(const o of [{size:'M,banana'},{measure:'총장:70-75,오타:1-2'},{sort:'unknown'},{limit:'2x'},{'is-used':'maybe'},{'my-size':'top'}])
    assert.throws(()=>validateOptions('search',o),{code:'INVALID_ARGUMENT'});
});
test('legacy size and range cases',()=>{
  const get=o=>new URL(searchUrl('셔츠',o)).searchParams;
  assert.equal(get({size:'270'}).get('shoeSizeOption'),'270');
  assert.equal(get({'shoe-size':'270mm'}).get('shoeSizeOption'),'270');
  assert.equal(get({size:'2XL'}).get('standardSize'),'XXL');
  assert.equal(get({measure:'총장:75-70'}).get('measurement'),'총장^70^75');
  assert.equal(get({measure:'총장:70.4-75.6'}).get('measurement'),'총장^70^76');
  assert.equal(get({size:'270','shoe-size':'275'}).get('shoeSizeOption'),'270');
  assert.throws(()=>searchUrl('   '),{code:'INVALID_ARGUMENT'});
});

test('mixed size categories and prototype keys never reach the network',()=>{
  for(const options of [{size:'M,270'},{size:'M,__proto__'},{size:'constructor'},
    {measure:'총장:70-75,constructor:1-2'},{measure:'__proto__:1-2'}])
    assert.throws(()=>searchUrl('셔츠',options),{code:'INVALID_ARGUMENT'});
});

test('prototype property names are not supported filter aliases',()=>{
  assert.throws(()=>searchUrl('셔츠',{measure:'총장:70-75,constructor:1-2'}),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>searchUrl('셔츠',{size:'M,__proto__'}),{code:'INVALID_ARGUMENT'});
});
