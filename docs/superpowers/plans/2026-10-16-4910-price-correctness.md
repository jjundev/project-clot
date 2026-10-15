# 4910 Price Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 4910 가격·쿠폰 조건을 일관되게 수집하고 오수집 이력을 근거에 따라 교정하거나 비교에서 제외한다.

**Architecture:** 클라이언트가 AGLO 식별과 가격 출처를 통일하고 별도 조건 모듈이 단품 적용 가능성을 판정한다. 찜은 상품별 API 검증을 사용하고 전체 스캔은 적용 범위가 입증된 쿠폰만 계산한다. 과거 원본은 보존하고 검증 상태를 별도 테이블로 관리해 차트와 알림에서 일관되게 소비한다.

**Tech Stack:** Node.js 24, ES modules, node:sqlite, node:test, 기존 CLI/대시보드/Release 구조.

**Spec:** `docs/superpowers/specs/2026-10-16-4910-price-correctness.md`

## Global Constraints

- Node.js 24, ES modules, node:sqlite, node:test를 유지한다. 새 외부 의존성을 추가하지 않는다.
- 추적 가격은 수량 1, 쿠폰 1장, 포인트 차감 전 기준이다. 쿠폰 자동 발급·주문·계정 변경은 하지 않는다.
- 현재 가격을 과거 날짜의 정답으로 덮어쓰지 않는다.
- 알 수 없거나 목록이 불완전하면 해당 쿠폰의 추정가를 확정 가격으로 쓰지 않는다.
- 무신사와 기존 관련 없는 변경(data/4910-all.js 및 unified-price-dashboard 문서 포함)은 건드리지 않는다.
- 작업 시작 시 using-git-worktrees로 격리하고 기존 사용자 파일을 복사·이동·스테이징하지 않는다. 테스트는 임시 DB와 CLOT_NOTIFY_SANDBOX를 사용한다.
- 아래 커밋 단위는 통과한 작업 경계다. 원격 push/배포는 이 계획의 자동 실행에 포함하지 않는다.

## Review Focus

- 상세와 쿠폰 요청의 플랫폼 또는 옵션이 다르면 할인액을 잘못 빼지 않는다: Task 1/3.
- 다수 상품 조건·최소금액 문구 위치 변화가 단품 할인가로 새지 않는다: Task 2.
- 제한 대상 목록의 잘림·페이지 실패·카테고리만 확인된 상태는 적용 확정이 아니다: Task 2/3.
- 잘못된 과거 회원가를 제외해도 공개 쿠폰가로 폴백하거나 최저가로 부활하지 않는다: Task 4.
- 같은 날짜 재실행·인증 실패·빈 입력은 역사 중복, 원본 훼손, 성공 보고를 만들지 않는다: Task 3/5.

---

## File Structure

기존 파일: `src/site4910/client.js`(API 계약), `coupons.js`(범위 학습/계산), `liked.js`(상품별 수집), `store.js`(조건/검증 상태), `track.js`(검증 결과 집계), `digest.js`(미검증 요약), `src/visualizer.js`(검증 이력 소비), `src/dashboard.template.html`(필요한 상태 표시만), `README.md`, `docs/verify/4910-member-price.md`.

신규 파일: `src/site4910/coupon-eligibility.js`(순수 조건 판단), `src/site4910/price-validation.js`(이력 검증/교정), `scripts/4910-price-revalidate.js`(명시 DB 대상 보고/교정 CLI), 각각의 `tests/*.test.js`, `docs/verify/2026-10-16-4910-price-revalidation.md`.

### Task 1: AGLO 가격·옵션·응답 계약 고정

**Files:** Modify `src/site4910/client.js`, `tests/site4910-client.test.js`, `docs/verify/4910-member-price.md`.

**Interfaces:** `getGoodsDetail(sno, {memberToken})`는 기존 필드와 `priceBasis:'AGLO'`, `optionSno`를 반환한다. `getBestCoupon(optionSno, {memberToken})`는 기존 필드에 원본 `isApplied:boolean|null`을 보존한다. 회원 쿠폰은 원본 `conditions:string[]`, `hasTargets:boolean|null`, `appOnly:boolean`을 보존한다.

