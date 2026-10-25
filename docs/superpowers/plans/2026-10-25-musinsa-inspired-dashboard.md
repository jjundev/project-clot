# Musinsa-inspired CLOT Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 무신사·4910의 기존 가격 추적 기능을 유지하면서 무신사 스타일의 목록과 페이지형 가격 상세를 제공한다.

**Architecture:** 기존 정적 HTML 템플릿의 DOM·CSS·조회 연결을 변경하고 모델·Worker·분할 데이터·가격 계산은 재사용한다. URL/history 전이만 직렬화 가능한 작은 navigation factory로 분리한다. 목록을 보존한 채 상세를 전환하여 기존 120개 배치·360개 DOM 제한과 목록 복귀를 함께 유지한다.

**Tech Stack:** Node.js 24, ESM, node:sqlite, vanilla HTML/CSS/JavaScript, 기존 Chart.js, node:test, Playwright, GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-10-25-musinsa-inspired-dashboard-design.md` — 채팅 설계와 기본 확정된 #7·#8 포함. 실행자는 두 문서를 모두 읽는다.

## Global Constraints

- Node.js 24, ESM, node:sqlite, node:test, 기존 Playwright를 사용하며 새 의존성을 추가하지 않는다.
- 무신사·4910 모두 유지하고 첫 방문 출처는 `all`, 가격 필터는 `all`, 정렬은 `dropAmt`로 한다.
- 기존 정상 저장값과 `4910all`, `coupon`, `couponRate` 호환을 유지한다. 전체 초기화는 새 기본값으로 돌아간다.
- 직접 확인·추정·미확인 가격, 확인일, 신규회원가, 적립금 적용 가정을 구분한다. 적립금 추정가로 현재 가격·정렬·차트·최저가·하락 판정을 대체하지 않는다.
- 신선도 48시간, 동일 기준 비교, 과거 기록 포함, 검증·보정된 4910 가격, 기존 최저가·하락 계산은 유지한다.
- 목록 배치는 120개, 목록 DOM의 상품 카드는 최대 360개, bootstrap 상품은 최대 120개를 유지한다. 목록에서는 상품별 가격 이력을 요청하지 않는다.
- 기본 상세 기간은 90일, 선택 기간은 7·14·30·90일·전체이며 전체는 `days:0`으로 조회한다.
- 최대 콘텐츠 폭 1440px, 상품 이미지 5:6, 검증 화면 폭 390·768·1440px, 모바일 상품 2열, 페이지 전체 가로 스크롤 없음.
- 저장된 테마는 복원하고 저장값이 없으면 밝은 본문을 기본으로 한다. 다크 모드도 유지한다.
- GitHub Pages `/project-clot/`와 로컬 `file://`에서 동작하고, 기존 `?goods=1`, `?goods=musinsa:1`, `?goods=4910:1`, 선택적 `brand`와 `targetGoodsNo`를 지원한다.
- 수집·DB 스키마·스냅샷 형식·공개 v2 데이터 계약·기존 메모리 제한을 변경하지 않는다.
- `rea-musinsa/`는 참고 자료로 보존하고 런타임 의존성으로 가져오지 않는다. 더미 상품·가격·후기·추가 사진·상거래 코드는 사용하지 않는다.
- 운영 DB, 생성된 `data/dashboard.html`, 다른 미추적 파일과 사용자 변경은 수정·삭제·스테이징하지 않는다.

## Review Focus

1. `/project-clot/` 하위 경로의 직접 상세 진입·새로고침·외부 history: 목록 복귀가 사이트를 벗어나지 않아야 한다. Task 2·4에서 검증한다.
2. 120개 이후 또는 가상 목록 후반의 카드: 상세 왕복 후 조건·구간·스크롤·포커스가 복원되고 DOM이 360개를 넘지 않아야 한다. Task 5에서 검증한다.
3. 이력·기간 요청 도중 뒤로가기·다른 상품·다른 기간 선택: 늦은 응답이 새 선택이나 목록을 덮지 않아야 한다. Task 4에서 검증한다.
4. 검색 인덱스·이력·이미지·Chart.js 실패와 수집 안내: 요약·가격 기준·재시도 또는 사용 가능한 표를 유지해야 한다. Task 3·4에서 검증한다.
5. 저장된 테마·정렬·구형 출처, 적립금 opt-in, 열린 화면에서 49시간 경과: 복원·가격 비교·오래된 기록이 새 디자인에서도 일관되어야 한다. Task 1·3·4에서 검증한다.

