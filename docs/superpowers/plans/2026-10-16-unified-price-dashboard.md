# Unified Price Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모든 수집 상품을 `전체 / 무신사 / 4910`에서 검색하고, 공통 브랜드 필터와 일관된 건수를 제공한다.

**Architecture:** 전체 검색·카드용 요약과 상세 가격 이력을 분리한다. Node 빌드와 브라우저는 동일한 순수 모델을 사용하고, 4910 요약은 전부 로딩한 뒤 검색·집계에 참여시킨다. 기존 브랜드별 이력 파일은 상세에서만 읽고, 요약 객체와 집계를 변경하지 않는다.

**Tech Stack:** Node.js 24, ESM, node:sqlite, node:test, 순수 JavaScript/HTML/CSS, 기존 Chart.js, 정적 GitHub Pages, 개발 검증용 Playwright 1.62.1.

**Spec:** [확정 설계](../specs/2026-10-16-unified-price-dashboard.md). 실행자는 두 문서를 함께 읽는다. 이 계획은 아직 구현되지 않았다.

## Global Constraints

- 출처 버튼은 `전체 / 무신사 / 4910`이다. `전체`는 무신사와 4910의 합집합이며, 4910 찜과 일반 수집 상품을 별도 출처로 표시하지 않는다.
- 브랜드 선택창은 모든 출처에서 공통으로 제공한다. 브랜드는 다중 선택하고 즉시 반영한다. 미선택은 모든 브랜드를 뜻한다.
- 동일 4910 ID가 찜과 수집에 동시에 있으면 찜 데이터를 우선해 한 번만 포함한다.
- GitHub Pages와 로컬 `file://` 열기를 지원한다. 별도 서버 API는 도입하지 않는다.
- 가격 이력이 아직 다운로드되지 않았다는 이유로 관측 대기 상품으로 취급하지 않는다.
- 카드 렌더링은 기존처럼 120개씩 한다. 모든 숫자는 천 단위 쉼표를 사용한다.
- 새 최상위 테스트의 첫 줄은 `import './setup-env.js';`로 한다. `tests/browser/`에서는 `import '../setup-env.js';`를 먼저 읽고 임시 DB와 생성 경로만 사용한다. 저장소의 test-isolation 검사와 실제 DB 보호 규칙을 유지한다.
- 수집 대상·DB 스키마·회원가와 최저가 판정 기준·다른 쇼핑몰 상품의 동일 모델 병합은 바꾸지 않는다.
- 현재 main과 미추적 `data/4910-all.js`를 보존한다. 실행 시 using-git-worktrees로 별도 워크트리를 준비하고, 생성 결과는 전용 임시 디렉터리에 둔다. push·merge·배포는 별도 사용자 지시가 있어야 한다.

## Review Focus

1. 같은 숫자 ID가 다른 출처에 있거나 4910 찜과 수집에 겹치는 입력: 별개 출처는 유지하고 4910 중복만 회원가 우선으로 제거한다. Task 1·2에서 검증한다.
2. 가격 기준 전환·이력 없음·변하지 않은 수집 가격: 요약과 상세의 판정이 같고 가짜 하락·최저가가 생기지 않는다. Task 1·2에서 검증한다.
3. 중간 요약 파일 실패·다른 revision·부분 빌드: 정상 0건과 구분하고 재시도해도 누적 중복이나 그럴듯한 전체 건수가 생기지 않는다. Task 2·3에서 검증한다.
4. 상세 요청 A 이후 B 선택 또는 닫기, 저장된 구형 링크와 숨은 필터: 늦은 A가 B를 덮어쓰지 않고 구형 링크는 올바른 상품을 연다. Task 3·4에서 검증한다.
5. 조합형 한글·빈 브랜드·0건 선택·작은 화면·키보드: 브랜드 정체성과 선택이 보존되고 잘림·초점 이탈·숨은 클릭 대상이 없다. Task 1·5에서 검증한다.

---

## 실행 전 확인과 파일 구조

