# Dashboard Search Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 자연스러운 단어 조합과 상품번호·URL로 추적 상품을 찾고, 필터·미등록·조회 실패를 구분한다.

**Architecture:** 기존 model factory에서 입력 해석과 token AND 판정을 공유한다. scoped runtime은 기존 routes/card lookup으로 상품을 직접 조회하고 일반 검색과 최신 요청 보호를 공유한다. 대량 검색 데이터 구조와 가격 정책은 유지한다.

**Tech Stack:** 현재 저장소의 Node.js ESM, node:test, node:sqlite, 정적 HTML/JavaScript, Web Worker, Playwright. 새 패키지 없음.

**Spec:** `docs/superpowers/specs/2026-10-24-dashboard-search-correctness-design.md` — 먼저 읽는다. 채팅의 결정 #1/#2는 confirmed by default로 기록됐다.

## Global Constraints

- 기존 Node.js ESM·정적 HTML·Web Worker 구조와 현재 Node.js 버전 요구사항을 유지한다.
- 새 런타임 의존성을 추가하지 않는다.
- HTTP Worker와 file:// 로컬 실행에서 검색 의미를 동일하게 유지한다.
- 직렬화되는 factory 함수는 외부 import나 자유 변수에 의존하지 않는다.
- 브랜드 식별용 brandKey와 표시 원문은 유지하고 검색 전용 정규화를 분리한다.
- 수집 대상·DB 스키마·쿠폰가·하락·최저가 판정은 변경하지 않는다.
- 검색 데이터의 기존 필드 순서와 v2 revision·크기 검증을 유지한다.
- 상품번호·URL 직접 조회는 일반 검색 필터와 관계없이 상품을 표시하고 필터 상태를 보관한다.
- 미확인 범위의 상품 부재를 단정하지 않고, 요청 실패를 미등록으로 표시하지 않는다.
- 변경 범위 밖의 파일과 실행 데이터는 수정·스테이징하지 않는다.

## Review Focus

1. 악성 유사 호스트·잘못된 숫자·긴 tracking URL: 허용된 상품 key만 파싱하고 외부 URL은 요청하지 않는다 — Task 1.
2. 구두점 정규화 후 브랜드 충돌과 필드 경계: 필터 식별은 유지하고 서로 다른 필드를 붙인 거짓 일치는 거부한다 — Task 1.
3. 이전 index row·누락 별칭·문자열 직렬화: 기존 파일과 Worker/file://에서 같은 결과를 낸다 — Task 2.
4. 일반 검색 실패 뒤 직접 조회·늦은 응답·route/card 실패: 최신 상태와 재시도 operation이 정확하다 — Tasks 3–4.
5. 저장 필터·미확인 집계·IME 마지막 input: 필터 보관, 숫자 0과 미확정 구분, 최종 입력 한 번 검색 — Task 5.

---

## 실행 전 확인과 파일 구조

실행 시 using-git-worktrees로 작업을 격리하고 AGENTS.md와 현재 git 상태를 다시 확인한다. 이 계획 작성 시 기존 미추적 파일은 `data/4910-all.js`였다. 삭제·생성·스테이징하지 않는다. 실행 전에 baseline으로 `node --test 'tests/*.test.js'` 결과를 기록하고, 실패하면 변경 뒤 결과와 구분한다. 실제 DB와 dashboard 출력은 tests/setup-env.js가 제공하는 임시 경로만 사용한다.

| 파일 | 책임 / 작업 |
|---|---|
| `src/dashboard-model.js` | 입력 해석·검색 전용 정규화·단어 일치 / 1, 2 |
| `src/dashboard-musinsa.js` | 공개 브랜드 코드 보존 / 2 |
| `src/dashboard-index.js` | 별칭 열 추가와 이전 row 복원 / 2 |
| `src/dashboard-worker.js` | 현재 query 취소와 RPC 허용 목록 / 3 |
| `src/dashboard-runtime.js` | 직접 조회 상태·최신 요청·재시도 / 3 |
| `src/dashboard.template.html` | 직접 조회·invalid 화면·필터 안내·IME / 4, 5 |
| `tests/dashboard-search.test.js` (신규) | 독립된 검색 의미와 파싱 / 1 |
| `tests/dashboard-model.test.js` | 기존 필터·집계와 검색 의미 회귀 / 1 |
| `tests/dashboard-musinsa.test.js`, `tests/dashboard-index.test.js`, `tests/dashboard-scope.test.js` | export와 직렬화 / 2, 3 |
| `tests/dashboard-runtime-v2.test.js` | 조회 전환·오류·재시도 / 3 |
| `tests/helpers/dashboard-page.js` | production builder를 쓰는 opt-in 검색 fixture / 4 |
| `tests/browser/dashboard.test.js` | HTTP/file, 조회·필터·입력 시나리오 / 4, 5 |
| `README.md` | 사용자 검색 규칙과 범위 설명 / 5 |

