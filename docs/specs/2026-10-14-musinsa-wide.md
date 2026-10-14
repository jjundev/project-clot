# 무신사 와이드 스캔 — 4910식 쿠폰가 계산을 무신사에 적용

2026-10-14, grill-yourself 결과(추천값으로 확정). 구현 계획은 `docs/plans/2026-10-14-musinsa-wide.md`.

## Intent
4910과 같은 구조로 무신사를 넓게 본다. 비로그인으로 카테고리 목록을 수만 개 스캔하고, 로그인 쿠키는 브랜드×대분류마다 표본 1~2개의 쿠폰 조회에만 쓴다. 나머지 상품의 **쿠폰가**는 로컬에서 계산해 변경분만 기록한다. 완료 기준: GitHub Actions가 매일 약 3만 개를 스캔하고, 쿠폰가 이력이 Release DB에 쌓이고, 표본 자가검증 불일치 수가 요약에 나오고, 테스트가 통과한다.

Classification: architectural — 기존 `discover`(카테고리당 100개, 상품 페이지를 하나씩 엶)와 다른 수집기·저장소·workflow.

## 조사로 확인한 사실 (2026-10-14)
- 목록 API(`api.musinsa.com/api2/dp/v2/plp/goods`)는 페이지마다 `hmacId` 서명이 붙는다. `page`·`size`를 바꾸면 403 → `nextPageUrl`을 **순서대로** 따라가야 한다. 첫 페이지는 HTML `__NEXT_DATA__`. 한 페이지 60개.
- 목록 항목: `goodsNo, goodsName, goodsLinkUrl, thumbnail, isSoldOut, normalPrice, price, couponPrice, extraDiscountAmount, finalPrice, brand, brandName, reviewCount`. **`isLimitedDc`, `isRestrictedUsePoint`, `comId`, 쿠폰 정보 없음.** 가끔 `goodsNo`가 없는 비상품 항목이 섞인다.
- 쿠폰 API(`api.musinsa.com/api2/coupon/coupons/getUsableCouponsByGoodsNo`)는 비로그인 401.
- `sortCode=POPULAR`(=`SALE`) 앞쪽은 리뷰 0~1개짜리 신상(실험 재정렬 `rerank_relevance_qu_ver`). `sortCode=REVIEW` 1페이지는 59/60이 좋아요 1,000 이상.
- 무신사 쿠폰은 브랜드·카테고리·상품 단위가 섞여 있다(`.agents/verification/discount-rules-verification-report.md` §4). 4910처럼 "판매처 단위 전부 아니면 전무"가 보장되지 않는다.

## Behavior when done
- 새 workflow `Musinsa wide scan`이 매일 11:30 KST에 5개 대분류(001,002,003,103,004) × `REVIEW` 상위 100페이지(6,000개), `gf=A`를 스캔한다.
- 상품마다 `쿠폰가 = price − extraDiscountAmount − (그 브랜드×대분류에 적용되는 내 쿠폰 중 최대 할인)`.
- 이력은 바뀔 때만(NEW / PRICE / REVIVED, 쿠폰가는 `coupon_price_changes`). 완전한 스캔에서 2회 연속 안 보인 상품은 `OUT_OF_SCOPE`(종료 아님), 다시 보이면 REVIVED.
- 쿠키 없음/만료/학습 실패 날: 쿠폰 단계만 건너뛰고 마지막 쿠폰가 유지, 요약에 경고.
- 텔레그램 하루 1통: 스캔 요약, 쿠폰 학습·자가검증 요약, 쿠폰가 10% 이상 하락 상위 10개.
- VIP(`daily`)와 기존 `discover`는 그대로.

## Not in this round
- 대시보드 "무신사 전체" 필터 — 별도 하위 시스템.
- 와이드 상품의 회원가 추정(등급·적립금) — 목록에 제한 플래그가 없다.
- 카드 즉시할인 — 결제수단별·금액 문턱.
- 기존 `discover` 폐기·이전.

## Implementation outline
- 0단계 검증(go/no-go): 목록 값만으로 부른 쿠폰 API가 상품 페이지 값으로 부른 것과 같은지, 쿠폰 조건(율·최대·최소)을 읽을 수 있는지, 같은 키 안에서 쿠폰 집합이 같은지. 로컬 계산 일치 90% 미만이면 중단하고 재설계(C안: 목록가만).
- `src/musinsaWide/`: `client.js`(목록 체인, 쿠폰 API), `coupons.js`(계산·학습·자가검증), `store.js`(변경분만), `track.js`(순서·예산), `digest.js`, `release.js`.
- `src/site4910/release.js`를 태그·첨부 이름을 인자로 받게 일반화. 무신사는 `data-musinsa` / `musinsa-wide.db.gz`.
- CLI `track-musinsa`, `musinsa-db pull|push`. workflow는 `clot-daily` concurrency를 `daily.yml`과 공유하고 쿠키 회전 단계를 갖는다.

## Decisions
| # | Decision | Answer |
|---|---|---|
| 0 | 접근 | A: 브랜드×대분류 학습 + 로컬 계산 + 자가검증. 0단계 실패 시 중단 |
| 1 | 구현 전 검증 | 약 90개, 로컬 계산 일치 90% 이상이어야 진행 |
| 2 | 학습 단위 | 브랜드 × 대분류 |
| 3 | 기록 가격 | 쿠폰가만(등급·적립금·카드 제외) |
| 4 | 저장소 | `data/musinsa-wide.db`, Release `data-musinsa`, 변경분만 |
| 5 | 목록 이탈 | 완전 스캔 2회 연속 미노출 → `OUT_OF_SCOPE`, 재노출 → REVIVED |
| 6 | 페이지 순회 | `nextPageUrl` 순차, 대분류끼리만 병렬 |
| 7 | 실행 | 새 workflow, `clot-daily` concurrency 공유, 회전 단계 포함 |
| 8 | 자가검증 | 하루 200개 순환, 불일치 키는 그날 숨김 |
| 9 | 기존 `discover`·VIP | 그대로 |
| 10 | 스캔 범위 | 5 대분류 × `REVIEW` 상위 6,000 ≈ 3만, 필터 없음 — confirmed |
| 11 | 성별 | `gf=A` — confirmed by default |
| 12 | 공개 범위 | 쿠폰가·키별 쿠폰 집합을 Release에 공개 — confirmed by default |
| 13 | 텔레그램 | 하루 1통, 쿠폰가 10% 이상 하락 상위 10 — confirmed by default |