계획 시 확인: 현재 main, Node v24.17.0, `data/4910.db` 없음. 번들 Playwright는 1.62.1이나 전용 Chromium은 없고 설치된 Google Chrome은 있다. 기존 테스트는 node:test이며 브라우저 테스트와 package-lock.json은 없다. 계획 작성 중 제품 코드는 바꾸거나 테스트를 실행하지 않았다.

실행 단계에서 승인된 두 문서를 읽을 수 있는 워크트리를 준비한다. 4910 운영 검증은 자격이 허용하면 기존 `4910-db pull`을 `CLOT_4910_DB_PATH`로 임시 경로에 내려받아 수행한다. 실패 시 픽스처 검증을 계속하되 운영 건수·성능 검증은 미수행으로 남긴다. 원래 `data/`에 생성 CLI를 실행하면 기존 미추적 파일을 지울 수 있으므로 금지한다.

| 파일 | 책임 |
|---|---|
| 새 `src/dashboard-model.js` | 가격 요약·식별·브랜드 키·검색·정렬·필터 집계의 순수 함수 |
| 새 `src/dashboard-catalog.js` | raw 데이터 → 요약/이력 패키징, 4910 파일 생성과 build revision |
| 새 `src/dashboard-runtime.js` | DOM과 분리한 스크립트 로더·완료 상태·상세 캐시·구형 상태 복원 |
| 수정 `src/visualizer.js` | 기존 추출/쿠폰 병합 유지, 새 카탈로그 빌드와 세 스크립트 인라인 주입 |
| 수정 `src/dashboard.template.html` | 통합 출처, 공통 브랜드 창, 결과 표시, 상세 로딩 UI |
| 수정 `src/cli.js` | 전체 요약 상품 수를 사용하는 완료 문구 |
| 새 `tests/helpers/dashboard-fixture.js` | 작은 canonical 데이터와 임시 DB·출력 픽스처, 합성 규모 데이터 |
| 새 `tests/dashboard-model.test.js`, `tests/dashboard-catalog.test.js`, `tests/dashboard-runtime.test.js` | 각 순수/빌드/비동기 경계 검증 |
| 수정 `tests/visualizer-data.test.js`, `tests/visualizer-html.test.js`, `tests/cli-visualize.test.js` | 기존 추출·생성·CLI 계약 회귀 |
| 새 `tests/browser/dashboard.test.js` | 실제 CSS·DOM·file/HTTP·반응형·규모 회귀 |
| 새 `scripts/verify-dashboard-build.js`, `tests/dashboard-build.test.js` | 생성 HTML·요약·상세 manifest의 revision/건수 교차 검증 CLI |
| 수정 `package.json`, 새 `package-lock.json` | 개발용 Playwright와 명시적 브라우저 테스트 명령 |
| 수정 `.github/workflows/pages.yml`, `README.md` | 새 파일 변경의 배포 트리거, 배포 전 검증, 조회/집계 설명 |

## 공통 계약

`createDashboardModel()`은 외부 참조 없는 factory다. Node에서 import하고 브라우저에는 `(${createDashboardModel.toString()})()` 형태로 빌드 시 인라인한다. runtime factory도 같은 방식으로 인라인하고 model을 인자로 전달한다. 브라우저 런타임 import/fetch 없이 `file://`을 지원하며 factory 문자열을 VM에서 실행하는 테스트로 자유 변수를 검사한다.

