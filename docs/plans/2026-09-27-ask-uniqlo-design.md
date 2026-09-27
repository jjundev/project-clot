# ask-uniqlo 스킬 설계 (유니클로 KR 상품 조회)

## 의도
project-clot 저장소 안에 로컬 스킬 `ask-uniqlo`를 추가한다. Claude가 "유니클로 후리스 찾아줘", "이 제품 M 사이즈 실측이랑 재고 알려줘" 같은 요청을 받으면, 유니클로 KR의 JSON API를 HTTPS로 직접 호출해 검색 결과·상세 정보(가격·소재·세탁·원산지)·컬러×사이즈 온라인 재고·실측 사이즈표·리뷰를 가져와 비교표로 보고한다. ask-dc(`~/.claude/skills/ask-dc`)와 같은 구조: 브라우저 없이 Node 내장 fetch만 쓰는 독립 CLI + SKILL.md.

분류: architectural — 저장소에 유니클로 관련 코드가 없고 새 CLI·새 스킬을 만든다.

## 완성 후 동작
- `uq.mjs search 후리스 --gender men --sort price-asc --limit 10` → `{meta, items}` JSON (GU 기본 제외).
- `uq.mjs detail E450195-000` → 존재하는 모든 priceGroup의 가격·컬러별 재고 요약 + 실측표 + 소재·세탁·원산지.
- `uq.mjs reviews E450195-000 --limit 20` → 리뷰 + 평점 분포.
- 실패 시 stderr `{"error":{code,message}}`와 종료 코드 2 ARG / 3 EMPTY / 4 NOT_FOUND / 5 BLOCKED / 1 NETWORK.

## 이번 범위에서 제외
- 매장 재고 (온라인 재고만으로 충분 — 사용자 확정)
- 유니클로 가격 일일 추적·DB 연동 (별도 서브시스템)
- 스타일링·유사상품·추천 API
- 무신사 실측(`opencli musinsa mysize`) 연동 — 사용자가 말한 치수와 실측표 비교만 (N3)
- KR 외 국가

## 접근 방식
A. 스킬 폴더 안의 독립 CLI (ask-dc 구조) — **선택**. 스킬 폴더만으로 동작, 트래커 코드와 결합 없음.
B. `src/cli.js`에 `uniqlo` 하위 명령 — 트래커 CLI에 결합, 거부.
C. OpenCLI 어댑터 — OpenCLI 설치 필요, 거부.

## 확인된 API 사실 (2026-09-27 실측)
- 베이스 `https://www.uniqlo.com/kr/api/commerce/v5/ko`, 모든 요청에 `httpFailure=true`.
- Chrome User-Agent 필수 (없으면 연결이 끊김). 홈페이지·사이즈표 HTML은 curl에서 403, API는 200.
- 응답 형태 `{"status":"ok","result":...}`. 잘못된 파라미터는 HTTP 200 + `{"status":"nok"}`. 없는 상품 `details`는 404.
- 검색 `GET /products?q=&limit=&offset=&sort=&path=`
  - `sort`: 1 추천, 2 가격↑(낮은순), 3 가격↓, 4 평점순, 5 신상품
  - `path=<genderId>`: WOMEN 57892, MEN 57893, KIDS 57894, BABY 57925 (MEN 결과에 UNISEX 포함)
  - `result.items[]`: `productId, priceGroup, name, genderCategory, prices{base{value},promo{value}|null}, rating{average,count}, colors[{displayCode,name}], sizes[{name}]`; `result.pagination{total,offset,count}`
  - promo 값이 base와 같은 경우가 있음. 같은 productId가 priceGroup 00(정상)·01(가격 인하)로 따로 나옴 (예: E482279-000 00=49,900, 01=29,900). 이름이 `GU`로 시작하는 GU 상품이 섞임 (`GU데님…`처럼 공백 없는 경우가 대부분).
- 상세 `GET /products/{id}/price-groups/{pg}/details` → `name, genderCategory, breadcrumbs{gender,class,category,subcategory}.locale, rating{average,count,fit,rateCount}, prices, colors[], sizes[], plds[], composition, washingInformation, careInstruction, freeInformation, longDescription, countriesOfOrigin[{code}], manufacturingDate{localizedDate}, images.main{<colorCode>:{image}}, representative.color.displayCode`. 텍스트 필드에 `<br>` 포함.
- `productIds=<id>` 검색은 priceGroup 00만 돌려준다 → 그룹 탐색은 00–03 `details` 병렬 호출.
- 재고 `GET /products/{id}/price-groups/{pg}/l2s?withPrices=true&withStocks=true` → `l2s[{l2Id,color{displayCode},size{displayCode},pld{displayCode}}]`, `stocks{<l2Id>:{statusCode,quantity}}`, `prices{<l2Id>:{base,promo}}`. `statusCode` 관측값: `IN_STOCK`(재고 있음), `LOW_STOCK`(재고 적음), `STOCK_OUT`(품절).
- 사이즈표 `GET /products/size-charts?productIdsWithColorCode={id}&includeBodyMeasurements=true` → `result[0].sizeChart[]`(제품 실측), `result[0].bodyMeasurements[]`(권장 신체 치수), 각 `{name, sizeParts[{name, measurements[{value,unit}]}]}`. 없는 상품은 `sizeChart` 키가 없음. 잡화는 `unit:""`(예: 용량 22L).
- 리뷰 `GET /products/{id}/reviews?limit=&offset=&sort=` (priceGroup 경로는 404). 동작하는 sort: `submission_time`, `rating`. `helpful_count` 등은 `nok`.

## 결정사항
| # | 결정 | 답 |
|---|---|---|
| 0 | 접근 | A (독립 CLI) |
| 1 | 런타임 | Node 18+ 내장 fetch, 외부 의존성 없음, ESM |
| 2 | 데이터 소스 | JSON API만 |
| 3 | 리뷰 | 별도 `reviews` 명령 |
| 4 | 재고 | 온라인(`l2s`)만 |
| 5 | GU | 기본 제외, `--include-gu`로 포함 |
| 6 | priceGroup 모를 때 | 00–03 병렬 탐색 후 전부 반환. `--pg` 또는 URL의 그룹이 있으면 그 그룹만 |
| 7 | detail 출력 | 컬러별 `{inStock, lowStock, soldOut}` 사이즈 목록이 기본, `--raw`로 l2 전체 `variants` 추가. 분류는 `statusCode` 기준 |
| 8 | 할인 판정 | promo < base 또는 priceGroup ≠ 00 |
| 9 | 검색 파라미터 | `--gender men|women|kids|baby` → `path`, `--sort recommended|price-asc|price-desc|rating|new` → 1–5 |
| 10 | 오류 규약 | ask-dc와 같은 종료 코드·stderr JSON |
| 11 | 호출 간격·재시도 | 요청 간 300ms, 네트워크 오류·5xx 1회 재시도(1000ms), 10초 타임아웃. `timing` 객체로 테스트에서 0 |
| 12 | 사이즈표 없음 | `sizeChart: null`, 오류 아님 |
| 13 | 리뷰 정렬 | `--sort new|rating` (검증된 값만) |
| N1 | 스킬 위치 | 실제 파일 `.agents/skills/ask-uniqlo/`, `.claude/skills/ask-uniqlo` → 상대 심볼릭 링크 |
| N2 | 보고서 형식 | 상품별 비교표(가격·할인 / 평점 / 재고 있는 사이즈 / 핵심 실측) + 소재·세탁 요약 + URL |
| N3 | 무신사 실측 연동 | 제외 |