생산 코드의 새 파일이나 새 factory는 만들지 않는다. model 함수는 기존 factory 안에 정의한다. `src/visualizer.js:529`와 `tests/helpers/dashboard-page.js`가 함수 toString을 사용하므로 import helper를 참조하면 브라우저에서 깨진다. 신규 test 파일은 `import './setup-env.js';`로 시작한다.

## 공통 테스트 표기

이하 `coat`는 spec의 2156295 fixture를 `model.summarize()`한 값이며, `other`는 같은 이름의 다른 상품번호다. 테스트에서 `coat`·`other`를 명시적으로 선언한다. 새 browser fixture는 `writeFixture(dir, { search: true })`로 생성하고 기본 fixture는 변경하지 않는다. 공통 타입 `Summary`는 기존 summarize 반환값, `State`는 restoreState 반환값이다.

### Task 1: 입력 해석과 자연스러운 단어 검색

**Files:**
- Modify: `src/dashboard-model.js:2-11,40-45`
- Create: `tests/dashboard-search.test.js`
- Modify: `tests/dashboard-model.test.js`

**Interfaces:**
- Consumes: 기존 `summarize(raw)`, `restoreState(saved)`, `queryCatalog(items, state)`.
- Produces: `parseSearchInput(input: string): SearchInput`, `normalizeSearchText(value: unknown): string`, `searchFields(item: object): string[]`, `matchesSearch(item: object, tokens: string[]): boolean`. SearchInput의 네 variant와 입력 규칙은 spec과 같다.
- Produces: `queryCatalog()`가 단어별 AND를 집계 전에 적용한다. 기존 반환 구조·정렬·brandKey는 유지한다.

- [ ] **Step 1: 실패 테스트 작성**

`tests/dashboard-search.test.js`에 spec 고정 fixture와 아래 assertion을 넣는다. `matchesSearch()` 검증은 `parseSearchInput(q).tokens`를 사용한다.

```js
for (const q of ['키뮤어 캐시미어', '캐시미어 키뮤어', '캐시미어 블렌드', '발마칸 코트 블랙', 'Ｄｒａｐｅ'])
  assert.deepEqual(model.queryCatalog([coat], {q}).items.map(x => x.k), ['musinsa:2156295']);
assert.equal(model.queryCatalog([coat], {q:'키뮤어 존재하지않는단어'}).total, 0);
assert.equal(model.queryCatalog([model.summarize({src:'musinsa',n:1,b:'ab',g:'cd',L:[]})], {q:'bc'}).total, 0);
assert.deepEqual(model.parseSearchInput('0002156295'), {type:'product',key:'musinsa:2156295'});
assert.deepEqual(model.parseSearchInput('4910:2156295'), {type:'product',key:'4910:2156295'});
assert.equal(model.parseSearchInput('---').type, 'invalid');
assert.equal(model.parseSearchInput('  ').type, 'empty');
```

같은 test file에서 다음 이름과 assertion을 추가한다: `product URL parsing is strict and ignores long tracking data`, `IDs remain positive safe integers`, `search normalization does not merge brand identity`.

```js
const parse = model.parseSearchInput;
assert.deepEqual(parse('https://www.musinsa.com/products/2156295?utm_content='+'x'.repeat(4096)), {type:'product',key:'musinsa:2156295'});
for (const value of ['0','-1','+1','9007199254740992','https://musinsa.com.evil.test/products/2156295','https://user@www.musinsa.com/products/2156295','https://www.musinsa.com:8443/products/2156295','https://www.musinsa.com/products/nope','javascript:alert(1)','https://musinsa.onelink.me/abc'])
  assert.equal(parse(value).type, 'invalid');
assert.deepEqual(parse('ＭＵＳＩＮＳＡ:２１５６２９５'), {type:'product',key:'musinsa:2156295'});
assert.notEqual(model.brandKey('A-B'), model.brandKey('AB'));
```