- `Source = 'musinsa' | '4910'`; `Kind = 'musinsa' | 'liked' | 'scan'`; `Key = 'musinsa:ID' | '4910:ID'`.
- `HistoryRow = [date, normal, sale, my, soldout, basis, discount, newbie?]`: 기존 7/8 슬롯과 nullable 가격을 유지한다.
- `RawItem = { n,k,src,b,m?,g,u,i,s,c,fs,L,kind?,bs? }`: 기존 빌더의 반환값은 유지하고 kind/bs만 필요한 위치에서 추가한다.
- `PriceMetrics = { tracked,my,sale,normal,newbie,isOut,isLow,dropAmt,rate,coupon,couponName,lowMy,lowDate }`: 기존 derive 필드와 의미를 유지한다. 금액/날짜의 결측은 null이다.
- `DetailRef = { type:'inline' } | { type:'brand', brandSno:number, path:string }`.
- `Summary = Omit<RawItem,'L'|'src'|'k'> & PriceMetrics & { k:Key,src:Source,kind:Kind,brandKey:string,detail:DetailRef,_hay:string,_init:string }`: 이력 L은 포함하지 않는다. 검색·이미지 placeholder 보조값은 모델이 준비한다. 정렬은 _idx 대신 canonical key를 최종 tie break로 쓴다.
- `FilterState = { q:string,src:'all'|Source,cat:string,brandKeys:string[],filter:'all'|'lowest'|'drop'|'onsale'|'out',sort:'category'|'rate'|'priceAsc'|'priceDesc'|'dropAmt'|'brand'|'new' }`.
- `QueryResult = { items:Summary[], total:number, sources:{all,musinsa,'4910'}, categories:Record<string,number>, brands:Array<{key,label,count}>, quick:{all,lowest,drop,onsale,out} }`: 모든 count는 정수다.
- `CatalogManifest = { v:1,revision:string,scanState:'complete'|'partial'|'unavailable',scanCount:number,parts:Array<{id:string,path:string,count:number}>,notice:string|null }`.
- `Part = { v:1,revision:string,id:string,items:Summary[] }`. 파일은 `window.__CLOT_CATALOG_PARTS__[id] = Part`에 대입한다. 초기화 wrapper도 넣는다.
- 내장 payload는 기존 메타데이터와 `items:Summary[]`, `inlineHistories:Record<Key,HistoryRow[]>`, `catalog:CatalogManifest`다. 기존 raw payload 함수와 신규 HTML payload를 구분한다.
- 상세 파일 `4910/bSNO.js`는 기존 compact 형식을 유지하고 동일 `revision`을 추가한다. 한 번에 한 브랜드를 변환하고 요약은 최대 2,000개씩 `4910/catalog-NNNN.js`로 쓴다. 파트 수는 데이터에서 계산한다.
- revision은 빌드당 `randomUUID()` 한 개를 사용한다. 요약·manifest·상세가 일치해야 한다. 한 배포의 산출물을 함께 교체한다.

### Task 1: 공유 가격·검색·집계 모델

**Files:** Create `src/dashboard-model.js`, `tests/dashboard-model.test.js`, `tests/helpers/dashboard-fixture.js`; refer to existing template lines 685-729, 883-915, 965-1010.

**Interfaces:** Produces `createDashboardModel() -> { itemKey(source,id), resolveKey(value), brandKey(name), summarize(raw,{kind,detail}), mergeSummaries(base,scan), queryCatalog(items,state), restoreState(saved) }`. `summarize` returns Summary, merge returns unique Summary[], query returns QueryResult. restoreState supplies defaults, validates fields, maps old source/sort aliases. Brand choices use NFC/trim/collapsed whitespace/lowercase equality; no inferred translations. Within a brand selection use OR; across dimensions use AND.

- [ ] **Step 1: Add failing tests and the canonical fixture.** Fixture has `musinsa:1` 나이키 shoes 90→100, `musinsa:2` 아디다스 top 100→80, `4910:1` 나이키 shoes liked 100→90, `4910:3` 나이키 top scan constant 120, `4910:4` GU outer liked soldout 80. A duplicate scan `4910:1` priced 70 must lose to the liked 90. No coupons/price-basis switches in this baseline.

  Assertions: `mergeSummaries(...).length === 5`; source counts `{all:5,musinsa:2,'4910':3}`; quick counts `{all:5,lowest:3,drop:2,onsale:4,out:1}`; query `나이키` returns 3 with quick `{all:3,lowest:1,drop:1,onsale:3,out:0}`; add filter lowest and result is only `4910:1`, source counts `{all:1,musinsa:0,'4910':1}`, quick remains the preceding 3-item counts. Compare every facet against an independently written fixture predicate which ignores only that facet; iterate all 3 sources × 5 filters × categories × empty/single/multiple brands × empty/name/no-hit search. Do not derive expected values by calling queryCatalog again.

  Pin `resolveKey('1') === 'musinsa:1'`, cross-source same ID separation, member-price precedence independent of arrival order, all seven existing sorts with canonical-key tie break, missing-price ordering, decomposed Korean brand equality, 0-price preservation, no-history defaults, switched basis has no false drop, constant scan has isLow false. Test old source `4910all → 4910`, sort aliases, invalid saved values, and the factory VM path.

  ```js
  test('facet counts ignore only their own dimension', () => {
    const r = model.queryCatalog(fixture.items, { ...fixture.state, q: '나이키', filter: 'lowest' });
    assert.deepEqual(r.items.map(x => x.k), ['4910:1']);
    assert.deepEqual(r.sources, { all: 1, musinsa: 0, '4910': 1 });
    assert.deepEqual(r.quick, { all: 3, lowest: 1, drop: 1, onsale: 3, out: 0 });
  });
  ```
