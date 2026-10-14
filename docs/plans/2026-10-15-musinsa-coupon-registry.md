# 무신사 쿠폰 등록부 (번호 순회) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상품별 순환 조회(하루 회원 4,000회)를 쿠폰 등록부로 바꾼다. 쿠폰 번호를 비로그인으로 순회하고, 회원 조회 400회 이하로 우리 계정이 쓸 수 있는 쿠폰을 가린 뒤, 쓸 수 있는 쿠폰의 적용 상품 목록으로 3만 개 전부의 쿠폰가를 매일 계산한다.

**Architecture:**
- 기존 `src/musinsaWide/`를 확장한다.
  - `client.js`: 비로그인 쿠폰 목록 API를 더한다.
  - `registry.js` (새 파일): 번호 순회, 판별, 이웃 조회, 전환.
  - `walk.js` (새 파일): 쿠폰 목록 순회.
  - `coupons.js`: 회원 조회기, 쿠폰가 계산, 표본 정확도.
  - `store.js`: 새 표와 마이그레이션.
  - `track.js`: 하루 흐름과 전환 실행.
- DB는 지금처럼 `data/musinsa-wide.db` 하나를 쓰고 Release `data-musinsa`로 오간다.
- 전환은 workflow의 `backfill` 모드로 한 번 실행한다. 전환이 끝나기 전에는 쿠폰가를 계산하지 않는다.

**Tech Stack:** Node 24 ESM, `node:sqlite`, `node:test`, GitHub Actions. 외부 npm 의존성 없음.

**Spec:**
- `docs/specs/2026-10-14-musinsa-coupon-lists.md`: 6절은 설계, 10절은 결정, 11절은 구현 세부와 상수다.
- `docs/specs/2026-10-14-musinsa-wide.md`: 2026-10-15 개정 상자와 결정 #14~#18.
- 참고: 검증 스크립트 `scripts/musinsa-coupon-plp-verify.js`. `greedyPlan`은 694행, `walk`는 245행, `plpCount`는 668행이다. 이 계획의 알고리즘은 여기서 옮긴다. 스크립트 자체는 바꾸지 않는다.

## Global Constraints
- 쿠폰 목록 API: `https://api.musinsa.com/api2/coupon/plp/v1/goods`(목록)와 `…/goods/count`(개수). 공통 파라미터는 `couponNo, couponKind=PRODUCT, caller=COUPON, gf=A, category`이고, 목록에는 `sortCode=REVIEW, page, size=300`을 더한다. `size`는 항상 `300`이다(301 이상은 오류 없이 빈 응답).
- 비로그인 호출에는 쿠키를 붙이지 않는다. 헤더는 `User-Agent: USER_AGENT`, `Referer: https://www.musinsa.com/`. 작업자 `2`개, 작업자마다 호출 간격 `500`ms.
- 비로그인 재시도: 429는 다시 시도하지 않고 그 단계를 멈춘다. 그 밖의 오류는 `2000`, `4000`ms 뒤에 다시 시도한다(최대 3회).
- 번호 순회: `50`개씩 묶는다. 상품 없는 번호가 `200`개 이어지면 멈추고, 마지막으로 상품이 있던 번호의 `+500, +1000, +2000`을 묻는다. 빈 번호는 처음 본 날로부터 `3`일 동안 다시 묻는다.
- 이웃 조회: 반경 `50`, 하루 count `300`회까지. 대상은 등록부에 없던 쿠폰이 회원 조회에 나왔는데 번호가 `enum_floor`보다 작은 경우다.
- 회원 조회: 판별 하루 `200`회(`CLASSIFY_CAP`), 표본 하루 `200`개(`SAMPLE_PER_DAY`, 대분류마다 `40`), 전환 판별 `1500`회(`BACKFILL_CLASSIFY_CAP`).
- 목록 순회:
  - 5개 대분류 합이 `3000`개 이하인 쿠폰은 한 번에 끝까지 읽는다.
  - 그보다 큰 쿠폰은 대분류마다 읽는다. 마지막 상품의 리뷰 수가 그 대분류의 최저 리뷰 수보다 작아지면 `1`페이지 더 읽고 멈춘다. 대분류당 최대 `60`페이지다.
- 생존 관리: `7`일 동안 관찰 `3`건 이상이고 한 번도 나오지 않으면 퇴출한다.
- 정리: `OTHER`와 `OUT_OF_SCOPE`는 처음 본 날로부터 `60`일 뒤 지운다. 관찰은 `7`일 뒤 지운다.
- 직접 조회 결과는 `10`일 동안 쓴다(`COUPON_TTL_DAYS`). 만료된 쿠폰은 그 쿠폰만 뺀다.
- 마감:
  - 번호 순회는 실행 시작부터 `12`분, 판별은 `15`분, 전체는 `35`분(`RUN_BUDGET_MS_MUSINSA`, 지금과 같음).
  - 전환은 `160`분이고, 그중 번호 순회는 `130`분까지다. 전환 시작 번호는 `345000`이다.
  - workflow 제한은 일상 `45`분, `backfill` `180`분이다.
