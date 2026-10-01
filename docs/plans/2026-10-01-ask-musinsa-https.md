# ask-musinsa 공개 조회 HTTPS 전환 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** ask-musinsa의 공개 조회 4개를 OpenCLI 없이 실행하고 기존 계정·이미지·후기 기능을 보존한다.

**Architecture:** 스킬 내부에 Node.js 명령 실행기를 둔다. HTTP와 순수 파서/필터를 분리하고, 4개 명령은 같은 결과 계약을 사용한다. 계정 6개 명령과 이미지·후기는 기존 경로로 유지한다.

**Tech Stack:** Node.js 22+, ES modules, fetch, node:test, node:assert/strict, node:util.parseArgs. 추가 npm 패키지 없음.

**Spec:** `/Users/hyunjun_macbook_pro/Documents/Private/project-clot/docs/specs/2026-10-01-ask-musinsa-https.md`

## Global Constraints

- 런타임은 Node.js 22 이상, ES modules(.mjs), 추가 npm 의존성 없음.
- 공개 실행기는 OpenCLI 패키지, 전역 어댑터 파일, 브라우저, 계정 쿠키에 의존하지 않는다.
- 원본은 `.agents/skills/ask-musinsa/`, `.claude/skills/ask-musinsa` 심볼릭 링크를 유지한다.
- 사용자 계정 요청, 구매, 장바구니, 좋아요 변경, 리뷰 작성은 공개 실행기에 추가하지 않는다.
- 원본 OpenCLI 어댑터는 수정하지 않는다. 파서·필터 이식의 출처를 문서에 남긴다.
- JSON은 `{status,data,warnings,sourceUrls,fetchedAt,error?}` 형식이다.
- status는 ok, partial, error다. 정상 빈 목록은 ok/data:[], 응답 구조 누락은 SCHEMA_CHANGED다.
- 가격·치수·개수·평점은 숫자, 미확인은 null이다. 원화 문자열·하이픈·추정 기본값을 데이터에 넣지 않는다.
- 모든 결과의 fetchedAt은 UTC ISO-8601이며, 사용자 답변은 Asia/Seoul 시점으로 표시한다.
- 옵션 활성 여부는 실제 재고가 아니다. 재고 응답이 없거나 개별 옵션 재고가 누락되면 그 옵션의 재고는 null이다.
- 시간 제한은 시도마다 15초, 재시도는 최대 2회다. 네트워크 오류·429·502/503/504만 재시도한다.
- Retry-After는 초 또는 HTTP 날짜를 처리한다. 대기 시간이 30초를 넘으면 RATE_LIMITED로 종료한다.
- HTTP 리다이렉트는 자동 추적하지 않는다. 로그인 경로는 AUTH_REQUIRED, 나머지는 REDIRECT 오류다.
- 상세 이미지·후기 본문·현재 상품 실측은 기존 브라우저 판독 경로를 유지한다.

## Review Focus

1. 조회 URL처럼 생긴 외부 주소·사용자정보 포함 URL·잘못된 명령 옵션은 네트워크 요청 전에 거부한다 — Task 2, 6.
2. 잘못된 필터가 정상 필터와 섞여도 조용히 제거하지 않고 전체 입력 오류를 알린다 — Task 2.
3. 옵션 활성 상태와 실제 재고 응답이 다르거나 일부 재고 행이 없어도 재고를 추정하지 않는다 — Task 5.
4. 정상 빈 검색, 응답 구조 변경, 로그인 HTML을 서로 다른 결과로 알린다 — Task 1, 3.
5. 429의 HTTP 날짜 형식, 과도한 대기 시간, 반복 시간 초과에도 무한 재시도하거나 성공으로 표시하지 않는다 — Task 1.

---

## 작업 위치와 파일 구조

모든 경로는 저장소 `/Users/hyunjun_macbook_pro/Documents/Private/project-clot` 기준이다. 아래 쉘 블록은 이 루트에서 실행한다.
구현 시작 시 using-git-worktrees 지침에 따라 작업 위치를 선택한다. 이 계획 작성 단계에서는 작업 트리를 생성하지 않았다.
기존 ask-musinsa 파일들이 아직 untracked이므로 구현 전에 내용을 보존해 격리 작업 위치에 포함한다.
기존 스킬 생성 계획/검증 문서와 다른 output 파일은 이 작업의 커밋에 자동 포함하지 않는다.

| 파일 | 책임 |
|---|---|
| `.agents/skills/ask-musinsa/scripts/lib/result.mjs` | 오류·결과 계약, 값 검사 |
| `.agents/skills/ask-musinsa/scripts/lib/http.mjs` | HTTP 요청, 제한된 재시도, 리다이렉트 차단 |
| `.agents/skills/ask-musinsa/scripts/lib/filters.mjs` | 기존 순수 필터 함수 이식 |
| `.agents/skills/ask-musinsa/scripts/lib/input.mjs` | 상품 식별·옵션 검증·검색 URL |
| `.agents/skills/ask-musinsa/scripts/lib/parsers.mjs` | HTML/JSON에서 상품·옵션 정규화 |
| `.agents/skills/ask-musinsa/scripts/lib/commands.mjs` | 4개 조회와 부분 재고 실패 조합 |
| `.agents/skills/ask-musinsa/scripts/musinsa.mjs` | 도움말·명령 라우팅·JSON/종료 코드 |
| `.agents/skills/ask-musinsa/scripts/tests/*.test.mjs` | 오프라인 계약·회귀 테스트 |
| `.agents/skills/ask-musinsa/SKILL.md` | 새 실행기 사용과 기존 경로 연결 |
| `.agents/skills/ask-musinsa/references/https-commands.md` | 옵션·스키마·출처·제약 설명 |
| `.agents/skills/ask-musinsa/references/detail-and-reviews.md` | 새 JSON 필드와 기존 판독 절차 연결 |
| `docs/verify/ask-musinsa-https.md` | 실제 실행 결과와 제한 기록 |

