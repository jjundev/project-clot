# Musinsa Point Estimates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 일반 상품의 적립금 제한 정보를 점진 수집하고 기존 쿠폰가 옆에 잔액 충분을 가정한 예상가를 제공한다.

**Architecture:** 익명 상품 JSON API의 제한 조건을 같은 SQLite DB의 추가 테이블에 캐시한다. 별도 직렬 workflow에서 수집하고, 네트워크 없는 가격 계산을 기존 스캔과 연결한다. 쿠폰 가격 체계와 별도의 필드·이력을 사용해 정렬·최저가·알림 의미를 보존한다.

**Tech Stack:** Node.js 24 ESM, node:sqlite, built-in fetch, node:test, 기존 Playwright, GitHub Actions/Release/Pages. 새 의존성 없음.

**Spec:** [2026-10-24-musinsa-point-estimates-design.md](../specs/2026-10-24-musinsa-point-estimates-design.md). 구현자는 두 문서를 모두 읽는다. 채팅의 결정 #6~#8은 confirmed by default이며 계획 작성은 실행 권한이 아니다.

**검토 기준:** `2805482`까지 병합된 dashboard-search-correctness 변경을 반영했다. Tasks 1~4와 6의 설계·순서는 유지하고, Task 5에서 현재 인덱스와 독립 상품 조회 경로의 호환성을 검증한다. 이번 수정은 계획서에만 적용하며 구현은 시작하지 않는다.

## Global Constraints

- 이번에는 적립금 사용만 추가한다. 등급 할인·카드 할인·적립 예정 포인트 선할인은 제외한다.
- 개인 보유 적립금 잔액을 조회하지 않는다. 예상가는 필요한 적립금 전액 보유를 가정한다.
- 쿠폰가를 주 가격·정렬·차트·알림·역대 최저 판정 기준으로 유지한다.
- 과거 쿠폰가를 오늘의 제한 조건으로 재계산하지 않는다.
- 제한 여부 미확인·필드 누락·만료를 사용 가능으로 간주하지 않는다.
- 동시 요청은 1개, 요청 시작 간 최소 간격은 1,000ms, 요청 timeout은 최대 15,000ms다.
- 일일 요청 시도 한도는 기본 1,000회, 명시적 설정 상한은 5,000회, 네트워크 실행 예산은 85분이다.
- 성공·실패·재시도 모두 한도를 소비하며 같은 날 재실행해도 초기화하지 않는다.
- 429는 즉시 수집을 중단한다. 접근 거절을 우회하지 않는다.
- 캐시 유효기간은 확인 후 604,800,000ms 미만이며 현재 판매가·추가 할인액이 확인 당시 값과 같아야 한다.
- 새 workflow는 clot-daily 그룹을 사용하고 잠금 획득 후 최신 DB를 받아야 한다.
- 기존 DB·쿠폰 이력·scan_runs를 재작성하지 않고 새 테이블과 이름공간이 있는 meta 키만 추가한다.
- CLOT_MUSINSA_POINTS_ENABLED=1일 때만 활성화하고 그 외에는 새 수집·계산·표시를 비활성화한다.
- 쿠키·회원 API·텔레그램 발송을 새 수집 작업에서 사용하지 않는다.
- 테스트는 임시 DB와 주입한 fetch·시계·sleep만 사용하며 운영 DB와 원격 서비스에 쓰지 않는다.
- 기존 Node.js 24 ESM·정적 사이트·Worker 구조, v2 기존 필드 위치와 revision 검증을 보존하고 새 의존성을 추가하지 않는다.
- 변경 전 git status를 다시 확인한다. 다른 채팅의 dashboard-search-correctness 문서와 data/4910-all.js를 이 작업에 포함하지 않는다.

## Review Focus

1. false/0·철자 변경·충돌·잘못된 상품 응답: 미확인을 사용 가능으로 만들지 않는다 — Task 1.
2. KST 자정·중복 실행·실패 재시도: 영속 합계 한도와 간격을 지킨다 — Tasks 2~3.
3. 상품 가격은 그대로인데 쿠폰 수집 실패 또는 캐시 만료: 이전 추정 금액을 유효한 현재 가격으로 표시하지 않는다 — Tasks 4~5.
4. 적립금 정보만 바뀐 날·구형 wire/DB·인덱스를 우회하는 상품 조회: 기존 가격 판정과 검색 동작을 보존하고 카드·상세에서 같은 조건을 표시한다 — Tasks 2, 4~5.
5. prev fallback·부분 결과·동시 workflow·추출 누락: 최신 DB를 덮어쓰거나 미배포 상태를 성공으로 숨기지 않는다 — Task 6.

