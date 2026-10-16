# Dashboard Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 전체 상품 다운로드 전에 첫 목록을 표시하고, 검색·정렬과 이력 조회가 누적 데이터로 화면을 멈추게 하지 않도록 개선한 뒤 실제 배포 결과를 기록한다.

**Architecture:** 빌드 시 초기 120개와 정확한 집계를 생성하고, 전체 상품은 경량 검색 인덱스·카드 파일·기간별 이력 파일로 나눈다. HTTP에서는 Worker가 검색 결과를 소유하고 화면은 페이지 단위로 조회하며, file 실행은 동일 엔진의 대체 경로를 사용한다. 모든 산출물은 동일 revision을 검증한다.

**Tech Stack:** Node.js 24, node:sqlite, 기존 순수 JavaScript 모델, classic Web Worker, GitHub Pages, node:test, 기존 Playwright 1.62.1. 신규 외부 런타임 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-10-16-dashboard-loading-design.md`. 사용자가 2026-10-16 채팅에서 B안·최근 90일 기본·전체 기간 선택과 구현/재배포/실사이트 검증을 승인했다.

## Global Constraints

- GitHub Pages 정적 호스팅, 기존 카드·검색·정렬·필터·브랜드 다중 선택·상품 직접 링크를 유지한다.
- DIRECT/ESTIMATED/출처 미확인, 기준일, 쿠폰 예외 경고와 정확한 집계를 유지한다. 가격 판정은 기존 모델과 동등해야 한다.
- 기본 첫 목록 120개 이하, HTML의 가격 이력 행 0개, 첫 목록 표시가 전체 인덱스 다운로드를 기다리지 않는다.
- 상세 기본 기간은 상품의 최신 가격 관측일 기준 최근 90일, 전체 기간은 선택 시 추가 요청한다. 원본 이력 삭제 없음.
- 이력 파일 원문 256KiB(262144 bytes) 이하, 이력 파일 LRU 캐시 원문 16MiB(16777216 bytes) 이하. 표시 중 데이터는 별도이며 전체 heap 상한으로 주장하지 않는다.
- HTTP와 file 실행의 검색/가격 결과를 유지한다. file 대체 경로의 성능은 별도로 측정한다.
- 원본 DB는 읽기 전용이며 스키마·수집 로직·회원 조회 한도 변경 없음. 원시 회원 응답·쿠키는 산출물에 포함하지 않는다.
- 기존 일일 수집 성공 후 Pages 배포 연결과 실패 시 기존 사이트 유지 동작을 보존한다.
- 관련 없는 `data/4910-all.js`와 다른 작업은 수정·스테이징하지 않는다. 모든 커밋 전 `git diff --cached --check`.

## Review Focus

1. 90일 내 가격 변동이 없는 상품: 경계 이전 마지막 가격을 이월 기준으로 표시하고 신규 관측으로 꾸미지 않는다 — Task 2.
2. 검색 변경 직전에 끝나는 페이지/상세 요청: 이전 결과가 새 검색·선택을 덮어쓰지 않는다 — Tasks 1, 4.
3. 초기 120개 밖의 직접 링크와 페이지 경계 이전/다음: 같은 상품과 검색 순서를 유지한다 — Tasks 1, 4.
4. 일부 파일의 revision 불일치, Worker 실패, file 환경: 부분 집계를 확정하지 않고 정확한 재시도/대체 경로를 제공한다 — Tasks 3, 4.
5. 찜을 포함한 모든 출처의 1년 이력과 캐시 퇴출: 초기 데이터는 이력 수와 독립이고, 퇴출·재요청 후 가격/출처가 동일하다 — Tasks 2, 3, 5.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/dashboard-model.js` | 기존 가격 요약·정렬·facet 의미, 새 엔진의 동등성 기준 |
| 새 `src/dashboard-index.js` | 버전 2 검색 행 codec, 순수 조회 엔진, 페이지·키·이웃 조회 |
| 새 `src/dashboard-assets.js` | byte 제한 파일 writer, revision과 경로 검증, 공통 manifest 형식 |
| 새 `src/dashboard-history.js` | 이력 기간 선택, 경계 이전 기준 가격, byte LRU·요청 중복 제거 |
| 새 `src/dashboard-worker.js` | classic Worker 메시지 진입점; 생성 사이트에 독립 파일로 출력 |
| `src/dashboard-runtime.js` | Worker/file 전송 계층, 요청 번호·오류·재시도, 카드/이력 로더 |
| `src/dashboard-catalog.js`, `src/dashboard-musinsa.js`, `src/visualizer.js` | 읽기 전용 범위별 export, 초기 화면, 카드/인덱스/이력 배선 |
| `src/dashboard.template.html` | 비동기 조회·기간 선택·기존 화면 연결, 첫 카드 선표시 |
| `scripts/verify-dashboard-build.js` | 신규 산출물 전체 정합성·초기 크기·파일 상한 검사 |
| 새 `scripts/measure-dashboard-loading.js` | 같은 조건의 로컬/공개 브라우저 성능 증거 수집 |
| `tests/dashboard-*.test.js`, 새 `tests/dashboard-index.test.js`, `tests/dashboard-history.test.js` | 순수 계약·export·실패 회귀 검증 |
| `tests/helpers/dashboard-page.js`, `tests/browser/dashboard.test.js` | HTTP/file, 지연·실패·직접 링크·기간·실규모 fixture |
| `.github/workflows/pages.yml` | 새 테스트/생성 Worker 포함, 기존 성공 후 자동 배포 유지 |
| `docs/verify/2026-10-16-dashboard-loading-final.md` | 실제 테스트·배포·성능·한계 결과. 완료 전 성공 문서 작성 금지 |

