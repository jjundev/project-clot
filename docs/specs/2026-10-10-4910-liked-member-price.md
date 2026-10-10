# 4910 찜 상품 회원가·쿠폰가를 가격 대시보드에 — 설계

Source: 2026-10-10 grill-yourself session. Needs-you rows #1, #2, #8 were answered → **[confirmed]**. #1 differed from the assumption (조회 명령 + 리포트 보강 → Pages 대시보드 통합), so #0, #5, #6, #7, #9, #12 were re-derived.

## Intent
GitHub Pages에 배포된 무신사 가격 대시보드에 **4910에서 찜한 상품**을 함께 올린다. 상품마다 표시가·쿠폰적용가(신규회원 기준)·내 회원가(로그인 기준)를 매일 기록하고, 무신사 상품과 같은 카드/최저가/하락 필터/추이 차트로 보여 준다. 완료 기준: daily 실행 한 번에 4910 찜 목록 동기화 + 가격 기록이 끝나 `data/4910.db`에 커밋되고, Pages에서 "4910" 필터로 그 상품들의 가격 추이를 볼 수 있으며, 토큰 만료 시에도 무신사 수집·기존 4910 스캔·배포는 정상이고 텔레그램 경고 한 줄만 추가된다.

Classification: architectural — 회원 인증, 찜 동기화, 새 테이블, 대시보드 데이터 계약 확장.

## Facts (verified 2026-10-10, anonymous read-only requests)
- `GET https://api.a-bly.com/api/v2/goods/{sno}/` (익명 토큰) → 200. `goods.price` = 쿠폰적용가, `goods.price_description.text == "쿠폰적용가"`. 표시가 `goods.first_page_rendering.price`, 정가 `goods.linked_option.original_price`, `goods.is_soldout`, `goods.is_open`. 유니클로·GU 24/24 표본에서 쿠폰가 < 목록가.
- 비로그인 쿠폰적용가는 **신규회원 기준**: 21,600 × 0.85 = 18,360 = `[🎁첫 구매 ONLY] 15%`(앱 전용) 쿠폰 적용값.
- 회원 인증: 쿠키 `ably-jwt-token` → `Authorization: JWT <token>` (4910 `_app` 번들 axios 인터셉터). 번들에 토큰 갱신 로직 없음. 익명 토큰은 JWT지만 `exp` 없이 `iat`만.
- 찜 목록: `GET https://api.a-bly.com/aglo/api/members/me/liked-goods/?limit=&last_sno=` (4910 `/liked` 페이지 번들 `readLikedGoodsList`). 항목은 브랜드 목록 API와 같은 `item.sno`/`logging.analytics`/`render` 형식(페이지 렌더러가 같은 필드를 읽음). 응답 최상위 키는 미검증.
- **Gate verified 2026-10-10 (member token):** 찜 목록 응답 최상위 키 `total_count`, `goods_list`, `last_sno`(마지막 페이지에서 `null`). 항목 `item`/`logging`/`render`, `logging.analytics`에 `BRAND_SNO`, `BRAND_NAME`, `MARKET_NAME`, `SALES_PRICE` 있음. 회원 상세도 `price_description.text == "쿠폰적용가"`, `applied_coupon`은 null. 표본 3개 모두 회원가 ≠ 비로그인가이고 회원가가 더 높음(예: 비로그인 48,450 / 회원 51,870 / 표시가 59,000) — 신규회원 첫 구매 쿠폰이 기존 회원에게는 빠지기 때문. 회원 토큰 JWT 페이로드 키 `user_id`, `username`, `email`, `iat`, `exp` 없음.
- 무신사 대시보드: 상품 625개(ACTIVE+SOLDOUT), HTML 513KB. 가격 튜플 `[date, 정가, 판매가, my, 품절, 쿠폰명, 쿠폰할인]`(`src/visualizer.js:69-77`), 최저가·하락은 `my`(`[3]`) 기준(`src/dashboard.template.html:681-686`).

## Behavior when done
- Pages 대시보드에 출처 칩 `전체 · 무신사 · 4910`. 4910 카드는 `4910` 배지와 셀러명.
- 4910 카드 가격 = 내 회원가(토큰 없음/실패한 날은 쿠폰적용가), 아래 `쿠폰적용가(신규회원 기준) 18,360원`. 상세 시트 차트·표에 표시가, 쿠폰적용가(신규회원), 내 회원가.
- 최저가·하락 필터는 4910에도 같은 규칙(내 회원가 기준).
- 4910에서 찜 해제 → 다음 실행부터 대시보드에서 빠짐(이력은 DB에 남음).
- 텔레그램 4910 리포트에 `찜 N개 · 가격 기록 M개` 줄과 `찜 상품 회원가 하락` 상위 10(전날 대비). 토큰 만료면 `⚠️ 4910 로그인 만료 — ABLY_JWT_TOKEN 갱신 필요`, 그날 찜 가격 기록은 중단, 대시보드는 마지막 기록 유지.
- 4910 상세 링크 `https://4910.kr/goods/{sno}`, 공유 URL `?goods=4910:{sno}`.