---

## 파일 구조와 실행 순서

| 파일 | 책임 |
|---|---|
| Create `src/musinsaWide/point-policy.js` | 엄격한 익명 응답 판독과 순수 예상가 계산 |
| Create `src/musinsaWide/point-store.js` | 추가 스키마, 후보 선택, 영속 요청 한도, 변경 이력 |
| Create `src/musinsaWide/point-collector.js` | 간격·재시도·한도·중단을 지키는 직렬 수집 |
| Create `src/musinsaWide/point-pricing.js` | 최신 쿠폰 스냅샷 gate, 계산·현재 조회 adapter |
| Create `src/musinsaWide/point-cli.js` | CLI 실행 수명주기, 부분 완료/DB 오류 구분 |
| Modify `src/musinsaWide/track.js:299`, `src/cli.js:1331` | 기존 스캔 후 로컬 재계산, 새 명령 연결 |
| Modify `src/dashboard-musinsa.js:28`, `src/dashboard-model.js:6`, `src/dashboard-index.js:4` | 별도 표시 필드와 유효 확보 집계 |
| Modify `src/visualizer.js:423`, `src/dashboard.template.html`의 cardHtml·fillModal | 활성화/시각 전달, 일반 검색·독립 상품 조회의 카드·상세 병기 |
| Create `.github/workflows/musinsa-points.yml`; modify `musinsa-wide.yml`, `pages.yml` | opt-in 실행, Release 직렬 갱신, 표시 활성화 및 Pages 연결 |
| Create `scripts/run-musinsa-points.js`, `scripts/check-musinsa-points.js`; modify `README.md` | 테스트 가능한 작업 진입점, 업로드 전 검증, 운영·한계·복구 안내 |
| Create `tests/helpers/musinsa-point-fixtures.js` | 고정된 순수 응답·가격·임시 DB fixture |
| Create `tests/musinsa-point-{policy,store,collector,pricing,workflow}.test.js`, `tests/cli-musinsa-points.test.js` | 각 책임과 장애 계약 검증 |
| Modify `tests/dashboard-musinsa.test.js`, `tests/dashboard-index.test.js`, `tests/browser/dashboard.test.js` | 기존 가격 보존과 실제 표시 검증 |
| Modify `tests/helpers/dashboard-page.js` | 검색 fixture에 정책·계산 이력·유효 coverage·고정 시각 전달 |

Task 1 → 2 → 3 → 4 → 5 → 6 순서다. 한 기능의 연속 계약이므로 별도 하위 프로젝트로 나누지 않는다. 공용 dashboard 파일은 구현 직전 다시 읽고 다른 검색 작업의 변경을 보존한다. 아래 커밋 단계는 미래 구현자를 위한 지시이며 계획 작성 중에는 실행하지 않는다.

### Task 1: 익명 제한 정보와 예상가 계산

**Files:** Create `src/musinsaWide/point-policy.js`, `tests/musinsa-point-policy.test.js`, `tests/helpers/musinsa-point-fixtures.js`.

**Interfaces:** Consumes: 내장 fetch/AbortSignal, `floor10`와 동등한 절사 규칙. Produces: Spec의 `PointPolicy`, `CouponBasis`, `PointEstimate` 계약 및 `parsePointPolicy`, `fetchPointPolicy`, `evaluatePointEstimate`. 오류 code는 SCHEMA_CHANGED/HTTP/TIMEOUT/NETWORK이며 HTTP는 status를 갖는다.

- [x] **Step 1: 실패 테스트와 고정 fixture 작성.** helper는 `rawPointPolicy(overrides={})`, `pointPolicy(overrides={})`, `couponBasis(overrides={})`를 제공한다. raw 기본은 meta.SUCCESS와 상품 2156295의 false/0.07/263200/추가할인 0, checkedAt 기본은 `2026-10-24T09:00:00.000Z`, basis.couponPrice=248200, couponSource=ESTIMATED다. helper의 각 호출은 새 객체를 반환한다.

```js
test('키뮤어: 등급 제한과 무관하게 적립금만 차감', () => {
  const p = parsePointPolicy(rawPointPolicy(), 2156295, Date.parse('2026-10-24T09:00:00Z'));
  const r = evaluatePointEstimate({basis: couponBasis(), policy:p,
    asOfMs:Date.parse('2026-10-24T10:00:00Z'), couponFresh:true});
  assert.equal(r.price, 230830); assert.equal(r.discount, 17370);
  assert.equal(r.state, 'ELIGIBLE');
});
```