이식 출처는 `/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/`다. 실행기는 이 위치를 import하지 않는다.

### Task 1: 결과 계약과 HTTP 클라이언트

**Files:** Create `scripts/lib/result.mjs`, `scripts/lib/http.mjs`, `scripts/tests/http.test.mjs` (이하 scripts는 스킬 원본 아래).

**Interfaces:**
- Produces `fail(code:string,message:string):Error` (error.code 포함).
- Produces `numberOrNull(value):number|null`, `booleanOrNull(value):boolean|null`.
- Produces `envelope(data:Array,warnings:Array,sourceUrls:Array,fetchedAt:string):object`.
- Produces `request(url:string,{method='GET',body,fetchImpl=fetch,sleepImpl,timeoutMs=15000,now=Date.now}={}):Promise<string>`.
- Produces `requestJson(url,options={}):Promise<object>`. JSON 오류는 SCHEMA_CHANGED.

- [x] **Step 1: HTTP 실패·재시도 테스트 작성**

```js
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
```

- [x] **Step 2: red 확인**

Run: `node --test .agents/skills/ask-musinsa/scripts/tests/http.test.mjs`
Expected: 새 모듈이 없어 FAIL. 테스트 런타임 문제와 기능 실패를 구분한다.

- [x] **Step 3: 최소 구현 작성**

```js
// result.mjs
export const fail=(code,message)=>Object.assign(new Error(message),{code});
export const numberOrNull=v=>!['number','string'].includes(typeof v)||String(v).trim()===''||!Number.isFinite(Number(v))?null:Number(v);
export const booleanOrNull=v=>typeof v==='boolean'?v:null;
export const envelope=(data,warnings,sourceUrls,fetchedAt)=>({
  status:warnings.length?'partial':'ok',data,warnings,sourceUrls,fetchedAt
});
```

```js
// http.mjs
import {fail} from './result.mjs';
const hosts=new Set(['www.musinsa.com','api.musinsa.com','goods-detail.musinsa.com']);
export async function request(url,{method='GET',body,fetchImpl=fetch,
  sleepImpl=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  timeoutMs=15000,now=Date.now}={}) {
  const target=new URL(url);
  if(target.protocol!=='https:'||!hosts.has(target.hostname)||target.username||target.password||target.port)
    throw fail('INVALID_ARGUMENT','허용되지 않은 요청 주소');
  if(!['GET','POST'].includes(method)||
    (method==='POST'&&!/^\/api2\/goods\/\d+\/options\/v2\/prioritized-inventories$/.test(target.pathname)))
    throw fail('INVALID_ARGUMENT','허용되지 않은 요청 방식');
  for(let attempt=0;attempt<3;attempt++) {
    let response,content;
    try {
      response=await fetchImpl(target.href,{method,body,redirect:'manual',
        signal:AbortSignal.timeout(timeoutMs),headers:{
          'User-Agent':'Mozilla/5.0','Accept':'application/json,text/html',
          'Accept-Language':'ko-KR,ko;q=0.9','Referer':'https://www.musinsa.com/',
          ...(body?{'Content-Type':'application/json'}:{})
        }});
      content=await response.text();
    } catch(e) {
      if(attempt===2) throw fail(['TimeoutError','AbortError'].includes(e.name)?'TIMEOUT':'NETWORK_ERROR','HTTPS 요청 실패');
      await sleepImpl(500*(2**attempt)); continue;
    }
    if(response.status>=300&&response.status<400) {
      const location=new URL(response.headers.get('location')||'/',target);
      throw fail(location.pathname.includes('/auth/login')?'AUTH_REQUIRED':'REDIRECT','리다이렉트 응답');
    }
    if([401,403].includes(response.status)) throw fail(response.status===401?'AUTH_REQUIRED':'ACCESS_DENIED',`HTTP ${response.status}`);
    if([429,502,503,504].includes(response.status)) {
      const raw=response.headers.get('retry-after');
      const parsed=raw==null?NaN:(/^\d+$/.test(raw)?Number(raw)*1000:Date.parse(raw)-now());
      const delay=Number.isFinite(parsed)?Math.max(0,parsed):500*(2**attempt);
      if(delay>30000||attempt===2) throw fail(response.status===429?'RATE_LIMITED':'HTTP_ERROR',`HTTP ${response.status}`);
      await sleepImpl(delay); continue;
    }
    if(!response.ok) throw fail('HTTP_ERROR',`HTTP ${response.status}`);
    return content;
  }
}
export async function requestJson(url,options={}) {
  const text=await request(url,options);
  try {return JSON.parse(text);} catch {throw fail('SCHEMA_CHANGED','JSON 응답을 읽을 수 없습니다');}
}
```

