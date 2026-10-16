import './setup-env.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('actual history table renderer never labels missing prices lowest or unchanged',()=>{
  const html=fs.readFileSync(new URL('../src/dashboard.template.html',import.meta.url),'utf8');
  const fn=html.match(/  function fillTable\(it\) \{[\s\S]*?\n  \}/)[0];
  const target={innerHTML:''};
  const context={document:{getElementById:()=>target},slice:it=>it.L,is4910:()=>true,won:n=>n==null?'—':String(n)};
  vm.createContext(context);vm.runInContext(fn,context);
  context.fillTable({tracked:true,lowMy:null,couponName:'가격 재검증 필요',L:[['2026-10-14',null,null,null,0,'가격 재검증 필요'],['2026-10-15',null,null,null,0,'가격 재검증 필요']]});
  assert.ok(!target.innerHTML.includes('최저가'));assert.ok(!target.innerHTML.includes('변동 없음'));
  assert.ok(target.innerHTML.includes('가격 재검증 필요'));
});