## Shared Contracts

- `Summary`: 기존 모델의 이력 없는 상품 요약. `k/src/kind/n/b/g/c/fs/my/sale/normal/newbie/rate/dropAmt/isOut/isLow/lowEligible/lowMy/lowDate/tracked/priceSource/observedDate`와 기존 카드 표시 필드를 보존한다.
- `IndexPart`: `{v:2, revision, id, rows}`. codec은 카드의 `i/u/detail`와 중복 파생 문자열을 인덱스에서 제외한다. `packIndex(summaries)`/`unpackIndex(part)` roundtrip 후 query 결과가 원래 Summary와 같아야 한다. 행 순서와 값은 codec 단일 파일에 정의한다.
- `AssetRef`: `{id,path,bytes,count}`. `path`는 출력 디렉터리 안의 상대 `.js` 경로, 외부 URL·상위 경로 불가. 모든 파일 envelope는 `{v:2,revision,id,...}`.
- `ManifestV2`: `{v:2,revision,scanState,notice,totalItems,indexParts,bootstrap,workerPath}`. `bootstrap={state,total,sources,quick,categories,brands,items}`; state는 기존 `restoreState({})`이고 items는 정확한 기존 정렬 첫 120개. 전체 상품별 이력 참조를 root manifest에 펼치지 않는다.
- `QueryResult`: `{requestId,resultId,total,sources,quick,categories,brands,items,offset,nextOffset}`. items 최대 120개. resultId는 새 query마다 달라지고 이전 결과의 page/neighbor는 `STALE_RESULT` 오류.
- `HistoryResult`: `{key,from,to,rows,anchor,complete}`. rows는 요청 기간의 원래 tuple, anchor는 경계 이전 마지막 tuple 또는 null. `days:90`이면 to는 상품 observedDate, from은 to에서 89일 전. `days:0`은 전체 기간. 원래 tuple의 날짜·출처는 변경하지 않는다.

### Task 1: 경량 인덱스와 페이지 조회 엔진

**Files:** Create `src/dashboard-index.js`, `tests/dashboard-index.test.js`; modify `src/dashboard-model.js` only to share existing comparators/facet semantics when necessary.