추가 테스트: 일반 302→REDIRECT, 403→ACCESS_DENIED(재시도 0), 404→HTTP_ERROR, 503→성공,
금지 POST/외부 호스트→INVALID_ARGUMENT, 실제 짧은 timeoutMs로 AbortSignal이 전달되는지 검증한다.
아래 테스트를 http.test.mjs에 추가해 body 다운로드 시간 초과도 TIMEOUT으로 처리함을 확인한다.

```js
test('body timeout has the same bounded contract',async()=>{
  let calls=0;
  await assert.rejects(request('https://api.musinsa.com/test',{
    sleepImpl:async()=>{},fetchImpl:async()=>{
      calls++;return {text:async()=>{throw Object.assign(new Error('body timeout'),{name:'TimeoutError'});}};
    }
  }),{code:'TIMEOUT'});
  assert.equal(calls,3);
});
```

- [x] **Step 4: green 확인** — 위 node --test 명령, Expected: PASS.
- [x] **Step 5: 커밋**

```bash
git add .agents/skills/ask-musinsa/scripts/lib/result.mjs .agents/skills/ask-musinsa/scripts/lib/http.mjs .agents/skills/ask-musinsa/scripts/tests/http.test.mjs
git commit -m "feat: add musinsa HTTPS transport"
```

### Task 2: 입력·필터와 검색 URL

**Files:** Create `scripts/lib/filters.mjs`, `scripts/lib/input.mjs`, `scripts/tests/input.test.mjs`.

**Interfaces:**
- Consumes `fail(code,message)`.
- Produces `goodsNo(input:string):number`, `searchUrl(query:string,options:object={}):string`.
- Produces `validateOptions(command:string,options:object):object` with numeric page/limit and explicit defaults.
- filters exports `normalizeStandardSize`, `normalizeShoeSize`, `parseMeasurementInput`, `buildFilterQueryParams` as existing pure functions.

- [x] **Step 1: 상품 URL와 혼합 필터 회귀 테스트**

```js
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
  assert.equal(u.searchParams.get('q'),'티셔츠 & 셔츠');
  assert.equal(u.searchParams.get('sortCode'),'PRICE_LOW');
  assert.equal(u.searchParams.get('standardSize'),'M,L');
  assert.equal(u.searchParams.get('measurement'),'총장^70^75,가슴단면^55^60');
});
test('invalid pieces never disappear',()=>{
  for(const o of [{size:'M,banana'},{measure:'총장:70-75,오타:1-2'},{sort:'unknown'},{limit:'2x'},{'is-used':'maybe'},{'my-size':'top'}])
    assert.throws(()=>validateOptions('search',o),{code:'INVALID_ARGUMENT'});
});
```

- [x] **Step 2: red** — `node --test .agents/skills/ask-musinsa/scripts/tests/input.test.mjs`, Expected: module missing.
- [x] **Step 3: 필터 이식과 입력 검사 구현**

의존성이 없는 기존 filters.js 전체를 다음 명령으로 새 파일로 복사한다. 원본을 수정하지 않는다.

```bash
mkdir -p .agents/skills/ask-musinsa/scripts/lib
cp /Users/hyunjun_macbook_pro/.opencli/clis/musinsa/filters.js .agents/skills/ask-musinsa/scripts/lib/filters.mjs
```

input.mjs 상품번호 구현:

```js
import {fail} from './result.mjs';
import {normalizeStandardSize,normalizeShoeSize,parseMeasurementInput,buildFilterQueryParams} from './filters.mjs';
export function goodsNo(input) {
  const text=String(input).trim(); let id=text;
  if(!/^\d+$/.test(text)) {
    let u; try {u=new URL(text);} catch {throw fail('INVALID_ARGUMENT','상품번호 또는 무신사 상품 URL 필요');}
    const m=u.pathname.match(/^\/products\/(\d+)\/?$/);
    if(u.protocol!=='https:'||u.hostname!=='www.musinsa.com'||u.username||u.password||u.port||!m)
      throw fail('INVALID_ARGUMENT','상품 URL 형식 오류');
    id=m[1];
  }
  const number=Number(id);
  if(!Number.isSafeInteger(number)||number<1) throw fail('INVALID_ARGUMENT','상품번호 형식 오류');
  return number;
}
```

`validateOptions`의 확정 알고리즘:

```js
const allowed={search:['limit','page','sort','gender','is-used','size','shoe-size','measure'],
  recommend:['limit','gender','store'],product:[],options:[]};
const sorts={popular:'POPULAR',sale:'SALE',price_low:'PRICE_LOW',price_high:'PRICE_HIGH',newest:'NEWEST',review:'REVIEW'};
const genders={all:'A',men:'M',women:'F'};
export function validateOptions(command,options={}) {
  if(!allowed[command]||Object.keys(options).some(k=>!allowed[command].includes(k)))
    throw fail('INVALID_ARGUMENT','지원하지 않는 명령 또는 옵션');
  const o={...options};
  if(['search','recommend'].includes(command)) {
    o.limit=Number(o.limit??20);
    if(!Number.isInteger(o.limit)||o.limit<1||o.limit>100) throw fail('INVALID_ARGUMENT','limit은 1..100');
  }
  if(command==='search') {
    o.page=Number(o.page??1);o.sort=o.sort??'popular';o.gender=o.gender??'all';
    if(!Number.isSafeInteger(o.page)||o.page<1||!Object.hasOwn(sorts,o.sort)||!Object.hasOwn(genders,o.gender))
      throw fail('INVALID_ARGUMENT','page/sort/gender 형식 오류');
    const used=o['is-used']??false;
    if(![true,false,'true','false'].includes(used)) throw fail('INVALID_ARGUMENT','is-used는 true/false');
    o['is-used']=used===true||used==='true';
    for(const [key,parser] of [['size',s=>/^\d{3}$/.test(s)?normalizeShoeSize(s):normalizeStandardSize(s)],['shoe-size',normalizeShoeSize],['measure',parseMeasurementInput]]) {
      if(o[key]!==undefined) {
        const pieces=String(o[key]).split(',');
        if(pieces.some(p=>!p.trim()||!parser(p.trim()))) throw fail('INVALID_ARGUMENT',`${key} 필터 형식 오류`);
      }
    }
  }
  if(command==='recommend') {
    o.gender=o.gender??'M';o.store=o.store??'musinsa';
    if(!['M','F','A'].includes(o.gender)||!['musinsa','outlet','beauty','player','boutique'].includes(o.store))
      throw fail('INVALID_ARGUMENT','추천 gender/store 형식 오류');
  }
  return o;
}
export function searchUrl(query,options={}) {
  if(!String(query??'').trim()) throw fail('INVALID_ARGUMENT','검색어 필요');
  const o=validateOptions('search',options);
  const u=new URL('https://www.musinsa.com/search/musinsa/goods');
  u.search=new URLSearchParams({q:String(query),page:String(o.page),sortCode:sorts[o.sort],gf:genders[o.gender],isUsed:String(o['is-used']),...buildFilterQueryParams(o)});
  return u.href;
}
```

추가 회귀 케이스를 input.test.mjs에 넣는다: `size:270`, `shoe-size:270mm`, `2XL→XXL`, 실측 역범위→정렬,
소수 실측은 기존 Math.round 계약, size와 shoe-size 동시 입력은 기존 buildFilterQueryParams 우선순위 유지.
무효 item 하나만 있는 경우와 유효/무효 혼합, 공백 검색어도 INVALID_ARGUMENT인지 검사한다.

```js
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
```

- [x] **Step 4: green** — 위 input.test.mjs 실행, Expected: PASS.
- [x] **Step 5: 커밋**

```bash
git add .agents/skills/ask-musinsa/scripts/lib/filters.mjs .agents/skills/ask-musinsa/scripts/lib/input.mjs .agents/skills/ask-musinsa/scripts/tests/input.test.mjs
git commit -m "feat: preserve musinsa search filters"
```

### Task 3: HTML 검색·상품 파서

**Files:** Create `scripts/lib/parsers.mjs`, `scripts/tests/parsers.test.mjs`.

**Interfaces:**
- Consumes `fail`, `numberOrNull`, `booleanOrNull`.
- Produces `nextQueries(html:string):Array`, `parseSearch(html:string,{page=1,limit=20}={}):ProductRow[]`, `parseProduct(html:string,id:number):ProductRow[]`.
- ProductRow 계약은 Spec의 데이터 모델을 따른다. parseProduct는 1행 배열을 반환한다.

- [x] **Step 1: 빈 결과·구조 변경·숫자/미확인 구분 테스트 작성**

```js
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
```

- [x] **Step 2: red** — `node --test .agents/skills/ask-musinsa/scripts/tests/parsers.test.mjs`, Expected: module missing.
- [x] **Step 3: 최소 파서 구현**

```js
import {fail,numberOrNull as num,booleanOrNull as bool} from './result.mjs';
const text=v=>v==null||!String(v).trim()?null:String(v).trim().replace(/\s+/g,' ');
const schema=()=>{throw fail('SCHEMA_CHANGED','예상 데이터 구조 없음');};
export function nextQueries(html) {
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
export function parseSearch(html,{page=1,limit=20}={}) {
  const q=nextQueries(html).find(q=>q.queryKey?.[0]==='search'&&q.queryKey?.[1]==='goods');
  const items=q?.state?.data?.pages?.[0]?.items;
  if(!Array.isArray(items)) return schema();
  return items.slice(0,limit).map((x,i)=>({...row(x.goodsNo,x.goodsName,x.brandName,
    x.finalPrice??x.price,x.normalPrice,x.finalDiscount??x.saleRate,x.reviewScore,x.reviewCount,x.isSoldOut),rank:(page-1)*limit+i+1}));
}
export function parseProduct(html,id) {
  const d=nextQueries(html).find(q=>q.queryKey?.[0]==='Detail'&&Number(q.queryKey?.[1])===id)?.state?.data?.data;
  if(!d||typeof d!=='object'||Array.isArray(d)) return schema();
  const p=d.goodsPrice??{},r=d.goodsReview??{};
  const features=(d.goodsMaterial?.materials??[]).map(m=>{
    const chosen=(m.items??[]).filter(x=>x.isSelected).map(x=>text(x.name)?.replace(/\|/g,''));
    return chosen.length?`${m.name}: ${chosen.join(', ')}`:null;
  }).filter(Boolean).join(' | ');
  return [{...row(id,d.goodsNm,d.brandInfo?.brandName??d.brand,p.finalPrice??p.salePrice??p.normalPrice,
    p.normalPrice,p.finalDiscount??p.discountRate,r.satisfactionScore,r.totalCount,d.isSoldOut),
    category:text([d.category?.categoryDepth1Title,d.category?.categoryDepth2Title].filter(Boolean).join(' > ')),
    features:text(features),season:text([d.seasonYear,d.season].filter(Boolean).join(' ')),
    delivery:text(d.deliveryExpectedArrival?.arrivalText)}];
}
```