- [x] **Step 1: 읽기 전용 대조로 계약을 확인한다.** 57821918, 58451420, 76532314를 동일 시점·동일 옵션으로 AGLO 익명/회원 상세와 best-coupon에 조회한다. 공식 4910 웹 번들의 같은 요청/계산 경로를 읽고 `is_applied`, 기준 옵션 금액, 10원 반올림 의미를 문서에 기록한다. 헤더/토큰/개인정보는 fixture에 넣지 않는다. 확인 불가 상태는 `unverified`로 처리하는 계약을 유지한다.
- [x] **Step 2: 실패 테스트를 작성한다.** `detail_uses_aglo_identity`는 세 AGLO 헤더를 검사한다. `detail_and_coupon_share_basis`는 상세 75,900원·할인 3,790원을 보존하고 기존 85,200원을 사용하지 않음을 검사한다. `best_coupon_preserves_application_state`는 true/false/누락을 각각 true/false/null로 검사한다. `wallet_preserves_conditions`는 문구·대상·앱 조건 보존을 검사한다.
- [x] **Step 3: `node --test tests/site4910-client.test.js`를 실행해 새 테스트 실패를 확인한다.**
- [x] **Step 4: 위 클라이언트 계약을 구현한다.** 상세의 AGLO 헤더와 요청/응답 출처를 통일한다. 불명확한 응답 상태를 할인 확정으로 해석하지 않는다.
- [x] **Step 5: 같은 테스트를 실행해 통과를 확인한다.** 인증 오류 재시도 정책과 토큰 비노출 테스트도 유지한다.
- [x] **Step 6: 이 작업 파일만 스테이징하고 diff 검사 후 `fix: use consistent 4910 price basis` 커밋을 만든다.**

### Task 2: 쿠폰 단품 적용 조건과 범위 저장

**Files:** Create `src/site4910/coupon-eligibility.js`, `tests/site4910-coupon-eligibility.test.js`; Modify `client.js`, `store.js`, `tests/site4910-store.test.js`.

**Interfaces:** `parseCouponConditions(conditions:string[]) -> {minAmount:number|null,minQuantity:number|null}`; `evaluateCouponEligibility({coupon,goodsSno,quantity,basePrice,scopeEvidence}) -> {status:'eligible'|'ineligible'|'unknown',reason:string}`. `scopeEvidence`는 `{kind:'goods'|'seller'|'unknown',complete:boolean,goodsSnos?:Set<number>,marketSno?:number}`. 조건 정보는 `wallet_coupons`에 가산 컬럼으로 저장하고 구DB 누락은 unknown으로 읽는다.

- [x] **Step 1: 실패 테스트를 작성한다.** 조건 배열 전체에서 최소 10,000원을 찾는다. `['상품 3개 이상 구매시 사용 가능','1원 이상 구매 시 최대 100,000원 할인']`은 minQuantity=3,minAmount=1이다. quantity=1은 ineligible이다. 377개 완전 목록의 포함/제외는 eligible/ineligible, 잘린 목록·카테고리만·앱 전용·유입 제한·파싱 불가는 unknown/ineligible로 분리한다. usable=true만으로 eligible이 되지 않는다.
- [x] **Step 2: `node --test tests/site4910-coupon-eligibility.test.js tests/site4910-store.test.js`의 실패를 확인한다.**
- [x] **Step 3: 순수 파서·판정 및 가산 스키마 마이그레이션을 구현한다.** 수량 조건 부재는 보존된 전체 문구에서 다품목 제한이 없음을 확인한 신규 응답에서만 1로 처리한다. 쿠폰 하나의 판매처 행이 다른 판매처 조건을 덮어쓰는 구조를 적용 근거로 사용하지 않는다.
- [x] **Step 4: 같은 명령을 실행해 통과와 기존 DB 재오픈 멱등성을 확인한다.**
- [x] **Step 5: 이 작업 파일만 검사하고 `fix: enforce single-item coupon eligibility` 커밋을 만든다.**