**Interfaces:** `packIndex(summaries,{revision,id}) -> IndexPart`; `unpackIndex(part) -> SearchRow[]`; `createDashboardQueryEngine({rows,loadCards}) -> {query(state,requestId),page(resultId,offset,limit=120),lookup(key),neighbor(resultId,key,delta)}`. 조회 메서드는 Promise이며 `loadCards(keys) -> Promise<Summary[]>`를 소비한다. 전체 행/결과는 엔진 내부 소유다.

- [ ] **Step 1: 실패 테스트 작성.** `compact index preserves canonical query semantics`: 원본 `model.queryCatalog`와 모든 기존 sort, 교차 facet, 0원/null/한글 브랜드/다중 브랜드의 key 순서·총수·집계가 같다. `page boundary and stale result`: 121개 fixture에서 첫 페이지 120개, 다음 1개, neighbor 119→120, 이전 resultId 거부, 마지막 상품 lookup 성공을 assert한다.
- [ ] **Step 2: RED 확인.** `node --test tests/dashboard-index.test.js` → 새 export 부재로 FAIL.
- [ ] **Step 3: codec/엔진 구현.** 가격 재계산 없이 기존 모델의 정렬·facet 의미를 공유한다. Worker가 전체 결과 key 순서를 보유하고 loadCards는 요청 페이지에만 호출한다. 불필요한 전 상품 객체 복제·메인 스레드 전송 없음.
- [ ] **Step 4: GREEN 확인.** `node --test tests/dashboard-index.test.js tests/dashboard-model.test.js` → 실패 0, 기존 모델 테스트 유지.
- [ ] **Step 5: 선별 커밋.** 해당 source/test만 add, `git diff --cached --check`, `git commit -m "feat: add paged dashboard query engine"`.

### Task 2: 기간별 이력과 byte 제한 자산·캐시

**Files:** Create `src/dashboard-assets.js`, `src/dashboard-history.js`, `tests/dashboard-history.test.js`; add asset cases to `tests/dashboard-build.test.js`.

**Interfaces:** `createAssetWriter({outDir,revision,maxBytes=262144}) -> {writeRows(kind,rows),writeRecord(kind,record)}` returns AssetRef(s). `createHistoryExporter({writer}) -> {add(key,iterableRows),finish()}`; `add` returns `{firstDate,lastDate,parts:[{...AssetRef,from,to}]}`. `createHistoryLoader({revision,loadAsset,maxBytes=16777216}) -> {get(key,ref,{days=90}),stats(),clear()}` returns HistoryResult. `loadAsset(ref)` returns `{payload,bytes}` validated against ref/envelope.

- [ ] **Step 1: 실패 테스트 작성.** `recent window retains original boundary anchor`: observedDate 2026-10-16이면 from 2026-07-19, 이전 행은 anchor에만 존재, 행 날짜/출처 불변. `all loads archived history only on request`: 90일 요청은 최근 구간과 anchor 확보에 필요한 마지막 이전 구간만 요청하고 더 오래된 파일 요청은 0, days=0에서 전체 행 일치. `oversized product spans bounded files`: 1년 이상 고밀도 이력도 각 파일 ≤262144 bytes, 조합 후 행 누락/중복 0. `LRU and shared requests`: 작은 시험 예산에서 성공 cacheBytes≤예산, 동시 요청 1회, 실패 후 재시도, 퇴출 후 재요청 동일 결과.
- [ ] **Step 2: RED 확인.** `node --test tests/dashboard-history.test.js` → 새 export 부재로 FAIL.
- [ ] **Step 3: writer/exporter/loader 구현.** 실제 UTF-8 wrapper 포함 byte로 분할하고 revision/id/path 검증. 구간 경계를 넘는 anchor는 필요한 이전 마지막 구간만 요청한다. 한 행 자체가 상한 초과면 잘라 버리지 말고 식별 가능한 빌드 오류. in-flight Map과 성공 byte LRU를 분리하고 표시용 반환값은 캐시 상한의 heap 보장으로 해석하지 않는다.
- [ ] **Step 4: GREEN 확인.** `node --test tests/dashboard-history.test.js tests/dashboard-build.test.js` → 실패 0.
- [ ] **Step 5: 선별 커밋.** 해당 source/test만 add/check 후 `git commit -m "feat: bound dashboard history loading and cache"`.