- [ ] **Step 2: Run `node --test tests/dashboard-model.test.js`.** Expect missing-module/export failure before implementation.
- [ ] **Step 3: Implement the model factory.** Port existing derive rules without changing membership/price math. `kind === 'scan'` replaces the former price-rule dependency on src 4910all. Merge by canonical key with liked precedence. queryCatalog follows the spec facet table and uses stable key tie breaks. Missing categories become `etc`; retain every unique brand, including 0-count selected choices. Do not mutate caller arrays or summaries.
- [ ] **Step 4: Run the Task 1 command.** Expect PASS for all fixture cases and factory execution in Node/VM. Record the 626/489/119/609/17 local baseline only if the unchanged local DB is available; it is not a hardcoded production assertion.
- [ ] **Step 5: Inspect staged diff and commit only Task 1 files.** Run `git diff --cached --check`; message `feat(dashboard): share price and facet calculations`.

### Task 2: 전체 요약 파일과 상세 이력 빌드

**Files:** Create `src/dashboard-catalog.js`, `tests/dashboard-catalog.test.js`; modify `src/visualizer.js:28-75,242-256,394-503`, `tests/visualizer-data.test.js`, `tests/visualizer-html.test.js`.

**Interfaces:** Consumes Task 1 factory and existing `buildClotDataPayload()`, `buildScan4910Index()`, `buildScan4910Payload()`. Produces `buildDashboardCatalog({baseItems,scanIndex,readBrand,dir4910,revision,scanState,notice}) -> { items,inlineHistories,catalog }`; `readBrand(brandSno)` supplies one existing compact payload at a time. Existing `generateDashboardHtml(options)` keeps its arguments and returns `{outputPath,targetGoodsNo,totalItems,total4910All,total4910,scanState}`; totalItems is now the unique full catalog count, total4910All stays scan-only for compatibility, total4910 includes liked.

- [ ] **Step 1: Add failing catalog and HTML integration tests.** Reuse the canonical fixture in temporary DBs/output directories. Assert 5 summaries, 2/3 source split, no L in summaries, inline histories for base items, liked 90 wins over scan 70, brand file maps to the same latest metrics as summaries, sum(part.count) equals scanCount, manifest/item keys are unique. For 2,001 scan items assert exactly 2 parts with counts 2,000/1. Evaluate data scripts in VM; verify shared revision, `<script>` closing strings and `$` text round-trip. Preserve existing no-liked-table, no-coupon-table, dropped/unliked exclusion and coupon-carry cases.

  Inject missing/corrupt DB and a failing second brand: expect usable base data plus explicit partial/unavailable state, no published partial scan files, no stale files after rebuild. Empty valid scan is complete count 0, distinct from unavailable. Set fixture db4910Path explicitly so tests never accidentally read a user's default DB. Existing raw buildClotDataPayload keys/tuples stay compatible; update HTML-only old v2-brand-list assertions to new summary behavior.

  ```js
  test('summary package includes every unique item without histories', () => {
    assert.equal(result.totalItems, 5);
    assert.equal(result.total4910, 3);
    assert.equal(result.total4910All, 1);
    assert.equal(allSummaries.some(x => Object.hasOwn(x, 'L')), false);
    assert.equal(allSummaries.find(x => x.k === '4910:1').my, 90);
  });
  ```
