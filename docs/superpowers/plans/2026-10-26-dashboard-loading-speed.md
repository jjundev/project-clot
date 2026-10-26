# Dashboard Loading Speed and Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기본 화면은 즉시 확정하고, 조건 검색은 필요한 인덱스만 더 빨리 받으며, 로딩 중에는 문구 대신 스켈레톤·진행 막대를 보여준다.

**Architecture:** 빌드가 인덱스를 출처 × 카테고리 × tier(live/history)로 나누고 `exactUntilMs`를 계산한다. Worker는 과거 기록 미포함 질의에서 live만 동시 8개로 받고 진행 이벤트를 보낸다. 런타임의 `exactPreview`가 기본 조건의 빌드 결과를 확정 결과로 돌려주고, 템플릿은 그 외 로딩에서 스켈레톤·진행 막대·오류 패널을 그린다.

**Tech Stack:** Node.js 24, ES modules, Web Worker, node:test, Playwright 1.62, GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-10-26-dashboard-loading-speed.md`. 이전 계약은 `docs/superpowers/specs/2026-10-17-scoped-dashboard-loading.md`이며, 이번 spec이 그중 "동시 4개"와 "검색 준비 중" 문구 규칙을 대체한다.

## Global Constraints

- GitHub Pages 정적 호스팅과 HTTP Worker·file:// 대체 경로를 유지한다. 신규 의존성과 서버는 추가하지 않는다.
- `createDashboardModel`·`createDashboardScope`·`createDashboardTransport`·`createDashboardIndex`·`createDashboardRuntime`·`runDashboardWorker`는 `toString()`으로 직렬화된다(`src/visualizer.js:540-543`). 함수 밖 모듈 변수·import를 참조하지 않는다.
- scoped 다운로드 동시 실행은 최대 8개다. 모든 파일 요청은 15초 제한, 자산 원문은 256KiB 이하를 유지한다.
- tier 규칙: `freshWindow(x)?.until >= asOfMs`이면 `"live"`, 아니면 `"history"`. `tier`가 없는 index ref는 live로 본다.
- `exactUntilMs` = live 항목의 `(from > asOfMs ? from : until)` 최솟값, live가 없으면 `asOfMs + PRICE_TTL_MS`.
- 기기 시각이 `manifest.asOfMs`보다 이르면 모든 tier를 선택한다.
- 화면 문구는 다음과 같다. 숨김 상태 텍스트는 `상품을 불러오는 중`, 오류 패널은 `상품을 불러오지 못했습니다`와 버튼 `다시 시도`, 더 보기 대기는 `불러오는 중`이다. `검색 준비 중`으로 시작하는 카탈로그 문구는 모두 제거한다(브랜드 대화상자의 `브랜드 검색 준비 중…`은 유지).
- 스켈레톤은 12개(상품번호 조회는 1개)이며 기존 카드가 있을 때만 150ms 지연 후 교체한다. 스켈레톤 요소는 `.card` 클래스를 쓰지 않고 `aria-hidden="true"`다.
- 결과·순서·페이지·집계는 기존 `queryCatalog`와 같아야 하며, 미확인 건수는 `—`다.
- DB·수집·가격 정책은 바꾸지 않는다. 미추적 파일(`data/4910-all.js`, `rea-musinsa/`, `tools/` 등)과 수정된 `package.json`은 작업에 포함하지 않는다.
- 구현은 using-git-worktrees로 격리한다. 이 계획과 spec은 아직 main 작업 트리의 미추적 파일이므로, 워크트리 생성 직후 복사해 Task 1 커밋에 함께 넣는다. push·merge·배포는 사용자 승인 후 별도로 한다.

## Review Focus

1. 60초 주기 갱신·탭 복귀(`refreshPrices`, `src/dashboard.template.html:2058-2066`): 기존 카드가 스켈레톤으로 바뀌거나 깜빡이면 안 된다 (Task 6).
2. 조건을 빠르게 연속 변경: 이전 질의의 진행 이벤트나 150ms 타이머가 새 결과를 덮으면 안 된다 (Task 3, Task 6).
3. 기기 시계가 빌드 시각보다 이름: history 상품이 누락된 결과를 확정으로 보여주면 안 된다 (Task 2).
4. 페이지를 연 채 `exactUntilMs`가 지남: 빌드 결과를 계속 확정으로 쓰면 안 되고 실제 질의로 넘어가야 한다 (Task 4, Task 6).
5. 기본 화면에서 백그라운드 질의 완료 전에 "더 보기"에 도달: 멈추거나 120개 뒤를 건너뛰면 안 되고, 기다렸다가 이어서 받아야 한다 (Task 5).

---

### Task 1: `freshWindow` 모델 헬퍼

**Files:**
- Modify: `src/dashboard-model.js:5-19` (`priceSignalEligibility` 주변)
- Test: `tests/dashboard-model.test.js`

**Interfaces:**
- Produces: `model.freshWindow(x: {my, priceBasis, tracking}) -> {from: number, until: number} | null` (ms epoch). 모델 반환 객체에 추가한다.

- [ ] **Step 1: 실패 테스트 작성**

```js
import {freshTracking} from './helpers/dashboard-fixture.js';
test("freshWindow matches refresh at every boundary", () => {
  const m = createDashboardModel(), H = 3600e3, base = Date.parse("2026-10-26T00:00:00Z");
  const x = {my: 90, priceBasis: null, tracking: freshTracking(90, null, {at: base})};
  const w = m.freshWindow(x);
  assert.deepEqual(w, {from: base - H, until: base - H + 48 * H});
  for (const t of [w.from - 1, w.from, base, w.until, w.until + 1])
    assert.equal(m.refresh({...x}, {asOfMs: t}).fresh, t >= w.from && t <= w.until);
  const late = {...x, tracking: {...x.tracking, saleAt: new Date(base - 30 * H).toISOString()}};
  assert.deepEqual(m.freshWindow(late), {from: base - H, until: base - 30 * H + 48 * H});
  assert.equal(m.freshWindow({...x, my: 80}), null);
  assert.equal(m.freshWindow({...x, tracking: {...x.tracking, status: "STOPPED"}}), null);
  assert.equal(m.freshWindow({...x, tracking: {...x.tracking, samples: []}}), null);
  assert.equal(m.freshWindow({...x, priceBasis: "회원가"}), null); // sample basis is null
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test --test-name-pattern="freshWindow" tests/dashboard-model.test.js`
Expected: FAIL (`m.freshWindow is not a function`)

- [ ] **Step 3: 구현**

`priceSignalEligibility`의 정적 조건을 그대로 쓴다. 정적 조건은 ACTIVE 상태, 마지막 샘플 존재, `at`/`saleAt` 유한, `last.price != null && last.price === x.my`, `!basis || last.basis === basis`(`basis = x.priceBasis`)다. 조건을 만족하면 `{from: Math.max(at, saleAt), until: Math.min(at, saleAt) + PRICE_TTL_MS}`를 반환하고, `from > until`이면 `null`을 반환한다. `priceSignalEligibility`가 이 정적 판정을 공유하도록 정리해도 된다. 단, `trackingState` 값(STOPPED/RETAINED/UNKNOWN/STALE/CURRENT)은 바꾸지 않는다.

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/dashboard-model.test.js tests/tracking-freshness.test.js`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/dashboard-model.js tests/dashboard-model.test.js docs/superpowers/specs/2026-10-26-dashboard-loading-speed.md docs/superpowers/plans/2026-10-26-dashboard-loading-speed.md
git commit -m "feat: expose price freshness window" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: live/history 인덱스 분할과 범위 선택

**Files:**
- Modify: `src/dashboard-builder.js:70-146` (`finish`)
- Modify: `src/dashboard-scope.js:4-28`
- Modify: `src/dashboard-worker.js:238-262` (scoped `query`의 `selectParts`/`facetCoverage` 호출)
- Modify: `scripts/verify-dashboard-build.js:182-200` (index 루프), `:283` 근처(빌드 메타 검사)
- Test: `tests/dashboard-scope.test.js`, `tests/dashboard-build.test.js`

**Interfaces:**
- Consumes: `model.freshWindow` (Task 1).
- Produces:
  - manifest `indexParts[]`에 `tier: "live" | "history"` 추가, catalog에 `exactUntilMs: number` 추가.
  - `scope.selectParts(manifest, state = {}, {nowMs = Date.now()} = {}) -> AssetRef[]`.
  - `scope.facetCoverage(manifest, loadedIds, state, {nowMs = Date.now()} = {})`.
  - Worker `query(state, requestId, asOfMs)`는 두 함수에 `{nowMs: asOfMs}`를 넘긴다.

- [ ] **Step 1: 실패 테스트 작성** (`tests/dashboard-scope.test.js`)

```js
function tierFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-"));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const asOfMs = Date.parse("2026-10-26T00:00:00Z"), H = 3600e3,
    b = createDashboardBuilder({outDir: dir, revision: "tier", asOfMs}),
    L = [["2026-10-25", 200, 100, 90, 0, null, 0]];
  for (let n = 0; n < 40; n++)
    b.add({src: "musinsa", n, b: "A", g: "P" + n, c: "top", L,
      tracking: freshTracking(90, null, {at: n % 4 ? asOfMs : asOfMs - 72 * H})});
  const data = b.finish({scanState: "complete"});
  const read = (ref) => { const s = fs.readFileSync(path.join(dir, ref.path), "utf8"), ctx = {};
    vm.runInNewContext(s, ctx); return {payload: JSON.parse(JSON.stringify(ctx.__CLOT_ASSETS__[ref.id])), bytes: Buffer.byteLength(s)}; };
  return {data, read, asOfMs, H};
}
test("index parts split by freshness tier and expose exactUntilMs", (t) => {
  const {data, read, asOfMs, H} = tierFixture(t);
  const counts = {};
  for (const r of data.catalog.indexParts) {
    counts[r.tier] = (counts[r.tier] || 0) + r.count;
    for (const x of index.unpackIndex(read(r).payload))
      assert.equal(model.freshWindow(x)?.until >= asOfMs ? "live" : "history", r.tier);
  }
  assert.deepEqual(counts, {live: 30, history: 10});
  assert.equal(data.catalog.exactUntilMs, asOfMs - H + 48 * H);
});
test("selectParts skips history unless included or the clock precedes the build", async () => {
  const scope = (await import("../src/dashboard-scope.js")).createDashboardScope();
  const m = {asOfMs: 100, indexParts: [
    {id: "a", source: "musinsa", category: "top", tier: "live"},
    {id: "b", source: "musinsa", category: "top", tier: "history"},
    {id: "c", source: "musinsa", category: "top"}]};
  const ids = (s, nowMs) => scope.selectParts(m, s, {nowMs}).map((r) => r.id);
  assert.deepEqual(ids({}, 200), ["a", "c"]);
  assert.deepEqual(ids({includeHistory: true}, 200), ["a", "b", "c"]);
  assert.deepEqual(ids({}, 50), ["a", "b", "c"]);
  assert.equal(scope.facetCoverage(m, new Set(["a", "c"]), {}, {nowMs: 200}).sources.musinsa, true);
});
test("default query never requests history parts; includeHistory adds only them", async (t) => {
  const {data, read, asOfMs} = tierFixture(t), calls = [];
  const scope = (await import("../src/dashboard-scope.js")).createDashboardScope();
  const engine = await createDashboardTransport({manifest: data.catalog, index, scope,
    loadAsset: async (ref) => { calls.push(ref.id); return read(ref); }});
  const tierOf = (id) => data.catalog.indexParts.find((r) => r.id === id)?.tier;
  assert.equal((await engine.query({}, 1, asOfMs + 1)).total, 30);
  assert.ok(calls.filter((id) => id.startsWith("index")).every((id) => tierOf(id) === "live"));
  const before = calls.length;
  assert.equal((await engine.query({includeHistory: true}, 2, asOfMs + 1)).total, 40);
  assert.ok(calls.slice(before).filter((id) => id.startsWith("index")).every((id) => tierOf(id) === "history"));
});
```

`tests/dashboard-build.test.js`에는 `verifyDashboardBuild` 실패 테스트를 추가한다. 생성된 index 자산 하나의 tier를 바꾸거나 `exactUntilMs`를 1 줄인 산출물을 검증하면 `"index tier mismatch"` / `"exactUntilMs mismatch"`로 throw해야 한다. 해당 파일의 기존 빌드 생성 헬퍼를 재사용한다.

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/dashboard-scope.test.js tests/dashboard-build.test.js`
Expected: FAIL (`r.tier` undefined, `exactUntilMs` undefined, history 요청 포함)

- [ ] **Step 3: 빌더 구현**

`finish()`에서 `const w = model.freshWindow(x), tier = w && w.until >= asOfMs ? "live" : "history"`를 구한다. 그룹 키를 `x.src + ":" + x.c + ":" + tier`로 바꾸고 `indexParts.push({...ref, source, category, tier})`로 기록한다. 같은 순회에서 `exactUntilMs`를 계산해 catalog에 넣는다. previews·routes·bootstrap은 그대로 둔다.

- [ ] **Step 4: scope·worker 구현**

`selectParts`에 tier 조건 `state.includeHistory || nowMs < manifest.asOfMs || r.tier !== "history"`를 추가한다. `facetCoverage`는 받은 `{nowMs}`를 내부 `selectParts` 호출에 그대로 넘긴다. scoped `query`는 두 호출에 `{nowMs: asOfMs}`를 전달한다.

- [ ] **Step 5: 검증기 구현**

index 루프에서 행마다 tier를 다시 계산해 `r.tier ?? "live"`와 다르면 `throw Error("index tier mismatch")`를 던진다. 루프에서 모은 최소 전환 시각이 `m.exactUntilMs`와 다르면 `throw Error("exactUntilMs mismatch")`를 던진다. 이 검사는 `m.loadingMode === "scoped"`일 때만 한다.

- [ ] **Step 6: 통과 확인**

Run: `node --test tests/dashboard-*.test.js tests/visualizer-data.test.js tests/visualizer-html.test.js`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add src/dashboard-builder.js src/dashboard-scope.js src/dashboard-worker.js scripts/verify-dashboard-build.js tests/dashboard-scope.test.js tests/dashboard-build.test.js
git commit -m "feat: split search index by freshness tier" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 동시 8개 다운로드와 진행 이벤트

**Files:**
- Modify: `src/dashboard-worker.js:1-8` (transport 옵션), `:133-152` (`pump`), `:229-275` (scoped `query`), `:325-345` (`runDashboardWorker` init)
- Modify: `src/dashboard-runtime.js:96-160` (`start`의 worker onmessage, transportFactory 호출), `:166-195` (`operation`)
- Test: `tests/dashboard-scope.test.js`, `tests/dashboard-runtime-v2.test.js`

**Interfaces:**
- Produces:
  - `createDashboardTransport({..., onProgress = () => {}})`. scoped `query`는 `onProgress({requestId, loaded, total})`를 호출한다. 시작할 때 이미 받은 파일 수로 1회, 그 뒤 index 파일이 하나 끝날 때마다 1회 호출하며, 대체된 질의는 보내지 않는다.
  - Worker는 `postMessage({type: "progress", requestId, loaded, total})`를 보낸다.
  - 런타임 상태에 `progress: {loaded: number, total: number | null}`를 추가한다. operation 시작 시 `{loaded: 0, total: null}`로 두고, `requestId === querySeq`이고 `status === "loading"`일 때만 갱신·emit한다.

- [ ] **Step 1: 실패 테스트 작성**

`tests/dashboard-scope.test.js`에 합성 manifest 헬퍼 `synthetic(n)`/`syntheticAsset(ref)`를 추가한다.
- `synthetic(n)`은 `{v: 2, revision: "r", asOfMs: 0, loadingMode: "scoped", bootstrap: {items: []}, indexParts}`를 만든다. index ref n개는 모두 `source:"musinsa", category:"top", tier:"live", bytes:1, count:1`이다.
- `item_i`는 `model.summarize`에 카드 ref `{id: "cards-i", path: "assets/cards-i.js", bytes: 1, count: 1}`를 붙인 것이다.
- `syntheticAsset(ref)`는 index ref면 `{payload: packIndex([item_i], {revision: "r", id: ref.id}), bytes: 1}`, 카드 ref면 `{payload: {v: 2, revision: "r", id: ref.id, items: [item_i]}, bytes: 1}`을 반환한다.

```js
test("scoped downloads run at most eight at a time", async () => {
  let active = 0, max = 0;
  const engine = await createDashboardTransport({manifest: synthetic(12), index, scope,
    loadAsset: async (ref) => { max = Math.max(max, ++active); await new Promise((r) => setTimeout(r, 5)); active--; return syntheticAsset(ref); }});
  await engine.query({includeHistory: true}, 1, Date.now());
  assert.equal(max, 8);
});
test("progress reports monotonic counts for the active request", async () => {
  const events = [];
  const engine = await createDashboardTransport({manifest: synthetic(12), index, scope,
    loadAsset: async (ref) => syntheticAsset(ref), onProgress: (p) => events.push(p)});
  await engine.query({includeHistory: true}, 7, Date.now());
  assert.ok(events.every((e) => e.requestId === 7 && e.total === 12));
  assert.deepEqual(events.map((e) => e.loaded), [...Array(13).keys()]);
});
```

`tests/dashboard-runtime-v2.test.js`:

```js
test("runtime applies progress only from the current query", async () => {
  let report, release;
  const gate = new Promise((r) => (release = r));
  const api = createDashboardRuntime({manifest: {v: 2, revision: "r", bootstrap: {items: []}, indexParts: []},
    model, indexFactory: createDashboardIndex, historyFactory: createHistoryLoader,
    transportFactory: async ({onProgress}) => { report = onProgress; return {query: () => gate, cancelQuery: async () => {}}; }});
  const first = api.query({q: "a"}).catch(() => {}), second = api.query({q: "b"}).catch(() => {});
  await new Promise((r) => setTimeout(r, 0));
  report({requestId: 1, loaded: 1, total: 2});
  assert.deepEqual(api.getState().progress, {loaded: 0, total: null});
  report({requestId: 2, loaded: 1, total: 2});
  assert.deepEqual(api.getState().progress, {loaded: 1, total: 2});
  release({items: []}); await Promise.all([first, second]); api.dispose();
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test --test-name-pattern="eight at a time|progress" tests/dashboard-scope.test.js tests/dashboard-runtime-v2.test.js`
Expected: FAIL (max 4, 이벤트 없음, `progress` undefined)

- [ ] **Step 3: 구현**

- scoped `pump`의 조건을 `active < 8`로 바꾼다. 비scoped 경로의 `Math.min(4, …)`는 그대로 둔다.
- `runDashboardWorker` init에서 `transport({..., onProgress: (p) => postMessage({type: "progress", ...p})})`를 넘긴다.
- 런타임의 worker `onmessage` 첫 줄에서 `data.type === "progress"`이면 공통 `handleProgress(data)`를 호출하고 반환한다.
- file:// 경로의 `transportFactory` 호출에도 `onProgress: handleProgress`를 넘긴다.

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/dashboard-*.test.js`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/dashboard-worker.js src/dashboard-runtime.js tests/dashboard-scope.test.js tests/dashboard-runtime-v2.test.js
git commit -m "perf: widen index downloads and report progress" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 런타임 `exactPreview`

**Files:**
- Modify: `src/dashboard-runtime.js:197-230` (v2 `api`)
- Test: `tests/dashboard-scope.test.js` (기존 `fixture` 재사용)

**Interfaces:**
- Consumes: catalog `asOfMs`, `exactUntilMs`, `previews`, `previewItems` (Task 2).
- Produces: `api.exactPreview(state, nowMs = Date.now()) -> null | {...previews[src].facets, items: Card[], exact: true, nextOffset: number | null}`. `items`는 `previews[src].keys` 순서의 preview 카드를 `model.refresh(x, {asOfMs: nowMs})`한 것이다. `nextOffset`은 `facets.total > items.length ? items.length : null`이다.

- [ ] **Step 1: 실패 테스트 작성**

```js
test("exactPreview returns the build result only for default state inside the exact window", async (t) => {
  const {data} = fixture(t), m = data.catalog, calls = [];
  const api = createDashboardRuntime({manifest: m, model, indexFactory: createDashboardIndex,
    scopeFactory: createDashboardScope, historyFactory: createHistoryLoader,
    transportFactory: createDashboardTransport, loadAsset: async (ref) => { calls.push(ref.id); throw Error("no"); }});
  const r = api.exactPreview({src: "musinsa"}, m.asOfMs + 1);
  assert.deepEqual(r.items.map((x) => x.k), m.previews.musinsa.keys);
  assert.equal(r.total, m.previews.musinsa.facets.total);
  assert.equal(r.nextOffset, r.total > 120 ? 120 : null);
  for (const [s, now] of [[{src: "musinsa", cat: "top"}, m.asOfMs + 1], [{src: "musinsa", sort: "priceAsc"}, m.asOfMs + 1],
    [{src: "musinsa"}, m.exactUntilMs], [{src: "musinsa"}, m.asOfMs - 1]])
    assert.equal(api.exactPreview(s, now), null);
  assert.deepEqual(calls, []);
  api.dispose();
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test --test-name-pattern="exactPreview" tests/dashboard-scope.test.js`
Expected: FAIL (`api.exactPreview is not a function`)

- [ ] **Step 3: 구현**

`JSON.stringify(model.restoreState(state)) === JSON.stringify(previews[src].state)`이고 `asOfMs <= nowMs < exactUntilMs`일 때만 결과를 반환한다. 그 외에는 `null`이다. `exactUntilMs`가 없는 manifest도 `null`이다.

- [ ] **Step 4: 통과 확인**

Run: `node --test tests/dashboard-*.test.js`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/dashboard-runtime.js tests/dashboard-scope.test.js
git commit -m "feat: serve exact default catalog from build previews" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 템플릿 — 기본 화면 즉시 확정과 백그라운드 질의

**Files:**
- Modify: `src/dashboard.template.html:1461-1466` (`showPreview`/`previewSource` 제거), `:1489-1513` (`render`), `:1566-1580` (`renderMore` v2 분기)
- Test: `tests/browser/dashboard.test.js`

**Interfaces:**
- Consumes: `runtime.exactPreview(state)` (Task 4).
- Produces: 템플릿 내부 변수 `exactPending: Promise | null`(현재 exact 화면의 백그라운드 `runtime.query`). Task 6은 `render(opts)`의 v2 분기를 이어서 수정한다.

- [ ] **Step 1: 실패 테스트 작성**

```js
test('default landing is exact while every index request hangs',async t=>{
 const {page,url}=await fixture(t);await page.context().route('**/assets/index-*.js*',()=>{});await page.goto(url);
 await page.locator('#shownN').filter({hasText:/^5$/}).waitFor();
 assert.equal(await page.locator('#grid').getAttribute('data-search-status'),'ready');
 assert.equal(await page.locator('.skeleton-card').count(),0);
});
test('more beyond the exact first page waits for the background query',async t=>{
 const {page,url}=await fixture(t,{scale:true,scaleCount:600});let release;const gate=new Promise(r=>release=r);
 await page.addInitScript(()=>{window.IntersectionObserver=class {observe(){} unobserve(){}};});
 await page.context().route('**/assets/index-*.js*',async r=>{await gate;await r.continue();});
 await page.goto(url);await page.locator('.card').nth(119).waitFor();
 await page.locator('#gridMore').click();await page.locator('#gridMore').filter({hasText:'불러오는 중'}).waitFor();
 release();await page.locator('.card').nth(120).waitFor();
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test --test-name-pattern="exact|background query" tests/browser/dashboard.test.js`
Expected: FAIL (`#shownN`이 `—`에 머물고, 더 보기 문구 없음)

- [ ] **Step 3: 구현**

`render()`의 v2 분기 처음에서 `runtime.exactPreview(state)`를 호출한다. 결과가 있을 때의 처리는 다음과 같다.

1. `paint(exact,{status:'ready'},false)` 후 `grid.dataset.searchStatus='ready'`로 둔다.
2. `exactPending`을 시작한다. `window` load 이후 `requestIdleCallback`(없으면 `setTimeout(…,1)`) 시점에 `runtime.query(state)`를 실행한다.
3. 같은 `queryToken`일 때만 `lastQuery.resultId`/`nextOffset`을 갱신하고 화면은 다시 그리지 않는다.

`renderMore`의 v2 분기는 `lastQuery.resultId`가 없고 `exactPending`이 있으면 버튼을 `불러오는 중`(스피너 포함)으로 바꾸고 기다린 뒤 기존 `runtime.page` 경로를 탄다. 실패하면 기존 `목록을 불러오지 못했습니다 · 다시 시도`를 쓴다. exact가 아닌 경로는 이 Task에서 건드리지 않는다.

- [ ] **Step 4: 통과 확인**

Run: `npm run test:dashboard:browser`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/dashboard.template.html tests/browser/dashboard.test.js
git commit -m "feat: show exact default catalog without waiting for indexes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 템플릿 — 스켈레톤·진행 막대·오류 패널

**Files:**
- Modify: `src/dashboard.template.html` CSS (`#catalogNotice` 규칙 `:526` 근처에 추가), 마크업 `:1191-1192`, `render`·`paint`·`showStatus`·`paintProduct`(`:1474-1557`), runtime `onChange`(`:1346`), `refreshPrices`(`:2058-2066`)
- Test: `tests/browser/dashboard.test.js` (기존 `:240-245`, `:366-377` 수정 + 신규)

**Interfaces:**
- Consumes: 런타임 `state.progress` (Task 3), Task 5의 `render` v2 분기.
- Produces:
  - 마크업: `#grid` 앞에 `<div id="loadBar" class="load-bar" hidden><span></span></div>`, `<p id="loadStatus" class="sr-only" role="status"></p>`.
  - 템플릿 함수: `skeletonHtml(n)`, `setLoading(on, progress)`, `paintError()`, `render(opts)` (`opts.silent`).

- [ ] **Step 1: 테스트 수정·작성**

```js
test('restored filters show skeletons then a retry panel when indexes fail',async t=>{
 const {page,url}=await fixture(t);await page.addInitScript(()=>{localStorage.setItem('clot.src','musinsa');localStorage.setItem('clot.cat','top');localStorage.setItem('clot.sort','priceAsc');});
 await page.context().route('**/assets/index-*.js*',r=>setTimeout(()=>r.abort(),1500));await page.goto(url);
 await page.locator('.skeleton-card').nth(11).waitFor();assert.equal(await page.locator('.card').count(),0);
 assert.equal(await page.locator('#grid').getAttribute('aria-busy'),'true');assert.ok(await page.locator('#loadBar').isVisible());
 assert.equal(await page.locator('#loadStatus').textContent(),'상품을 불러오는 중');
 await page.locator('#grid').getByRole('button',{name:'다시 시도',exact:true}).waitFor();
 assert.match(await page.locator('#grid').textContent(),/상품을 불러오지 못했습니다/);
 assert.equal(await page.locator('#shownN').textContent(),'—');assert.doesNotMatch(await page.locator('#catalogNotice').textContent(),/검색 준비 중/);
});
test('periodic refresh keeps cards without skeleton',async t=>{
 const {page,url}=await fixture(t);await page.clock.install();await page.goto(url);
 await page.locator('#shownN').filter({hasText:/^5$/}).waitFor();
 await page.context().route('**/assets/index-*.js*',()=>{});
 await page.clock.fastForward(49*3600e3);await page.clock.runFor(1000);
 assert.equal(await page.locator('.skeleton-card').count(),0);assert.ok(await page.locator('.card').count()>0);
});
test('superseded slow scope never paints skeletons over the newer result',async t=>{
 const {page,url}=await fixture(t,{search:true});await page.addInitScript(()=>{localStorage.setItem('clot.src','musinsa');localStorage.setItem('clot.cat','top');});
 await page.goto(url);await page.waitForFunction(()=>document.querySelector('#grid').dataset.searchStatus==='ready');
 const outer=await page.evaluate(()=>window.__CLOT_DATA__.catalog.indexParts.filter(x=>x.source==='musinsa'&&x.category==='outer').map(x=>'/'+x.path));
 await page.route('**/assets/index-*.js*',r=>outer.includes(new URL(r.request().url()).pathname)?undefined:r.continue());
 await openFilters(page);await page.locator('[data-cat="outer"]').click();await page.locator('[data-cat="top"]').click();
 await page.waitForTimeout(400);assert.equal(await page.locator('.skeleton-card').count(),0);assert.ok(await page.locator('.card').count()>0);
});
test('product lookup shows one skeleton card while loading',async t=>{
 const {page,url}=await fixture(t,{scale:true,scaleCount:600});await page.goto(url);await page.locator('.card').first().waitFor();
 await page.context().route('**/assets/routes-*.js*',r=>setTimeout(()=>r.continue(),1000));
 await page.locator('#q').fill('4910:609');await page.locator('.skeleton-card').first().waitFor();
 assert.equal(await page.locator('.skeleton-card').count(),1);
});
test('reduced motion keeps skeletons static',async t=>{
 const {page,url}=await fixture(t);await page.emulateMedia({reducedMotion:'reduce'});
 await page.addInitScript(()=>{localStorage.setItem('clot.cat','top');});await page.context().route('**/assets/index-*.js*',()=>{});await page.goto(url);
 const d=await page.locator('.skeleton-card .sk-thumb').first().evaluate(e=>parseFloat(getComputedStyle(e).animationDuration));assert.ok(d<0.001);
});
```

기존 `:366-377` `query failure marks counts unknown and labels previous cards`는 이름을 `query failure marks counts unknown and shows a retry panel`로 바꾼다. 마지막 단언은 `#grid` 안의 `다시 시도` 버튼, `#shownN === '—'`, `.card` 0개로 교체한다.

- [ ] **Step 2: 실패 확인**

Run: `npm run test:dashboard:browser`
Expected: 위 테스트들 FAIL (`.skeleton-card` 없음, 오류가 notice에 있음)

- [ ] **Step 3: 구현**

- **CSS.**
  - `.skeleton-card`는 `.card`와 같은 그리드 칸을 쓰고, `.sk-thumb`은 `aspect-ratio:5/6`, `.sk-line` 3개(마지막은 `.short`)를 둔다. `.sk-thumb`과 `.sk-line`의 배경은 `--surface-2` 기반 `linear-gradient`에 `background-size:200%`, `@keyframes sk-shimmer`로 1.2s 무한 반복한다.
  - `.load-bar`는 2px 높이이고 안쪽 `span`의 width transition으로 진행을 보여준다. total이 null이면 `.indeterminate` 애니메이션을 쓴다.
  - `#grid.dim`은 `opacity:.45`다. 기존 reduced-motion 규칙(`:1014`)이 애니메이션을 멈춘다.
- **`render(opts={})` v2 분기 (exact가 아닐 때).**
  - silent가 아니면 `setLoading(true,null)`을 호출한다. 그리드에 `.card`가 없으면 즉시, 있으면 `#grid.dim`을 단 뒤 150ms 타이머로 `skeletonHtml(12)`로 바꾼다. 타이머 콜백은 `token===queryToken`이고 status가 loading일 때만 실행한다.
  - silent면 아무 표시 없이 질의한다.
  - 결과가 오면 타이머 해제 → `setLoading(false)` → `paint`.
  - 실패하면 silent가 아닐 때 `paintError()`를 호출한다. 그리드에 `<div class="empty load-error"><b>상품을 불러오지 못했습니다</b><button type="button" data-retry-catalog>다시 시도</button></div>`을 넣고 `unknownCounts()`를 호출한다. silent면 카드를 유지하고 `#catalogNotice`에 오류와 `data-retry-catalog` 버튼만 표시한다. 재시도는 기존 grid 클릭 처리기(`:1768`)가 처리한다.
- **`setLoading(on,progress)`.** `#loadBar` hidden·폭, `#loadStatus` 텍스트(`상품을 불러오는 중`/빈 문자열), `grid.setAttribute('aria-busy',String(on))`, `dim` 해제를 담당한다. runtime `onChange`는 v2에서 `data.progress`가 바뀌고 로딩 표시 중일 때 `setLoading(true,data.progress)`를 호출한다.
- **`refreshPrices`.** `render({silent:true})`를 호출한다.
- **문구 제거.** `paint`의 빈 그리드 문구(`:1530`)와 `showStatus`의 `검색 준비 중…`/`기본 상품 미리보기 · `/`이전 검색 결과 표시 · ` 접두를 삭제한다. 미리보기 기반 경로(`showPreview`, `previewSource`, `previousCards`, `render`의 `keep` 분기)도 삭제한다.
- **상품번호 조회.** `paintProduct(null,'loading')`은 `skeletonHtml(1)`을 그린다.

- [ ] **Step 4: 통과 확인**

Run: `npm run test:dashboard:browser && npm test`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/dashboard.template.html tests/browser/dashboard.test.js
git commit -m "feat: replace loading copy with skeleton and progress" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 측정 스크립트와 전후 비교 기록

**Files:**
- Modify: `scripts/measure-dashboard-loading.js:44-55` (저장 키), `:61-80` (측정 타이머), `:172-191` (CLI 시나리오)
- Create: `docs/verify/2026-10-26-dashboard-loading-speed.md`
- Test: `tests/browser/dashboard.test.js:253-255` (기존 성능 샘플 테스트)

**Interfaces:**
- Produces:
  - 결과 항목에 `countReadyMs`(질의 입력 전 `#shownN`이 처음 숫자가 된 시각, v1/v2 공통)를 추가한다.
  - CLI 기본 시나리오 `all-all {src:'all',cat:'all'}`, `musinsa-top {src:'musinsa',cat:'top'}`, `all-history {src:'all',cat:'all',includeHistory:'true'}`.
  - `measureDashboard`의 기본 `scenarios` 인자는 그대로 둔다(기존 테스트 호환).

- [ ] **Step 1: 테스트 보강**

기존 `scoped performance sample distinguishes preview from search readiness`에 `assert.ok(sample.countReadyMs!=null&&sample.countReadyMs<=sample.searchReadyMs)`를 추가한다.

- [ ] **Step 2: 실패 확인**

Run: `node --test --test-name-pattern="scoped performance sample" tests/browser/dashboard.test.js`
Expected: FAIL (`countReadyMs` undefined)

- [ ] **Step 3: 구현**

init script의 저장 키 목록에 `includeHistory`를 추가한다. 타이머에서 `#shownN`이 숫자가 되는 첫 시각을 `window.__measure.count`에 기록하고, 결과에 `countReadyMs`로 노출한다. CLI 경로는 위 3개 시나리오와 `runs: 3`으로 호출하고, 시나리오마다 `countReadyMs`/`searchReadyMs`/index 파일 수/압축 바이트를 출력한다.

- [ ] **Step 4: 통과 확인**

Run: `node --test --test-name-pattern="scoped performance sample" tests/browser/dashboard.test.js`
Expected: PASS

- [ ] **Step 5: 전후 측정과 기록**

1. 개선 전: `node scripts/measure-dashboard-loading.js https://jjundev.github.io/project-clot/ <scratch>/before.json`을 실행한다.
2. 개선 후 로컬: Pages 워크플로와 같은 명령(`node src/cli.js 4910-db pull`, `node src/cli.js musinsa-db pull`, `CLOT_DASHBOARD_PATH=<scratch>/site/index.html node --max-old-space-size=4096 src/cli.js visualize --no-open`, `node --max-old-space-size=4096 scripts/verify-dashboard-build.js <scratch>/site/index.html`)으로 빌드·검증한다.
3. 같은 정적 서버로 main 빌드와 브랜치 빌드를 각각 측정해 index 파일 수·압축 바이트를 비교한다.
4. 결과를 `docs/verify/2026-10-26-dashboard-loading-speed.md`에 표로 기록한다.

로컬 서버는 Pages와 압축·HTTP/2 조건이 달라 절대 시간은 참고치로만 적는다. 실사이트 개선 후 수치는 사용자가 배포를 승인한 뒤 같은 명령으로 추가한다.
Expected: 검증기 `ok`. 문서에 시나리오별 개선 전/후 파일 수가 기록되고, 전체·전체 기본의 `countReadyMs`가 index 응답과 무관하게 첫 카드 직후 시점이다.

- [ ] **Step 6: 커밋**

```bash
git add scripts/measure-dashboard-loading.js tests/browser/dashboard.test.js docs/verify/2026-10-26-dashboard-loading-speed.md
git commit -m "test: measure exact and tiered dashboard loading" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