- 등록부 상태 문자열: `USABLE`, `OTHER`, `PENDING`, `OUT_OF_SCOPE`, `RETIRED`.
- `meta` 키: `frontier`, `enum_cursor`, `enum_floor`, `backfill_done`, `registry_first_priced`.
- 쿠키 값은 로그, 에러, 텔레그램 어디에도 찍지 않는다. 텔레그램 한 통은 4096자 이하이고, `parse_mode=HTML`에 맞게 이스케이프한다.
- 모든 테스트 파일의 첫 줄은 `import './setup-env.js';`. 날짜는 KST `YYYY-MM-DD` 문자열이다.
- 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`을 붙인다.

## Review Focus
1. **이미 Release에 있는 DB(옛 스키마)를 새 코드가 열 때.** 컬럼과 표가 추가되고, 기존 행과 쿠폰가 이력은 그대로 남아야 한다. → Task 2의 마이그레이션 테스트.
2. **전환이 끝나기 전의 일상 실행.** 쿠폰가는 모두 NULL이어야 하고, 2~5단계는 호출을 하나도 하지 않으며, 요약에 "backfill 필요"가 나와야 한다. → Task 9 테스트.
3. **비로그인 429가 단계 도중에 나는 경우.** 그 단계만 멈춘다. 순회하지 못한 쿠폰은 전날 `coupon_goods`를 그대로 쓰고, 쿠폰가 계산과 DB push는 정상으로 진행한다. → Task 7, Task 9 테스트.
4. **오래된 구간의 성긴 번호(공백이 200개를 넘음).** 전환 실행은 등록부의 가장 큰 번호에 닿기 전에는 멈추면 안 된다. → Task 5 테스트(`mustReach`).
5. **같은 날 다시 실행하는 경우.** 표본이 같은 상품을 다시 뽑지 않고(오늘 조회한 상품은 제외), 관찰이 중복되지 않고, `coupon_goods`가 두 번 쌓이지 않아야 한다. → Task 3 테스트.

---

### Task 1: 클라이언트 — 비로그인 쿠폰 목록 API와 리뷰 수

**Files:**
- Modify: `src/musinsaWide/client.js`
- Test: `tests/musinsa-wide-client.test.js`

**Interfaces:**
- Produces:
  - 상수: `PLP_API = 'https://api.musinsa.com/api2/coupon/plp/v1/goods'`, `PLP_PAGE_SIZE = 300`, `ALL_CATEGORIES_PARAM = '001,002,003,103,004'`, `ANON_RETRY_BACKOFF_MS = [2000, 4000]`.
  - `createMusinsaClient({ ..., anonDelayMs = 500 })`가 새 메서드 두 개를 돌려준다. 둘 다 쿠키를 보내지 않는다.
    - `getCouponGoodsCount(couponNo, { category = ALL_CATEGORIES_PARAM } = {}) → Promise<number>`. 응답의 `data`가 숫자가 아니면 Error.
    - `getCouponGoodsPage(couponNo, { page = 1, category = ALL_CATEGORIES_PARAM } = {}) → Promise<{ items: Array<{ goodsNo: number, reviewCount: number|null, isSoldOut: boolean }>, totalCount: number, hasNext: boolean }>`. `meta.result !== 'SUCCESS'`이거나 `data.list`가 배열이 아니면 Error.
    - 둘 다 HTTP 오류이면 `err.status`를 붙여 던진다. 비로그인 호출끼리 같은 카운터를 써서, 두 번째 호출부터 `anonDelayMs`만큼 쉰다.
  - `anonCall(fn, { sleep }) → Promise<T>`: 위 두 메서드를 감싸는 재시도 함수. 429는 곧바로 다시 던진다. 그 밖의 오류는 `ANON_RETRY_BACKOFF_MS`대로 쉬고 다시 시도하며, 최대 3회 시도한다.
  - `toListingRow`가 `review_count: item.reviewCount ?? null`을 더한다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `getCouponGoodsCount builds the count URL without a cookie`
    - 가짜 fetch가 받은 URL이 `PLP_API + '/count?'`로 시작한다.
    - 파라미터는 `couponNo=360001&couponKind=PRODUCT&caller=COUPON&gf=A&category=001%2C002%2C003%2C103%2C004`이다.
    - 헤더에 `Cookie`가 없다.
    - 응답 `{ data: 42 }`면 `42`를 돌려준다.
  - `getCouponGoodsPage asks sortCode=REVIEW size=300 and maps items`
    - URL 파라미터에 `sortCode=REVIEW`, `size=300`, `page=2`가 있다.
    - 응답 `{ meta: { result: 'SUCCESS' }, data: { list: [{ goodsNo: '7', reviewCount: 10, isSoldOut: false }], pagination: { totalCount: 1, hasNext: false } } }`이면 `{ items: [{ goodsNo: 7, reviewCount: 10, isSoldOut: false }], totalCount: 1, hasNext: false }`를 돌려준다.
  - `anonymous calls are spaced by anonDelayMs and carry a timeout signal`
    - 두 번째 호출 전에 `sleep(500)`이 불린다.
    - 모든 요청에 `signal`이 있다.
  - `anon 429 throws err.status 429; anonCall does not retry it`
    - `anonCall`이 429를 1회만 시도하고 다시 던진다.
  - `anonCall retries a 503 after 2000 then 4000 ms and gives up after 3 attempts`
  - `toListingRow keeps reviewCount as review_count`
    - `reviewCount: 1234` → `review_count: 1234`, 값이 없으면 `null`.
- [ ] **Step 2:** `node --test tests/musinsa-wide-client.test.js` → 새 테스트가 FAIL.
- [ ] **Step 3:** `src/musinsaWide/client.js`에 위 Interfaces를 구현한다. 헤더 구성은 `getUsableCoupons`(client.js:40)와 같고, `Cookie`만 뺀다.
- [ ] **Step 4:** `node --test tests/musinsa-wide-client.test.js` → PASS.
- [ ] **Step 5: 커밋** `feat(musinsa): anonymous coupon goods list/count client and listing review counts`

---

### Task 2: 저장소 — 스키마, 마이그레이션, 메타, 등록부 상태

**Files:**
- Modify: `src/musinsaWide/store.js`
- Test: `tests/musinsa-wide-store.test.js`

**Interfaces:**
- Produces:
  - 상수: `COUPON_STATE = { USABLE: 'USABLE', OTHER: 'OTHER', PENDING: 'PENDING', OUT_OF_SCOPE: 'OUT_OF_SCOPE', RETIRED: 'RETIRED' }`.
  - 타입 `RegistryCoupon = { coupon_no: number, state, name, type, percent, price, max, min, start_date, until_date, last_count, scope_goods: number[]|null, first_seen_date, last_member_seen_date, classified_date }`
  - 메타:
    - `getMeta(key) → string|null`
    - `setMeta(key, value|null)`: `null`이면 그 키를 지운다.
  - 조회:
    - `getCoupon(couponNo) → RegistryCoupon|undefined`
    - `maxCouponNo() → number|null`
    - `filterActive(goodsNos: number[]) → number[]`: ACTIVE인 상품만 남긴다.
  - 번호 순회 기록:
    - `recordHit(couponNo, date, count, { scopeGoods = null } = {}) → 'new'|'known'`
      - 등록부에 없으면 새로 넣는다. `scopeGoods`가 비어 있지 않으면 `PENDING`, 비어 있으면 `OUT_OF_SCOPE`이고, `first_seen_date = date`로 둔다.
      - 이미 있으면 `last_count`만 갱신한다.
      - 어느 경우든 `coupon_empty_numbers`에서 그 번호를 지운다.
    - `recordEmpty(couponNo, date)`: 이미 있으면 처음 본 날을 유지한다.
    - `emptyNumbersToRecheck(date) → number[]`: `date−3 ≤ first_seen_date < date`인 번호.
  - 판별:
    - `pendingCoupons() → RegistryCoupon[]`: `coupon_no` 오름차순.
    - `upsertMemberCoupons(date, coupons /* parseCoupon 결과 */) → { added: number[], revived: number[] }`
      - 받은 쿠폰을 모두 `USABLE`로 둔다. 조건(`name, type, percent, price, max, min, start_date=c.start, until_date=c.until`)과 `last_member_seen_date=date`를 쓴다.
      - `added`는 등록부에 없던 번호, `revived`는 `USABLE`이 아니던 번호다.
    - `markClassified(couponNos, date, state)`: 대상이 `PENDING`일 때만 `state`로 바꾸고 `classified_date=date`로 둔다.
  - 쓸 수 있는 쿠폰:
    - `usableCoupons(date) → RegistryCoupon[]`: `USABLE`이고 `until_date`가 NULL이거나 `>= date`인 것.
    - `seedFromGoodsCoupons(date) → number`: `goods.coupons_json`의 쿠폰 중 `until`이 없거나 `>= date`인 것을 `upsertMemberCoupons`로 넣는다. 넣은 수를 돌려준다.
    - `registryCounts(date) → { usable, pending, expiredYesterday }`: `expiredYesterday`는 `until_date`가 어제인 `USABLE` 쿠폰 수다.
  - 마이그레이션: 생성자가 `PRAGMA table_info`를 보고 다음 컬럼이 없으면 `ALTER TABLE ... ADD COLUMN`으로 더한다.
    - `goods.review_count INTEGER`
    - `scan_runs.coupon_metrics_json TEXT`
  - 새 표: `coupons`, `coupon_empty_numbers`, `coupon_goods`, `coupon_observations`, `meta`. 컬럼은 spec §11.2를 따른다. `coupon_goods`의 기본 키는 `(coupon_no, goods_no)`, `coupon_observations`는 `(coupon_no, goods_no, date)`.
  - `applyScan`의 `UPDATABLE`에 `review_count`를 넣는다. insert와 update에서도 쓴다.
  - `recordScanRun({ ..., couponMetrics = null })`이 `coupon_metrics_json`에 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `opening a DB with the 2026-10-14 schema adds the new columns and tables and keeps rows`
    - `DatabaseSync`로 옛 `goods`와 `scan_runs` DDL(store.js:33-60 그대로)만 만들고 행 하나를 넣는다.
    - `new MusinsaWideStore(path)`로 연 뒤 `getGoods(1).review_count === null`이다.
    - `recordScanRun({ ..., couponMetrics: { a: 1 } })`가 동작한다.
    - `coupons` 표가 있다.
  - `applyScan stores review_count and rewrites a row when only review_count changed`
  - `meta round-trips and null deletes`
  - `recordHit puts PENDING with scope goods, OUT_OF_SCOPE without, and only updates last_count when known`
    - 두 번째 `recordHit`의 반환값이 `'known'`이고 상태는 그대로다.
  - `recordHit clears an empty number; emptyNumbersToRecheck keeps 3 days and excludes today`
    - `D-4`, `D-3`, `D-1`, `D`에 기록한 번호 중 `D`에 다시 물을 번호는 `[D-3 번호, D-1 번호]`다.
  - `upsertMemberCoupons registers USABLE with conditions and reports added and revived`
    - `OTHER`, `OUT_OF_SCOPE`, `RETIRED`였던 번호는 `revived`에 들어가고 `USABLE`이 된다.
  - `markClassified changes only PENDING rows`
  - `usableCoupons excludes expired and non-USABLE`
  - `seedFromGoodsCoupons registers unexpired stored coupons once`
  - `registryCounts reports usable, pending and coupons that expired yesterday`
- [ ] **Step 2:** `node --test tests/musinsa-wide-store.test.js` → FAIL.
- [ ] **Step 3:** `src/musinsaWide/store.js`에 위 Interfaces를 구현한다. 파일 머리 주석에 등록부 표를 설명하는 두 줄을 더한다.
- [ ] **Step 4:** `node --test tests/musinsa-wide-store.test.js` → PASS.
- [ ] **Step 5: 커밋** `feat(musinsa): coupon registry tables, schema migration and meta`

---

### Task 3: 저장소 — 적용 상품, 관찰과 퇴출, 표본, 리뷰 최저선, 정리

**Files:**
- Modify: `src/musinsaWide/store.js`
- Test: `tests/musinsa-wide-store.test.js`

**Interfaces:**
- Consumes: Task 2의 표와 `COUPON_STATE`.
- Produces:
  - 상수: `LIVENESS_DAYS = 7`, `LIVENESS_MIN_OBS = 3`, `REGISTRY_KEEP_DAYS = 60`, `EMPTY_RECHECK_DAYS = 3`(Task 2가 쓰던 값을 상수로 올린다).
  - 적용 상품:
    - `replaceCouponGoods(couponNo, date, goodsNos)`: 트랜잭션 하나로 처리한다. 그 쿠폰의 행을 지우고, ACTIVE 상품만 `(coupon_no, goods_no, date)`로 넣는다.
    - `couponGoodsCount() → number`
    - `couponsByGoods() → Map<number, number[]>`: 상품 번호에서 쿠폰 번호들로.
    - `goodsHasDirectCoupon(couponNo) → boolean`: `goods.coupons_json` 중 이 번호를 담은 상품이 있는지.
  - 관찰과 퇴출:
    - `recordObservations(date, checks: Array<{ goods_no: number, couponNos: number[] }>) → number`
      - 각 조회 상품에 대해, `USABLE`이면서 `coupon_goods`에 그 상품이 있는 쿠폰마다 `seen = couponNos.includes(coupon_no) ? 1 : 0`을 `INSERT OR REPLACE`한다.
      - 넣은 행 수를 돌려준다.
    - `retireDead(date) → number[]`: `date−6 ≤ date' ≤ date` 구간에서 관찰이 3건 이상이고 `seen`의 합이 0인 `USABLE` 쿠폰을 `RETIRED`로 바꾸고, 그 번호들을 돌려준다.
  - 표본과 최저선:
    - `pickSample(n, date) → Array<{ goods_no, cat, brand, sale_price, extra_discount }>`
      - 대분류마다 `Math.floor(n / 5)`개를 뽑는다.
      - 후보는 ACTIVE이고, 품절이 아니고, `sale_price`가 있고, `coupon_checked_date`가 `date`가 아닌 상품이다.
      - 후보를 `goods_no` 순으로 놓고, 날짜에서 나온 시드로 섞는다. 시드는 `date`의 문자 코드를 FNV-1a 32비트로 해시한 값이고, 섞을 때는 `mulberry32`(검증 스크립트 52행)를 쓴다. 섞은 뒤 앞에서부터 가져간다.
    - `categoryReviewFloors() → Record<string, number>`: 대분류마다 ACTIVE이고 `review_count`가 NULL이 아닌 상품의 최솟값.
  - 정리: `pruneRegistry(date) → { coupons, empties, observations }`
    - `OTHER`와 `OUT_OF_SCOPE`는 `first_seen_date < date−60`이면 지운다.
    - 빈 번호는 `first_seen_date < date−3`이면 지운다.
    - 관찰은 `date < date−6`이면 지운다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `replaceCouponGoods keeps only ACTIVE goods and replaces that coupon's rows only`
    - 같은 날 두 번 불러도 행 수가 같다.
  - `couponsByGoods groups coupons per goods`
  - `recordObservations writes seen 1/0 only for USABLE coupons whose list holds the goods; a same-day rerun does not duplicate`
  - `retireDead retires after 3 unseen observations within 7 days, not with 2, not when one was seen, not with an 8-day-old observation`
  - `pickSample is deterministic per date, takes n/5 per category, skips sold-out and today-checked goods`
    - 같은 `date`로 두 번 부르면 같은 결과다.
    - 다른 `date`로 부르면 다른 결과다(대분류마다 후보 100개 기준).
  - `categoryReviewFloors returns the minimum review_count of ACTIVE goods per category`
  - `pruneRegistry removes 60-day-old OTHER/OUT_OF_SCOPE, 3-day-old empties and 7-day-old observations, never USABLE`
  - `goodsHasDirectCoupon finds a coupon in stored coupon lists`
