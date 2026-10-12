# 4910 쿠폰 학습 병렬화와 숨김 원인별 요약

## 배경
- 두 번째 scan(run 38108396671, 2026-10-11)에서 단계별 소요는 목록 14분, 셀러 4분, 쿠폰 학습 17분이었다.
- 쿠폰 학습이 실행 예산 `RUN_BUDGET_MS_4910`(35분)에 걸려 셀러 2곳의 쿠폰가가 NULL이 됐다.
- 원인: `learnMarketCoupons`(`src/site4910/coupons.js`)가 셀러 250곳을 클라이언트 하나(요청 간격 300ms)로 순서대로 처리한다.
- 텔레그램 요약의 `⚠️ 쿠폰 계산 불일치 셀러 N곳`에는 범위 한정이나 네이버 전용이라 숨긴 셀러도 들어간다. 두 번째 실행의 64곳은 범위 한정 36, 네이버 4, 불일치 24였다.

## 목표
- 쿠폰 학습을 track의 클라이언트 풀(동시 3)로 나눠 약 6분 안에 끝낸다.
- 요약을 `⚠️ 쿠폰가 숨김 셀러 N곳 (범위 한정 a · 네이버 b · 불일치 c)`로 바꾼다.

## 동작
- 쿠폰함(`getMyCoupons` → `replaceWallet`)과 포인트(`getMe`)는 셀러 처리 전에 한 번만 조회한다.
- 셀러는 `mapConcurrent(marketSnos, concurrency, …)`로 처리하고, 셀러마다 `withClient`로 클라이언트를 하나씩 받는다.
  - 클라이언트 하나를 동시에 쓰면 요청 간격이 지켜지지 않는다. `client.js`는 호출마다 따로 sleep할 뿐 요청을 줄 세우지 않는다.
- 범위 분류는 쿠폰 sno별 Promise로 캐시한다. 그래서 동시 실행에서도 `classifyCoupon`과 `setCouponGoods`는 쿠폰당 한 번만 실행된다.
  - 다른 셀러는 그 Promise가 끝난 뒤에 `addMarketCoupon`과 `couponSetOf`를 호출한다.
- MEMBER_AUTH가 나면 새 셀러를 시작하지 않는다. 진행 중인 셀러도 다음 표본 요청 전에 멈추고, 결과는 `memberStatus: 'expired'`다.
- 실행 예산이 지나면 새 셀러는 요청 없이 건너뛴다. 루프가 끝난 뒤 `⚠️ [4910] 실행 예산 초과 — 판매처 N곳 쿠폰 확인 생략 (쿠폰가 없음)` 로그를 한 번 남긴다.
- 결과에 `hidden: { scope, naver, mismatch }`를 추가하고, 기존 필드는 그대로 둔다. 항상 `scope + naver + mismatch === mismatched`다.
  - `couponSetOf`가 null이고 지갑 쿠폰이 아닌 `coupon_snos` 중 하나라도 오늘 행의 scope가 `category`, null이거나 행이 없으면 → `scope`
  - 위에 해당하지 않고 `naver`가 있으면 → `naver`
  - `couponSetOf`는 있는데 자가 검증(금액 차 10원 초과 또는 min 불일치)에 실패하면 → `mismatch`
- 요약은 세 숫자를 0이어도 모두 보여 준다. `hidden`이 없는 예전 결과 형태는 전부 불일치로 표시한다.
- 회원 API 동시 요청 수는 scan과 같은 `concurrency`(기본 3)를 쓴다.

## 범위 밖
- 같은 전용 쿠폰 행을 여러 셀러가 덮어쓰는 문제(`INSERT OR REPLACE`): 순차 실행에서도 마지막 셀러의 조건이 남는다.
- 옵션 가격 기준 할인(YOSEMITE), 쿠폰 상품 목록 1,000건 상한
- `market_coupons` 스키마 변경, 셀러 조회 단계 병렬화

## 완료 확인
- `npm test`가 모두 통과한다(기존 668개 + 새 테스트).
- merge 후 `gh workflow run 4910.yml -f mode=scan`(사용자 승인 후)에서 다음을 확인한다.
  - 예산 경고가 없다.
  - `4910 sellers:` 줄에서 `💜` 줄까지 약 6분이다.
  - 요약에 원인별 숫자가 나온다.
- 공개 쿠폰가 30건을 비로그인 상세가와 best-coupon으로 대조한다. 스크립트는 scratchpad에 두는 일회용이다.
