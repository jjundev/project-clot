# 무신사 와이드 스캔 — 4910식 쿠폰가 계산을 무신사에 적용

2026-10-14, grill-yourself 결과(추천값으로 확정). 구현 계획은 `docs/plans/2026-10-14-musinsa-wide.md`.

## Intent
4910과 같은 구조로 무신사를 넓게 본다. 비로그인으로 카테고리 목록을 수만 개 스캔하고, 로그인 쿠키로는 하루 최대 4,000개 상품의 쿠폰을 **상품별로** 돌아가며 조회한다. 조회한 쿠폰 목록은 상품에 저장해 두고, 매일 그날 판매가로 **쿠폰가**를 로컬 계산해 변경분만 기록한다. 완료 기준: GitHub Actions가 매일 약 3만 개를 스캔하고, 쿠폰가 이력이 Release DB에 쌓이고, 쿠폰 조회 수와 미확인 상품 수가 요약에 나오고, 테스트가 통과한다.

Classification: architectural — 기존 `discover`(카테고리당 100개, 상품 페이지를 하나씩 엶)와 다른 수집기·저장소·workflow.

## 조사로 확인한 사실 (2026-10-14)
- 목록 API(`api.musinsa.com/api2/dp/v2/plp/goods`)는 페이지마다 `hmacId` 서명이 붙는다. `page`·`size`를 바꾸면 403 → `nextPageUrl`을 **순서대로** 따라가야 한다. 첫 페이지는 HTML `__NEXT_DATA__`. 한 페이지 60개.
- 목록 항목: `goodsNo, goodsName, goodsLinkUrl, thumbnail, isSoldOut, normalPrice, price, couponPrice, extraDiscountAmount, finalPrice, brand, brandName, reviewCount`. **`isLimitedDc`, `isRestrictedUsePoint`, `comId`, 쿠폰 정보 없음.** 가끔 `goodsNo`가 없는 비상품 항목이 섞인다.
- 쿠폰 API(`api.musinsa.com/api2/coupon/coupons/getUsableCouponsByGoodsNo`)는 비로그인 401.
- `sortCode=POPULAR`(=`SALE`) 앞쪽은 리뷰 0~1개짜리 신상(실험 재정렬 `rerank_relevance_qu_ver`). `sortCode=REVIEW` 1페이지는 59/60이 좋아요 1,000 이상.
- 무신사 쿠폰은 브랜드·카테고리·상품 단위가 섞여 있다(`.agents/verification/discount-rules-verification-report.md` §4). 4910처럼 "판매처 단위 전부 아니면 전무"가 보장되지 않는다.

## Behavior when done
- 새 workflow `Musinsa wide scan`이 매일 11:30 KST에 5개 대분류(001,002,003,103,004) × `REVIEW` 상위 100페이지(6,000개), `gf=A`를 스캔한다.
- 상품마다 `쿠폰가 = price − extraDiscountAmount − (그 상품에서 조회한 내 쿠폰 중 만료되지 않은 것의 최대 할인)`. 쿠폰 조회가 10일보다 오래됐거나 한 번도 없으면 쿠폰가는 NULL.
- 쿠폰 조회 순서: 한 번도 조회하지 않은 상품 → 조회 후 판매가·추가할인이 바뀐 상품 → 조회가 오래된 상품. 품절 상품은 조회하지 않는다. 하루 최대 4,000개(약 8일이면 전체 한 바퀴).
- 이력은 바뀔 때만(NEW / PRICE / REVIVED, 쿠폰가는 `coupon_price_changes`). 완전한 스캔에서 2회 연속 안 보인 상품은 `OUT_OF_SCOPE`(종료 아님), 다시 보이면 REVIVED.
- 쿠키 없음/만료/429 날: 쿠폰 조회만 건너뛰거나 멈춘다. 쿠폰가는 저장된 쿠폰 목록으로 계속 계산(10일 지나면 NULL), 요약에 경고.
- 텔레그램 하루 1통: 스캔 요약, 쿠폰 조회 요약, 쿠폰가 10% 이상 하락 상위 10개.
- VIP(`daily`)와 기존 `discover`는 그대로.

## Not in this round
- 대시보드 "무신사 전체" 필터 — 별도 하위 시스템.
- 와이드 상품의 회원가 추정(등급·적립금) — 목록에 제한 플래그가 없다.
- 카드 즉시할인 — 결제수단별·금액 문턱.
- 기존 `discover` 폐기·이전.

## Implementation outline
- 0단계 검증 결과(`docs/verify/musinsa-coupon-price.md`): 목록 값만으로 부른 쿠폰 API = 상품 페이지 값 90/90, 쿠폰 목록으로 할인 재현 435/435, **같은 키 다른 상품 예측 17/27(63%) — 관문 B 실패**. 상품마다 쿠폰이 다르다(쿠폰 0개 상품 21/90, SG·CP 상품 한정 쿠폰). → 키 학습을 버리고 상품별 순환 조회로 재설계(사용자 결정, 2026-10-14).
- `src/musinsaWide/`: `client.js`(목록 체인, 쿠폰 API), `coupons.js`(계산·상품별 조회·쿠폰가 반영), `store.js`(변경분만, 상품별 쿠폰 목록), `track.js`(순서·예산), `digest.js`, `release.js`.
- `src/site4910/release.js`를 태그·첨부 이름을 인자로 받게 일반화. 무신사는 `data-musinsa` / `musinsa-wide.db.gz`.
- CLI `track-musinsa`, `musinsa-db pull|push`. workflow는 `clot-daily` concurrency를 `daily.yml`과 공유하고 쿠키 회전 단계를 갖는다.

## Decisions
| # | Decision | Answer |
|---|---|---|
| 0 | 접근 | ~~A: 브랜드×대분류 학습~~ → 관문 B 실패 후 **상품별 순환 조회 + 저장된 쿠폰 목록으로 로컬 계산** — confirmed (2026-10-14) |
| 1 | 구현 전 검증 | 완료: 동등 90/90, 식 재현 435/435, 키 예측 63%(실패) |
| 2 | 쿠폰 단위 | 상품. 하루 최대 4,000개 조회(`COUPON_CHECKS_PER_DAY`), 조회 결과 10일 유효(`COUPON_TTL_DAYS`), 만료된 쿠폰(`useToDate` < 오늘)은 계산에서 뺌 |
| 3 | 기록 가격 | 쿠폰가만(등급·적립금·카드 제외) |
| 4 | 저장소 | `data/musinsa-wide.db`, Release `data-musinsa`, 변경분만 |
| 5 | 목록 이탈 | 완전 스캔 2회 연속 미노출 → `OUT_OF_SCOPE`, 재노출 → REVIVED |
| 6 | 페이지 순회 | `nextPageUrl` 순차, 대분류끼리만 병렬 |
| 7 | 실행 | 새 workflow, `clot-daily` concurrency 공유, 회전 단계 포함 |
| 8 | 조회 순서 | 미조회 → 조회 후 가격 변경 → 오래된 순, 품절 제외. 429면 그날 조회 중단(`throttled`) |
| 9 | 기존 `discover`·VIP | 그대로 |
| 10 | 스캔 범위 | 5 대분류 × `REVIEW` 상위 6,000 ≈ 3만, 필터 없음 — confirmed |
| 11 | 성별 | `gf=A` — confirmed by default |
| 12 | 공개 범위 | 쿠폰가·상품별 쿠폰 목록을 Release에 공개 — confirmed by default |
| 13 | 텔레그램 | 하루 1통, 쿠폰가 10% 이상 하락 상위 10 — confirmed by default |