- [ ] **Step 2:** `node --test tests/musinsa-wide-store.test.js` → FAIL.
- [ ] **Step 3:** 구현한다. 날짜 계산은 `coupons.js`의 `dayNumber`와 같은 방식(UTC 자정 기준 일수)으로 하고, store 안에 `shiftDate(date, days) → string` 헬퍼를 둔다.
- [ ] **Step 4:** `node --test tests/musinsa-wide-store.test.js` → PASS.
- [ ] **Step 5: 커밋** `feat(musinsa): coupon goods lists, liveness observations, daily sample and registry pruning`

---

### Task 4: 회원 조회기 — `checkGoodsCoupons`를 공용 조회기로

**Files:**
- Modify: `src/musinsaWide/coupons.js`, `src/musinsaWide/store.js`(`pickCouponChecks` 삭제)
- Test: `tests/musinsa-wide-coupons.test.js`, `tests/musinsa-wide-store.test.js`(`pickCouponChecks` 테스트 삭제)

**Interfaces:**
- Produces:
  - `COUPON_FIELDS.start = 'useFromDate'`. `parseCoupon`이 `start`(날짜 부분 또는 `null`)를 돌려준다.
  - 상수: `CLASSIFY_CAP = 200`, `SAMPLE_PER_DAY = 200`, `BACKFILL_CLASSIFY_CAP = 1500`. `COUPON_CHECKS_PER_DAY`와 `checkGoodsCoupons`는 지운다.
  - `createMemberChecker({ withClient, sessionProvider, concurrency = 3, log = console.log }) → MemberChecker`
    - `start() → Promise<'ok'|'none'|'error'>`: 세션을 한 번 읽는다. 쿠키가 없으면 `'none'`, 읽기가 실패하면 `'error'`.
    - `check(goodsList: Array<{ goods_no, brand, sale_price, extra_discount }>, { deadline = Infinity, onResult }) → Promise<void>`
      - 상품마다 `getUsableCoupons`를 부른다. 결과를 `parseCoupon`으로 바꾸고 `id`로 중복을 지운 뒤 `onResult(goods, coupons)`를 부른다.
      - `stop`이 걸렸거나 마감이 지났으면 새 상품을 시작하지 않는다.
    - `status`(getter): `'ok'|'none'|'error'|'expired'|'throttled'`. 조회가 하나도 성공하지 못하고 실패만 있으면 `'error'`.
    - `calls`(성공 수)와 `failed`(실패 수).
    - 세션 갱신, 쿠키 교체 재시도, 429 처리는 지금 `checkGoodsCoupons`(coupons.js:107-212)와 같다. `check`를 여러 번 불러도 세션 갱신은 그 조회기 안에서 한 번뿐이다.
    - 저장소에는 쓰지 않는다. 쓰는 일은 `onResult`가 한다.