---

## 파일 구조와 책임

| 파일 | 처리 | 책임 |
|---|---|---|
| `src/dashboard-model.js` | 수정 | 기본 정렬만 변경. 가격 계산과 기존 정렬 비교자는 보존 |
| `src/dashboard-navigation.js` | 생성 | DOM·데이터 조회 없는 URL/history 상태 전이 factory |
| `src/dashboard.template.html` | 수정 | 디자인, 목록·상세 표시, 포커스/스크롤 복원, 기존 runtime 연결 |
| `src/visualizer.js` | 수정 | navigation factory를 기존 단일 HTML에 주입 |
| `tests/dashboard-navigation.test.js` | 생성 | 탐색 전이와 직렬화 회귀 |
| `tests/dashboard-model.test.js` | 수정 | 새 기본값과 구형 설정 호환 |
| `tests/helpers/dashboard-fixture.js` | 수정 | 공통 fixture 기본 정렬 동기화 |
| `tests/helpers/dashboard-page.js` | 수정 | scale fixture에도 factory 주입 |
| `tests/visualizer-html.test.js` | 수정 | 생성된 HTML의 factory 실행 확인 |
| `tests/browser/dashboard.test.js` | 수정 | 기존 fixture/setup 재사용, 새 UI와 탐색·복원 검증 |
| `docs/verify/2026-10-25-musinsa-inspired-dashboard.md` | 실행 마지막에 생성 | 검증 명령·결과·화면·변경 전후 측정·한계 |

수정 예정 위치는 조사 HEAD `6ef9f3e` 기준: 모델 `88–119`, 템플릿 CSS `10–507`, DOM `510–696`, 목록 `912–1096`, 상세 `1122–1303`, 초기화 `1471–1488`, visualizer 주입 `539–542`, scale fixture `83–88`. 줄번호는 탐색용이고 실행 시 실제 소스를 확인한다. `package.json`은 이미 사용자 변경이 있으므로 이번 계획에서 수정하지 않는다.

## 실행 전 준비

- [ ] 실행 방식이 선택된 뒤 `using-git-worktrees`로 격리한다. `rea-musinsa/`는 현재 미추적이므로 원래 checkout의 절대 경로에서 참고 이미지를 읽는다. 전체를 커밋하거나 워크트리에 무조건 복사하지 않는다.
- [ ] `node --version`, `git status --short`를 확인한다. Node 24를 사용하고 기존 사용자 변경을 기록한다.
- [ ] 현재 `npm run test:dashboard:browser`를 실행하고, 변경 전 로딩 비교가 가능한 임시 fixture 서버를 준비한다. `writeFixture(dir, {scale:true})`의 생성물에 기존 `measureDashboard`를 적용해 1440×1000, 동일 출처 시나리오, 3회 baseline을 `/tmp`에 보관한다. 임시 서버는 하위 경로 `/project-clot/`를 해당 디렉터리에 매핑한다.

### Task 1: 기본 탐색을 전체 상품·하락폭 순으로 통일

**Files:** Modify `src/dashboard-model.js:88–119`, `src/dashboard.template.html:1091–1095`, `tests/helpers/dashboard-fixture.js:11`; Test `tests/dashboard-model.test.js`, `tests/browser/dashboard.test.js`; Documentation `docs/superpowers/specs/2026-10-25-musinsa-inspired-dashboard-design.md`, `docs/superpowers/plans/2026-10-25-musinsa-inspired-dashboard.md`.

**Interfaces:** Consumes 기존 `createDashboardModel().restoreState(saved={})`, `queryCatalog(items,input,{asOfMs})`. Produces 같은 객체 형태·sort enum을 유지하며 미지정/잘못된 sort의 기본값만 `dropAmt`; 기존 `coupon → priceAsc`, `couponRate → rate`, `4910all → 4910`는 유지한다. builder·index·worker는 이 공통 기본값을 그대로 사용한다.