- [ ] **Step 2: Run `node --test tests/dashboard-catalog.test.js tests/visualizer-data.test.js tests/visualizer-html.test.js`.** New contract tests must fail before implementation.
- [ ] **Step 3: Implement buildDashboardCatalog and generator integration.** Convert compact history with existing coupon/indicated-price basis rules before Task 1 summarize. Recover liked brandSno from goods by ID when available, and use existing display-name fallback otherwise. Generate summaries/history files in a temporary staging directory; a scan failure discards the staged scan set and rebuilds a base-only manifest with notice. Keep no all-history accumulation in memory. Write all generated files under the requested output directory; preserve the existing default DB/extraction API. Inline model/runtime via distinct placeholder comments separate from the data placeholder. Runtime placeholder is an empty stub until Task 3.
- [ ] **Step 4: Run the Task 2 command.** Expect all tests PASS; regenerate twice in one disposable output to prove stale scan cleanup. No production DB writes or data/dashboard.html changes.
- [ ] **Step 5: Commit Task 2 files after staged diff/check.** Message `feat(dashboard): build complete summaries with lazy histories`.

### Task 3: 완료 상태와 요청 충돌을 관리하는 요약·상세 로더

**Files:** Create `src/dashboard-runtime.js`, `tests/dashboard-runtime.test.js`; modify `src/visualizer.js` inline runtime assembly; extend `tests/visualizer-html.test.js`.

**Interfaces:** Produces external-reference-free `createDashboardRuntime({model,baseItems,inlineHistories,manifest,loadScript,onChange}) -> { getCatalog(),ensureCatalog(),getHistory(key),retryCatalog() }`. `loadScript(path) -> Promise<Part|BrandPayload>` is injected. `getCatalog()` returns `{status:'idle'|'loading'|'ready'|'error',items:Summary[],scanState,notice,error:null|string}`. ensure/retry resolve that state and notify onChange; getHistory resolves HistoryRow[] or rejects. Base items are available while all/4910 queries wait. Browser adapter injects script tags, checks the expected global, and rejects after 15,000ms, removing failed tags and timers.

- [ ] **Step 1: Write deferred-promise tests.** Fail the middle part and assert catalog status error, no scan items become authoritative, and retry yields 5 unique items instead of duplicates. Reject incorrect revision, wrong id/count, duplicate key, duplicate part completion; valid repeated calls reuse one promise. getHistory on inline item does not call loadScript; same brand loads once for two keys; failed promise can retry. Returned history must not change Summary or queryCatalog result/order. A brand with the wrong revision or missing requested ID rejects. VM-evaluate runtime factory with only injected dependencies; test timeout/tag cleanup through the browser adapter in Task 5.

  ```js
  test('retry replaces a failed staged catalog without duplicates', async () => {
    loader.failOnce('catalog-0001');
    assert.equal((await runtime.ensureCatalog()).status, 'error');
    const ready = await runtime.retryCatalog();
    assert.equal(ready.status, 'ready');
    assert.equal(new Set(ready.items.map(x => x.k)).size, 5);
  });
  ```
- [ ] **Step 2: Run `node --test tests/dashboard-runtime.test.js tests/visualizer-html.test.js`.** Expect missing factory or new behavior failure.
- [ ] **Step 3: Implement the factory and inject its source.** Validate a whole incoming catalog before swapping the authoritative array. Read detail into a separate cache; never append detail-loaded items to the search array. Limit simultaneous summary script requests to 4. Paths must come from the same-build manifest/detail reference. onChange only signals state, never chooses a UI source or reopens a dialog.
- [ ] **Step 4: Run the Task 3 command.** Expect PASS for deferred races, retry, validation and factory injection. Keep browser-only globals outside the pure factory.
- [ ] **Step 5: Commit Task 3 files after staged diff/check.** Message `feat(dashboard): isolate catalog and history loading state`.

### Task 4: 통합 출처·전체 검색·상세 연결