추가 test 이름과 assertion: `제한 상품`→RESTRICTED/248200/0; `정상가 0과 사용률 0`→유효 0 차감; `누락·상충 철자·다른 goodsNo·문자열 boolean·NaN·1 초과 비율`→SCHEMA_CHANGED; `만료 경계`→604799999ms 유효/604800000ms STALE/미래시각 STALE; `현재 가격 불일치`→POLICY_BASE_MISMATCH/null; `쿠폰 미갱신`→COUPON_UNAVAILABLE/null. fetch stub은 고정 URL, Cookie 부재, 200 meta 검사, 429 status, body 미노출, timeout 및 요청 1회만을 assert한다.

- [x] **Step 2: 실패 확인.** Run `node --test tests/musinsa-point-policy.test.js`; Expected FAIL: 새 모듈/함수 미존재. 기존 fixture 오류로 실패한 경우 먼저 fixture를 고친다.
- [x] **Step 3: 계약 구현.** 세 공개 함수와 injected now/timeout을 구현한다. 판정 순서·0원 처리·strict 필드 검사는 Spec 그대로다. helper에 성공·제한·일반 비아울렛 제한 사례를 넣되 운영 원본 응답을 복사하지 않는다.
- [x] **Step 4: 통과 확인.** 같은 명령 Expected 모든 case PASS, 외부 네트워크 호출 0회.
- [x] **Step 5: 커밋.** `git add src/musinsaWide/point-policy.js tests/musinsa-point-policy.test.js tests/helpers/musinsa-point-fixtures.js` 후 `git commit -m "feat(musinsa): parse point policies and estimate point usage"`.

### Task 2: 캐시·후보 순환·영속 한도·독립 이력

**Files:** Create `src/musinsaWide/point-store.js`, `tests/musinsa-point-store.test.js`; extend fixture helper.

**Interfaces:** Consumes: Task 1 types, 기존 `MusinsaWideStore.db`. Produces: Spec의 `PointPolicyStore` 클래스와 모든 메서드. helper에 `makePointStoreFixture(t)` 추가: 임시 wide store와 초기화한 PointPolicyStore, 기준 상품 삽입 도우미를 반환하고 cleanup한다. 각 테스트 파일은 `./setup-env.js`를 먼저 import한다.

- [x] **Step 1: 실패 테스트 작성.** 이름/핵심 assertions:

```js
test('실패는 정책 확인 시각을 연장하지 않는다', (t) => {
  const {points} = makePointStoreFixture(t);
  points.savePolicy(pointPolicy());
  points.saveFailure({goodsNo:2156295, atMs:Date.parse('2026-10-25T09:00:00Z'), code:'NETWORK'});
  assert.equal(points.getPolicy(2156295).checkedAt, '2026-10-24T09:00:00.000Z');
});
```

추가로 `재실행 공유 한도`→store 재개방 후 cap=2의 세 번째 reserve=false; `KST 자정`→14:59:59Z와15:00:00Z의 quotaDate가 다르되 nextStartAt 간격 유지; `재시도 대기`→next_retry_at 이전 미선택; `순환 공정성`→실패 앞번호가 다음 rotation을 독점하지 않음; `lane 중복`→excludeGoodsNos 제외; `미품절 ACTIVE만 선택`→품절/OUT_OF_SCOPE/가격 null 제외. `추가 스키마만 생성`→기존 테이블 dump 동일; `read-only 구형 DB`→initialize=false에서 hasTables=false/조회 빈값/DDL 0; `당일 되돌림`→직전날 상태로 복귀하면 당일행 제거; `checkedAt만 변경`→가격 행 수 동일, 최신 성공 캐시는 갱신.

- [x] **Step 2: 실패 확인.** Run `node --test tests/musinsa-point-store.test.js`; Expected FAIL: PointPolicyStore 미존재.
- [x] **Step 3: Spec의 클래스/테이블/인덱스 구현.** candidates는 SQL LIMIT·정렬·LEFT JOIN을 사용하고 30만 상품 전체를 JS 배열에 적재해 매 요청마다 정렬하지 않는다. quota 예약과 시도 metadata는 트랜잭션, checkedAt은 성공 때만 변경한다. 누락 테이블을 읽는 경로는 빈값으로 처리한다. meta에 마지막 nextStartAt은 날짜를 넘어 보존한다.
- [x] **Step 4: 통과 확인.** Run `node --test tests/musinsa-point-policy.test.js tests/musinsa-point-store.test.js tests/musinsa-wide-store.test.js`; Expected PASS. 30만 ACTIVE 합성 fixture에서 후보 반환 수가 limit 이하이며 쿼리 수가 후보 수에 선형으로 폭증하지 않는 assertion도 넣는다.
- [x] **Step 5: 커밋.** `git add src/musinsaWide/point-store.js tests/musinsa-point-store.test.js tests/helpers/musinsa-point-fixtures.js` 후 `git commit -m "feat(musinsa): persist point policies budgets and price history"`.