추가 테스트: 검색 정상 2행→limit 1, 잘못된 상품 ID/누락 이름→SCHEMA_CHANGED,
상품 ID 다른 Detail query만 존재→SCHEMA_CHANGED, JSON 파싱 오류,
가격 0과 normalPrice 같음 보존, features 선택 항목과 카테고리·배송 텍스트 보존.
상품 HTML에 선택적 필드가 잘못된 타입인 경우 generic TypeError로 새지 않게 해당 필드 타입을 검사한다.

```js
test('search limit, identity and malformed JSON',()=>{
  const query=items=>html([{queryKey:['search','goods'],state:{data:{pages:[{items}]}}}]);
  const rows=parseSearch(query([{goodsNo:1,goodsName:'a',price:0},{goodsNo:2,goodsName:'b'}]),{limit:1});
  assert.equal(rows.length,1);assert.equal(rows[0].price,0);
  assert.throws(()=>parseSearch(query([{goodsNo:1}])),{code:'SCHEMA_CHANGED'});
  assert.throws(()=>parseSearch('<script id="__NEXT_DATA__">broken</script>'),{code:'SCHEMA_CHANGED'});
  assert.throws(()=>parseProduct(html([{queryKey:['Detail',13],state:{data:{data:{goodsNm:'a'}}}}]),12),{code:'SCHEMA_CHANGED'});
});
```

- [x] **Step 4: green** — 위 parsers.test.mjs 실행, Expected: PASS.
- [x] **Step 5: 커밋**

```bash
git add .agents/skills/ask-musinsa/scripts/lib/parsers.mjs .agents/skills/ask-musinsa/scripts/tests/parsers.test.mjs
git commit -m "feat: parse public musinsa product data"
```

### Task 4: 검색·상품·추천 조회 연결

**Files:** Create `scripts/lib/commands.mjs`, `scripts/tests/commands.test.mjs`; Modify `scripts/lib/parsers.mjs`.

**Interfaces:**
- Consumes `request`, `requestJson`, `envelope`, `goodsNo`, `validateOptions`, `searchUrl`, `parseSearch`, `parseProduct`.
- Produces `parseRecommend(json:object,limit:number=20):ProductRow[]` in parsers.mjs.
- Produces `search(query,options={},deps={})`, `product(input,options={},deps={})`, `recommend(options={},deps={})`, each Promise<envelope>.
- deps forwards HTTP injection keys from Task 1; optional `clock:()=>string` for fetchedAt. No account/session dependency.

- [x] **Step 1: 추천 실제 shape와 조회 URL 테스트 작성**

```js
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
```

- [x] **Step 2: red** — `node --test .agents/skills/ask-musinsa/scripts/tests/commands.test.mjs`.
- [x] **Step 3: 추천 파서와 3개 명령 구현**

parsers.mjs에 추가:

```js
export function parseRecommend(json,limit=20) {
  const modules=json?.data?.modules;if(!Array.isArray(modules)) return schema();
  const rows=[];
  for(const module of modules) {
    if(module.items===undefined&&['QUICKMENU_HIGHLIGHT','QUICKMENU_ONEROW','BANNER_BIG_PROMOTION'].includes(module.type)) continue;
    if(!Array.isArray(module.items)) return schema();
    for(const item of module.items) {
      const ga=item.onClick?.eventLog?.ga4?.payload??item.impressionEventLog?.ga4?.payload??{};
      const info=item.info??{};
      const id=info.productId??item.onClick?.productId??ga.item_id;
      const name=info.productName??ga.item_name??info.title?.text;
      // 모듈에 상품 외 배너도 섞인다. 상품 ID가 없는 항목은 배너로 제외한다.
      if(id==null) continue;
      rows.push(row(id,name,info.brandName??ga.brand_name??ga.item_brand,
        info.finalPrice??ga.price??ga.best_price,info.originalPrice??ga.original_price,
        info.discountRatio??ga.discount_rate,null,null,info.isSoldOut));
    }
  }
  return rows.slice(0,limit).map((x,i)=>({...x,rank:i+1}));
}
```

2026-10-01 직접 확인: 6개 모듈 중 QUICKMENU_HIGHLIGHT, QUICKMENU_ONEROW, BANNER_BIG_PROMOTION에는 items가 없다. 상품 CAROUSEL 모듈에는 ga.item_id와 productName이 존재한다.
다음 테스트로 알려진 비상품 모듈을 허용하고 알 수 없는 목록 구조는 오류로 처리한다.

```js
test('known non-product modules do not break recommendations',()=>{
  assert.deepEqual(parseRecommend({data:{modules:[{type:'QUICKMENU_HIGHLIGHT',menus:[]},{type:'BANNER_BIG_PROMOTION',bannerBigPromotion:{}}]}}),[]);
  assert.throws(()=>parseRecommend({data:{modules:[{type:'CAROUSEL_ONEROW'}]}}),{code:'SCHEMA_CHANGED'});
});
```