**Files:** Modify `src/dashboard.template.html:549-584,685-915,957-1115,1145-1292,1453-1465`, `src/cli.js:1143-1161`, `tests/cli-visualize.test.js`, `tests/visualizer-html.test.js`; create `tests/browser/dashboard.test.js`; modify `package.json`, create `package-lock.json`.

**Interfaces:** Consumes model queryCatalog/restoreState and runtime APIs. Produces one canonical FilterState, result rendering from QueryResult, and `openModal(key)` with a monotonically increasing request token. Existing detail drawing receives `{...summary,L:history}` only when history is ready; summary facts remain visible while loading. Expose no test-only window hooks; browser tests use accessible controls and rendered results.

- [ ] **Step 1: Add failing generated-page browser tests.** Use temporary fixture output over an ephemeral node:http server and file://. Assert exactly three source buttons with counts 5/2/3, initial 5 results, Nike search 3, lowest 1 with quick-all 3, source counts 1/0/1 for that combination. Price-ascending order is identical before/after loading every history. Restore clot.src=4910all as 4910; resolve old `?goods=1`, current canonical keys and `?goods=4910:1&brand=...`; product outside selected category/brand must open and become locatable. Delay A history, open B, resolve A and assert B remains; close before completion and assert closed. Force detail failure and retain counts/cards with a history retry. Test source change to musinsa during delayed catalog completion.

  Add CLI assertions using child-process fixture paths `CLOT_DB_PATH`, `CLOT_4910_DB_PATH`, `CLOT_DASHBOARD_PATH`: stdout must contain `총 5개 상품 반영 완료.`; generator return totals 5/3/1 remain covered by Task 2. CLI copy becomes `총 N개 상품 반영 완료.` so it does not claim every history was downloaded. Install dev dependency with `npm install --save-dev --save-exact playwright@1.62.1`; add `test:dashboard:browser = node --test tests/browser/dashboard.test.js`. The test launcher uses `CLOT_BROWSER_EXECUTABLE` when provided, otherwise Playwright's installed Chromium. Launch failure is a failure, never a silent skip. Block external image/CDN requests in tests and use a minimal local Chart stub to verify history handoff; Chart rendering itself remains unchanged.

  ```js
  test('search covers a brand whose history was never requested', async () => {
    await page.getByRole('searchbox', { name: '브랜드 또는 상품명 검색' }).fill('나이키');
    await page.waitForFunction(() => document.querySelector('#shownN').textContent === '3');
    assert.equal(await page.locator('.card').count(), 3);
    assert.equal(requestedHistoryPaths.length, 0);
  });
  ```
- [ ] **Step 2: Run `CLOT_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:dashboard:browser` and `node --test tests/cli-visualize.test.js tests/visualizer-html.test.js`.** Expect the old four-source/loaded-only page to fail the new behavior assertions.
- [ ] **Step 3: Replace duplicated page calculations with the shared contracts.** Remove src=4910all UI/state and brand-gated loading. All/4910 ensureCatalog automatically; musinsa queries only base musinsa immediately. While loading/error, all/4910 show `집계 중`/retry instead of partial totals. Partial/unavailable build notice remains visible alongside available results. Format all counts; KPI mirrors quick facets; count text distinguishes total from rendered. Preserve source/sort persistence and numeric deep links, reset all conflicting dimensions for directly opened products, and invalidate pending detail request tokens on close/step/open. Update CLI totals/copy without changing argument parsing.
- [ ] **Step 4: Run both Task 4 commands.** Expect PASS over HTTP and file://, including no summary script loaded on a restored musinsa-only view and no history script loaded merely to compute counts.
- [ ] **Step 5: Commit Task 4 files after staged diff/check.** Message `feat(dashboard): unify source filtering and full catalog search`.

### Task 5: 모든 출처 공통 브랜드 선택창과 툴바

**Files:** Modify `src/dashboard.template.html:79-79,140-205,425-446,531-577,1219-1239`, extend `tests/browser/dashboard.test.js`, `tests/visualizer-html.test.js`.