### Task 3: 중단·재개 가능한 직렬 수집기

**Files:** Create `src/musinsaWide/point-collector.js`, `tests/musinsa-point-collector.test.js`.

**Interfaces:** Consumes: Task 2 PointPolicyStore, Task 1 fetchPointPolicy. Produces: `collectPointPolicies({store, fetchPolicy=fetchPointPolicy, now=Date.now, sleep, dailyCap=1000, budgetMs=5100000}) -> Promise<{quotaDate,attempted,succeeded,failed,stop}>`. fetchPolicy는 `(goodsNo,{now,timeoutMs}) -> Promise<PointPolicy>`이며 네트워크를 테스트에서 전부 stub한다.

- [x] **Step 1: 실패 테스트 작성.** fake clock/sleep와 요청 시작시각 배열을 사용한다.

```js
// '실패·재시도까지 quota에 포함': cap=3, 첫 상품이 503→성공, 다음 1회 이후 종료
assert.equal(result.attempted, 3);
assert.equal(points.getAttempts(result.quotaDate), 3);
assert.ok(starts.every((ms,i) => i === 0 || ms - starts[i-1] >= 1000));
assert.equal(maxConcurrent, 1);
```

이 assertions를 named test에 넣고 result/points/starts/maxConcurrent를 해당 fixture로 정의한다. 나머지 tests: `429 즉시 중단`→후속 호출 0/성공 행 보존/stop=rate_limited; `401·403`→blocked/자동 우회 0; `schema 오류`→error/후속 호출 0; `5xx 세 번 상한`→1초·2초 backoff 후 마지막 실패와 1시간 대기; `deadline`→새 호출 시작 없음/timeoutMs가 남은 예산 이하; `재시작 중복 quota`→앞선 실패 시도도 포함; `lane 반분과 차용`→4회 예산 양 lane 2회, 한 lane 고갈 때 다른 lane 사용; `KST 자정 통과`→각 날짜 cap과 1초 간격 유지.

- [x] **Step 2: 실패 확인.** Run `node --test tests/musinsa-point-collector.test.js`; Expected FAIL: collector 미존재.
- [x] **Step 3: collector 구현.** Spec의 후보·시도 예약·간격·3회 재시도·즉시 중단 규칙을 적용하고 매 성공을 바로 저장한다. 매번 예약 직전에 now를 다시 읽는다. 잘못된 dailyCap(양의 정수 아님/5000 초과)은 호출 전에 거절한다. budget 도달/queue 완료를 구분하고 recordRun을 남긴다.
- [x] **Step 4: 통과 확인.** Run `node --test tests/musinsa-point-collector.test.js tests/musinsa-point-store.test.js`; Expected PASS, 실시간 sleep/원격 호출 0회.
- [x] **Step 5: 커밋.** `git add src/musinsaWide/point-collector.js tests/musinsa-point-collector.test.js` 후 `git commit -m "feat(musinsa): collect point policies within persistent request limits"`.

### Task 4: 유효 쿠폰 스냅샷과 새 가격 이력 연결

**Files:** Create `src/musinsaWide/point-pricing.js`, `tests/musinsa-point-pricing.test.js`; modify `src/musinsaWide/track.js:299-312`.

**Interfaces:** Consumes: Tasks 1~2, `verifyDailyCoverage(run)` from `coverage.js`. Produces: `refreshPointEstimates({db,asOfMs,enabled}) -> {written,counts}`, `readPointEstimateViews({db,asOfMs,enabled}) -> {byGoods:Map<number,PointEstimate>,counts}`. counts={active,eligible,restricted,unknown}; read 함수는 DDL이나 쓰기를 수행하지 않는다. enabled=false 또는 테이블 미존재 시 byGoods는 빈 Map이고 모든 ACTIVE를 unknown으로 센다. write 함수는 테이블 미존재 시 no-op이다.

