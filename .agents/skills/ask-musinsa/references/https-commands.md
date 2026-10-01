# HTTPS 공개 조회

Node.js 22 이상. npm 설치와 브라우저·계정 쿠키 없이 실행한다. 아래 `<SKILL_DIR>`은 SKILL.md 디렉터리의 절대 경로로 치환한다.

```bash
node "<SKILL_DIR>/scripts/musinsa.mjs" search '티셔츠' --limit 3
node "<SKILL_DIR>/scripts/musinsa.mjs" search '바람막이' --size 'M,L' --measure '총장:62-66,가슴:63-67'
node "<SKILL_DIR>/scripts/musinsa.mjs" product 6596166
node "<SKILL_DIR>/scripts/musinsa.mjs" options 6596166
node "<SKILL_DIR>/scripts/musinsa.mjs" recommend --gender M --limit 3
```

## 옵션

| 명령 | 옵션 |
|---|---|
| search | limit=20(1..100), page=1(양의 정수), sort=popular/sale/price_low/price_high/newest/review, gender=all/men/women, is-used=true/false(기본 false), size, shoe-size, measure |
| recommend | limit=20(1..100), gender=M/F/A(기본 M), store=musinsa/outlet/beauty/player/boutique(기본 musinsa) |
| product/options | 상품번호 또는 https://www.musinsa.com/products/<번호>, 추가 옵션 없음 |

의류 `--size 'M,L'`, 신발 `--shoe-size 270` 또는 `--size 270`을 사용한다. 계정 실측은 별도 `mysize` 경로다.
실측 `기장:70-75`는 `총장^70^75`로 변환한다. 가슴/허리 등 별칭을 지원한다.
소수 cm는 기존 필터와 동일하게 정수로 반올림하고 역범위는 작은 값부터 정렬한다.
`총장:75+`는 75..150, `총장:~75`는 0..75다. 2XL/3XL은 기존 매핑인 XXL을 유지한다.
숫자 size와 shoe-size를 동시에 주면 기존 동작대로 size 값이 우선한다. 오타 필터나 의류/신발 size가 한 목록에 섞이면 전체 입력 오류로 종료한다.
실측 필터를 적용해 검색했다는 사실과 현재 상품의 실측 표를 직접 확인했다는 사실을 구분한다.

## 결과

stdout은 도움말을 제외하면 단일 JSON이다. 정상/부분 성공은 종료 코드 0, 입력 오류는 2, 조회 오류는 1이다.

```json
{
  "status": "partial",
  "data": [{"goodsNo": 12, "variantId": 10, "size": "M", "activated": true, "soldOut": null, "remain": null, "priceExtra": 0, "delivery": null}],
  "warnings": [{"code": "INVENTORY_UNAVAILABLE", "message": "재고 조회 실패", "cause": "ACCESS_DENIED"}],
  "sourceUrls": ["https://goods-detail.musinsa.com/api2/goods/12/options"],
  "fetchedAt": "2026-10-01T00:00:00.000Z"
}
```

가격·할인율·평점·개수는 숫자이며 미확인은 null이다. 상품 결과는 goodsNo,goodsName,brand,price,normalPrice,discount,rating,reviews,soldOut,url을 포함한다.
상품 상세에는 category,features,season,delivery가 추가된다. 검색/추천에는 rank가 추가된다. rank는 반환된 페이지 안의 1부터 시작하는 위치이며 전체 검색 순위가 아니다. limit은 서버 페이지 크기를 바꾸지 않고 출력만 자른다.
옵션은 variantId,size,activated,soldOut,remain,priceExtra,delivery를 포함한다. 재고가 없는 옵션의 soldOut/remain은 null이다.
상품 soldOut는 페이지 요약값이다. 실제 옵션 재고는 options로 확인한다. 모든 가격은 공개 응답값이며 회원 할인가 검증이 아니다.

- `ok`/빈 배열: 해당 응답 구조에서 정상적으로 확인한 빈 결과.
- `partial`: 일부 정보 확보. INVENTORY_UNAVAILABLE은 재고 조회 전체 실패, INVENTORY_MISSING은 특정 옵션 재고 누락.
- `error`: error.code/message 확인. SCHEMA_CHANGED는 빈 결과가 아니라 파싱 실패다.
- INVALID_ARGUMENT: 명령/상품 URL/옵션/필터 오류. 요청 전에 수정한다.
- AUTH_REQUIRED/ACCESS_DENIED: 인증 요구/접근 거부. 공개 데이터가 없다고 해석하지 않는다.
- TIMEOUT/NETWORK_ERROR/HTTP_ERROR/RATE_LIMITED: 요청 실패. 재시도는 최대 2회이며 과도한 대기 시간은 종료한다.
- FILTER_NOT_APPLIED: 서버가 요청 조건을 다른 값으로 바꾸거나 누락함. 반환 상품을 해당 조건의 검색 결과로 답하지 않는다. 현재 공개 HTML 검색에서 is-used=true가 false로 바뀌는 것을 확인해 오류로 처리한다.
- REDIRECT: 예상 밖 주소 이동. 응답을 확인하고 필요한 브라우저 판독 경로를 선택한다.

fetchedAt은 UTC ISO-8601이다. 답변에는 Asia/Seoul로 표시한다. sourceUrls는 실제 요청한 주소이며 질문에 대한 상품 근거는 상품 URL을 함께 제시한다.
상세 이미지·현재 상품 실측 표·실제 후기 본문은 이 실행기가 판독하지 않는다. [상세·후기 절차](detail-and-reviews.md)를 따른다.

## 구현 출처와 범위

2026-10-01 로컬 OpenCLI musinsa 어댑터의 common/search/product/recommend/options/filters.js를 바탕으로 공개 조회를 분리했다.
filters의 순수 변환 코드를 이식했으며 나머지는 결과 계약과 구조 검사를 추가한 독립 구현이다. 전역 어댑터를 import하거나 수정하지 않는다.
검색의 현재 직접 조회 주소는 /search/goods?keyword=…다. 기존 /search/musinsa/goods?q=…의 308 응답을 확인해 현재 주소를 사용한다.
주문·찜·회원 할인가·과거 구매 실측·회원 정보·로그인과 상세 이미지·후기는 기존 OpenCLI 경로를 유지한다.

추천은 메뉴·홍보 배너를 제외하고 상품 목록과 탭 모듈의 기본 탭을 읽는다. 다른 탭을 전부 합산한 결과는 아니다.