- [ ] **Step 1: 실패 테스트 작성.** 모델 테스트에 다음을 추가하고 기존 invalid-sort 기대값을 변경한다. 브라우저에는 `first visit and reset use dropAmt while saved sorts survive`를 추가하여 첫 진입/초기화 `#sortSel=dropAmt`, 저장된 `priceAsc`는 reload 후 유지, 하락 0개라도 `filter=all` 목록이 존재함을 단언한다.

```js
test('dropAmt defaults preserve saved and legacy sorts', () => {
  assert.equal(m.restoreState().sort, 'dropAmt');
  assert.equal(m.restoreState({sort:'invalid'}).sort, 'dropAmt');
  for (const sort of ['rate','priceAsc','priceDesc','brand','new','category','dropAmt'])
    assert.equal(m.restoreState({sort}).sort, sort);
  assert.equal(m.restoreState({sort:'coupon'}).sort, 'priceAsc');
  assert.equal(m.restoreState({sort:'couponRate'}).sort, 'rate');
  assert.equal(m.restoreState({src:'4910all'}).src, '4910');
});
```

- [ ] **Step 2: 실패 확인.** `node --test --test-name-pattern='dropAmt defaults' tests/dashboard-model.test.js` → 기본값이 `rate`라 FAIL.
- [ ] **Step 3: 기본값 구현.** 모델 `restoreState`의 fallback, template 전체 초기화, fixture `defaultState.sort`를 `dropAmt`로 맞춘다. 저장값은 덮어쓰지 않는다. 실제 가격 비교자와 tie-break는 수정하지 않는다. 새 기본순서에 의존하는 기존 테스트는 명시적인 sort가 필요한지 구분하여 기대값을 수정한다.
- [ ] **Step 4: 검증.** `node --test tests/dashboard-model.test.js tests/dashboard-index.test.js tests/dashboard-scope.test.js tests/dashboard-build.test.js tests/dashboard-v2.test.js` 및 `node --test --test-name-pattern='first visit and reset' tests/browser/dashboard.test.js` → 모두 PASS. 생성 bootstrap·source previews·검색 결과가 동일 기본 정렬을 사용하는지 기존 build 검증으로 확인한다.
- [ ] **Step 5: 커밋.** 위 Files의 실제 수정 파일만 `git add`하고 `git commit -m "feat: prioritize price drops in dashboard defaults"`.

### Task 2: 안전한 상세 탐색 factory와 단일 HTML 주입

**Files:** Create `src/dashboard-navigation.js`, `tests/dashboard-navigation.test.js`; Modify `src/visualizer.js:539–542`, `src/dashboard.template.html:731–732`, `tests/helpers/dashboard-page.js:83–88`, `tests/visualizer-html.test.js`.

**Interfaces:**

```js
createDashboardNavigation({window: win, model, onRoute})
// model.parseSearchInput(input) is the existing model method.
// onRoute(route) returns void; it starts UI work but navigation never awaits data.
// Route = {type:'catalog'}
//       | {type:'detail', key:string, brand:string|null}
//       | {type:'invalid', message:string}
// Return: start():void, open({key,brand=null}):void,
// replace({key,brand=null}):void, backToList():void, dispose():void
```

`win`은 location/history와 popstate 이벤트 API를 제공한다. factory는 모듈 외부 변수·import를 참조하지 않아 `toString()` 직렬화가 가능해야 한다. HTML에는 `/* __CLOT_NAVIGATION__ */`를 두고 `window.__CLOT_NAVIGATION_FACTORY__`에 factory를 주입한다. 이 단계에서는 기존 modal 동작을 교체하지 않는다.

- [ ] **Step 1: 실패 테스트 작성.** `tests/dashboard-navigation.test.js`는 `import './setup-env.js';`로 시작한다. 테스트 로컬 `createHistoryWindow(initialUrl)`는 URL, state, push/replace/back/forward, popstate listeners를 가진 최소 fake window를 반환한다. 실제 브라우저처럼 push/replace는 이벤트를 발생시키지 않고 back/forward만 popstate를 전달한다. 다음 단언을 작성한다.