- [x] **Step 1: 실패 테스트 작성.** 기존 coverage fixture를 읽어 유효 30만 대상 metrics를 가진 run fixture를 helper에 정의하고 actual 상품 row는 작은 수로 구성한다. 날짜/시계는 고정한다.

```js
// '실패한 오늘의 쿠폰 수집은 캐시 예상가를 무효화한다'
assert.equal(readPointEstimateViews({db,asOfMs,enabled:true}).byGoods.get(2156295).state,
  'COUPON_UNAVAILABLE');
assert.equal(readPointEstimateViews({db,asOfMs,enabled:true}).byGoods.get(2156295).price, null);
```

추가 named tests: `어제 run만 존재`→미확인; `오늘 유효 snapshot·7일미만 cache`→230830; `coupon extra만 변경`→POLICY_BASE_MISMATCH; `가격 동일 TTL 만료`→STALE/null 전환행; `처음 UNKNOWN`→이력 0행; `OUT_OF_SCOPE 전환`→이전 금액 무효; `같은 날 재실행`→이력 1행 이하; `과거 자료`→도입 이전 point 이력 없음; `기능 off/구형 DB`→DDL·신규행 없음; `다른 출처`→4910/찜 DB 미접근. 기존 price_changes/coupon_price_changes/scan_runs dump는 추가 계산 전후 동일해야 한다.
- [x] **Step 2: 실패 확인.** Run `node --test tests/musinsa-point-pricing.test.js`; Expected FAIL: 새 pricing 함수 미존재.
- [x] **Step 3: 계산·읽기 adapter 구현.** 현재 UTC 날짜의 최신 run에 verifyDailyCoverage를 호출하고 실패는 couponFresh=false로 취급한다. 읽기 adapter는 마지막 저장 이력과 현재 basis/정책을 검증해 현재 값만 반환하고 과거 행을 만들지 않는다. counts 분모는 전체 ACTIVE, 명시적 유효 restricted/eligible 외는 unknown으로 합산한다. trackMusinsa는 recordScanRun 다음에 feature flag와 테이블 존재를 확인해 refresh를 호출하며 새 계산 오류는 경고로 남기되 기존 반환값/알림을 바꾸지 않는다.
- [x] **Step 4: 통과 확인.** Run `node --test tests/musinsa-point-pricing.test.js tests/musinsa-wide-track.test.js tests/musinsa-wide-coupons.test.js tests/musinsa-wide-coverage.test.js`; Expected PASS. 기존 쿠폰 DIRECT/ESTIMATED와 하락 결과 동일.
- [x] **Step 5: 커밋.** `git add src/musinsaWide/point-pricing.js src/musinsaWide/track.js tests/musinsa-point-pricing.test.js tests/helpers/musinsa-point-fixtures.js` 후 `git commit -m "feat(musinsa): derive point estimates from valid coupon snapshots"`.

### Task 5: 기존 가격 의미를 보존하는 카드·상세 병기

**Files:** Modify `src/dashboard-musinsa.js`의 buildMusinsaCatalog, `src/dashboard-model.js`의 summarize, `src/dashboard-index.js`의 fields·unpackIndex, `src/visualizer.js`의 generateDashboardHtml, `src/dashboard.template.html`의 cardHtml·fillModal, `tests/dashboard-musinsa.test.js`, `tests/dashboard-index.test.js`, `tests/browser/dashboard.test.js`, `tests/helpers/dashboard-page.js`. 검색 변경으로 이동한 줄 번호보다 이 함수 이름을 기준으로 찾는다.

**Interfaces:** Consumes: Task 4 readPointEstimateViews. Produces: 기존 summary에 optional `pointEstimate:number|null`, `pointDiscount:number|null`, `pointState:PointState|null`, `pointCheckedAt:string|null`, `pointMaxUseRate:number|null`; metadata.points는 Spec 계약을 따른다. `generateDashboardHtml`와 `buildMusinsaCatalog` 옵션에 `pointEstimatesEnabled`와 `asOfMs`를 추가하며 기본 flag는 환경 변수, 기본 시각은 Date.now()다. 모든 factory는 자유 변수/import에 의존하지 않는다.

현재 v2 fields의 0~24번 위치는 유지한다. `searchAliases`는 24번이며, 새 다섯 필드는 위 순서대로 25~29번에 추가한다. 누락된 point 필드는 unpack 시 null로 정규화한다. 부가 필드는 `sink.add` 이전의 summary에 붙여 전체 card asset·preview·일반 검색 결과·route 기반 독립 조회가 같은 값을 전달하도록 한다. 기존 `searchProduct`·lookup·cancelQuery 및 route 스키마는 그대로 사용하며 worker/runtime 구조 변경은 필요하지 않다.