두 단어가 서로 다른 필드에 나뉘어도 AND 일치하고 순서를 바꿔도 같은지 고정한다. factory를 vm에서 toString으로 재생성한 뒤 같은 파싱·검색 결과를 assert한다.

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/dashboard-search.test.js tests/dashboard-model.test.js`
Expected: 새 함수 부재 또는 새 검색 기대값에서 FAIL. 기존 테스트 실패를 새 동작으로 덮어쓰지 않는다.

- [ ] **Step 3: model 계약 구현**

위 함수를 factory 안에 구현한다. NFKC 후 Unicode `\p{L}\p{M}\p{N}` 구간으로 token을 만들고 compact 필드의 includes로 각 token을 판정한다. `queryCatalog()`는 URL/상품번호 분류를 수행하지 않고 q 문자열을 같은 token 규칙으로 나누며, item을 mutate하지 않는다. 기호뿐인 q는 빈 검색과 달리 0건이며 UI에서는 invalid 안내가 된다. existing `_hay`만 있는 객체도 원본 필드로 검색할 수 있게 한다. 각 summarize 결과에 `_searchFields: string[]`를 만들되 브랜드 키와 기존 가격 속성은 변경하지 않는다.

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/dashboard-search.test.js tests/dashboard-model.test.js tests/dashboard-index.test.js`
Expected: 전부 PASS. model query의 기존 input 불변성 assertion도 PASS.

- [ ] **Step 5: 작업 범위만 커밋**

Run: `git add src/dashboard-model.js tests/dashboard-search.test.js tests/dashboard-model.test.js` 후 `git diff --cached --check`.
Run: `git commit -m "fix: support normalized multi-term dashboard search"`
문서 파일이 아직 커밋되지 않았다면 이 spec과 plan 두 경로도 명시적으로 포함한다. 다른 파일을 일괄 add하지 않는다.

### Task 2: 원본 브랜드 별칭을 export와 index에 보존

**Files:**
- Modify: `src/dashboard-musinsa.js:122-135`, `src/dashboard-model.js:6-11`, `src/dashboard-index.js:4-62`
- Test: `tests/dashboard-musinsa.test.js`, `tests/dashboard-index.test.js`, `tests/dashboard-scope.test.js`

**Interfaces:**
- Consumes: Task 1 `searchFields(item)`와 model 함수.
- Produces: 모든 새 summary의 `searchAliases: string[]`, `_searchFields: string[]`. `searchAliases`는 기존 index fields 뒤의 마지막 열이며 누락 시 `[]`다.
- Produces: buildMusinsaCatalog의 공개 brand 코드가 card, preview, index, 직접 조회에 보존된다. 표시명과 index v2 필드 위치는 그대로다.

- [ ] **Step 1: 실패 테스트 작성**

```js
const raw = {...coat, searchAliases:['kimuir']};
const item = model.summarize({...raw,L:[]});
const packed = packIndex([item], {revision:'r',id:'alias'});
const restored = unpackIndex(packed)[0];
assert.deepEqual(restored.searchAliases, ['kimuir']);
assert.equal(model.queryCatalog([restored], {q:'kimuir 캐시미어'}).total, 1);
const old = structuredClone(packed);
old.rows[0].pop();
assert.deepEqual(unpackIndex(old)[0].searchAliases, []);
```