- [ ] **Step 1: 테스트 고치기**
  - 지금의 `checkGoodsCoupons` 테스트(coupons.test.js:124-260)를 `createMemberChecker` 기준으로 옮긴다. 기대값(갱신 1회, 교체 재시도, 429면 `throttled`, 실패만 있으면 `error`, 쿠키가 로그에 없음)은 그대로다.
  - 새 테스트:
    - `two check() calls share one refresh: a second 401 after the refresh ends as expired`
    - `onResult gets deduped parsed coupons with start`
    - `parseCoupon reads useFromDate as start`
  - store 테스트에서 `pickCouponChecks` 세 개를 지운다.
- [ ] **Step 2:** `node --test tests/musinsa-wide-coupons.test.js` → FAIL.
- [ ] **Step 3:** 구현한다. `track.js`는 아직 `checkGoodsCoupons`를 import한다. 이 Task에서는 `track.js`가 `createMemberChecker`와 `store.pickSample(SAMPLE_PER_DAY, date)`로 같은 일을 하도록 최소한만 바꿔 테스트가 통과하게 한다. 흐름 전체는 Task 9에서 다시 짠다.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: 커밋** `refactor(musinsa): shared member coupon checker; drop the 4,000-a-day rotation`

---

### Task 5: 번호 순회와 이웃 조회 (`registry.js`)

**Files:**
- Create: `src/musinsaWide/registry.js`
- Test: `tests/musinsa-wide-registry.test.js`

**Interfaces:**
- Consumes:
  - Task 1의 `getCouponGoodsCount`, `getCouponGoodsPage`, `anonCall`.
  - Task 2의 `recordHit`, `recordEmpty`, `getCoupon`, `maxCouponNo`, `filterActive`, `getMeta`, `setMeta`, `emptyNumbersToRecheck`.
  - `clientPool`, `mapConcurrent`(`src/pool.js`).
- Produces:
  - 상수: `ENUM_BATCH = 50`, `ENUM_EMPTY_STOP = 200`, `ENUM_PROBES = [500, 1000, 2000]`, `NEIGHBOR_RADIUS = 50`, `NEIGHBOR_CAP = 300`, `BACKFILL_FROM = 345000`, `ANON_CONCURRENCY = 2`.
  - `probeNumbers({ withClient, store, date, numbers, deadline = Infinity }) → Promise<{ probed, hits: number[], empties: number[], newCoupons: number[], stop: null|'throttled'|'deadline'|'error' }>`
    - 번호마다 count를 묻는다.
    - count가 0보다 크고 등록부에 없는 번호는 첫 페이지(`page 1`)를 읽는다. 첫 페이지 상품 중 `store.filterActive`를 통과한 것을 `scopeGoods`로 해서 `recordHit`을 부른다.
    - 이미 있는 번호는 `recordHit(n, date, count)`만 부른다.
    - 빈 번호는 기록하지 않고 `empties`로 돌려준다. 기록할지는 호출하는 쪽이 정한다.
    - 429가 나면 `stop = 'throttled'`로 즉시 멈춘다. 같은 번호가 재시도 후에도 계속 실패하면 `stop = 'error'`로 멈춘다.
  - `enumerateNumbers({ withClient, store, date, from, mustReach = null, deadline = Infinity, recordEmpties = true, onCursor = null }) → Promise<{ from, next, probed, hits, highest, stop }>`
    - 알고리즘은 아래 코드 블록과 같다.
    - 끝나면 `highest`가 `meta.frontier`보다 크면 갱신한다.
    - `recordEmpties`가 참이면 `highest`보다 작은 빈 번호만 `recordEmpty`로 기록한다.
  - `recheckEmpties({ withClient, store, date, deadline }) → Promise<{ probed, newPositive }>`: `emptyNumbersToRecheck(date)`를 `probeNumbers`로 다시 묻는다. 빈 번호는 기록을 그대로 둔다.
  - `probeNeighbors({ withClient, store, date, centers: number[], cap = NEIGHBOR_CAP, deadline }) → Promise<{ probed, hits }>`
    - 각 중심의 `±NEIGHBOR_RADIUS` 안에서 등록부에 없는 번호를 중심 순서대로 모은다.
    - `cap`개까지만 `probeNumbers`로 묻고, 빈 번호는 기록하지 않는다.

```
enumerateNumbers 알고리즘
n = from; lastHit = from - 1; run = 0; reach = mustReach ?? -Infinity
loop:
  if now ≥ deadline → stop='deadline', break
  batch = [n .. n+ENUM_BATCH-1]; r = probeNumbers(batch)
  batch 번호 순서대로: count>0 → lastHit = 번호, run = 0, 아니면 run++
  n += ENUM_BATCH; onCursor?.(n)
  if r.stop → stop = r.stop, break
  if run ≥ ENUM_EMPTY_STOP and n > reach:
     probes = ENUM_PROBES.map(d => lastHit + d) 중 ≥ n 인 것; probeNumbers(probes)
     첫 hit p 가 있으면 reach = p, run = 0 으로 계속 (n부터 순서대로 p까지 훑는다)
     없으면 break
highest = lastHit (from-1이면 null)
```