commands.mjs:

```js
import {request,requestJson} from './http.mjs';
import {envelope} from './result.mjs';
import {goodsNo,validateOptions,searchUrl} from './input.mjs';
import {parseSearch,parseProduct,parseRecommend} from './parsers.mjs';
const time=deps=>(deps.clock??(()=>new Date().toISOString()))();
export async function search(query,options={},deps={}) {
  const o=validateOptions('search',options),url=searchUrl(query,o);
  return envelope(parseSearch(await request(url,deps),o),[],[url],time(deps));
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
```

- [x] **Step 4: green** — commands.test.mjs와 parsers.test.mjs를 `node --test`로 실행、Expected: PASS.
- [x] **Step 5: 커밋**

```bash
git add .agents/skills/ask-musinsa/scripts/lib/commands.mjs .agents/skills/ask-musinsa/scripts/lib/parsers.mjs .agents/skills/ask-musinsa/scripts/tests/commands.test.mjs
git commit -m "feat: connect musinsa public queries"
```

### Task 5: 옵션·재고 부분 실패 처리

**Files:** Modify `scripts/lib/parsers.mjs`, `scripts/lib/commands.mjs`; Create `scripts/tests/options.test.mjs`.

**Interfaces:**
- Produces `parseOptions(json,id):{rows:OptionRow[],valueNos:number[]}` and `mergeInventory(rows,json):{data:OptionRow[],warnings:Array}`.
- Produces `options(input,options={},deps={}):Promise<envelope>` in commands.mjs.
- 재고 경고에는 code,message,variantId(개별 누락 시)를 넣는다.

- [x] **Step 1: 활성 옵션·누락 재고·실제 재고 충돌 테스트 작성**

```js
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
```

- [x] **Step 2: red** — `node --test .agents/skills/ask-musinsa/scripts/tests/options.test.mjs`.
- [x] **Step 3: 최소 옵션 파서와 재고 연결**

parsers.mjs에 추가:

```js
export function parseOptions(json,id) {
  const d=json?.data;if(!Array.isArray(d?.optionItems)||!Array.isArray(d?.basic)) return schema();
  const names=new Map(d.basic.flatMap(g=>(g.optionValues??[]).map(v=>[v.no,v.name])));
  const valueNos=new Set();
  const rows=d.optionItems.map(item=>{
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
```

commands.mjs에 parseOptions/mergeInventory import와 함수 추가:

```js
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
```

추가 테스트: 중복 optionValueNos는 POST body에서 중복 제거, 정상 전체 재고는 ok,
optionItems:[]는 재고 요청 없이 ok, 옵션 응답 구조 누락은 SCHEMA_CHANGED,
옵션 ID와 optionValueNos 원소의 숫자 타입 오류는 SCHEMA_CHANGED.
옵션 이름 일부가 매핑에 없을 때 일부 색상만 표시하지 않도록 다음 테스트를 추가한다.

```js
test('unknown option value is a schema error',async()=>{
  const bad={data:{basic:[],optionItems:[{no:10,optionValueNos:[999],activated:true}]}};
  await assert.rejects(options('12',{}, {fetchImpl:async()=>Response.json(bad)}),{code:'SCHEMA_CHANGED'});
});
```

```js
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
```

- [x] **Step 4: green** — options.test.mjs 실행, Expected: PASS.
- [x] **Step 5: 커밋**

```bash
git add .agents/skills/ask-musinsa/scripts/lib/parsers.mjs .agents/skills/ask-musinsa/scripts/lib/commands.mjs .agents/skills/ask-musinsa/scripts/tests/options.test.mjs
git commit -m "feat: distinguish unavailable musinsa inventory"
```

### Task 6: CLI·스킬 라우팅과 배포 검증

**Files:** Create `scripts/musinsa.mjs`, `scripts/tests/cli.test.mjs`, `references/https-commands.md`, `docs/verify/ask-musinsa-https.md`.
Modify `.agents/skills/ask-musinsa/SKILL.md:8-25,30-34`, `references/detail-and-reviews.md:5,26`.

**Interfaces:**
- Consumes commands.search/product/options/recommend and Task 2 validation.
- Produces `run(argv:string[],deps={}):Promise<{exitCode:number,result:object}>`.
- 성공/부분 성공 exit 0; INVALID_ARGUMENT exit 2; 나머지 오류 exit 1. stdout은 단일 JSON만, 도움말은 텍스트.
- --help는 네트워크 요청 없이 명령·옵션 설명을 반환한다.