adapter test에서는 SQLite fixture의 `brand='kimuir', brand_name='키뮤어'`를 설정하고 실제 buildMusinsaCatalog → sink → pack/unpack으로 별칭이 유지되는지 assert한다. 표시명 키뮤어, 동일 원문 상품명, 가격 출처·가격 값은 유지돼야 한다. null/빈/누락 별칭은 []로 복원하고 brand만 없는 다른 출처에 추정 별칭을 만들지 않는다. 기존 SECRET_PRIVATE_RESPONSE 비노출 검사를 유지한다. `tests/dashboard-scope.test.js`에서 실제 builder의 별칭 검색과 build verifier 통과를 확인한다.

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/dashboard-musinsa.test.js tests/dashboard-index.test.js tests/dashboard-scope.test.js`
Expected: brand 별칭 전달/round-trip assertion에서 FAIL.

- [ ] **Step 3: adapter와 직렬화 계약 구현**

model은 string 배열만 정리·중복 제거해 `searchAliases`로 보존한다. adapter는 공개 brand 코드만 전달한다. index는 fields 뒤에 열을 추가하고 unpack에서 누락을 []로 보완한 뒤 Task 1 helper로 `_searchFields`를 만든다. 기존 validate의 revision/bytes/v2 검사는 약화하지 않는다. builder의 크기별 분할을 재사용하며 원시 회원 응답이나 URL을 검색 index에 추가하지 않는다.

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/dashboard-search.test.js tests/dashboard-model.test.js tests/dashboard-musinsa.test.js tests/dashboard-index.test.js tests/dashboard-scope.test.js tests/dashboard-build.test.js`
Expected: 전부 PASS, 기존 bounded asset·verifier·identity 검증 유지.

- [ ] **Step 5: 커밋**

Run: `git add src/dashboard-musinsa.js src/dashboard-model.js src/dashboard-index.js tests/dashboard-musinsa.test.js tests/dashboard-index.test.js tests/dashboard-scope.test.js` 후 `git diff --cached --check`.
Run: `git commit -m "fix: preserve public brand aliases in dashboard search"`

### Task 3: index 완료와 독립적인 상품 직접 조회

**Files:**
- Modify: `src/dashboard-worker.js:219-300,330-351`, `src/dashboard-runtime.js:30-208`
- Test: `tests/dashboard-runtime-v2.test.js`, `tests/dashboard-scope.test.js`

**Interfaces:**
- Consumes: 기존 scoped `lookup(key)`와 `query(state, requestId)`, routes/card loader.
- Produces: transport `cancelQuery(): Promise<void>`와 Worker RPC `cancelQuery`.
- Produces: v2 runtime `searchProduct(key: string): Promise<{mode:'product',key:string,item:Summary|null}>`. query와 공유하는 latest-request sequence, `state.phase='product'`, 마지막 operation을 재실행하는 retry(). 기존 query 결과 구조와 저수준 lookup 의미는 유지한다.

- [ ] **Step 1: 실패 테스트 작성**

runtime harness의 transport에 controllable lookup/cancelQuery를 추가한다. fixture helper는 파일 내부에 정의하고 공개 제품 API로 추가하지 않는다.

```js
const pending = api.searchProduct('musinsa:2156295');
assert.equal(api.getState().phase, 'product');
lookup.resolve(coat);
assert.deepEqual(await pending, {mode:'product',key:'musinsa:2156295',item:coat});
assert.equal(api.getState().status, 'ready');
```

`direct lookup ignores blocked indexes after query failure`는 일반 query의 index를 실패시킨 뒤 searchProduct가 routes/card만으로 성공하는지 assert한다. `latest operation owns direct and catalog states`는 query→product 및 product→query의 늦은 성공/오류가 STALE_RESULT이고 최신 상태를 바꾸지 않는지 assert한다. `retry repeats product lookup and preserves missing versus failure`는 null은 정상 ready이며 reject는 error, retry는 query 대신 같은 key lookup을 호출하는지 assert한다. `dispose settles product requests`는 진행 중 직접 조회가 dispose로 종료되는지 확인한다.

transport tests는 query의 네 active index 요청을 gate로 묶고 cancelQuery 후 query가 gate 해제 전에 STALE_RESULT로 끝나는지, queued index가 실행되지 않는지, lookup이 새 index 없이 routes/card로 완료되는지 확인한다. 이미 시작된 gate 요청은 finally에서 해제한다.

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/dashboard-runtime-v2.test.js tests/dashboard-scope.test.js`
Expected: searchProduct/cancelQuery 부재에서 FAIL.

- [ ] **Step 3: runtime과 transport 계약 구현**

공유 operation wrapper로 query/searchProduct의 sequence·status·guard·retry를 묶는다. searchProduct는 scoped 모드에서 cancelQuery를 RPC 호출하고 lookup을 수행한다. cancelQuery는 generation 증가·cancelCurrent 종료·current 무효화·queued index 취소를 수행하고 loaded cache는 유지한다. 기존 pending 초기화/worker 재시작/dispose 보호를 유지한다. non-scoped v2에서는 scoped 전용 cancelQuery를 호출하지 않는다. 저수준 lookup은 모달용으로 상태를 바꾸지 않는다.

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/dashboard-runtime-v2.test.js tests/dashboard-runtime.test.js tests/dashboard-scope.test.js tests/dashboard-index.test.js`
Expected: 전부 PASS, 기존 query/page/neighbor 계약과 Worker 재시작 테스트 유지.

