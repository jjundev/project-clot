# 좋아요 목록 동기화 HTTPS화 — 설계

(2026-09-26 grill-yourself 결과. 결정 #10은 사용자가 확정.)

## Intent
`syncLikedItemsFromMusinsa`가 OpenCLI(Chrome DOM 스크롤) 대신 캐시된 인증 쿠키로 무신사 좋아요 API를 직접 호출하게 한다. Mac이 잠든 deferred 실행에서도 동기화가 되고, 이후 B안(클라우드 수집)의 전제 조건을 채운다. 목록이 불완전하면 결과를 버리고 OpenCLI로 폴백하며, 브리지가 없으면 동기화를 건너뛴다. 안전 가드와 반환 형식은 유지한다.

Classification: bounded — 기존 sync 흐름에 데이터 소스를 추가하는 작업. 인증 인프라(`makeSessionProvider`)와 인증 HTTPS 패턴(`collectAuthenticatedPrices`)이 이미 있다.

## 조사 결과 (2026-09-26, 캐시 쿠키로 GET 몇 번, 형태만 확인)
| 항목 | 결과 |
|---|---|
| 목록 | `GET https://like.musinsa.com/api2/like/like-page/v1/tab/goods?size=30` → `{ meta:{result}, data:[...], link:{next, nextCursor} }` |
| 페이지 처리 | `link.next`가 다음 페이지 절대 URL(`size, cursor, lastIndex`), 마지막 페이지는 `null`. 실측 4페이지(31+30+30+19) |
| 항목 | `itemType === 'GOODS'`만 상품. `goodsNo:number, goodsName, brandName, isSoldOut` 등. 목록에 `BANNERS`가 섞이고, 번들에 `AD_GOODS`도 있음 |
| 전체 개수 | `GET https://like.musinsa.com/api2/like/like-page/v1/tab` → `data.goods` (`/like/api/v2/goods/sorted-count`의 `data.count`와 동일) |
| 실측 | 전체 109, GOODS 고유 109 = DB like ACTIVE 95 + SOLDOUT 14 |
| 로그아웃 | 쿠키 없음 / `app_atk`만 / 잘못된 값 모두 HTTP 401, `meta.errorCode: "LIKE-000-0001"` |
| Set-Cookie | `__cf_bm`만. 인증 쿠키 재발급 없음 |
| SSR | `/like/goods`의 `__NEXT_DATA__`에는 목록이 없음 |

## Behavior when done
- daily(깨어 있음)·`sync`: HTTPS 먼저. 성공하면 OpenCLI·Chrome을 쓰지 않는다. 실패하면 이유를 한 줄 경고하고 기존 OpenCLI 경로(prewarm 포함)로 간다.
- daily(deferred): HTTPS만. 실패하면 동기화를 건너뛰고 OpenCLI는 부르지 않는다.
- 고유 상품 수 < 전체 개수, 고유 상품 수 > 전체 개수 + 3, 401 두 번, 스키마 불일치, 페이지 끊김 → 결과 전체를 버린다. 부분 반영 없음. 전체 개수보다 1~3개 많은 목록은 받아들이고 알림 한 줄을 남긴다(아래 "개수 API 지연").
- 요약 객체에 `source: 'https' | 'opencli'`만 추가.
- deferred 실행에서 좋아요 HTTPS 동기화 성공 + VIP 가격 전부 HTTPS → `'full'` 기록(upgrade 재실행 없음). 하나라도 못 하면 `'deferred'`.

### 개수 API 지연 (2026-09-27 추가)

좋아요를 추가한 직후 `tab.data.goods`가 목록보다 늦게 갱신된다. 페이징 전후 총수는 같았으므로 페이징 중 변동이 아니다.

| 시점 | 목록의 고유 GOODS | `tab.data.goods` | 당시 결과 |
|---|---|---|---|
| 아침 deferred 실행 | 113 | 112 | 목록을 버림, 동기화 건너뜀 |
| 11시대 upgrade 실행 | 114 | 113 | 목록을 버리고 OpenCLI 폴백 |
| 11:3x 직접 조회 | 114 | 114 | 일치 |

규칙(`LIKES_TOTAL_LAG_TOLERANCE = 3`): 모자라면 버린다(대량 UNLIKED 위험). 1~3개 많으면 받아들이고 `[Sync HTTPS Notice] like total lags the list (X listed, total Y); accepting`을 남긴다. 3개를 넘게 많으면 다른 목록이 섞였거나 API가 바뀐 것으로 보고 버린다. 남는 쪽의 최악은 취소한 좋아요가 하루 더 ACTIVE로 추적되는 것이다. 총수를 기다렸다 다시 읽는 방식은 지연 폭을 몰라 택하지 않았다.

## Not in this round
- OpenCLI 어댑터 수정·제거 (폴백으로 유지, 저장소 밖 파일)
- 기존 항목의 이름·브랜드 갱신
- 원격에서 사라진 `SOLDOUT` like가 UNLIKED로 바뀌지 않는 기존 동작
- `limit` 인자: HTTPS는 항상 전체, `limit`은 OpenCLI 폴백에만

## Decisions
| # | Decision | Answer |
|---|---|---|
| 1 | 데이터 소스 | `like.musinsa.com` `tab/goods`, `link.next` 커서 |
| 2 | 완전성 | 페이징 전·후 `tab.data.goods`가 같고 GOODS 고유 수와도 같아야 함, 다르면 폐기 (후 재확인은 최종 리뷰 후 추가) |
| 3 | 로그아웃 판별 | 401 또는 `LIKE-000-0001` → `SessionExpiredError` |
| 4 | 만료 처리 | refresh 1회 후 1페이지부터 재시작, 또 실패하면 폴백 |
| 5 | 모듈 경계 | 가져오기 `src/likes-https.js`, 조율 `src/sync.js` |
| 6 | 포함 항목 | `itemType === 'GOODS'`만, goodsNo 중복 제거 |
| 7 | 스키마 불일치 | 폴백 |
| 8 | prewarm | OpenCLI 폴백 직전에만 |
| 9 | deferred 동기화 | HTTPS만(`allowOpenCli:false`, `allowBridge:false`) |
| 10 | deferred + 전부 HTTPS | `'full'` 기록 **[confirmed]** |
| 11 | provider | daily에서 한 인스턴스를 sync·수집이 공유 |
| 12 | 간격·재시도 | 요청 사이 700ms, 429/5xx 2초 뒤 1회 재시도 |
| 13 | `limit` | HTTPS에선 무시 |
| 14 | 페이지 상한 | `maxPages=50`, 같은 `next` 반복 감지 |
