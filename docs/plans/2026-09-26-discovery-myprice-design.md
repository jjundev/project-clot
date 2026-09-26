# discovery 상품에 실제가(나의 할인가) 기록하기 — 설계

2026-09-26, grill-yourself 결과. 구현 계획은 `2026-09-26-discovery-myprice.md`.

## Intent
`discover`/`daily --with-discovery` 실행 시 카탈로그 스캔 뒤, discovery 상품 일부를 인증 HTTPS로 실제가를 받아 `price_logs.my_price`에 기록한다. 기존 목록 추정가(`estimated_my_price`)는 그대로 계속 기록한다. 비교는 실제가↔실제가, 추정가↔추정가만 한다. 완료 = 실제가가 쌓이고, 최저가·표시가가 같은 종류로 짝지어지고, 실패 시 오늘과 동일하게 추정가만 기록되며, 테스트 통과.

Classification: bounded — 기존 `handleDiscover` 흐름에 기존 `collectAuthenticatedPrices` 단계를 끼워 넣는다.

## 조사로 확인한 사실
- launchd(`com.musinsa.price-tracker.plist`)는 `cli.js daily`만 실행한다. `--with-discovery` 없음. DB의 discovery 가격 기록은 2026-09-05 하루치 499건뿐.
- discovery에는 가격 하락 알림 경로가 없다. `handleDiscover`는 하락 판정을 하지 않고 핫딜 Top 5(같은 날 정가 대비)만 보낸다. `collector.js`의 추정가↔추정가 비교는 `track` 일괄에서만 돌고 알림을 보내지 않는다.
- `fetchAuthenticatedPriceInfo`는 `myPrice`와 `estimatedMyPrice`를 함께 돌려준다(`src/myprice.js`).
- `recordPriceLog`는 같은 날 재기록 시 `my_price = COALESCE(?, my_price)`로 실제가를 보존한다(`src/db.js`).
- VIP 109개 수집이 590초(약 5.4초/개). 499개 전부면 약 45분.

## Behavior when done
- `discover` 실행 시 스캔 후 `🔐 [Discovery Auth] 87/120 priced (cap 120, 379 deferred to later runs)`. 실제가를 가장 오래 못 받은 상품부터.
- 오차 통계 한 줄: `📐 [Discovery Auth] myPrice vs estimate: n=87, median -1,230원, myPrice<estimate 71`.
- 하락은 콘솔에만: `📉 [Discovery] myPrice drops vs last myPrice: 3`. 알림 없음.
- 대시보드/`latest_prices.json`의 현재가·최저가는 같은 종류의 값.
- 핫딜 Top 5 순위는 추정가 기준 유지, 실제가가 있으면 ` · 나의 할인가 X원` 표시.
- 쿠키 없음/세션 만료/연속 3회 실패 시 `my_price`는 null, 나머지는 지금과 동일. 같은 날 재실행해도 받은 실제가는 유지.

## Not in this round
- discovery 실제가 하락 텔레그램 알림 (#11)
- 정기 daily에 discovery 포함 (#10)
- `track` 일괄의 discovery 인증 (`collector.js`의 VIP 한정 필터 유지)
- 대시보드 차트의 추정→실제 연결선 (`visualizer.js`의 `my_price ?? estimated`, VIP deferred에도 원래 있던 동작)

## Decisions
| # | Decision | Answer |
|---|---|---|
| 1 | 비교 기준 | A: 같은 종류끼리만. 첫 실제가는 이전 실제가가 없어 자연히 비교 제외 |
| 2 | `estimated_my_price` 출처 | 목록 추정가 유지(인증 응답의 추정가는 쓰지 않음) |
| 3 | 인증 단계 위치 | `handleDiscover` 안, 스캔 뒤·기록 전. `collectAuthenticatedPrices` 재사용 |
| 4 | 대상·순서 | 목록상 매진 아닌 discovery 소유 상품, 마지막 실제가 날짜 오래된 순(없으면 맨 앞), 동률은 goodsNo |
| 5 | 폴백 | `my_price` null, 나머지 동일 |
| 6 | 최저가 | `lowest_my_price` 새로 쌓음. `lowest_estimated_price`도 계속 쌓되 `lowest_my_price`가 있으면 날짜 칸을 덮지 않음 |
| 7 | 표시 | `pickDisplayPrices`로 현재가·최저가 종류 맞춤 |
| 8 | 핫딜 순위 | 추정가 기준, 실제가는 옆에 표시 |
| 9 | 인증 상한 | 120개/실행 (`--auth-limit`) — confirmed |
| 10 | 실행 주기 | 수동 유지 — confirmed |
| 11 | 하락 알림 | 콘솔 로그만 — confirmed |
