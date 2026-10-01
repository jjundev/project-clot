import test from 'node:test';
import assert from 'node:assert/strict';
import {request,requestJson} from '../lib/http.mjs';
import {numberOrNull,booleanOrNull,envelope} from '../lib/result.mjs';

test('unknown stays null',()=>{
  assert.equal(numberOrNull(''),null);
  assert.equal(numberOrNull(undefined),null);
  assert.equal(numberOrNull('19900'),19900);
  assert.equal(booleanOrNull(undefined),null);
  assert.equal(envelope([],[],[],'2026-10-01T00:00:00Z').status,'ok');
});
test('429 HTTP date retries without cookies',async()=>{
  let calls=0; const waits=[];
  const value=await request('https://api.musinsa.com/test',{
    now:()=>Date.parse('2026-10-01T00:00:00Z'),
    sleepImpl:async ms=>waits.push(ms),
    fetchImpl:async(url,options)=>{
      assert.equal(options.redirect,'manual');
      assert.equal(options.headers.Cookie,undefined);
      return ++calls===1
        ? new Response('',{status:429,headers:{'Retry-After':'Thu, 01 Oct 2026 00:00:02 GMT'}})
        : new Response('yes');
    }
  });
  assert.equal(value,'yes'); assert.deepEqual(waits,[2000]);
});
test('long retry-after fails without waiting',async()=>{
  await assert.rejects(request('https://api.musinsa.com/test',{
    sleepImpl:async()=>assert.fail('must not sleep'),
    fetchImpl:async()=>new Response('',{status:429,headers:{'Retry-After':'120'}})
  }),{code:'RATE_LIMITED'});
});
test('timeouts bounded to three attempts',async()=>{
  let count=0;
  await assert.rejects(request('https://api.musinsa.com/test',{
    sleepImpl:async()=>{},fetchImpl:async()=>{
      count++; throw Object.assign(new Error('timeout'),{name:'TimeoutError'});
    }
  }),{code:'TIMEOUT'});
  assert.equal(count,3);
});
test('login redirect and malformed JSON are distinct',async()=>{
  await assert.rejects(request('https://www.musinsa.com/test',{
    fetchImpl:async()=>new Response('',{status:302,headers:{Location:'/auth/login'}})
  }),{code:'AUTH_REQUIRED'});
  await assert.rejects(requestJson('https://api.musinsa.com/test',{
    fetchImpl:async()=>new Response('<html>broken</html>')
  }),{code:'SCHEMA_CHANGED'});
});
test('body timeout has the same bounded contract',async()=>{
  let calls=0;
  await assert.rejects(request('https://api.musinsa.com/test',{
    sleepImpl:async()=>{},fetchImpl:async()=>{
      calls++;return {text:async()=>{throw Object.assign(new Error('body timeout'),{name:'TimeoutError'});}};
    }
  }),{code:'TIMEOUT'});
  assert.equal(calls,3);
});

test('transport rejects malformed URLs and inventory POST on wrong host',async()=>{
  for(const url of ['not a URL','https://evil.test/test','https://api.musinsa.com/api2/goods/12/options/v2/prioritized-inventories']) {
    await assert.rejects(request(url,{method:'POST',fetchImpl:async()=>assert.fail('no fetch')}),{code:'INVALID_ARGUMENT'});
  }
});
test('HTTP failures, redirects and retryable upstream failures',async()=>{
  for(const [status,headers,code] of [[302,{Location:'/other'},'REDIRECT'],[403,{},'ACCESS_DENIED'],[404,{},'HTTP_ERROR']]) {
    let calls=0;
    await assert.rejects(request('https://api.musinsa.com/test',{fetchImpl:async()=>{calls++;return new Response('',{status,headers});}}),{code});
    assert.equal(calls,1);
  }
  let calls=0;
  assert.equal(await request('https://api.musinsa.com/test',{sleepImpl:async()=>{},fetchImpl:async()=>++calls<3?new Response('',{status:503}):new Response('ok')}),'ok');
  assert.equal(calls,3);
});
test('timeout covers an actual slow response body',async()=>{
  let count=0;
  await assert.rejects(request('https://api.musinsa.com/test',{timeoutMs:5,sleepImpl:async()=>{},fetchImpl:async(u,o)=>{
    count++;
    return {text:()=>new Promise((resolve,reject)=>{
      const keepAlive=setTimeout(()=>resolve('too late'),100);
      o.signal.addEventListener('abort',()=>{clearTimeout(keepAlive);reject(o.signal.reason);},{once:true});
    })};
  }}),{code:'TIMEOUT'});
  assert.equal(count,3);
});

test('API login HTML is classified as authentication instead of broken JSON',async()=>{
  await assert.rejects(requestJson('https://api.musinsa.com/test',{
    fetchImpl:async()=>new Response('<form action="/auth/login"><input type="password"></form>')
  }),{code:'AUTH_REQUIRED'});
});