```js
const w = createHistoryWindow('https://example.test/project-clot/?keep=1#catalog');
const routes = [];
const nav = createDashboardNavigation({window:w, model:createDashboardModel(), onRoute:r=>routes.push(r)});
nav.start();
nav.open({key:'musinsa:1'});
assert.equal(new URL(w.location.href).pathname, '/project-clot/');
assert.equal(new URL(w.location.href).searchParams.get('keep'), '1');
assert.equal(new URL(w.location.href).hash, '#catalog');
assert.equal(routes.at(-1).key, 'musinsa:1');
nav.replace({key:'4910:3',brand:'9'});
nav.backToList();
assert.equal(routes.at(-1).type, 'catalog');
w.history.forward();
assert.equal(routes.at(-1).key, '4910:3');
```

별도 named tests `direct detail returns locally without traversing foreign history`, `numeric and canonical goods resolve identically`, `invalid goods is not a broad catalog query`, `denied history falls back to in-page navigation`, `serialized navigation has no module dependencies`를 추가한다. 직접 진입·재생성된 controller는 과거 marker만 믿고 back하지 않아야 한다. `file:///tmp/site/index.html?goods=1`도 시험한다. 직렬화 테스트는 `vm`에서 `factory.toString()`을 실행한다. HTML 테스트는 `writeFixture`의 일반/scale 생성물 모두 factory를 포함하고 실행 가능한지 확인한다.
- [ ] **Step 2: 실패 확인.** `node --test tests/dashboard-navigation.test.js` → 신규 모듈이 없어 FAIL.
- [ ] **Step 3: factory 구현.** `new URL(win.location.href)`와 기존 parser로 goods를 읽고, query의 `goods`·`brand`만 수정한다. 직접 진입 invalid 값은 invalid route다. 목록→상세에만 push하고 상세 이전/다음은 replace한다. 같은 세션의 자신이 만든 목록 진입점일 때만 back한다. direct/reload/foreign entry는 goods·brand를 제거해 replace하고 catalog를 알린다. 타 앱의 `history.state` 필드는 보존하고 앱 marker는 `__clotNavigation`에 넣는다. history 오류 시도 route를 알리며 기능은 계속 동작한다. dispose는 listener를 제거한다.
- [ ] **Step 4: 주입 연결.** visualizer에서 factory를 import하여 marker를 치환하고 scale fixture의 수동 치환에도 똑같이 연결한다. 새 런타임 파일 요청이나 전체 REA asset 복사를 추가하지 않는다. `tests/visualizer-html.test.js`의 일반/scale 두 경로 주입 검사를 완성한다.
- [ ] **Step 5: 검증.** `node --test tests/dashboard-navigation.test.js tests/visualizer-html.test.js tests/dashboard-build.test.js` → 모두 PASS, `npm run test:dashboard:browser` → 기존 화면 그대로 PASS.
- [ ] **Step 6: 커밋.** 이 Task Files만 스테이징하고 `git commit -m "feat: add dashboard detail history navigation"`.

### Task 3: 무신사 스타일 목록과 가격 정보 계층

**Files:** Modify `src/dashboard.template.html:10–627,842–1120`, `tests/browser/dashboard.test.js`.

**Interfaces:** Consumes Task 1 기본값, 기존 `cardHtml(item):string`, `paint(query,data,waiting):void`, `setSearchMode(mode):void`, `unknownCounts():void`, `applyTheme(theme):void`. Produces `#catalogView` wrapper, `.price-tabs`의 `data-filter=all|drop|lowest`, 기존 `#q`, `.card[data-k]`, `#grid`, `#gridMore`, `#shownN`, `#renderedN`, `#cAll/#cDrop/#cLowest/#cOnsale/#cOut`와 기존 출처·카테고리·브랜드 ID. Task 4는 `#catalogView`를 숨기고 보존한다.

- [ ] **Step 1: 실패 테스트 작성.** 기존 browser fixture에 아래 named tests를 추가한다. 외부 네트워크는 기존 fixture처럼 차단한다.

```js
// 'catalog shows one price-filter group without duplicate KPI cards'
assert.equal(await page.locator('.kpi').count(), 0);
for (const filter of ['all','drop','lowest'])
  assert.equal(await page.locator(`[data-filter="${filter}"]`).count(), 1);
assert.equal(await page.locator('[data-src]').count(), 3);
assert.equal(await page.locator('#sortSel').inputValue(), 'dropAmt');
// 'catalog fits 390 768 1440 with the specified column counts'
for (const [width,columns] of [[390,2],[768,3],[1440,6]]) {
  await page.setViewportSize({width,height:1000});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(await page.locator('#grid').evaluate(el=>
    getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length), columns);
}
// 'unstored theme defaults light even under dark OS preference'
assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
```