### Task 3: 수집기·검증기·알림을 같은 조건으로 연결

**Files:** Modify `src/site4910/{coupons,liked,track,digest}.js`, `tests/site4910-{coupons,liked,track,digest}.test.js`.

**Interfaces:** Task 1/2 계약을 사용한다. `couponSetOf`는 쿠폰함 전체를 확장하지 않는다. 상품별로 검증된 쿠폰과 완전한 대상 증거가 있는 쿠폰만 적용한다. 수집 결과에 `validation:{verified:number,unverified:number,reasons:Record<string,number>}`를 추가하고 기존 memberStatus를 보존한다.

- [x] **Step 1: 실패 테스트를 작성한다.** 해링턴 계산은 75,900−3,790=72,110, 카고는 47,100−2,350=44,750이다. 12,850원 표본에서 API 22% 할인 2,820원을 단품 30%의 9,000원으로 대체하지 않는다. 판매처 한 표본의 쿠폰 승인이 다른 상품의 적용 증거가 되지 않는다. 다른 옵션·응답 불확실·401/403·시간 예산 초과·옵션 없음은 검증가를 만들지 않는다.
- [x] **Step 2: `node --test tests/site4910-{coupons,liked,track,digest}.test.js`를 실행해 실패를 확인한다.**
- [x] **Step 3: 찜 상품별 검증과 전체 스캔의 보수적 범위 계산을 연결한다.** 전체 상품의 무제한 회원 API 호출로 대체하지 않는다. 스캔 실행 예산과 동시성은 유지한다. 할인 없음이 확인된 경우만 판매가를 사용하며 확인 실패는 별도 상태로 남긴다. 이전 잘못된 값과 신규 값을 하락 비교하지 않는다.
- [x] **Step 4: 같은 테스트를 실행하고 숨김 사유 합계 및 미검증 알림 요약을 확인한다.**
- [x] **Step 5: 이 작업 파일만 검사하고 `fix: validate 4910 prices before recording discounts` 커밋을 만든다.**

### Task 4: 과거 검증 상태·교정값과 대시보드 연결

**Files:** Create `src/site4910/price-validation.js`, `tests/site4910-price-validation.test.js`; Modify `store.js`, `liked.js`, `src/visualizer.js`, `src/dashboard.template.html`, `tests/visualizer-data.test.js`, `tests/visualizer-html.test.js`.

**Interfaces:** `price_validations(kind,sno,date,status,corrected_json,reason,evidence_json,checked_at)`를 추가한다. PK는 `(kind,sno,date)`이고 kind는 `liked|scan`, status는 `verified|corrected|unverified|invalid`다. `effective4910Price({raw,validation})`는 교정·검증 가격 또는 비교 불가 null을 반환한다. 원본 가격 행은 삭제하지 않는다.

- [x] **Step 1: 실패 테스트를 작성한다.** invalid/unverified 회원가 81,410원과 공개 쿠폰가가 동시에 있어도 비교값은 null이다. corrected 행만 교정값으로 나타난다. 재실행은 중복을 만들지 않는다. 최신 검증가가 없으면 과거 값을 오늘의 값으로 표시하지 않는다. 제외 행은 최저가·하락·차트·쿠폰 carry 경로에 재등장하지 않는다. 검증 테이블 없는 구DB는 오류 없이 읽되 기존 4910 쿠폰가를 검증 완료로 승격하지 않는다. 무신사 출력은 동일하다.
- [x] **Step 2: `node --test tests/site4910-price-validation.test.js tests/visualizer-data.test.js tests/visualizer-html.test.js` 실패를 확인한다.**
- [x] **Step 3: 유효 가격 해석기를 DB·찜 이전가격 조회·스캔 이력 병합에 공통 적용한다.** UI에는 `가격 재검증 필요`와 실제 검증일을 표시하고 추정치를 확정 회원가로 라벨링하지 않는다.
- [x] **Step 4: 같은 테스트를 실행하고 임시 대시보드에서 정상·교정·미검증 3개 상태를 확인한다.**
- [x] **Step 5: 이 작업 파일만 검사하고 `fix: exclude unverified 4910 history from comparisons` 커밋을 만든다.**