- [ ] **Step 1: 실패하는 테스트 작성** (가짜 client: `counts` 맵과 `pages` 맵, 429를 던지는 번호 지정 가능)
  - `enumerateNumbers stops after 200 empties past the last hit`
    - 100~130과 200에 쿠폰이 있다.
    - 불린 번호는 `from=100`부터 `≤ 200+200+50`까지다.
    - `+500/+1000/+2000` 탐침이 1회씩 불린다. `highest === 200`이다.
  - `a probe hit at lastHit+1000 makes it walk on up to and past the probe`
  - `mustReach keeps walking through a 400-number gap below it`
    - 100에 쿠폰이 있고 그다음은 600이다. `mustReach=600`이면 600을 찾는다.
  - `only empties below the highest hit are recorded`
  - `a new number's first page sets PENDING with ACTIVE goods, OUT_OF_SCOPE without; a known number only updates last_count`
  - `429 stops with throttled and keeps what was recorded`
  - `deadline stops before the next batch`
  - `frontier meta advances only upward`
  - `recheckEmpties counts numbers that turned positive`
  - `probeNeighbors probes ±50 of each center, skips known numbers, caps at 300`
- [ ] **Step 2:** `node --test tests/musinsa-wide-registry.test.js` → FAIL.
- [ ] **Step 3:** `src/musinsaWide/registry.js`를 만든다. 비로그인 호출은 `withClient((client) => anonCall(() => client.getCouponGoodsCount(n), { sleep: client.sleep }))` 형태로 하고, `mapConcurrent`의 동시 수는 `ANON_CONCURRENCY`다.
- [ ] **Step 4:** `node --test tests/musinsa-wide-registry.test.js` → PASS.
- [ ] **Step 5: 커밋** `feat(musinsa): coupon number enumeration, empty re-checks and neighbour probes`

---

### Task 6: 새 쿠폰 판별 (`registry.js`)

**Files:**
- Modify: `src/musinsaWide/registry.js`, `src/musinsaWide/store.js`(`goodsInfo`)
- Test: `tests/musinsa-wide-registry.test.js`, `tests/musinsa-wide-store.test.js`

**Interfaces:**
- Consumes:
  - Task 4의 `MemberChecker`.
  - Task 2의 `pendingCoupons`, `upsertMemberCoupons`, `markClassified`, `getMeta('enum_floor')`.
  - 기존 `putGoodsCoupons`(store.js:197).
- Produces:
  - `planClassification(pending: RegistryCoupon[], goodsInfo: Map<number, { review_count, is_sold_out, status }>) → { plan: Array<{ goods_no, couponNos: number[] }>, unclassifiable: number[] }`
    - 순수 함수다. 알고리즘은 검증 스크립트의 `greedyPlan`(694행)과 같다.
    - 후보 상품은 `status === 'ACTIVE'`이고 품절이 아닌 상품이다.
    - 남은 대기 번호를 가장 많이 덮는 상품부터 고른다. 같으면 `review_count`가 큰 상품, 그다음 `goods_no`가 작은 상품이다.
    - 어떤 후보 상품에도 걸리지 않는 대기 번호는 `unclassifiable`이다.
  - store에 `goodsInfo(goodsNos) → Map`을 더한다(위 세 필드).
  - `classifyPending({ store, checker, date, cap = CLASSIFY_CAP, deadline = Infinity }) → Promise<{ calls, usable, other, outOfScope, pending, neighborCenters: number[], checks: Array<{ goods_no, couponNos }> }>`
    - `unclassifiable`은 `markClassified(..., 'OUT_OF_SCOPE')`.
    - `plan.slice(0, cap)`의 상품을 `checker.check`로 조회한다. 결과마다:
      1. `putGoodsCoupons(goods_no, date, coupons, goods)`
      2. `upsertMemberCoupons(date, coupons)`. 돌려받은 `added` 중 `enum_floor`보다 작은 번호를 `neighborCenters`에 넣는다.
      3. 그 상품이 덮은 번호 중 결과에 없는 번호는 `markClassified(..., 'OTHER')`.
    - `checks`는 생존 관찰(Task 3)에 넘길 조회 기록이다.
    - `pending`은 끝난 뒤 남은 `PENDING` 수다.
    - 조회기가 `'ok'`가 아니면 아무것도 하지 않고 0을 돌려준다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `planClassification picks the goods covering most pending coupons, ties by reviews then goods_no`
    - 대기 A=[1,2], B=[2,3], C=[4], 리뷰는 2>1>3>4다.
    - 계획은 `[{goods:2, [A,B]}, {goods:4, [C]}]`이다. 품절 상품은 고르지 않는다.
  - `a pending coupon whose scope goods are all sold out or gone is unclassifiable`
  - `classifyPending marks returned coupons USABLE and the rest of the covered ones OTHER`
  - `classifyPending stops at cap; leftovers stay PENDING and are counted`
  - `an old-numbered coupon newly seen in a member result becomes a neighbour centre`
    - `enum_floor = 345000`이고, 결과에 등록부에 없던 334342가 있다.
  - `a non-ok checker classifies nothing`
- [ ] **Step 2:** `node --test tests/musinsa-wide-registry.test.js` → FAIL.
- [ ] **Step 3:** 구현한다.
- [ ] **Step 4:** `node --test tests/musinsa-wide-registry.test.js` → PASS.
- [ ] **Step 5: 커밋** `feat(musinsa): greedy member classification of new coupons`

---

### Task 7: 쿠폰 목록 순회 (`walk.js`)

**Files:**
- Create: `src/musinsaWide/walk.js`
- Test: `tests/musinsa-wide-walk.test.js`

**Interfaces:**
- Consumes:
  - Task 1의 `getCouponGoodsPage`, `anonCall`, `CATEGORIES_MUSINSA`.
  - Task 3의 `replaceCouponGoods`, `categoryReviewFloors`, `goodsHasDirectCoupon`.