카드에 대해 `.mine`은 현재 가격, `.rate`는 정상가 대비 할인율, `.pin.drop`는 비교 가능한 원 단위 하락, `.price-source`는 직접/추정·확인일임을 단언한다. 저장 `dark` 복원과 브랜드 dialog 색상/포커스도 검증한다. `collection explanation stays available when collapsed`는 짧은 요약과 펼친 원문(쿠폰 미확인 포함), `blocked index retains previews and unknown counts`는 `—`와 재시도, `missing product image preserves accessible card`는 카드 이름과 가격·대체 표시를 검증한다. 기존 적립금 카드의 값·가정·확인일 assertions는 유지한다.
- [ ] **Step 2: 실패 확인.** `node --test --test-name-pattern='catalog shows one|catalog fits|unstored theme|collection explanation|missing product image' tests/browser/dashboard.test.js` → 새 구조/밝은 기본값 부재로 FAIL.
- [ ] **Step 3: 목록 DOM과 스타일 구현.** 헤더 `#1a1b1f`, 본문 `#f4f4f4`, 최대 1440px, 이미지 5:6, breakpoint 1200/900/640px로 6/4/3/2열을 적용한다. 기존 폰트/CDN은 유지한다. KPI를 제거하고 가격 필터를 한 곳에만 둔다. 판매중·품절 보조 버튼은 기존 filter enum을 사용한다. 기존 상세 modal은 이 Task에서는 유지한다. 카드 정보 순서와 문구를 spec대로 바꾸고 pointHtml의 병기·조건은 유지한다. `img` 오류를 네트워크 재시도 루프 없이 대체 표시한다.
- [ ] **Step 4: 렌더링/상태 연결 수정.** `paint`의 삭제된 kTotal/kLowest/kDrop/kOut 참조를 제거하고 `unknownCounts`, `setSearchMode`의 예전 `.kpi/.toolbar>.chips` selector를 실제 wrapper로 바꾼다. 상품번호 조회 시 목록 필터 숨김·복원을 유지한다. 긴 수집 설명은 `details/summary`로 표시하되 `#catalogNotice`의 실패/재시도와 카드 추정 표시는 항상 보인다. 저장 테마 없을 때 `applyTheme('light')`; 기존 저장값과 dark 대비는 보존한다. `역대 최저가`는 도움말·카드·필터 설명에서 `수집 이력 최저가`로 일관되게 바꾼다.
- [ ] **Step 5: 검증.** `npm run test:dashboard:browser` → PASS, 특히 기존 검색·한글 조합·정렬·브랜드 OR·신선도·적립금·HTTP/file 테스트가 통과해야 한다. 390/768/1440px과 저장 dark의 목록·브랜드 dialog를 한 번에 캡처해 비교하고 발견 사항을 한 번에 수정한다.
- [ ] **Step 6: 커밋.** Task Files만 스테이징하고 `git commit -m "feat: restyle price catalog with Musinsa layout"`.

### Task 4: 페이지형 상세·브라우저 이동·실패 복구

**Files:** Modify `src/dashboard.template.html:634–696,1122–1303,1339–1488`, `tests/browser/dashboard.test.js`.

**Interfaces:** Consumes Task 2 navigation, Task 3 `#catalogView`, 기존 `runtime.lookup(key)`, `runtime.getHistory(key,{days})`, `runtime.neighbor(resultId,key,delta)`, `drawChart(item)`, `fillTable(item)`, `fillModal(item)`. Produces `#detailView`(페이지 section), `#detailBack`(목록으로), 기존 `#mName/#mThumb/#mPrice/#mFacts/#mLink/#mRows/#chart/#chartFallback/#prevBtn/#nextBtn`와 기간 버튼. `fillModal(item)`은 표시 함수 이름만 유지해 광범위한 무관한 rename을 피한다.