**Interfaces:** Consumes QueryResult.brands and FilterState.brandKeys. Produces labelled `브랜드 선택` dialog, independent `브랜드 찾기` input, instant multi-selection, and summary chips with separate remove buttons. The dialog search only filters choices, never state.q or product results. It is available for all three sources; on incomplete all/4910 catalog its choices show loading/error instead of pretending the base list is complete.

- [ ] **Step 1: Add failing browser tests.** For all/musinsa/4910 open the picker and select normalized 나이키: baseline results are respectively 3/1/2. Add GU (OR), change to musinsa and keep selected GU removable even with count 0. NFC/NFD duplicates form one option, distinct untranslated brand names remain separate, empty fallback names render. Removing the last selected chip restores all brands; global reset clears brands and product/brand search fields. At 390×844 and 1440×1000 assert dialog fits viewport, long labels wrap, summary never exceeds two named brands plus `외 N개`, hidden elements have no layout/focus, closed state returns focus. Test Escape, Tab, Shift+Tab, slash shortcut, backdrop dismissal and focus transfer when product detail opens. Test header wrapping does not overlap sticky toolbar and count 0 is visible rather than treated as missing.

  ```js
  test('brand dialog returns focus and becomes hidden', async () => {
    const trigger = page.getByRole('button', { name: '브랜드 선택', exact: true });
    await trigger.click();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog', { name: '브랜드 선택' }).count(), 0);
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
  });
  ```
- [ ] **Step 2: Run the Task 4 browser command.** Expect picker and hidden-layout failures before UI changes.
- [ ] **Step 3: Implement the common dialog and toolbar refinement.** Read impeccable craft-floor immediately before UI edits. Use a single native dialog, desktop constrained panel and mobile bottom sheet; instant selection means no apply button. Separate source/category/quick groups with readable labels. Add explicit `[hidden]{display:none!important}` for the page's boolean hidden use. Use ResizeObserver for actual topbar height, with an initial measured fallback. Close dialog on source changes, preserve selected keys, restore focus. Show an `기타` category only when its count is positive or it is selected; unknown categories remain accessible. Preserve incumbent tokens and scope selectors so brand controls do not trigger product shortcut/event handlers.
- [ ] **Step 4: Run browser tests and inspect the two viewport screenshots in one batch.** Fix demonstrated defects in one batch and confirm once; record screenshot locations in the verification note. Expect no page errors, horizontal overflow, clipped options, or hidden active controls. Run the Impeccable mechanical detector once on the changed template if available, and resolve actionable findings in scope.
- [ ] **Step 5: Commit Task 5 files after staged diff/check.** Message `feat(dashboard): share accessible brand picker across sources`.

### Task 6: 전체 규모·배포 계약 검증과 문서

**Files:** Extend `tests/browser/dashboard.test.js`, `tests/dashboard-catalog.test.js`; create `scripts/verify-dashboard-build.js`, `tests/dashboard-build.test.js`; modify `.github/workflows/pages.yml:6-10,40-57`, `README.md`; create `docs/verification/2026-10-16-unified-price-dashboard.md` during execution.

**Interfaces:** Uses the full generator/runtime/UI contracts. Produces `verifyDashboardBuild(outputPath:string) -> {totalItems:number,total4910:number,scanState:string}` exported from the new script; direct CLI `node scripts/verify-dashboard-build.js PATH` prints that JSON and exits 0 on consistency, nonzero on missing/mismatched parts/revision/count. Importing the script must not run its CLI. Produces deployment checks covering every new source dependency, a reproducible scale scenario, and a verification record separating synthetic/local/live evidence.