- Produces:
  - 상수: `SMALL_COUPON_MAX = 3000`, `MAX_PAGES_PER_CAT = 60`, `WALK_EXTRA_PAGES = 1`.
  - `walkCoupon(client, couponNo, floors: Record<string, number>) → Promise<{ goodsNos: number[], pages: number, mode: 'combined'|'per-category' }>`
    - 1페이지를 5개 대분류 합으로 읽는다.
    - `totalCount ≤ SMALL_COUPON_MAX`이면 `hasNext`가 끝날 때까지 읽는다(`'combined'`).
    - 그보다 크면 대분류마다 1페이지부터 읽는다(`'per-category'`).
      - `hasNext`가 없으면 멈춘다.
      - 마지막 항목의 `reviewCount < floors[cat]`이 된 페이지 다음에 `WALK_EXTRA_PAGES`장을 더 읽고 멈춘다.
      - `floors[cat]`이 없으면 1페이지만 읽는다.
      - 최대 `MAX_PAGES_PER_CAT`장이다.
    - 오류는 그대로 던진다.
  - `walkCouponLists({ withClient, store, date, couponNos: number[], deadline = Infinity, concurrency = ANON_CONCURRENCY }) → Promise<{ walked, failed, suspectEmpty, calls, stop: null|'throttled'|'deadline', failedCoupons: number[] }>`
    - 성공한 쿠폰은 `replaceCouponGoods`로 바꾼다.
    - 결과가 0건인데 `goodsHasDirectCoupon(couponNo)`가 참이면 실패로 센다(`suspectEmpty++`). 그 쿠폰의 전날 행은 그대로 둔다.
    - 429가 나면 남은 쿠폰을 시작하지 않는다.
    - 실패한 쿠폰과 시작하지 못한 쿠폰은 전날 행을 그대로 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `a coupon with ≤3000 goods in the five categories is read whole with the combined filter`
    - 페이지 3장이다. 모든 호출의 `category`가 `ALL_CATEGORIES_PARAM`이다.
  - `a large coupon is read per category and stops one page after the review floor`
    - `floors['001']=100`이고 페이지별 마지막 리뷰 수가 500, 200, 90, 50, 10이면 001은 4페이지를 읽는다.
  - `per-category reading ends at hasNext false and never exceeds 60 pages`
  - `a successful walk replaces that coupon's goods; a failed one keeps yesterday's rows`
  - `an empty list for a coupon that a stored member check holds counts as suspectEmpty and keeps yesterday's rows`
  - `429 stops the walk: started coupons finish or fail, unstarted ones keep yesterday's rows`
- [ ] **Step 2:** `node --test tests/musinsa-wide-walk.test.js` → FAIL.
- [ ] **Step 3:** 구현한다.
- [ ] **Step 4:** `node --test tests/musinsa-wide-walk.test.js` → PASS.
- [ ] **Step 5: 커밋** `feat(musinsa): walk usable coupons' goods lists`

---

### Task 8: 쿠폰가 계산과 표본 정확도

**Files:**
- Modify: `src/musinsaWide/coupons.js`
- Test: `tests/musinsa-wide-coupons.test.js`

**Interfaces:**
- Consumes:
  - Task 2의 `usableCoupons`, `getCoupon`.
  - Task 3의 `couponsByGoods`, `couponGoodsCount`.
  - 기존 `getActivePriceRows`, `setCouponPrices`, `logCouponPriceChanges`.
- Produces:
  - `registryCouponToCalc(c: RegistryCoupon) → { id, type, percent, price, max, min, until }`
  - `bestCoupon(salePrice, coupons) → { id, discount } | null`: 할인이 0보다 큰 쿠폰 중 최대인 것이다.
  - `applyCouponPrices({ store, date, ready }) → { priced, withCoupon, drops, lateDrops, best: Map<number, string|null> }`
    - `ready`가 거짓이거나 `couponGoodsCount() === 0`이면 모든 ACTIVE 상품을 `null`로 둔다. 이때 `drops`와 `lateDrops`는 `[]`다.
    - 그 밖에는 상품마다 다음 두 가지를 합친다.
      1. `couponsByGoods`에 걸린 쿠폰 중 `usableCoupons(date)`에 있고, `start_date`가 NULL이거나 `≤ date`인 쿠폰
      2. `coupon_checked_date`가 10일 안인 직접 조회 목록 중 `until`이 NULL이거나 `≥ date`이고, 등록부 상태가 `RETIRED`가 아닌 쿠폰
    - 쿠폰가는 `couponPriceMusinsa`로 계산한다. 판매가가 없으면 `null`이다.
    - `withCoupon`은 최대 할인이 0보다 큰 상품 수다.
    - `logCouponPriceChanges` 뒤에 `drops`를 나눈다. 오늘 최대 할인 쿠폰의 `first_seen_date === date`이고 `start_date < date`인 하락은 `lateDrops`로 옮긴다.
  - `sampleAccuracy({ store, date, results: Array<{ goods, coupons }>, before: Map<number, string> }) → { checked, exact, under, over, reasons: { unregistered, listGap, retired } }`
    - `before`는 판별이 끝난 시점의 `coupon_no → state` 스냅샷이다.
    - 예측: `couponsByGoods`의 쿠폰 중 `before`에서 `USABLE`이고 만료 전인 쿠폰의 최대 할인.
    - 실제: 조회 결과 중 만료 전인 쿠폰의 최대 할인.
    - 둘의 크기에 따라 `exact`, `under`, `over`로 센다.
    - `under`의 이유는 실제 최대 쿠폰의 `before` 상태로 정한다. 없거나 `PENDING`, `OTHER`, `OUT_OF_SCOPE`면 `unregistered`, `RETIRED`면 `retired`, `USABLE`이면 `listGap`이다.

- [ ] **Step 1: 실패하는 테스트 작성** (지금의 `applyCouponPrices` 테스트는 새 규칙에 맞게 고친다. "만료 쿠폰이 있으면 NULL" 테스트는 "그 쿠폰만 뺀다"로 바꾼다.)
  - `not ready or no coupon lists yet: every coupon price is null`
  - `a goods in a usable coupon's list gets that coupon; a goods in no list gets sale − extra`
  - `an expired, not-yet-started or RETIRED coupon is skipped; the others still apply`
  - `a fresh direct check fills a list gap; one older than 10 days does not`
  - `the best of list and direct coupons wins, floored to 10 won`
  - `a drop caused by a coupon first seen today that started earlier goes to lateDrops`
  - `sampleAccuracy counts exact/under/over and names the reason of each under`
    - 사례 네 개를 넣는다: 정확 1, 등록부에 없음 1, 목록에 없음 1, 퇴출 1.
- [ ] **Step 2:** `node --test tests/musinsa-wide-coupons.test.js` → FAIL.
- [ ] **Step 3:** 구현한다. `applyCouponPrices`의 doc 주석을 새 규칙으로 고친다.
- [ ] **Step 4:** `node --test tests/musinsa-wide-coupons.test.js` → PASS.
- [ ] **Step 5: 커밋** `feat(musinsa): price from coupon lists plus fresh direct checks; daily sample accuracy`

---

### Task 9: 하루 흐름 (`trackMusinsa`)

**Files:**
- Modify: `src/musinsaWide/track.js`
- Test: `tests/musinsa-wide-track.test.js`

**Interfaces:**
- Consumes: Task 4~8의 함수 전부.
- Produces:
  - 상수: `ENUM_BUDGET_MS = 12 * 60_000`, `CLASSIFY_BUDGET_MS = 15 * 60_000`.
  - `trackMusinsa(...)`는 매개변수는 그대로이고, 결과에 다음을 더한다.
    - `coupons: { memberStatus, checked, failed, priced, withCoupon, drops, lateDrops: number, dropsSuppressed: boolean, ready: boolean }`
    - `registry: { enum: { probed, hits, highest, stop }, recheck: { probed, newPositive }, classify: { calls, usable, other, outOfScope, pending }, neighbors: { probed, hits }, walk: { walked, failed, suspectEmpty, calls, stop }, sample: { checked, exact, under, over, reasons }, counts: { usable, pending, expiredYesterday, added, retired } } | null`
  - `counts`는 `store.registryCounts(date)`에 두 값을 더한 것이다. `added`는 그날 `upsertMemberCoupons`가 돌려준 `added`의 합이고, `retired`는 `retireDead(date).length`다.
  - 같은 객체가 `recordScanRun({ couponMetrics: registry })`에 들어간다. `couponChecks`는 `checker.calls`다.