template 내부에 `applyRoute(route):void`, `showDetail(key,brand):Promise<void>`, `returnToCatalog():void`를 둔다. navigation callback은 `applyRoute`, 카드 클릭은 `navigation.open`, 이전/다음은 `navigation.replace`, 목록 버튼/Escape는 `navigation.backToList`를 호출한다. `showDetail`은 URL을 다시 쓰지 않는다. `openModal/closeModal/setUrl`의 옛 진입 연결은 이 함수들로 교체한다.

- [ ] **Step 1: 실패 테스트 작성.** 기존 `#scrim.open`, `#closeBtn`, modal focus-trap 전용 assertions를 페이지형 selector와 기대 동작으로 바꾼다. 다음 named cases를 추가한다: `detail is a page and browser back restores catalog`, `direct and reloaded detail return to local catalog HTTP/file`, `late history after back or product change cannot reopen detail`, `late all-history reply cannot replace a newer 30-day selection`, `chart failure retains history table`, `detail lookup failure is visible and retryable`, `detail expires without rebuilding the hidden list`.

```js
await page.locator('.card[data-k="musinsa:2"]').click();
await page.locator('#detailView').waitFor({state:'visible'});
assert.equal(await page.locator('#catalogView').isVisible(), false);
assert.notEqual(await page.locator('#detailView').getAttribute('role'), 'dialog');
assert.equal(await page.locator('[data-range="90"]').getAttribute('aria-pressed'), 'true');
await page.goBack();
await page.locator('#catalogView').waitFor({state:'visible'});
assert.equal(await page.locator('#detailView').isVisible(), false);
await page.goForward();
await page.locator('#detailView').waitFor({state:'visible'});
assert.equal(await page.locator('#mName').textContent(), '아디다스 상품 2');
```

HTTP 하위 경로는 현재 fixture 서버에 `/project-clot/` prefix 매핑 옵션을 추가해 검증한다. 변경 signature는 `fixture(t,{basePath='/',...fixtureOptions}={})`이며 `basePath`는 `writeFixture`로 전달하지 않는다. `/project-clot/?goods=1&keep=1#x`에서 원본 링크와 목록 복귀 경로·keep·hash를 단언한다. key `4910:3`은 4910 원본 링크, 숫자 1은 musinsa:1이다. 없는/잘못된 상품, 상품 summary 요청 실패, storage/history 거부 시 보이는 로컬 목록 복귀를 검증한다. fake는 Task 2를 사용하고 브라우저는 실제 popstate를 검사한다.
- [ ] **Step 2: 실패 확인.** `node --test --test-name-pattern='detail is a page|direct and reloaded detail|late history after back|chart failure retains|detail lookup failure|detail expires without' tests/browser/dashboard.test.js` → 새 상세 화면이 없어 FAIL.
- [ ] **Step 3: 상세 페이지와 탐색 연결.** `#scrim/#sheet`를 `#detailView`로 교체하고 900px 이상 2개 영역, 그 미만 1열로 배치한다. 큰 대표 이미지와 가격 패널·차트·기록을 배치하되 390px에서는 요약 후 차트가 나온다. 기존 대표 사진만 사용한다. chart·table·range loader를 재사용하고 데이터 계약은 그대로 둔다. 가격 표의 국소 overflow만 허용하며 페이지 폭은 늘리지 않는다.
- [ ] **Step 4: 복원과 비동기 수명 연결.** 목록→상세에서 기존 렌더 구간과 결과 ID, scrollY, 진입 카드 key·focus를 보존한다. navigation history에는 전체 상품 배열·이력을 저장하지 않는다. 상세 중 `moreIo`와 목록 스크롤 재배치를 중단하고 목록 DOM을 유지한다. `queryToken/detailToken`을 route/선택/기간 변경 때 무효화해 늦은 응답을 무시한다. 목록에서 진행하던 query가 상세 중 완료되면 목록 복귀 때 재조회하도록 표시하고 DOM을 재배치하지 않는다. 60초/visibility/pageshow 갱신은 상세만 재평가하고 목록을 dirty 표시한다. 복귀 시 dirty면 보존 query·offset부터 최대 360개를 다시 받아 앵커 카드와 스크롤을 복원한다. 결과에서 사라진 카드는 인접 남은 카드, 없으면 검색으로 focus를 보낸다. 일반 왕복은 재조회 없이 구간을 복원한다.
- [ ] **Step 5: 오류·접근성 연결.** direct link는 목록 상태와 독립적으로 lookup하고 `targetGoodsNo`는 URL에 goods가 없을 때 replace 진입한다. summary 실패는 상세의 retry 영역, 없는 상품은 목록으로 버튼을 보여준다. 이력 실패는 요약·선택 기간을 유지하고 재시도한다. Chart.js 실패에도 표를 그린다. modal body-lock/backdrop/Tab trap을 제거하고 제목에 `tabindex=-1` 후 focus한다. 브랜드 dialog 우선 Escape 처리는 유지한다. 입력·링크 조작 중 좌우 키는 가로채지 않는다.
- [ ] **Step 6: 검증.** `npm run test:dashboard:browser`와 `node --test tests/dashboard-navigation.test.js tests/dashboard-history.test.js tests/tracking-freshness.test.js tests/visualizer-html.test.js` → 모두 PASS. 기존 365일 archive·기간 race·독립 상품 검색·적립금 모든 상태·49시간 만료 검사를 유지한다. 390/768/1440px 상세, 저장 dark, 이미지 실패·chart 실패를 한 번에 캡처하고 발견 사항을 한 번에 수정한다.
- [ ] **Step 7: 커밋.** Task Files만 스테이징하고 `git commit -m "feat: present price history as a navigable detail page"`.