### Task 3: 전체 export와 첫 화면 빌드 연결

**Files:** Modify `src/dashboard-catalog.js`, `src/dashboard-musinsa.js`, `src/visualizer.js`, `scripts/verify-dashboard-build.js`, `tests/dashboard-catalog.test.js`, `tests/dashboard-musinsa.test.js`, `tests/dashboard-build.test.js`, `tests/visualizer-data.test.js`, `tests/visualizer-html.test.js`.

**Interfaces:** `buildDashboardCatalog` produces `{catalog:ManifestV2,items:bootstrap.items,inlineHistories:{}}`. `buildMusinsaCatalog` and 4910/base adapters feed canonical Summary + iterable original history into the shared asset/history writers. `generateDashboardHtml` public options/result remain compatible. `verifyDashboardBuild(outputPath)` returns existing totalItems/total4910/scanState plus byte/part diagnostics and throws on invalid artifacts.

- [ ] **Step 1: 실패 테스트 작성.** `all sources exclude inline history`: wide/무신사찜/4910찜/scan fixture에 1일→365일 이력을 넣어 HTML 이력 행 0과 초기 데이터가 기록 수에 비례하지 않음을 assert. `bootstrap is exact first page`: 기존 모델의 첫 min(120,N) key·가격·출처·집계와 동일. `wrong revision or missing asset fails verification`: 카드/이력/인덱스 각각 변조 시 FAIL. 기존 중복 우선순위와 partial 4910 notice도 보존한다.
- [ ] **Step 2: RED 확인.** `node --test tests/dashboard-build.test.js tests/dashboard-musinsa.test.js tests/dashboard-catalog.test.js` → V2/인라인 제거 기대에서 FAIL.
- [ ] **Step 3: export 변경.** wide/4910/base 이력을 상품 key 범위별 SQLite iterator로 읽어 writer에 전달한다. 전체 과거 `.all()`/전 상품 이력 Map을 생성하지 않는다. 기존 공개 데이터 helper 호환은 유지하되 사이트 빌드 경로는 bounded iterator로 전환한다. bootstrap 집계·요약은 전체 과거를 반영한 기존 모델 의미를 유지한다. card 파일 참조는 검색 행에, 이력 참조는 카드에 둔다. HTML의 전 기간 dates/runs 배열도 최신·최초 기준일 등 고정 개수 메타데이터로 대체해 날짜 누적을 숨겨 넣지 않는다. Worker 파일은 런타임 코드와 함께 출력해 HTTP/file에서 쓸 수 있게 한다.
- [ ] **Step 4: GREEN 확인.** `node --test tests/dashboard-*.test.js tests/visualizer-data.test.js tests/visualizer-html.test.js tests/cli-visualize.test.js` → 실패 0. 생성 전체 상품 수와 원본 DB 교차 확인.
- [ ] **Step 5: 선별 커밋.** 해당 source/test/verifier만 add/check 후 `git commit -m "feat: build dashboard bootstrap and compact assets"`.

### Task 4: Worker 전송과 화면·기간 선택 통합

**Files:** Create `src/dashboard-worker.js`; modify `src/dashboard-runtime.js`, `src/dashboard.template.html`, `tests/dashboard-runtime.test.js`, `tests/helpers/dashboard-page.js`, `tests/browser/dashboard.test.js`.

**Interfaces:** Worker request `{requestId,method,args}`, reply `{requestId,ok,result,error:{code,message}|null}`. `createDashboardRuntime({manifest,loadAsset,createWorker,onChange})` exposes `start(),query(state),page(resultId,offset),lookup(key),neighbor(resultId,key,delta),getHistory(key,{days=90}),retry(),dispose()`. `getState()` exposes readiness/query/error/bootstrap, never a full items array. Runtime maps engine query/page into QueryResult and uses Task 2 history loader. file transport uses Task 1 engine with cooperative loading/yields and identical results.