흐름 (스캔과 `applyScan`은 지금과 같다):
```
ready = store.getMeta('backfill_done') != null
checker = createMemberChecker(...); memberStatus = await checker.start()
if ready:
  enum   = enumerateNumbers({ from: frontier+1, mustReach: store.maxCouponNo(), deadline: start+ENUM_BUDGET_MS })   (throw → stop:'error')
  recheck= recheckEmpties({ deadline: start+ENUM_BUDGET_MS })
  classify = classifyPending({ cap: CLASSIFY_CAP, deadline: start+CLASSIFY_BUDGET_MS })
  before = 등록부 상태 스냅샷
  [sample, walk] = Promise.all([
     checker.check(store.pickSample(SAMPLE_PER_DAY, date), onResult: putGoodsCoupons + upsertMemberCoupons + 결과 수집),
     walkCouponLists({ couponNos: usableCoupons(date) 번호들, deadline: runDeadline }) ])
  walk2  = walkCouponLists(표본에서 새로 USABLE이 된 번호 중 오늘 순회하지 않은 것)
  neighbors = probeNeighbors(classify.neighborCenters + 표본의 오래된 새 번호, deadline: runDeadline)
  recordObservations(date, classify.checks + 표본 checks); retired = retireDead(date)
prices = applyCouponPrices({ store, date, ready })
dropsSuppressed = ready && !store.getMeta('registry_first_priced')  → 참이면 setMeta('registry_first_priced', date), drops = []
accuracy = ready ? sampleAccuracy(...) : null
pruneRegistry(date)
```
- 단계마다 예외를 잡는다. 실패한 단계는 그 지표에 `stop: 'error'`를 남기고, 실행은 계속한다. 로그에는 상태만 찍는다.
- `ready`가 거짓이면 `log('⚠️ [무신사] 쿠폰 등록부 미완성 — backfill 필요')`를 남기고, 비로그인 쿠폰 호출과 회원 조회를 하나도 하지 않는다.

- [ ] **Step 1: 테스트 고치기와 추가.** 가짜 client에 `getCouponGoodsCount`와 `getCouponGoodsPage`를 더하고 호출을 기록한다.
  - `not ready: no coupon API calls at all, prices null, ready false in the result`
  - `ready: phases run in order and the registry metrics land in scan_runs.coupon_metrics_json`
    - 번호 순회에서 새 쿠폰 1개 → 판별에서 `USABLE` → 목록 순회 → 해당 상품에 쿠폰가가 붙는다.
  - `a coupon first found by the sample is walked the same day`
  - `anonymous 429 during the walk: unwalked coupons keep yesterday's lists, prices and scan_runs still written`
  - `no session: enumeration and the walk still run; classification and sample are skipped; memberStatus none`
  - `the first ready run suppresses coupon drops once and records registry_first_priced`
  - `phase deadlines: enumeration stops at 12 min, classification at 15 min` (`now`를 주입한다)
  - 기존 테스트 중 `checkGoodsCoupons`와 `pickCouponChecks`를 쓰는 것은 새 이름으로 바꾼다.
- [ ] **Step 2:** `node --test tests/musinsa-wide-track.test.js` → FAIL.
- [ ] **Step 3:** 구현한다. 시간 주입을 위해 `trackMusinsa`에 `now = Date.now` 매개변수를 더한다. 파일 머리 주석을 새 순서로 고친다.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: 커밋** `feat(musinsa): daily registry flow — enumerate, classify, sample, walk, price`

---

### Task 10: 전환 실행 (`backfillMusinsaCoupons`)

**Files:**
- Modify: `src/musinsaWide/track.js`
- Test: `tests/musinsa-wide-track.test.js`

**Interfaces:**
- Produces:
  - 상수: `BACKFILL_BUDGET_MS = 160 * 60_000`, `BACKFILL_ENUM_BUDGET_MS = 130 * 60_000`, `CURSOR_EVERY = 1000`.
  - `backfillMusinsaCoupons({ makeClient, store, date, sessionProvider, from = null, concurrency = 3, budgetMs = BACKFILL_BUDGET_MS, enumBudgetMs = BACKFILL_ENUM_BUDGET_MS, now = Date.now, log }) → Promise<{ from, next, probed, hits, seeded, classify, done: boolean, memberStatus, stop }>`
    1. 시작 번호를 `meta.enum_cursor ?? from ?? BACKFILL_FROM` 순서로 정한다.
    2. `enum_floor`가 없으면(첫 실행):
       - `seeded = store.seedFromGoodsCoupons(date)`
       - `setMeta('enum_floor', String(시작 번호))`
    3. `enumerateNumbers({ from, mustReach: store.maxCouponNo(), recordEmpties: false, deadline: start+enumBudgetMs, onCursor })`
       - `onCursor`는 `CURSOR_EVERY`개마다 `setMeta('enum_cursor', n)`을 부른다.
    4. `classifyPending({ cap: BACKFILL_CLASSIFY_CAP, deadline: start+budgetMs })`
    5. 번호 순회가 `stop === null`로 끝났으면:
       - `setMeta('backfill_done', date)`
       - `setMeta('enum_cursor', null)`
       - `done = true`
    6. 그렇지 않으면 cursor를 남기고 `done = false`다.
  - 표본, 목록 순회, 쿠폰가 계산은 하지 않는다. 다음 일상 실행이 한다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `first backfill seeds stored coupons, sets enum_floor and walks from 345000 through a sparse gap up to the highest known coupon`
  - `a backfill cut by the enumeration deadline saves enum_cursor and is not done; the next one resumes there and finishes`
  - `backfill records no empty numbers`
  - `backfill classification is capped at 1500`
  - `done sets backfill_done and clears enum_cursor; a following trackMusinsa is ready`
- [ ] **Step 2:** `node --test tests/musinsa-wide-track.test.js` → FAIL.
- [ ] **Step 3:** 구현한다.
- [ ] **Step 4:** `node --test tests/musinsa-wide-track.test.js` → PASS.
- [ ] **Step 5: 커밋** `feat(musinsa): resumable one-time coupon registry backfill`

---

### Task 11: 텔레그램 요약

**Files:**
- Modify: `src/musinsaWide/digest.js`
- Test: `tests/musinsa-wide-digest.test.js`