브라우저 helper의 `writeFixture(dir, options)`는 기존 옵션을 보존하고 `pointScenario=null`, `pointEstimatesEnabled=(pointScenario!==null)`, `asOfMs=Date.parse('2026-10-24T10:00:00.000Z')`를 추가한다. pointScenario는 null 또는 ELIGIBLE/RESTRICTED/UNKNOWN/STALE이다. null이면 기존 fixture 내용을 유지한다. 그 외에는 `search:true`의 상품 2156295와 130개 방해 상품을 재사용하고, Task 4의 유효 coverage fixture와 Tasks 1~4의 정책·계산 helper로 상태를 만든다. ELIGIBLE의 정책 확인 시각은 asOfMs-3600000, 판매가263200·쿠폰가248200·사용률0.07이며, scan 날짜는 asOfMs의 UTC 날짜다. UNKNOWN은 정책 없음, RESTRICTED는 명시적 제한, STALE은 확인 후604800000ms 경계다. 생성된 point 이력은 fixture snapshot 날짜에만 기록한다. 두 빌드 옵션을 generateDashboardHtml에 전달하고 기존 테스트의 날짜·동작은 바꾸지 않는다.

- [x] **Step 1: 실패 테스트 작성.** 아래 assertions와 이름을 각각 existing fixture tests에 넣는다.

```js
// '별도 예상가는 기본 가격 판정을 바꾸지 않는다'
assert.equal(item.my, 248200);
assert.equal(item.pointEstimate, 230830);
assert.deepEqual(item.L, oldCouponRows); // archive fixture 또는 export한 L로 검사
assert.equal(item.dropAmt, previousCouponDropAmt);
assert.equal(item.isLow, previousCouponIsLow);
```

`인덱스 호환`→0~24번 field positions 동일/25~29번 pack-unpack 값 유지/브랜드 별칭 검색 유지. 기존 `brand aliases survive compact indexes and older rows remain searchable` 테스트의 `.pop()`은 제거하고 다음 두 구형 prefix를 각각 검증한다.

```js
const beforeAliases = structuredClone(packed);
beforeAliases.rows = beforeAliases.rows.map(row => row.slice(0, 24));
const aliasesOnly = structuredClone(packed);
aliasesOnly.rows = aliasesOnly.rows.map(row => row.slice(0, 25));
// beforeAliases: searchAliases=[]; aliasesOnly: searchAliases=['kimuir'];
// 두 경우 모두 다섯 point 필드가 null이고 한국어 상품 검색이 유지된다.
```

`read-only build`→DB dump 전후 동일; `빌드 시 만료`→카드 금액 null; `집계`→eligible+restricted+unknown=active; `feature off`→부가 필드 null·문구 숨김. `summary 전달 경로 일치`→같은 상품의 card asset·preview·route 조회 결과에 다섯 point 필드가 동일하다.

Browser named tests는 HTTP Worker와 file://에서 다음을 검증한다: `일반 검색의 적립금 병기`→쿠폰가248200·예상가230830·보유17370원 가정·KST 확인 시각, 제한/미확인/만료 및 feature off; `독립 상품 조회의 적립금 병기`→preview 밖 상품을 숫자2156295와 지원 URL로 각각 찾고, index 요청 차단 및 상품을 제외하는 저장 필터(src=4910/cat=top/filter=drop) 조건에서도 동일 금액·조건이 표시된다. 독립 조회에서 필터는 보존되고 이전/다음 결과 탐색은 비활성화다. 상세 history 로딩 완료와 close/reopen 뒤에도 값·조건이 유지된다. `쿠폰가 정렬 보존`→가격순 정렬은 pointEstimate가 아니라 기존 my 기준이다. 기존 chart L의 값·날짜 집합은 늘리지 않는다.
- [x] **Step 2: 실패 확인.** Run `node --test tests/dashboard-musinsa.test.js tests/dashboard-index.test.js`; Expected 새 필드 assertion FAIL.
- [x] **Step 3: adapter와 UI 구현.** 기존 my/rate/dropAmt/lowMy/priceSource와 L은 보존하고 summary·card·preview에 부가 필드를 전달한다. 일반 결과와 paintProduct가 공유하는 cardHtml 및 fillModal에 Spec 문구를 적용한다. 상세 history 갱신 시 summary 필드를 유지한다. searchAliases·독립 조회·저장 필터·명시적 재시도 동작을 보존한다. 전체 적립금 이력 UI는 만들지 않으며 빌드에서 원격 fetch를 하지 않는다.
- [x] **Step 4: 통과 확인.** 위 unit 명령과 `npm run test:dashboard:browser` Expected PASS. 실제 브라우저 검증을 실행하지 못하면 미완료로 보고한다. 30만 합성 build에서 정책/이력 읽기를 bulk/prepared streaming으로 처리하며 상품마다 새 테이블 검사를 하지 않는지 검사한다.
- [x] **Step 5: 커밋.** 이 Task의 Files에 적은 9개 파일만 `git add`로 명시한 뒤 `git commit -m "feat(dashboard): show optional point usage estimates beside coupon prices"`.