- [ ] **Step 1: 실패 테스트 작성.** `bootstrap survives stalled index`: 인덱스를 gate로 막아도 120개 기본 카드·경고·정확한 집계 표시. `saved nondefault state waits honestly`: 저장 필터에 기본 집계를 잘못 표시하지 않음. `stale replies cannot replace current selection`: 지연 query/page/history 이후 새 검색·모달 유지. `HTTP and file parity`: 필터·브랜드·상품 최종 페이지 검색 결과 동일. `deep link and neighbor cross unloaded page`: 처음 120개 밖 상품 직접 열기와 119→120 이동 성공. `90 day default and all retry`: 초기 90일 선택, archive 요청 0, 전체 선택 후 과거 표시, 실패 재시도/기간 변경 경쟁 검증. `worker failure retries without partial counts`: 인덱스 revision 변조/Worker 시작 실패가 확정 숫자를 만들지 않음.
- [ ] **Step 2: RED 확인.** `node --test tests/dashboard-runtime.test.js` 및 `npm run test:dashboard:browser` → 신규 계약/기간/초기 gate 기대에서 FAIL.
- [ ] **Step 3: runtime/Worker 연결.** Worker init에 revision·index refs 전달, 최대 4개 자산 동시 요청, 로드 완료 검증 후 전체 검색 허용. HTTP Worker 시작 실패는 오류/재시도, file은 명시적 대체 전송. bootstrap 첫 paint 뒤 백그라운드 start. 요청 번호와 결과 식별자 검증, dispose 시 Worker 종료 및 늦은 응답 무시.
- [ ] **Step 4: UI 연결.** 초기 전체 items 기반 render/brand Map/stepper를 Task 1 계약으로 교체. 페이지는 120개씩 받고 화면 카드 DOM은 최대 360개를 유지하는 window/spacer 방식으로 앞뒤 스크롤과 키보드 포커스 보존. 상세 range 기본 90, 전체=0. 기간 전환 시 HistoryResult 재요청, anchor는 이월 기준으로 표시하고 관측 테이블 행/확정 가격 이벤트로 만들지 않는다. 역대 최저가 등 전체 기간 지표는 Summary를 유지하고 보이는 기간으로 재판정하지 않는다.
- [ ] **Step 5: GREEN 확인.** `node --test tests/dashboard-runtime.test.js`; `CLOT_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:dashboard:browser` → HTTP/file, desktop/mobile, 오류 0. DOM 상한·focus·뒤로 스크롤도 assert한다.
- [ ] **Step 6: 선별 커밋.** 해당 source/test만 add/check 후 `git commit -m "feat: stream dashboard pages and recent history"`.

### Task 5: 운영 크기 검증·성능 측정·재배포

**Files:** Create `scripts/measure-dashboard-loading.js`, `docs/verify/2026-10-16-dashboard-loading-final.md`; modify `.github/workflows/pages.yml`, `README.md`, relevant browser/scale tests and this plan progress.

**Interfaces:** `node scripts/measure-dashboard-loading.js <url> <output.json>` writes viewport/환경/HTML revision/첫 카드 표시/검색 준비/요약·카드·이력 요청수와 byte/long-task/heap/오류를 기록한다. CLI 실패는 nonzero. file과 HTTP 결과는 구분한다. 성능 로그에 원시 회원 응답/secret 없음.