### Task 5: 대용량 상세 왕복과 생성물 수용 검증

**Files:** Modify `tests/browser/dashboard.test.js`; Create `docs/verify/2026-10-25-musinsa-inspired-dashboard.md`. 앞 Task 결함이 확인될 때만 해당 owning source를 수정한다.

**Interfaces:** Consumes `writeFixture(dir,{scale:true})`, Task 4 페이지 ID와 navigation, 기존 `verifyDashboardBuild(outputPath)`, `measureDashboard(url,{runs,scenarios,isolateExternal})`. Produces 440,129개 fixture에 대한 탐색·120/360 제한 회귀와 독립 실행 가능한 검증 기록. 새로운 프로덕션 API는 없다.

- [ ] **Step 1: 회귀 테스트 작성.** `virtual catalog detail round trip preserves window scroll focus and history budget`를 추가한다. scale fixture에서 IntersectionObserver를 중지해 배치 추가를 직접 제어하고 목록 이력 요청 수를 센다.

```js
await page.waitForFunction(()=>document.querySelector('#shownN').textContent==='440,129');
assert.equal(await page.locator('.card').count(), 120);
assert.equal(historyRequests, 0);
const initialKey = await page.locator('.card').first().getAttribute('data-k');
for (let i=0;i<4;i++) {
  const before = await page.locator('.card').last().getAttribute('data-k');
  await page.locator('#gridMore').click();
  await page.waitForFunction(key=>document.querySelector('.card:last-child').dataset.k!==key,before);
  assert.ok(await page.locator('.card').count()<=360);
}
assert.notEqual(await page.locator('.card').first().getAttribute('data-k'), initialKey);
const card = page.locator('.card').nth(30);
await card.scrollIntoViewIfNeeded();
const key = await card.getAttribute('data-k');
const keys = await page.locator('.card').evaluateAll(xs=>xs.map(x=>x.dataset.k));
const scrollY = await page.evaluate(()=>window.scrollY);
const sort = await page.locator('#sortSel').inputValue();
await card.click();
await page.locator('#detailView').waitFor({state:'visible'});
await page.locator('#nextBtn').click();
await page.waitForFunction(k=>new URLSearchParams(location.search).get('goods')!==k,key);
await page.goBack();
await page.locator('#catalogView').waitFor({state:'visible'});
assert.deepEqual(await page.locator('.card').evaluateAll(xs=>xs.map(x=>x.dataset.k)), keys);
assert.equal(await page.locator('#sortSel').inputValue(), sort);
assert.equal(await page.evaluate(()=>document.activeElement.dataset.k), key);
assert.ok(Math.abs(await page.evaluate(()=>window.scrollY)-scrollY)<=2);
assert.ok(await page.locator('.card').count()<=360);
```