- [ ] **Step 1: Add failing scale/build checks.** Generate exactly 140,129 unique summaries (626 musinsa and 139,503 4910 including liked), assert source count arithmetic and rendered cards=120 before auto-pagination; hold IntersectionObserver in this test until explicit load-more. Search a sentinel existing only in the last part, assert exact result and all facet counts. Open details and assert no count/order changes. Check generated summaries contain no L, history requests remain zero until detail, and rebuild does not leave old part/history files. Measure 10 warmed search/facet/sort operations using performance.now and record median/max; this fixture proves scale behavior, not current production quantities.

  ```js
  test('build verifier rejects incomplete parts instead of passing a subtotal', () => {
    assert.deepEqual(verifyDashboardBuild(outputPath), { totalItems: 5, total4910: 3, scanState: 'complete' });
    fs.unlinkSync(lastPartPath);
    assert.throws(() => verifyDashboardBuild(outputPath), /missing catalog part/);
  });
  ```

  Also reject wrong revision/count and missing detail files; accept a valid empty scan and a base-only unavailable/partial manifest with its mandatory notice. Verify the script's CLI exits nonzero for invalid output and only prints aggregate fields, not item data.
- [ ] **Step 2: Run `node --test tests/dashboard-build.test.js tests/dashboard-catalog.test.js` and the browser command.** Expect the missing verifier to fail first; scale assertions must be present and actually execute with no skipped or zero-test success. A deterministic scale failure must be resolved before completion. If individual interactive operations block the browser for at least 1,000ms, record the evidence and revisit scheduling before claiming the UI is ready; do not weaken scope or accuracy to hit the diagnostic threshold.
- [ ] **Step 3: Implement the verifier, CI and user documentation.** Parse the generator's data placeholder and run only generated data files in an isolated VM; use Task 1 merge/identity rules to cross-check counts, validate every referenced part/detail revision, and reject missing files. Add new model/catalog/runtime/verifier files, relevant tests, package.json/lock to Pages push path filters. In the existing Node 24 job add npm ci, focused dashboard node tests, `npx playwright install --with-deps chromium`, and browser tests before build/upload. Replace the optional 4910 index check with `node scripts/verify-dashboard-build.js _site/index.html`, retaining explicit partial/unavailable behavior when the release is absent. Explain source union, common brands, facet counts, full-summary loading and lazy history in README. Do not publish or push from this task.
- [ ] **Step 4: Run focused checks, then the full suite once.** Run `node --test tests/dashboard-model.test.js tests/dashboard-catalog.test.js tests/dashboard-runtime.test.js tests/dashboard-build.test.js tests/visualizer-data.test.js tests/visualizer-html.test.js tests/cli-visualize.test.js`; run browser tests; then `npm test`. Expect zero failures and no silent browser skips. Build a representative fixture in a disposable directory and verify file:// plus HTTP. If authorized credentials work, download the real 4910 release to a temporary CLOT_4910_DB_PATH and independently compare DISTINCT IDs and generated summary counts; report lastScan and whether the asset is current or fallback. If unavailable, report that exact limitation without claiming live parity. Record commands, actual output, revision, viewport screenshots and timing in the verification note. Check that CLI/DB tests have not touched source data via git status.
- [ ] **Step 5: Self-review requirements against the spec and review the complete branch before integration.** Run `git diff --check` and inspect staged changes; commit only Task 6 files with `test(dashboard): verify catalog scale and deployment contract`. Use requesting-code-review in the execution method chosen by the user. Stop at the reviewable branch; no automatic merge, push or deployment.

## 계획 자체 검토

- 제품 범위: 출처 통합(Task 2·4), 공통 브랜드(Task 1·5), 전체 검색과 독립 집계(Task 1·4), 요약/이력 분리(Task 2·3), 실패·기존 상태 복원(Task 3·4), 접근성·표시 오류(Task 5), 배포와 규모(Task 6)를 연결했다.
- 타입: 모델은 canonical Summary만 조회하고 raw 추출 API는 유지한다. runtime은 이력을 별도 캐시하며 DOM은 모델·runtime 외의 별도 가격/집계 수식을 만들지 않는다.
- Review Focus의 다섯 항목에 테스트를 배정했다. 각 작업은 실패 확인, 구현, 통과 확인, 범위 커밋 단계를 포함한다.
- 구현 전 검토 항목: 아직 운영 4910 DB와 실측 성능을 검증하지 않았다. 이 사실은 Task 6의 조건이며 합성 픽스처로 숨기지 않는다. 실행 방식은 사용자가 아직 선택하지 않았다.
