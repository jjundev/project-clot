import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {run} from '../musinsa.mjs';
test('unknown option does not fetch',async()=>{
  const r=await run(['search','셔츠','--oops','1'],{fetchImpl:async()=>assert.fail('no fetch')});
  assert.equal(r.exitCode,2);assert.equal(r.result.error.code,'INVALID_ARGUMENT');
});
test('is-used false is not truthy',async()=>{
  const result=await run(['search','셔츠','--is-used','false'],{fetchImpl:async u=>{
    assert.equal(new URL(u).searchParams.get('isUsed'),'false');
    return new Response(`<script id="__NEXT_DATA__">${JSON.stringify({props:{pageProps:{dehydratedState:{queries:[{queryKey:['search','goods',{keyword:'셔츠',page:'1',sortCode:'POPULAR',gf:'A',isUsed:false}],state:{data:{pages:[{items:[]}]}}}]}}}})}</script>`);
  }});
  assert.equal(result.exitCode,0);assert.deepEqual(result.result.data,[]);
});
test('help usable as subprocess',()=>{
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('../musinsa.mjs',import.meta.url)),'--help'],{encoding:'utf8'});
  assert.equal(r.status,0);assert.match(r.stdout,/search/);assert.match(r.stdout,/recommend/);
});

test('entrypoint works through a skill discovery symlink',async()=>{
  const {mkdtempSync,symlinkSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const directory=mkdtempSync(join(tmpdir(),'musinsa-link-'));
  try {
    const alias=join(directory,'musinsa.mjs');
    symlinkSync(fileURLToPath(new URL('../musinsa.mjs',import.meta.url)),alias);
    const r=spawnSync(process.execPath,[alias,'--help'],{encoding:'utf8'});
    assert.equal(r.status,0);assert.match(r.stdout,/search/);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
test('invalid positionals and filters use exit 2, HTTP errors use exit 1',async()=>{
  for(const args of [[],['orders'],['recommend','extra'],['product','12','--limit','1'],['search','셔츠','--size','M,typo']]) {
    const r=await run(args,{fetchImpl:async()=>assert.fail('no fetch')});
    assert.equal(r.exitCode,2);assert.equal(r.result.status,'error');
  }
  const r=await run(['product','12'],{fetchImpl:async()=>new Response('',{status:403})});
  assert.equal(r.exitCode,1);assert.equal(r.result.error.code,'ACCESS_DENIED');
});