### Task 6: CLI·직렬 workflow·Release 검증과 운영 문서

**Files:** Create `src/musinsaWide/point-cli.js`, `.github/workflows/musinsa-points.yml`, `scripts/run-musinsa-points.js`, `scripts/check-musinsa-points.js`, `tests/cli-musinsa-points.test.js`, `tests/musinsa-point-workflow.test.js`; modify `src/cli.js:1331-1339,1372`, `.github/workflows/musinsa-wide.yml`, `.github/workflows/pages.yml`, `README.md`.

**Interfaces:** Consumes: Tasks 2~4, 기존 Release pullDb/pushDb. Produces: `runPointPolicyStep({flags,dbPath,openStore,fetchPolicy,now,sleep,log}) -> Promise<{ok:boolean,publishable:boolean,result?:CollectorResult,error?:string}>` 및 CLI `node src/cli.js musinsa-point-policies [--limit 1..5000] [--dry-run]`. CollectorResult는 Task 3의 반환 타입이다. `runPointPolicyJob({dbPath,pullFn,stepFn,checkFn,pushFn,flags,enabled,log}) -> Promise<{ok:boolean,published:boolean,skipped?:boolean,result?:CollectorResult,error?:string}>`는 pull→step→check→push 순서를 소유하며 main script는 이를 호출한다. pullFn({dest})는 기존 {bytes,source}, stepFn({flags,dbPath})는 위 Step 결과, checkFn(dbPath)는 아래 검증 결과, pushFn({src})는 기존 push 결과를 반환한다. 독립 check 함수 `verifyPointSnapshot(db) -> {policies,prices,valid,unknown,lastStop}`를 검증 script에서 export한다. script main은 read-only로 확인하고 구조적 불일치면 exit 1이다.

- [x] **Step 1: 실패 테스트 작성.** 새 CLI를 dependency injection으로 검사한다: `없는 DB`→생성·fetch·push 없음; `dry-run`→후보 요약만/쓰기·fetch 0; `feature off`→no-op; `잘못된 limit`→실행 전 거절; `429 부분완료`→ok=true/publishable=true/성공분 보존; `DB 오류`→ok=false/publishable=false; `check`→존재 상품 참조·금액·상태·정책버전·NULL 일관성 위반 시 실패. 새 CLI의 main dispatch는 !ok일 때 exitCode=1이다.

workflow test는 runPointPolicyJob의 주입된 함수 호출 순서와 원격 실패를 검증한다: source=prev면 step/push 없음, step→check→push 순서, 구조적 오류이면 push 없음, quota/429는 결과 상태를 유지하고 부분 snapshot push, push 실패는 ok=false. YAML은 main 성공 wide workflow_run/job guard, 수동 limit 검증, shared clot-daily/cancel-in-progress=false, timeout=100분, quota 기본1000, 잠금 이후 pull 진입점, Pages 성공 workflow 목록의 새 이름을 정적으로 확인한다. GitHub runner 자체의 직렬 동작은 로컬 테스트로 검증했다고 주장하지 않는다.

