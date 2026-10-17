# Scoped Dashboard Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 첫 상품을 즉시 표시하고 출처·카테고리에 필요한 검색 인덱스만 로딩한다.

**Architecture:** 기존 V2 자산 포맷에 scoped manifest를 추가한다. 빌드는 범위별 인덱스·미리보기·직접 링크 경로를 만들고 Worker는 요청 범위별로 준비한다. UI는 미리보기와 확정 결과를 구분하며 미확인 필터 건수는 `—`로 표시한다.

**Tech Stack:** Node.js 24, ES modules, node:sqlite, Web Worker, node:test, Playwright, GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-10-17-scoped-dashboard-loading.md` (이번 사용자 승인 설계). 이전 상세 이력 계약은 `docs/superpowers/specs/2026-10-16-dashboard-loading-design.md` 참고.

## Global Constraints

- GitHub Pages 정적 호스팅과 HTTP Worker·file:// 대체 경로를 유지한다. 신규 의존성과 서버는 추가하지 않는다.
- 첫 페이지는 120개 이하, 다운로드 동시 실행은 최대 4개, 모든 파일 요청 제한은 15초다.
- 미확인 건수는 `—`, 기본 조건과 다른 로딩 미리보기는 `검색 준비 중 · 기본 상품 미리보기`다.
- 범위 밖 필터 건수 계산을 목적으로 인덱스를 추가 다운로드하지 않는다.
- 기존 부분 문자열 검색·정렬·동률 순서·페이지·가격 출처·쿠폰 안내를 보존한다.
- 자산 원문 256KiB 이하, 기본 상세 최근 90일, 이력 캐시 원문 16MiB 상한을 유지한다.
- DB·이력·수집 정책을 수정하지 않는다. 기존 미추적 `data/4910-all.js`를 작업에 포함하지 않는다.
- 구현 시 using-git-worktrees로 격리한다. 아래 커밋은 계획된 로컬 작업 단위이며 push·merge·공개 배포는 별도 요청 범위다.

## Review Focus

1. 저장된 비기본 정렬·필터: 미리보기는 보이지만 선택 조건의 확정 결과로 표시되지 않아야 한다 (Task 4).
2. 범위를 빠르게 전환하거나 일부 파일 실패: 오래된 응답·실패가 새 결과를 덮거나 캐시를 완료로 표시하면 안 된다 (Task 2–3).
3. 빈 범위·미존재 상품·타 출처 직접 링크: 전체 인덱스 다운로드 없이 올바른 빈 결과/오류/상세를 제공해야 한다 (Task 1–4).
4. 카테고리·출처를 무시하는 교차 집계: 일부 범위로 계산한 숫자를 정확한 전체 필터 건수로 표시하면 안 된다 (Task 2, 4).
5. 직렬화된 함수와 file://: 모듈 import에만 존재하는 헬퍼 없이도 HTTP와 같은 결과가 나와야 한다 (Task 3, 5).

## File Structure and Shared Contracts

기존 역할을 유지한다. `dashboard-builder.js`는 산출물, `dashboard-index.js`는 순수 질의, `dashboard-worker.js`는 다운로드, `dashboard-runtime.js`는 요청 생명주기, template은 화면을 담당한다. 새 범위 규칙은 모듈 의존성 없이 직렬화 가능한 `src/dashboard-scope.js` 팩토리로 분리한다.

- `createDashboardScope()` → `{ selectParts(manifest,state), facetCoverage(manifest,loadedIds,state), routeBucket(key) }`.
- `selectParts`는 정규화된 `state.src`/`state.cat`에 필요한 ref 배열을 반환한다. `all`은 해당 축 전체, `etc`도 독립 카테고리다. 검색어·브랜드·가격 조건으로 파일을 추측해 제외하지 않는다.
- `routeBucket(key)`는 UTF-16 코드 단위 FNV-1a (초깃값 2166136261, 각 단위 XOR 후 `Math.imul(hash,16777619)`, 마지막 `hash & 255`)로 0–255를 반환한다. 상품 존재 여부와 무관하게 같은 버킷을 선택한다.
- V2 additive manifest: `loadingMode:'scoped'`, `indexParts:[{...AssetRef,source,category}]`, `routes:{[bucket]:AssetRef[]}`, `previews:{all|musinsa|4910:{state,keys,facets}}`, `previewItems:Card[]`. 기존 `bootstrap`/`items`는 전체 기본 첫 페이지를 유지한다.
- AssetRef는 기존 `{id,path,bytes,count}`다. route payload는 `{v:2,revision,id,entries:[[itemKey,cardRef],...]}`; 버킷이 256KiB를 넘으면 같은 버킷의 파일 여러 개로 분리한다. 카드·이력 자산 포맷은 유지한다.
- 결과는 기존 `{requestId,resultId,items,total,sources,categories,quick,brands,offset,nextOffset}`와 동일하다. `sources`/`categories`의 값은 `number|null`; `null`만 미확인이다. `total`/`quick`/현재 범위 브랜드 건수는 범위 완료 후 정확하다.
- `facetCoverage`는 source 건수에 현재 category의 해당 source 전체, category 건수에 현재 source의 해당 category 전체가 로딩되었는지 판정한다. `all` 건수는 해당 축 전체가 있어야 한다. 필터 자체를 제외하는 기존 모델 의미를 보존한다. 전체 범위를 로딩했다면 모든 값은 기존 모델과 같다.

---

### Task 1: 범위별 빌드·미리보기·직접 링크 경로

**Files:** Create `src/dashboard-scope.js`, `tests/dashboard-scope.test.js`; Modify `src/dashboard-builder.js:66`, `scripts/verify-dashboard-build.js:140`, `tests/dashboard-v2.test.js`.

**Interfaces:** Consumes existing `model.summarize`, `model.queryCatalog`, `packIndex`, asset writer. Produces the scoped manifest and `createDashboardScope()` contract above. Asset payload `v` stays 2; `loadingMode` opts into scoped behavior.

- [ ] **Step 1: Write failing tests** named `scoped build preserves every identity and partitions by source and category`, `previews share cards and preserve exact first-page order`, `routes find offscreen products without search indexes`, `empty scopes and oversized route buckets stay valid`. Assert every product appears in exactly one partition; `etc` is included; each source preview equals `model.queryCatalog(all,{src}).items.slice(0,120)`; duplicate preview cards are stored once; route entries cover all keys; every asset is <=262144 bytes. Independently assert `routeBucket('')===197` and deterministic repeated hashing.
- [ ] **Step 2: Run** `node --test tests/dashboard-scope.test.js tests/dashboard-v2.test.js`; expect new tests to fail for missing scoped metadata/factory, not environment errors.
- [ ] **Step 3: Implement** `createDashboardScope()` and scoped `createDashboardBuilder(...).finish(...)`. Group summaries before byte splitting, attach exact source/category to each index ref, create previews using existing query semantics, and write sharded key-to-card routes. Extend verifier to check partition membership/count, route/card identity, all preview facets/order, revision and byte validation. Preserve rollback semantics and old manifest verification.
- [ ] **Step 4: Run** the Step 2 command; expect all tests passing including corrupted revision rejection and watched-history size tests.
- [ ] **Step 5: Commit** explicit Task 1 paths only, including this plan/spec, as `feat(dashboard): build scoped indexes and previews` after staged diff/check review.

### Task 2: 필요한 범위만 읽는 transport와 정확한 집계

**Files:** Modify `src/dashboard-worker.js:2`, `src/dashboard-index.js:91`, `src/dashboard-scope.js`; Test `tests/dashboard-runtime-v2.test.js`, `tests/dashboard-index.test.js`, `tests/dashboard-scope.test.js`.

**Interfaces:** Consumes Task 1 manifest/scope API. Extend `createDashboardTransport({manifest,index,loadAsset,scope,yieldTask}) -> Promise<Engine>`; scoped creation performs zero index downloads. Engine retains `query(state,requestId)`, `page(resultId,offset,limit)`, `lookup(key)`, `neighbor(resultId,key,delta)` signatures. Existing V2 unscoped manifests retain current behavior.

- [ ] **Step 1: Write failing tests** `scoped init does not fetch indexes`, `musinsa top query fetches only matching parts`, `scope widening reuses loaded and inflight files`, `incomplete cross facets are null not partial counts`, `lookup uses only route and card files`, `latest scope bypasses obsolete queued downloads`, `failed part is retryable and never counted as complete`. Assert max active requests <=4; no history requests; unknown key returns null; complete-scope results match existing model for all seven sorts, substring queries, multiple brands, zero price and sold-out states.
- [ ] **Step 2: Run** `node --test tests/dashboard-scope.test.js tests/dashboard-index.test.js tests/dashboard-runtime-v2.test.js`; expect failures for eager fetching or missing scoped results.
- [ ] **Step 3: Implement** lazy per-ref caches/inflight deduplication and one shared four-slot queue for indexes/routes/cards. On a newer query, remove obsolete queued index jobs, settle superseded callers with `STALE_RESULT`, and allow already active valid requests to finish/cache; queued shared lookup/card consumers remain valid. Create the query engine against the completed selected scope plus already-loaded rows needed for covered cross facets; use canonical `model.queryCatalog` and mask uncovered facets with null. Scope changes invalidate resultId, page and neighbor results. Resolve lookup from previewItems first, otherwise the computed route bucket. Do not fetch sibling scopes for counts.
- [ ] **Step 4: Run** the Step 2 command; expect all tests passing, including unscoped compatibility. Verify a failed query retains usable previously cached parts.
- [ ] **Step 5: Commit** explicit Task 2 paths as `feat(dashboard): load search indexes by requested scope` after staged review.

### Task 3: 범위별 runtime과 Worker·file 전달 계약

**Files:** Modify `src/dashboard-runtime.js:13`, `src/dashboard-worker.js:103`, `src/visualizer.js:529`, `tests/helpers/dashboard-page.js`; Test `tests/dashboard-runtime-v2.test.js`, `tests/dashboard-v2.test.js`.

**Interfaces:** Consumes Task 2 Engine and Task 1 scope factory. Runtime `start()` initializes transport only; `query(state)` prepares its scope. State is `{status:'idle'|'loading'|'ready'|'error',phase:'preview'|'query',requestId,error,bootstrap,notice}`. Keep `ensureCatalog`, `retryCatalog`, `getState`, `getCatalog`, `getHistory`, `page`, `lookup`, `neighbor`, `dispose`; retryCatalog retries the most recent query. Default getHistory and lookup do not call global ensureCatalog. Existing serialized factory globals gain `__CLOT_SCOPE_FACTORY__`.

- [ ] **Step 1: Write failing tests** `runtime separates worker ready from scope ready`, `late query success or error cannot replace current state`, `worker error settles pending calls and retry recreates transport`, `dispose rejects pending work without later emissions`, `history lookup does not prepare search scope`. Test both fake Worker RPC and direct transport with identical state/result assertions.
- [ ] **Step 2: Run** `node --test tests/dashboard-runtime-v2.test.js tests/dashboard-v2.test.js`; expect failures for current one-time global readiness.
- [ ] **Step 3: Implement** latest-request state guards and retry semantics. Avoid onChange→render→query loops: onChange updates loading/error presentation, while user actions and initial load initiate queries. Pass serialized scope factory in generated HTML, production Worker and scale fixtures. Use the same transport/scope rules in file fallback and Worker; keep factories free of external module references.
- [ ] **Step 4: Run** the Step 2 command; expect passing tests and no pending RPC after worker failure/dispose.
- [ ] **Step 5: Commit** explicit Task 3 paths as `feat(dashboard): track scoped query readiness` after staged review.

### Task 4: 첫 상품 유지와 미확인 건수 표시

**Files:** Modify `src/dashboard.template.html:735` and initial render, `tests/browser/dashboard.test.js`, `tests/helpers/dashboard-page.js`; Test `tests/visualizer-html.test.js` if serialized markup assertions change.

**Interfaces:** Consumes Task 3 runtime and Task 1 previews. UI adds `showPreview(state)` choosing active-source preview; preview cards hydrate from deduplicated previewItems. `formatCount(value)` returns `—` only for null/undefined and `0` for numeric zero. Full search results keep existing page/resultId contract.

- [ ] **Step 1: Write failing browser tests** `blocked indexes still show first cards with restored filters`, `unknown facet counts render dash while zero stays zero`, `query failure retains cards and retries current conditions`, `rapid scope changes retain newest results`, `direct link outside previews opens without indexes`, `missing direct link reports missing product`. Gate index responses, assert <=120 visible preview cards, explicit preview copy for nondefault conditions, no false zero-result message, no out-of-scope network requests and no initial history requests. Keep selected brand zero-count removal and focus tests.
- [ ] **Step 2: Run** `npm run test:dashboard:browser`; expect new tests failing for empty waiting grid/eager index requests.
- [ ] **Step 3: Implement** immediate source preview before Worker initialization; preserve preview/current cards during query errors. Route UI event handlers through a single latest-query path. Use null-aware formatting in every metric/category/source/brand surface; numeric zero remains visible. Only confirmed completed empty queries show `조건에 맞는 상품이 없습니다`. Reset clears all conditions coherently and shows all preview; more/paging waits for matching resultId. Add 15000ms AbortSignal timeout to HTTP fallback asset loading and keep existing script timeout for file://.
- [ ] **Step 4: Run** Step 2 plus `node --test tests/visualizer-html.test.js`; expect passing tests on HTTP and file://, mobile/desktop brand dialog and detail focus behavior intact.
- [ ] **Step 5: Commit** explicit Task 4 paths as `fix(dashboard): keep first products visible during search loading` after staged review.

### Task 5: 산출물 검증과 범위별 성능 측정

**Files:** Modify `scripts/measure-dashboard-loading.js`, `scripts/verify-dashboard-build.js`, `tests/browser/dashboard.test.js`, `tests/dashboard-build.test.js`; Create `docs/verify/2026-10-17-scoped-dashboard-loading.md`. Modify `.github/workflows/pages.yml` only if its existing test/build commands need a new test file explicitly included.

**Interfaces:** `measureDashboard(url,{runs=3,scenarios=[{name:'musinsa-top',state:{src:'musinsa',cat:'top'}}]})` returns per-scenario first-card time, selected-scope-ready time, requested part paths/count, encoded transfer bytes, page errors and existing memory/long-task observations. Preserve CLI URL and output JSON arguments. Worker network measurements use browser-context response events, not only main-page Performance entries.

- [ ] **Step 1: Write failing tests** `scoped build verifier rejects wrong partition and route target`, `440129 items search final scoped part without unrelated fetches`, `scoped performance sample distinguishes preview from search readiness`. Extend scale fixture with both sources and multiple categories including etc; compare whole-data query results with scoped results, masking only unavailable cross facets. Test file:// serialization and legacy unscoped fixture.
- [ ] **Step 2: Run** `node --test tests/dashboard-build.test.js tests/dashboard-v2.test.js` and `npm run test:dashboard:browser`; expect intentional failures for missing validation/measurements.
- [ ] **Step 3: Implement** checks and scoped measurement scenarios; preserve the existing whole-catalog measurement as an explicit `all` scenario. Measure an untouched baseline and changed build from the same read-only DB snapshot or same generated fixture. If live release DBs are unavailable, clearly label synthetic measurements; never substitute them for live price/count proof.
- [ ] **Step 4: Run** `node --test tests/dashboard-*.test.js tests/visualizer-data.test.js tests/visualizer-html.test.js tests/cli-visualize.test.js`, `npm run test:dashboard:browser`, then `npm test`. All must exit 0. Build to a temporary output using the available snapshot, run `node scripts/verify-dashboard-build.js <temporary-output>/index.html`, then measure the served baseline and changed build with identical scenarios and three cold contexts each. Record input revision/conditions, first-card and selected-range times, downloaded index files/bytes, page errors and full-scope limitations in the verification document. No absolute speed claim without measurements.
- [ ] **Step 5: Commit** explicit Task 5 paths as `test(dashboard): verify scoped loading and first render` after `git diff --check` and staged scope review. Report local implementation/tests separately from any deployment; do not push or deploy implicitly.

## Plan Self-Review

- Spec coverage: Task 1 produces previews/partitions/routes; Tasks 2–3 implement lazy loading and consistency; Task 4 implements visible behavior; Task 5 proves compatibility, correctness and performance.
- Signatures/metadata: all tasks share the contracts above; asset V2 and legacy fallback remain explicit.
- Review Focus: all five inputs have named tests in their owning tasks.
- User decision #5 is resolved: unknown counts are `—`; no further product question remains.
- Execution approach has not been selected. Recommend Native: the five tasks share manifest/runtime/UI interfaces and benefit from one continuous implementation context. Follow writing-plans' review/execution-method handoff before implementation.