### Task 5: 실제 데이터 재검증과 검증 보고서

**Files:** Create `scripts/4910-price-revalidate.js`, `tests/site4910-revalidate.test.js`, `docs/verify/2026-10-16-4910-price-revalidation.md`; Modify `README.md`.

**Interfaces:** `revalidate4910({db,client,from,to,now,apply=false}) -> {affected,correctable,corrected,unverified,invalid,liveChecks,errors}`. CLI는 `--db <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD> --out <path> [--apply]`를 지원한다. 기본은 읽기 전용 보고다. apply는 원본 DB 백업+SHA256 확인 뒤 검증 테이블에만 트랜잭션으로 기록한다.

- [x] **Step 1: 실패 테스트를 작성한다.** 빈 DB·범위 입력 오류는 nonzero로 종료한다. dry-run DB 해시는 같다. 현재 API 응답으로 과거 날짜를 교정하지 않는다. 당시 기준가/옵션/할인 근거가 모두 있는 행만 corrected다. 인증 오류는 errors로 집계하고 검증 완료로 표시하지 않는다. 적용 재실행은 결과·행 수가 같다. 토큰·회원 개인정보는 보고서에 없다.
- [x] **Step 2: `node --test tests/site4910-revalidate.test.js` 실패를 확인한다.**
- [x] **Step 3: 재검증 CLI와 보고 집계를 구현한다.** Release 원본, 날짜별 아카이브, 당시 로그를 근거로 영향 기간을 산정한다. 모든 과거 찜/스캔 쿠폰 기록을 조사 대상으로 집계하고 증거 없는 행은 unverified로 남긴다. 현재 찜 전건과 최소 30개 판매처/상품 표본(실패 상품 4개 및 정상 첫구매 22% 상품 포함)은 오늘 시각의 별도 검증으로 기록한다.
- [x] **Step 4: 테스트 및 `npm test`를 실행한다.** 모든 테스트 통과, 알림 전송 0건, 원본 DB 해시 보존을 확인한다.
- [x] **Step 5: 최신 Release를 임시 경로에 다운로드하고 해시를 남긴 뒤 복사본에 dry-run/apply/재실행을 수행한다.** 미검증 사유별 건수와 교정 가능 건수, 현재 API 일치율, 숨김률 변화를 보고서에 기록한다. 재검증 대상 누락은 0건이어야 한다. 과거 81,410원을 현재 계산한 72,110원으로 소급 덮어쓰지 않는다.
- [x] **Step 6: 교정 DB 복사본으로 임시 대시보드를 생성하고 브라우저에서 가격·차트·최저가·상태 표시를 확인한다.** 원본 파일과 사용자 작업은 유지한다.
- [x] **Step 7: `git diff --check`, 범위별 staged diff 및 전체 변경 리뷰를 완료하고 문서/도구 커밋을 만든다.** 테스트 결과, 재검증 완료/미확정 범위, DB 백업 및 결과 경로를 사용자에게 전달한다. 원격 반영이 필요한 경우 검토 가능한 코드·DB·보고서를 먼저 제시한다.

## Self-review

Spec 요구사항을 Tasks 1–5에 매핑했다. Review Focus 다섯 조건은 각 작업 테스트에 포함했다. 원본/현재/과거 증거를 분리하며, 실제 서버가 첫구매 쿠폰을 제외하는 내부 정책은 추측하지 않는다. 배포와 원격 DB 덮어쓰기는 구현·테스트 성공과 별개이며 이 계획 완료 주장에 포함하지 않는다.

## 실행 결과
Native 실행 완료. 공식 `is_applied=false` 의미 확인으로 후보가를 확정가로 쓰지 않는 계약을 보완했다. 독립 리뷰의 주요 7건을 RED→GREEN으로 수정했으며 최종 913개 테스트가 통과했다. 상세 결과와 경미한 집계 한계는 재검증 보고서에 기록했다. 원격 반영은 아직 수행하지 않았다.