- [x] **Step 1: CLI 인자 오류·help·JSON 계약 테스트**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {run} from '../musinsa.mjs';
test('unknown option does not fetch',async()=>{
  const r=await run(['search','셔츠','--oops','1'],{fetchImpl:async()=>assert.fail('no fetch')});
  assert.equal(r.exitCode,2);assert.equal(r.result.error.code,'INVALID_ARGUMENT');
});
test('is-used false is not truthy',async()=>{
  const result=await run(['search','셔츠','--is-used','false'],{fetchImpl:async u=>{
    assert.equal(new URL(u).searchParams.get('isUsed'),'false');
    return new Response(`<script id="__NEXT_DATA__">${JSON.stringify({props:{pageProps:{dehydratedState:{queries:[{queryKey:['search','goods'],state:{data:{pages:[{items:[]}]}}}]}}}})}</script>`);
  }});
  assert.equal(result.exitCode,0);assert.deepEqual(result.result.data,[]);
});
test('help usable as subprocess',()=>{
  const r=spawnSync(process.execPath,[new URL('../musinsa.mjs',import.meta.url).pathname,'--help'],{encoding:'utf8'});
  assert.equal(r.status,0);assert.match(r.stdout,/search/);assert.match(r.stdout,/recommend/);
});
```

- [x] **Step 2: red** — `node --test .agents/skills/ask-musinsa/scripts/tests/cli.test.mjs`.
- [x] **Step 3: CLI 작성**

```js
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {fail} from './lib/result.mjs';
import * as commands from './lib/commands.mjs';
const help=`musinsa: search <query>, product <goodsNo-or-url>, options <goodsNo-or-url>, recommend
search: --limit 1..100 --page N --sort popular|sale|price_low|price_high|newest|review
        --gender all|men|women --is-used true|false --size M,L --shoe-size 270 --measure 총장:70-75
recommend: --limit 1..100 --gender M|F|A --store musinsa|outlet|beauty|player|boutique`;
export async function run(argv,deps={}) {
  try {
    const {values,positionals}=parseArgs({args:argv,allowPositionals:true,strict:true,options:{
      help:{type:'boolean'},limit:{type:'string'},page:{type:'string'},sort:{type:'string'},gender:{type:'string'},
      'is-used':{type:'string'},size:{type:'string'},'shoe-size':{type:'string'},measure:{type:'string'},store:{type:'string'}
    }});
    if(values.help) return {exitCode:0,result:{help}};
    const [command,arg]=positionals;
    const opts={...values};delete opts.help;
    if(!['search','product','options','recommend'].includes(command)||positionals.length!==(command==='recommend'?1:2))
      throw fail('INVALID_ARGUMENT','명령 또는 위치 인자 형식 오류');
    const result=await (command==='recommend'?commands.recommend(opts,deps):commands[command](arg,opts,deps));
    return {exitCode:0,result};
  } catch(error) {
    const code=error.code?.startsWith('ERR_PARSE_ARGS')?'INVALID_ARGUMENT':error.code??'INTERNAL_ERROR';
    return {exitCode:code==='INVALID_ARGUMENT'?2:1,result:{status:'error',data:[],warnings:[],sourceUrls:[],
      fetchedAt:(deps.clock??(()=>new Date().toISOString()))(),error:{code,message:error.message}}};
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const {exitCode,result}=await run(process.argv.slice(2));
  process.stdout.write(result.help??`${JSON.stringify(result)}\n`);process.exitCode=exitCode;
}
```

원래 스킬의 첫 안내와 공개 4개 행을 다음 내용으로 교체한다. 원본·계정 6개 행을 함께 git diff로 대조한다.

```markdown
먼저 `node <이 SKILL.md가 있는 디렉터리>/scripts/musinsa.mjs --help`로 공개 조회 명령을 확인한다.
공개 조회는 HTTPS 실행기의 JSON을 사용한다. 계정 조회는 기존 OpenCLI 명령을 사용하며,
해당 명령 실행 전에 `opencli musinsa <명령> --help -f yaml`로 옵션을 확인한다.
검색: `node <skill>/scripts/musinsa.mjs search <query>`
추천: `node <skill>/scripts/musinsa.mjs recommend`
상품: `node <skill>/scripts/musinsa.mjs product <goodsNo-or-url>`
옵션·재고: `node <skill>/scripts/musinsa.mjs options <goodsNo-or-url>`
내 사이즈 검색은 `opencli musinsa mysize --as-filter -f json`에서 확보한 실측 필터를
새 search의 `--measure` 인자로 전달한다. 계정 실측 조회가 실패하면 내 사이즈 검색이 성공했다고 답하지 않는다.
JSON의 warnings와 null은 미확인으로 취급한다. 상품 soldOut와 옵션 실제 재고를 구분한다.
fetchedAt을 Asia/Seoul로 표시한다. price는 공개 응답 가격이며 내 회원 할인가로 표현하지 않는다.
```

실제 문서에서는 기존 표의 형식을 유지하고 실행 가능한 절대 경로를 설명한다.
references/https-commands.md에는 위 help, envelope 예시, 오류 코드, 필터 반올림/역범위/3XL 매핑,
정상 빈 목록·구조 오류·부분 재고의 구분, 위 이식 출처와 날짜를 기록한다.
상품 소재·이미지/후기 본문을 이 실행기가 반환한다고 쓰지 않는다.
references/detail-and-reviews.md의 `product/options`는 새 실행기 명령을 뜻하도록 설명하고,
브라우저 예시와 이미지 출처·행 이름·AI 요약 제외·최근/낮은 평점 표본 규칙을 유지한다.

- [x] **Step 4: 오프라인 green과 스킬 라우팅 대조**

```bash
node --test .agents/skills/ask-musinsa/scripts/tests/*.test.mjs
node .agents/skills/ask-musinsa/scripts/musinsa.mjs --help
rg -n 'opencli musinsa|mysize|orders|likes|whoami|my-prices|login|scripts/musinsa' .agents/skills/ask-musinsa/SKILL.md
rg -n 'opencli|\.opencli|Cookie|Authorization' .agents/skills/ask-musinsa/scripts/lib .agents/skills/ask-musinsa/scripts/musinsa.mjs
```

Expected: tests PASS; help 4개 명령; 계정 6개와 새 공개 명령 모두 문서에 존재;
마지막 rg는 코드의 금지 의존성/계정 헤더가 없음을 확인(출처 주석만 있으면 허용).
format validator가 사용 가능하면 `/Users/hyunjun_macbook_pro/.codex/skills/.system/skill-creator/scripts/quick_validate.py`를 실행한다.
도구가 unavailable이면 그 사실을 검증 문서에 기록하며 형식 검증 성공으로 쓰지 않는다.

- [x] **Step 5: live 실행과 독립 데이터 대조**

```bash
node .agents/skills/ask-musinsa/scripts/musinsa.mjs search '티셔츠' --limit 3
node .agents/skills/ask-musinsa/scripts/musinsa.mjs product 6596166
node .agents/skills/ask-musinsa/scripts/musinsa.mjs options 6596166
node .agents/skills/ask-musinsa/scripts/musinsa.mjs recommend --limit 3
```

검색에서 얻은 상품번호 하나로 product/options도 실행한다. ID·상품명이 일치하는지 확인한다.
원본 공개 HTML/API를 같은 시점에 fetch해 조회 금액·옵션·재고 값을 대조한다.
파서가 요청하는 __NEXT_DATA__와 JSON 경로를 검증 문서에 명시한다.
상품마다 정상 options/basic 구조가 달라 실패하면 성공으로 간주하지 않고 원본 응답을 확인해 파서를 수정하고 관련 오프라인 테스트를 추가한다.
추천 항목의 상품 경로와 ID/이름/가격을 대조한다. 실패·차단·부분 성공은 각각 기록한다.
계정 로그인 세션을 읽거나 개인 데이터 테스트를 실행하지 않는다.

- [x] **Step 6: 검증 문서 작성과 커밋**

`docs/verify/ask-musinsa-https.md`에 날짜/KST 시각, Node 버전, 실행 명령과 종료 코드,
4개 live 결과, 상품 연결 대조, 오프라인 테스트 수/결과, 기존 기능 보존 검토, 미검증 기능을 기록한다.
새 설계/계획도 아래 명시적 범위로 stage한다. output 디렉터리나 기존 스킬 생성 문서는 stage하지 않는다.

```bash
git add .agents/skills/ask-musinsa/SKILL.md .agents/skills/ask-musinsa/references/detail-and-reviews.md .agents/skills/ask-musinsa/references/https-commands.md .agents/skills/ask-musinsa/scripts/musinsa.mjs .agents/skills/ask-musinsa/scripts/tests/cli.test.mjs docs/specs/2026-10-01-ask-musinsa-https.md docs/plans/2026-10-01-ask-musinsa-https.md docs/verify/ask-musinsa-https.md
git diff --cached --stat
git commit -m "feat: route musinsa public lookups through HTTPS"
```

## 최종 리뷰와 인수

- [x] 변경된 실행기 전체와 스킬 라우팅을 선택된 실행 방식의 독립 리뷰로 확인한다.
- [x] 재고 미확인과 공개 가격/회원 할인가 경계를 최종 답변에서 명시한다.
- [x] 전역 어댑터와 계정·이미지·후기 경로의 잔존 OpenCLI 의존성을 기록한다.
- [x] 사용자 요청 없이는 push/PR/기존 제출물 변경을 수행하지 않는다.

## 계획 자체 검토

Spec coverage: 공개 4개 Task 3–6, JSON/숫자/null Task 1·3·5·6, 필터 Task 2,
재시도/리다이렉트 Task 1, 계정 경로·내 사이즈·이미지/후기 Task 6, live 인수 Task 6.
Review Focus 5개는 해당 Task의 구체적 테스트 또는 추가 케이스에 배정했다.
모든 cross-task 함수 이름과 시그니처를 Interfaces 블록에 명시했다.
이 파일은 구현 계획이며, 포함된 코드와 테스트는 아직 실행하거나 제품에 적용하지 않았다.


## 실행 결과와 설계 보완 (2026-10-01)

6개 작업 완료. 최종 Node 테스트 40개 통과(v26/v24), 실제 공개 4개 조회 및 원본 대조 통과.
코드 예제는 당시 계획이며 실제 구현은 다음 보완을 포함한다: 검색 /search/goods?keyword,
한글 경로 fileURLToPath, 심볼릭 링크 entrypoint realpath, 로그인 HTML 판별 html.mjs,
의류/신발 혼합 필터 거부와 own-property 검사, 페이지 내 rank.
기존 Python 전체 테스트는 변경 전후 동일한 PDF 16쪽/예상 15쪽 실패 1건이며 상세는 검증 문서에 기록했다.
검증 문서: docs/verify/ask-musinsa-https.md.


## 2026-10-02 프로젝트 위치 정정

사용자 지시에 따라 project-clot의 로컬 스킬로 옮겼다. 현재 원본은 `.agents/skills/ask-musinsa/`이고 `.claude/skills/ask-musinsa`는 그 원본의 상대 링크다. 위 구현·리뷰 기록 중 과거 Git 브랜치와 Python 논리회로실험 테스트는 잘못 선택했던 논회실 저장소의 이력이다. project-clot의 현재 검증이나 Git 이력으로 해석하지 않는다. 이번 위치 이동에서는 커밋하지 않는다.