- [ ] **Step 1: 실패 회귀 검증 추가.** 44만 상품과 365일 이력 fixture에서 첫 목록 전 전체 인덱스 완료 불필요, HTML 이력 행 0, 모든 history asset≤262144 bytes, 성공 캐시≤16777216 bytes를 assert. 인덱스 중간 실패/재시도와 두 배포 revision 혼합을 browser gate로 재현한다.
- [ ] **Step 2: RED 확인.** 해당 scale/build/browser 테스트를 실행해 새 제약을 실제로 검사하고 기존 산출물에서 실패함을 기록한다. 이미 구현으로 만족하는 항목은 Task 1–4의 RED 기록을 참조하며 고의로 코드를 되돌리지 않는다.
- [ ] **Step 3: 측정 도구·배포 배선 구현.** Pages 테스트에 새 dashboard 테스트와 생성 Worker 검증 포함. `Musinsa wide scan` 성공 후 workflow_run, required wide DB 검증, 가격 출처 검사 유지. node24·기존 Playwright 사용. 기준 브라우저/viewport에서 같은 DB의 기존/신규 빌드를 각각 3회 cold context로 측정해 중앙값 비교. CPU/네트워크 제한 실험은 별도 조건으로 기록한다.
- [ ] **Step 4: 전체 검증.** `npm test`; Chrome executable 지정 `npm run test:dashboard:browser`; 실제 읽기 전용 Release DB로 `CLOT_REQUIRE_MUSINSA_WIDE=1 CLOT_DASHBOARD_PATH=<별도 임시 디렉터리>/index.html node src/cli.js visualize --no-open`; `node scripts/verify-dashboard-build.js <생성 HTML>` → 모두 성공. 입력 DB SHA256 전후 동일. 실제 전체 상품 정합성, DIRECT/ESTIMATED와 예외 8종 표시 확인. 독립 리뷰 지적 수정 후 필요한 회귀 재실행.
- [ ] **Step 5: 커밋·PR·병합·배포.** fetch 후 unrelated 변경 보존, 선별 add와 `git diff --cached --check`, `git commit -m "perf: verify bounded dashboard loading"`. codex/ 브랜치 push→PR 생성·이 채팅 attach→검사 통과 후 병합. 사용자가 재배포를 명시 승인했으므로 별도 배포 승인 요청 없이 Pages 실행을 확인한다. 계획 검토 후 실행 시작 때 기존 첨부 worktree 재사용 가능 여부부터 확인한다.
- [ ] **Step 6: 실제 사이트 확인.** 배포 Actions success와 공개 HTML revision 일치 확인. 새 cold context에서 초기 120개, 전체 검색, 마지막 페이지 상품, DIRECT/ESTIMATED, 90일/전체 기간, 쿠폰 경고, 모바일 overflow와 pageerror, 검색 요청 경쟁을 확인하고 URL·시각·관측값·스크린샷 보관. 단기 운영 이력에 90일 이전 기록이 없으면 오래된 기간 확장은 fixture 증거로 구분해 보고한다.
- [ ] **Step 7: 최종 결과 저장·선별 push.** 최종 MD에 source SHA/PR/run/실측 전후/동일 입력 비교·공개 사이트 비교 구분/테스트 수/정합성/남은 한계·전체 검색은 상품 수에 비례한다는 점을 기록. 결과 문서만 선별 커밋·push하고 로컬 파일 및 공개 사이트 링크로 완료 보고한다.

## Self-Review

- 설계 1–2(bootstrap·요약 분리)→Tasks 1, 3; 설계 3(Worker·file·직접 링크)→Tasks 1, 4; 설계 4(90일·전체·상한·bounded export)→Tasks 2–4; 설계 5(실규모·배포·최종 MD)→Task 5. 미배정 요구 없음.
- Shared Contracts의 revision/requestId/resultId/HistoryResult를 후속 task에서 동일 이름으로 사용한다. summary 판정과 기간별 표시를 분리했다.
- Review Focus 다섯 조건 모두 소유 task에 구체적인 입력·assert·실행 명령을 연결했다.
- 바이트 상한은 wrapper 포함 UTF-8, 캐시는 raw bytes 기준이며 메모리 절대 상한으로 과장하지 않는다. 새로운 제품 결정이나 유료 서비스 없음.
- 이 계획은 구현 전 체크리스트다. 테스트·배포·개선 수치는 실행 후에만 완료로 기록한다.