- [ ] **Step 5: 커밋**

Run: `git add src/dashboard-worker.js src/dashboard-runtime.js tests/dashboard-runtime-v2.test.js tests/dashboard-scope.test.js` 후 `git diff --cached --check`.
Run: `git commit -m "feat: add independent dashboard product lookup"`

### Task 4: 검색창에 직접 조회와 입력 안내 연결

**Files:**
- Modify: `src/dashboard.template.html:572,609-617,889-956,1054-1095`
- Modify: `tests/helpers/dashboard-page.js:12-72`
- Test: `tests/browser/dashboard.test.js`

**Interfaces:**
- Consumes: Task 1 parseSearchInput, Task 3 searchProduct, 기존 query/getHistory와 cardHtml.
- Produces: empty/text/product/invalid 화면 분기. 직접 조회는 q 이외의 State와 localStorage를 보존하고 페이징/집계를 사용하지 않는다. UI request token은 모든 입력 모드를 관통한다.
- Produces: `writeFixture(dir,{search:true})` 옵션. 기존 기본 fixture와 scale fixture는 그대로다. search fixture는 production build 경로로 coat와 이름이 비슷한 other(2156296)를 만들며 coat는 직접 조회용 preview에 포함되지 않게 121개 이상의 높은 할인율 상품을 앞에 둔다. 방해 상품은 무신사 top/outer에 번갈아 배치해 범위 확대 테스트에 별도 index가 존재하도록 한다. 가격은 spec의 ESTIMATED 예시를 사용한다.

- [ ] **Step 1: 실패 browser 테스트 작성**

현재 browser fixture(t, options)의 options를 그대로 전달해 search fixture를 사용한다. 같은 테스트를 HTTP와 file://에서 실행한다. 표준 helper는 `await page.locator('#q').fill(value)` 후 기대 화면을 기다린다. 새 접근성 이름과 다음 assertion을 고정한다.

```js
await page.locator('#q').fill('2156295');
await page.locator('.card[data-k="musinsa:2156295"]').waitFor();
assert.equal(await page.locator('.card').count(), 1);
assert.equal(await page.locator('#gridMore').isVisible(), false);
await page.locator('.card').click();
assert.equal(await page.locator('#prevBtn').isEnabled(), false);
assert.equal(await page.locator('#nextBtn').isEnabled(), false);
```

`product search bypasses blocked indexes over HTTP and file`는 모든 index 파일 요청을 abort하고 긴 무신사 URL로 coat가 표시되는지 확인한다. routes/card는 허용한다. `product search preserves saved filters`는 저장 src=4910/cat=top/filter=drop 상태에서도 coat를 찾고 q를 비우면 같은 필터가 복원되는지 확인한다. `invalid, missing and failed lookup are separate screens`는 유사 호스트 입력에 lookup 요청 0회, 존재하지 않는 번호에는 spec 미등록 문구, route/card 실패에는 spec 오류 문구와 재시도 버튼을 assert한다. 실패 파일을 복원한 뒤 버튼으로 같은 key가 표시돼야 한다. `late lookup cannot replace newer text or invalid input`은 지연 조회 후 다른 문구/잘못된 URL을 입력했을 때 이전 카드가 나타나지 않는지 확인한다.

- [ ] **Step 2: 실패 확인**

Run: `CLOT_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test --test-name-pattern='product search|invalid, missing|late lookup' tests/browser/dashboard.test.js`
Expected: 단일 상품/모드 안내/필터 보관 assertion에서 FAIL. 실행 환경에 Chrome이 없으면 검증된 Playwright Chromium 실행 경로를 사용하고 임의 설치하지 않는다.

- [ ] **Step 3: UI 모드 구현**