- [x] **Step 2: 실패 확인.** Run `node --test tests/cli-musinsa-points.test.js tests/musinsa-point-workflow.test.js`; Expected 새 명령/검증/파일 assertion FAIL.
- [x] **Step 3: CLI와 검증기 구현.** point-cli는 DB 존재 확인 후에만 writer를 열고 dry-run은 read-only·initialize=false다. 일반 실행은 collector 후 refresh, 구조 검증, checkpoint/close까지 수행하되 직접 Release를 조작하지 않는다. 기존 cli.js의 라우팅·help만 연결한다. 구조 검증은 unknown 부분 지원을 실패로 취급하지 않는다.
- [x] **Step 4: workflow와 README 구현.** repo variable `CLOT_MUSINSA_POINTS_ENABLED`를 job/env에 전달하고 기본 비활성화한다. 새 workflow는 `scripts/run-musinsa-points.js`로 runPointPolicyJob을 실행하며 기존 pullDb 반환값의 source=latest를 확인한다(기존 CLI는 prev를 경고만 하므로 그대로 사용하지 않는다). publishable일 때만 check/push하고 result.stop을 Actions summary에 남긴다. check 실패는 push를 막는다. 새 작업은 세션 secret·텔레그램을 읽지 않는다. daily wide와 Pages에도 동일 활성화 변수를 전달한다. README에 지원 범위 상한35,000개, 7일 조건, 잔액 가정, 파일럿1000→설정5000, 조회 실패 해석, off/rollback을 기록한다. 이전 코드 복구 시 새 표시는 제거되지만 쿠폰 기록은 유지됨을 명시한다.
- [x] **Step 5: 국소·전체 검증.** Run `node --test tests/cli-musinsa-points.test.js tests/musinsa-point-workflow.test.js tests/musinsa-wide-release.test.js tests/site4910-release.test.js`, 이어 `npm test`, 이어 `npm run test:dashboard:browser`; Expected 모두 PASS. 검증용 build는 임시 디렉터리에 생성하고 `node scripts/verify-dashboard-build.js <임시경로>/index.html`도 PASS여야 한다. 외부 Actions/Release 실행과 실제 1,000회 파일럿은 이 테스트 단계에 포함하지 않는다.
- [x] **Step 6: 최종 scope 검사와 커밋.** `git diff --check` 후 이 Task의 파일만 stage하고 `git diff --cached --stat`/`git diff --cached --check`로 무관한 파일·데이터가 없는지 확인한다. `git commit -m "feat(musinsa): add opt-in point policy workflow and publishing checks"`.

## 자체 검토 및 실행 인계

- Spec coverage: API/계산 Task1, 캐시/공정성/한도/이력 Task2, 재시도/중단 Task3, 신선도/기존 수집 Task4, 표시/호환 Task5, 직렬 실행/배포/복구 Task6에 대응한다.
- Type consistency: 모든 후속 Task는 PointPolicy/PointEstimate와 클래스 메서드 이름을 그대로 사용한다. raw API는 typo 필드, 내부는 restricted/maxUseRate, DB는 snake_case, UI는 point 접두어를 사용한다.
- Review Focus의 다섯 장애군은 각 소유 Task의 named tests에 배정했다. 구현자 재량인 테스트 보조 변수/fixture body와 고정 인터페이스를 구분했다.
- `2805482` 반영 검토: Task 5는 searchAliases 위치 보존, 24/25필드 구형 prefix, 독립 상품번호·URL 조회, card/preview 전달 및 고정 시각 브라우저 fixture를 명시했다. Tasks 1~4와 6의 설계·순서는 변경하지 않았다.
- 구현 완료 후에도 실서비스의 지속 처리량·GitHub 직렬 실행·실제 Release/Pages 갱신은 별도 관측 전까지 미검증이다. 파일럿/활성화/배포는 사용자 지시 없이 수행하지 않는다.
- 실행은 6개 Task가 같은 저장·가격·표시 인터페이스를 순차 공유하므로 **Native**를 권장한다. 사용자 검토와 실행 방식 선택 후에 시작하며, Native를 택하면 executing-plans를 따르고 마지막에 독립 리뷰를 받는다. Subagent-driven을 택하면 subagent-driven-development를 따른다.

## Native 실행 결과

- 별도 작업트리의 `codex/musinsa-point-estimates`에서 Tasks 1~6을 구현했다.
- Node 24.22.1: 단위 테스트 1,085개, HTTP Worker·file 브라우저 테스트 50개 통과.
- 30만 ACTIVE 후보/빌드 검증 및 임시 예상가 활성 fixture 빌드 검증 통과.
- DB close 실패와 캐시 제한 값 NULL의 보수적 처리 회귀 테스트 추가.
- 기능 기본 비활성화. 실제 파일럿·변수 활성화·원격 업로드·배포는 실행하지 않았다.
- 전체 브랜치 독립 리뷰 완료. 후보 선택/예약 중 예산 만료를 schema 오류로 기록하던 경계 사례를 재현 테스트 2개로 확인하고 수정했다. 수정 후 Node 24 전체 단위 테스트 1,085개 통과.