## Not in this round
- 1.6만 스캔 결과를 대시보드에 — 페이지 크기·회원가 조회 불가. 스캔·하락 알림은 현행 유지.
- `price-4910` 조회 명령, 리포트 하락 상위 10 보강 — #1 답으로 대시보드로 대체.
- 토큰 자동 갱신 — 갱신 엔드포인트 미발견.
- 쿠폰 자동 받기 — 계정 쓰기 동작.
- 쿠폰 목록(`/coupons/`) 표시.

## Approaches
| Option | Approach | Pro | Con | Chosen |
|---|---|---|---|---|
| A | 1.6만 스캔 결과 전부를 대시보드에(표시가만) | 추가 동기화 없음 | HTML 10MB+, 회원가 없음 | — |
| B | 4910 찜 목록 동기화 → 찜 상품만 매일 비로그인+회원 상세 → 대시보드에 합침 | 무신사(좋아요→VIP→나의 할인가)와 같은 모델, 하루 2×N건 | 토큰 필수, 찜 안 한 건 안 보임 | ✔ |
| C | 매일 하락 상위를 골라 표시 | 찜 불필요 | 상품이 매일 바뀌어 추이 무의미 | — |

## Implementation outline
0. 착수 게이트(읽기 전용, 실제 토큰): 찜 목록 200 + 회원 `goods.price`가 비로그인과 다른지(또는 `applied_coupon` non-null). 실패 시 중단·재설계.
1. `client.js`: `getGoodsDetail(sno, { memberToken })`, `listLikedGoods({ memberToken, lastSno })`. 회원 호출은 `Authorization: JWT`만, 회원 401/403은 `err.code='MEMBER_AUTH'`(재시도 없음).
2. `store.js`: `liked_goods`, `liked_price_logs`(UNIQUE(sno,date), 매일 1행).
3. 새 `liked.js`: `readAblyToken`, `tokenExpiry`, `syncLiked4910`.
4. `cli.js run4910Step`: 스캔 뒤 별도 격리로 찜 단계, 다이제스트에 찜 줄·하락·만료 경고.
5. `visualizer.js`: `4910.db` 있으면 찜 상품을 items에 합침, `src`/`k` 키, 4910 튜플 8칸(`[7]` = 신규회원 쿠폰가).
6. `dashboard.template.html`: `k` 기반 조회, 출처 칩, 4910 배지·신규회원가 줄·차트 4번째 선.
7. Actions: `ABLY_JWT_TOKEN` secret, probe `4910 member login`, `pages.yml` paths, README·`.env.example`.

## Decisions
| # | Decision | Answer |
|---|---|---|
| 0 | 접근 | B — 찜 동기화 + 회원가 매일 기록 → 대시보드 통합 |
| 1 | 기능 범위 | Pages 대시보드에 4910 상품 통합 **[confirmed]** |
| 2 | 토큰 공급 | 쿠키 `ably-jwt-token` 수동 등록 → secret/env `ABLY_JWT_TOKEN` **[confirmed]** |
| 3 | 가격 출처 | 상세 `goods.price` + `price_description`, 표시가 `first_page_rendering.price` |
| 4 | 회원 인증 | `Authorization: JWT <ably-jwt-token>` |
| 5 | 대시보드 대상 | 4910 찜 목록 전체(브랜드 무관) |
| 6 | 저장 | `4910.db`에 `liked_goods` + `liked_price_logs`(매일 1행) |
| 7 | 실패·만료 | 찜 단계 별도 격리, 401이면 중단+경고, 대시보드는 마지막 기록 |
| 8 | 비로그인 쿠폰가 표기 | 내 회원가와 함께 "신규회원 기준"으로 표시 **[confirmed]** |
| 9 | 대시보드 통합 | `src`/`k` 키 분리, `my` = 회원가 ?? 쿠폰가, `[7]` = 신규회원 쿠폰가 |
| 10 | 러너 점검 | probe에 찜 목록 1페이지 점검(토큰 출력 금지) |
| 11 | 착수 게이트 | 찜 목록 200 + 회원가 ≠ 신규회원가 먼저 확인 |
| 12 | 텔레그램 | 기존 4910 리포트에 찜 줄 + 회원가 하락 상위 10 |