render()에서 parseSearchInput으로 분기한다. product는 runtime.searchProduct 결과만 전용 painter에 전달하고 lastQuery를 null로 두어 결과 내 neighbor와 more를 비활성화한다. 원래 일반 상태를 변경하거나 restoreState에 새 임의 mode 필드를 저장하지 않는다. invalid는 요청을 시작하지 않고 token을 증가시켜 이전 결과를 무효화한다. runtime 생성부의 onChange도 현재 화면이 invalid이면 이전 operation 오류를 표시하지 않도록 보호한다. 일반 KPI/필터/정렬/집계는 각각 wrapper 또는 hidden 처리로 product 모드에서 숨기고 복귀 시 복원한다. spec의 placeholder·aria-label·세 상태 문구를 그대로 사용한다. 기존 상세 링크의 startup, modal history와 닫기 동작을 유지한다. legacy v1은 catalog 준비 후 key lookup으로 같은 표시 의미를 제공하며 index 우회 성능 보장에서는 제외한다.

- [ ] **Step 4: 통과 확인**

Step 2 명령을 재실행한다. Expected: 새 browser tests 전부 PASS. 이어 `node --test tests/visualizer-html.test.js tests/dashboard-v2.test.js tests/visualizer-data.test.js`를 실행해 직렬화/HTML 회귀도 PASS인지 확인한다.

- [ ] **Step 5: 커밋**

Run: `git add src/dashboard.template.html tests/helpers/dashboard-page.js tests/browser/dashboard.test.js` 후 `git diff --cached --check`.
Run: `git commit -m "feat: support product IDs and URLs in dashboard search"`

### Task 5: 필터 안내·IME·통합 검증과 사용자 문서

**Files:**
- Modify: `src/dashboard.template.html:609-617,889-942,979-1015`
- Modify: `tests/browser/dashboard.test.js`, `README.md:300-309`

**Interfaces:**
- Consumes: Tasks 1–4의 검색 모드와 State.
- Produces: `필터 해제`는 src/cat/filter='all', brandKeys=[]로 만들되 q/sort 유지. 전체 초기화는 기존 동작. IME는 compositionend 후 180ms debounce 한 번만 실행한다.

- [ ] **Step 1: 실패 browser 테스트 작성**

`clear filters preserves query and sorting`에서 일반 검색 q='키뮤어 캐시미어', sort=priceAsc와 일치하지 않는 출처/카테고리/하락/브랜드 조건을 설정한다. `필터 해제` 클릭 후 아래 assertion과 localStorage의 src/cat/filter='all'을 확인한다. 브랜드 선택을 위한 fixture 값은 Task 4 search fixture의 실제 브랜드를 사용한다.

```js
await page.getByRole('button',{name:'필터 해제',exact:true}).click();
assert.equal(await page.locator('#q').inputValue(), '키뮤어 캐시미어');
assert.equal(await page.locator('#sortSel').inputValue(), 'priceAsc');
await page.locator('.card[data-k="musinsa:2156295"]').waitFor();
```

`composition searches only committed input`는 Worker postMessage에서 method='query' 호출 수를 테스트용 wrapper로 기록한다. fixture 초기 ready 뒤 compositionstart·여러 input을 dispatch하고 250ms 후 추가 query가 0회인지 확인한다. compositionend와 trailing input 후 250ms에 정확히 한 번이고 최종 문자열인지 assert한다. file://는 동일 결과와 input 상태를 검증하고 Worker 계수 검사는 HTTP에서 수행한다.

`filter clearing uses current pending input and full reset cancels it`는 180ms 전에 필터 해제/전체 초기화를 각각 클릭해 최신 q 보존과 전체 q 비움을 확인한다. `query failure marks counts unknown and labels previous cards`는 localStorage로 무신사 아우터만 먼저 준비하고 무신사 상의 index를 차단한 뒤 같은 출처에서 카테고리를 전체로 넓힌다. 전체 인덱스가 이미 cache된 상황에서 실패를 유도하지 않는다. 이전 카드 표시 문구·건수 —·재시도를 확인한다. `estimated drop exclusion has an explanation`은 ESTIMATED coat가 일반 하락 필터에서 빠지지만 spec 안내가 표시되는지 확인한다. 새 접근성 이름을 사용하도록 기존 browser searchbox 선택자도 갱신한다.

- [ ] **Step 2: 실패 확인**