**Interfaces:**
- Consumes: Task 9와 Task 10의 결과 모양.
- Produces:
  - `formatMusinsaWideDigest(result, opts)`에 다음 줄을 더한다. 문구는 그대로 쓰고, 숫자는 `fmt`로 찍는다.
    - 쿠폰 줄(지금 줄을 바꾼다): `🎟 회원 조회 ${checked}개 (실패 ${failed}) · 쿠폰가 ${priced}개 · 쿠폰 적용 ${withCoupon}개`
    - `ready`가 거짓일 때: `⚠️ 쿠폰 등록부 미완성 — backfill 필요`
    - `registry`가 있을 때 다음 다섯 줄을 이 순서로 넣는다.
      - `🔢 번호 순회 ${enum.probed}개 · 최대 ${enum.highest ?? '-'} · 새 쿠폰 ${enum.hits} · 0→양수 ${recheck.newPositive}`
      - `🧮 판별 ${classify.calls}회 · 쓸 수 있음 ${classify.usable} · 대상 아님 ${classify.other} · 범위 밖 ${classify.outOfScope} · 대기 ${classify.pending}`
      - `📒 쓸 수 있는 쿠폰 ${counts.usable}종 (새로 ${counts.added} · 만료 ${counts.expiredYesterday} · 퇴출 ${counts.retired})`
      - `🚶 목록 순회 ${walk.walked}종 · 호출 ${walk.calls} · 실패 ${walk.failed}`
      - `🎯 표본 ${sample.checked}개 · 정확 ${sample.exact} (${pct}) · 낮게 ${sample.under} · 높게 ${sample.over}`. `pct`는 소수 첫째 자리까지 찍은 백분율이고, `checked`가 0이면 `-`다.
    - 단계 하나가 `stop`이 `'throttled'`이면 `⚠️ 무신사 비로그인 쿠폰 API 제한(429) — ${단계명} 중단`, `'error'`이면 `⚠️ 무신사 ${단계명} 실패 — Actions 로그 확인`. 단계명은 `번호 순회`, `목록 순회`, `이웃 조회`다.
    - `lateDrops > 0`이면 하락 목록 바로 위에 `늦게 찾은 쿠폰 하락 ${lateDrops}건 제외`를 넣는다.
    - `dropsSuppressed`이면 `등록부 전환 첫날 — 쿠폰가 하락 알림 생략`을 넣고, 판매가 하락 목록으로 대신하지 않는다.
  - `formatBackfillDigest(result) → string`
    - 머리 줄: `<b>🗂 [Project-Clot] 무신사 쿠폰 등록부 전환 (${date})</b>`
    - 둘째 줄: `번호 ${from}–${next - 1} (${probed}개) · 상품 있음 ${hits} · 기존 쿠폰 등록 ${seeded}`
    - 판별 줄: 위 `🧮` 줄과 같은 형식.
    - 마지막 줄: `done`이면 `✅ 전환 완료 — 내일 실행부터 등록부로 계산`, 아니면 `⏸ ${next}에서 멈춤 — backfill을 다시 실행해 이어서`
    - 조회기 경고는 지금의 `couponWarning`을 그대로 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `registry lines appear in order with formatted numbers and sample percent`
  - `not ready shows the backfill warning and no registry lines`
  - `a throttled walk and a failed enumeration each add their warning`
  - `late drops are excluded with a count line; suppressed drops show the first-day line and no sale-price fallback`
  - `formatBackfillDigest shows done and resume variants`
  - 기존 `미확인·오래됨` 기대값은 새 쿠폰 줄로 바꾼다.
- [ ] **Step 2:** `node --test tests/musinsa-wide-digest.test.js` → FAIL.
- [ ] **Step 3:** 구현한다. 4096자를 넘으면 지금처럼 하락 줄부터 덜어낸다.
- [ ] **Step 4:** `node --test tests/musinsa-wide-digest.test.js` → PASS.
- [ ] **Step 5: 커밋** `feat(musinsa): registry lines in the daily digest and a backfill digest`

---

### Task 12: CLI, workflow, README

**Files:**
- Modify: `src/cli.js`, `.github/workflows/musinsa-wide.yml`, `README.md`
- Test: `tests/cli-musinsa-wide.test.js`

**Interfaces:**
- Consumes: Task 10의 `backfillMusinsaCoupons`, Task 11의 `formatBackfillDigest`.
- Produces:
  - CLI:
    - `BOOLEAN_FLAGS`에 `'backfill'`을 더한다.
    - `runMusinsaWideStep({ ..., backfillFn = backfillMusinsaCoupons })`
      - `flags.backfill`이면 DB가 있어야 한다. `--init`, `--dry-run`과 같이 쓰면 `'--backfill은 --init·--dry-run과 함께 쓸 수 없음'`으로 실패한다.
      - `--from`은 1 이상의 정수다. 아니면 `invalid --from '<값>' (use a positive integer)`로 실패한다.
      - `backfillFn`을 부르고, `notify(formatBackfillDigest(result))`를 한 번 보낸다.
      - 스토어 checkpoint와 close는 지금과 같다.
  - 사용법 문구: `track-musinsa [--category <codes>] [--depth <pages>] [--concurrency=1-4] [--dry-run] [--init] [--backfill [--from <n>]]`
  - workflow:
    - `mode` 선택지에 `backfill`을 더하고, 설명에 `backfill = pull DB, one-time coupon registry fill (~2 h, resumable), push DB`를 덧붙인다.
    - `timeout-minutes: ${{ inputs.mode == 'backfill' && 180 || 45 }}`
    - 새 단계 `Fill the coupon registry`를 둔다. 조건은 `env.MODE == 'backfill'`, 명령은 `node src/cli.js track-musinsa --backfill`.
    - pull과 push 단계의 조건을 `env.MODE == 'scan' || env.MODE == 'backfill'`로 바꾼다.
  - README §10:
    - 쿠폰 방식(번호 순회, 판별, 표본, 목록 순회)을 세 줄로 설명한다.
    - `backfill` 모드와 실행 시점을 적는다: 오후, daily(09:30)나 와이드 스캔(11:30)과 겹치지 않게, 끊기면 다시 실행.
    - 공개 범위 경고에 "쿠폰 등록부(쿠폰 이름·조건)와 쿠폰별 적용 상품"을 더한다.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `--backfill is a boolean and --from passes through`
  - `--backfill refuses without a DB and with --init or --dry-run`
  - `--from rejects 0 and non-integers`
  - `a backfill run notifies once with the backfill digest and closes the store`
- [ ] **Step 2:** `node --test tests/cli-musinsa-wide.test.js` → FAIL.
- [ ] **Step 3:** 구현한다. workflow와 README를 고친다.
- [ ] **Step 4:** `npm test` → 전부 PASS. 다음 두 줄은 아무것도 출력하지 않아야 한다.
  - `grep -rn "checkGoodsCoupons\|pickCouponChecks\|COUPON_CHECKS_PER_DAY" src tests`
  - `node -e "require('fs').readFileSync('.github/workflows/musinsa-wide.yml','utf8').includes('backfill') || process.exit(1)"`
- [ ] **Step 5: 커밋** `feat(musinsa): track-musinsa --backfill, workflow backfill mode and README`

---

## 배포 뒤 (사용자가 직접, 계획 밖)
1. 병합한 날 오후(KST 13:00 이후)에 `Musinsa wide scan`을 `mode=backfill`로 실행한다. 요약이 `⏸`면 다시 실행한다.
2. 다음 날 11:30 실행의 요약을 확인한다: "등록부 전환 첫날" 줄, `🎯` 정확도, `🧮` 대기 수.
3. 첫 주에는 퇴출 수, 0→양수 수, 429 경고를 본다(spec §9).