동일 테스트의 filtered 변형에서는 q·출처·브랜드의 선택값도 진입 전후 동일함을 단언한다. `page.clock` 변형에서는 초기 탐색 전에 clock을 설치하고 상세에서 `fastForward(60000)` 후 복귀하여 기존 anchor key·focus·360개 제한이 유지됨을 단언한다. 요청 수는 이력 asset URL 기준으로 목록 단계 0을 검증하고, 상세 단계의 asset 공유 때문에 상품당 요청 수를 1로 가정하지 않는다. 이전/다음은 `runtime.neighbor`의 전역 결과 순서를 사용하여 120개 경계를 넘는 기존 검사를 유지한다. 작은 동기 fixture뿐 아니라 지연된 query/page/history에도 같은 제한을 검사한다.
- [ ] **Step 2: 회귀 탐지 확인.** `node --test --test-name-pattern='virtual catalog detail round trip' tests/browser/dashboard.test.js`를 실행한다. 실패하면 원인이 해당 복원/렌더 코드임을 확인하고 최소 수정한다. 이미 통과하면 실패를 만들기 위한 임의 변경은 하지 않는다.
- [ ] **Step 3: 전체 검증.** `npm test`, `npm run test:dashboard:browser`를 각각 실행하고 exit 0을 확인한다. 이어 임시 디렉터리에 `writeFixture`로 일반·wide/search·scale 생성물을 만들고 각 `index.html`에 `node --max-old-space-size=4096 scripts/verify-dashboard-build.js <absolute-temp-index.html>`를 실행한다. `rea-musinsa` 더미 데이터나 runtime import가 없고 bootstrap/history 제한이 보존됨을 확인한다. 운영 데이터를 재생성하지 않는다.
- [ ] **Step 4: 시각·로딩 증거 기록.** 변경 전과 같은 fixture·브라우저·1440×1000·3회로 `measureDashboard`를 실행한다. firstCardsMs/searchReadyMs·asset bytes·main-thread heap(제공 시)·pageerror·동일 초기 이력 요청 0을 baseline과 비교한다. 계측 도구의 heap은 전체 Worker 메모리라고 보고하지 않는다. DOM 제한·신선도·기존 512MiB 회귀 테스트와 4GiB 생성 검증을 낮추지 않는다. 유의미한 악화가 있으면 원인을 확인하고 수정 또는 미해결 한계를 기록한다. 반복적인 취향 수정 대신 기존 캡처의 발견 사항을 정리하고 수정 후 한 번 확인한다.
- [ ] **Step 5: 검증 문서 작성.** 실제 실행 명령·종료 결과·fixture 종류·화면 폭·사진 경로·성능 비교와 미검증 범위를 기록한다. 로컬 성공과 배포 성공을 구분하고 배포·push는 수행하지 않는다. 필요 screenshot은 docs/verify 아래 이 문서 전용 디렉터리에만 저장한다.
- [ ] **Step 6: 커밋과 인계.** 실제 테스트·검증 문서와 이 Task에서 수정한 owning source만 명시적으로 스테이징하고 `git commit -m "test: verify responsive price dashboard navigation at scale"`. 최종 diff·사용자 변경 보존·모든 검증 결과를 확인하고 선택된 실행 방식의 마지막 리뷰로 인계한다.

## 자체 검토

- Spec coverage: 목록/정렬 Task 1·3, 탐색/직접 링크 Task 2·4, 차트/조건/접근성 Task 3·4, 대용량/생성/시각 Task 5. 제외한 수집·상거래·원격 게시 작업은 추가하지 않았다.
- Interfaces: factory 이름·주입 marker·route 형태는 Task 2가 소유하고 Task 4가 소비한다. `#catalogView`는 Task 3, `#detailView/#detailBack`은 Task 4가 소유한다. 기존 runtime·history 반환 형태는 변경하지 않는다.
- Review Focus의 다섯 항목을 각 owning Task의 named tests에 연결했다. default-sort 변경으로 기존 index/bootstrap fixture가 엇갈리는 위험도 Task 1 검증에 포함했다.
- 계획의 테스트 코드는 의도와 핵심 assertions에 한정한다. 화면 전체 마크업과 factory 몸체는 실행자가 작성한다. Task 5는 이미 통과하는 통합 동작을 억지로 실패시키지 않는다.
- 현재 단계에서 테스트 실행·구현·커밋·배포는 수행하지 않았다. 실행 방식 선택 후 위 checkbox 순서대로 진행한다.