Run: `CLOT_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test --test-name-pattern='clear filters|composition searches|filter clearing|query failure marks|estimated drop exclusion' tests/browser/dashboard.test.js`
Expected: 필터 해제/IME/오류 집계 안내 assertion에서 FAIL.

- [ ] **Step 3: 필터·입력 상태 구현**

활성 조건 요약과 필터 해제 버튼을 일반 검색 resultbar에 추가한다. 저장 값 갱신과 brandSearch 초기화를 포함한다. 필터 해제는 pending timer를 취소하고 qEl의 최신 값을 state.q에 반영한다. compositionstart/end와 input의 composing flag로 spec debounce 규칙을 구현한다. 전체 초기화는 timer와 composing flag도 정리한다. loading/error painter는 shownN과 모든 미확정 facet/KPI를 —로 표시하고, 확정 0은 숫자 0으로 유지한다. 재시도는 현재 입력 모드의 render를 재실행한다.

- [ ] **Step 4: 사용자 문서 반영**

README의 dashboard 검색 설명에 AND 단어 검색, 붙여쓰기 처리, 숫자=무신사·출처 접두어·허용 URL, 직접 조회의 필터 우회와 일반 검색 복원, 필터 해제/초기화 차이, 미등록과 실패 구분을 추가한다. 성능 개편이나 오타 교정을 완료했다고 쓰지 않는다.

- [ ] **Step 5: 통합 검증**

Run: `node --test 'tests/*.test.js'`
Expected: 전체 unit/integration PASS. 기존 baseline 실패는 별도로 비교하고 새 실패를 허용하지 않는다.

Run: `CLOT_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test tests/browser/dashboard.test.js`
Expected: 전체 browser PASS, pageerror 0. 기존 44만 상품 fixture의 마지막 상품 검색·페이징·상세·빠른 범위 전환 테스트 포함.

아래 명령으로 production builder가 만든 임시 search fixture를 독립 검증한다. 종료 시 임시 파일은 정리된다.

```bash
node --input-type=module <<'JS'
import './tests/setup-env.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writeFixture} from './tests/helpers/dashboard-page.js';
import {verifyDashboardBuild} from './scripts/verify-dashboard-build.js';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-search-verify-'));
try {
  writeFixture(directory, {search:true});
  console.log(JSON.stringify(verifyDashboardBuild(path.join(directory,'index.html'))));
} finally {
  fs.rmSync(directory, {recursive:true,force:true});
}
JS
```

Expected: exit 0과 totalItems/total4910/scanState JSON. HTTP/file://에서 spec 입력 7개와 모드 복원을 확인하고, routes/card 실패 후 재시도를 확인한다. 실제 Release 다운로드·수집 실행·Pages 배포는 수행하지 않는다.

- [ ] **Step 6: 최종 범위 검토와 커밋**

Run: `git diff --check` 및 `git status --short`. Expected: 범위 밖 실행 데이터의 변화 없음. 새 문서와 제품 변경 외 파일은 스테이징하지 않는다.
Run: `git add src/dashboard.template.html tests/browser/dashboard.test.js README.md` 후 `git diff --cached --check`.
Run: `git commit -m "fix: clarify dashboard search filters and input states"`

## 자기 검토 기록

- Spec coverage: 입력/일치 Task 1, 별칭/직렬화 Task 2, 취소/조회/재시도 Task 3, 화면/모달/호환 Task 4, 필터/IME/문서/전체 회귀 Task 5. 범위 밖 성능 개편은 구현하지 않는다.
- Type consistency: 검색 해석 결과는 SearchInput, 일반 결과 구조는 유지, product 결과는 mode/key/item, 새로운 공개 runtime 함수는 searchProduct뿐이다. cancelQuery는 transport/RPC 전용이다.
- Review Focus: 다섯 항목 모두 해당 task의 명명된 테스트에 연결했다.
- Proportion: 함수 본문을 계획에 대신 작성하지 않고 서명·규칙·핵심 assertion만 명시했다.
- Execution boundary: 계획 작성 턴에서는 제품 코드/테스트 실행/커밋/배포를 시작하지 않는다. 실행 방식은 아직 선택되지 않았다. 작업 간 공유 model·직렬화·runtime 계약이 많으므로 Native를 추천하고, 구현 완료 후 독립 리뷰를 수행한다.
