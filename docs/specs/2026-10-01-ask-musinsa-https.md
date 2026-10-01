# ask-musinsa 공개 조회 HTTPS 전환 설계

## 확정 범위

grill-yourself 결정 #1은 기본값으로 확정한다: 공개 조회 4개부터 전환하고 계정 기능은 기존 경로 유지.
검색(search), 상품 상세(product), 옵션·재고(options), 추천(recommend)을 스킬 내부 Node.js 실행기로 전환한다.
주문, 찜, 회원 할인가, 과거 구매 실측, 회원 정보, 로그인은 기존 OpenCLI 경로를 유지한다.
상세 이미지·개별 후기의 브라우저 판독을 유지한다. 이 단계는 OpenCLI 전체 제거가 아니다.

## 전역 제약

- 런타임은 Node.js 22 이상, ES modules(.mjs), 추가 npm 의존성 없음.
- 공개 실행기는 OpenCLI 패키지, 전역 어댑터 파일, 브라우저, 계정 쿠키에 의존하지 않는다.
- 원본은 `.agents/skills/ask-musinsa/`, `.claude/skills/ask-musinsa` 심볼릭 링크를 유지한다.
- 사용자 계정 요청, 구매, 장바구니, 좋아요 변경, 리뷰 작성은 공개 실행기에 추가하지 않는다.
- 원본 OpenCLI 어댑터는 수정하지 않는다. 파서·필터 이식의 출처를 문서에 남긴다.
- JSON은 `{status,data,warnings,sourceUrls,fetchedAt,error?}` 형식이다.
- status는 ok, partial, error다. 정상 빈 목록은 ok/data:[], 응답 구조 누락은 SCHEMA_CHANGED다.
- 가격·치수·개수·평점은 숫자, 미확인은 null이다. 원화 문자열·하이픈·추정 기본값을 데이터에 넣지 않는다.
- 모든 결과의 fetchedAt은 UTC ISO-8601이며, 사용자 답변은 Asia/Seoul 시점으로 표시한다.
- 옵션 활성 여부는 실제 재고가 아니다. 재고 응답이 없거나 개별 옵션 재고가 누락되면 그 옵션의 재고는 null이다.
- 시간 제한은 시도마다 15초, 재시도는 최대 2회다. 네트워크 오류·429·502/503/504만 재시도한다.
- Retry-After는 초 또는 HTTP 날짜를 처리한다. 대기 시간이 30초를 넘으면 RATE_LIMITED로 종료한다.
- HTTP 리다이렉트는 자동 추적하지 않는다. 로그인 경로는 AUTH_REQUIRED, 나머지는 REDIRECT 오류다.
- 상세 이미지·후기 본문·현재 상품 실측은 기존 브라우저 판독 경로를 유지한다.

## 인터페이스

`node <skill>/scripts/musinsa.mjs <command> [arguments]`

| 명령 | 위치 인자 | 옵션과 기본값 |
|---|---|---|
| search | 검색어 | limit=20(1..100), page=1(양의 정수), sort=popular, gender=all, is-used=false, size, shoe-size, measure |
| product | 상품번호 또는 https://www.musinsa.com/products/<번호> | 없음 |
| options | 상품번호 또는 같은 상품 URL | 없음 |
| recommend | 없음 | limit=20(1..100), gender=M, store=musinsa |

검색 sort: popular,sale,price_low,price_high,newest,review. 검색 gender: all,men,women.
추천 gender: M,F,A. store: musinsa,outlet,beauty,player,boutique.
`--my-size`는 실행기 옵션으로 추가하지 않는다. 스킬이 `opencli musinsa mysize`를 먼저 실행해 필터 문자열을 얻은 뒤 `search --measure`로 전달한다.
잘못된 옵션, 무효 필터 일부, 빈 검색어, 외부 URL은 INVALID_ARGUMENT로 요청 전에 거부한다.
HTTP 주소는 내부에서 생성한다. Cookie/Authorization 헤더를 허용하지 않는다.

## 데이터 모델

ProductRow: goodsNo:number, goodsName:string, brand:string|null, price:number|null,
normalPrice:number|null, discount:number|null, rating:number|null, reviews:number|null,
soldOut:boolean|null, url:string. 상품 상세에는 category,features,season,delivery:string|null을 더한다.
검색·추천에는 rank:number를 더한다. rank는 페이지 안의 위치(1부터)이며 전체 검색 순위가 아니다. 추천에서 확보하지 못한 rating/reviews는 null이다.
OptionRow: goodsNo:number, variantId:number, size:string, activated:boolean|null,
soldOut:boolean|null, remain:number|null, priceExtra:number|null, delivery:string|null.
재고 API 전체 실패 또는 누락 옵션은 INVENTORY_UNAVAILABLE 또는 INVENTORY_MISSING 경고와 partial 상태를 반환한다.
상품·옵션 ID와 이름이 필요한 위치에서 누락되면 SCHEMA_CHANGED로 실패한다.

## 접근 방식과 근거

Node.js fetch를 독립 실행기로 사용한다. 검색·상품은 HTML의 __NEXT_DATA__, 추천·옵션·재고는 현재 API를 사용한다.
현재 어댑터: /Users/hyunjun_macbook_pro/.opencli/clis/musinsa/{common,search,product,recommend,options,filters}.js.
2026-10-01 직접 요청에서 상품 6596166의 상세 데이터, 옵션 4개, 재고 POST 200/4개,
티셔츠 검색(POPULAR) 61개, 추천 data 응답을 확인했다. 계정 API는 미검증이다.
기존 options.js:80-81의 activated 기반 재고 대체는 이식하지 않는다.
기존 search.js:69-78의 누락 구조를 빈 검색으로 취급하는 동작도 이식하지 않는다.

## 완료 조건

4개 공개 명령이 OpenCLI 없이 실행된다. 명령·필터·파서·HTTP 실패·부분 재고 실패의 오프라인 테스트가 통과한다.
라이브 검색 결과의 상품번호로 상세와 옵션을 조회하고 상품 연결을 확인한다. 추천 결과는 실제 상품 ID/이름/가격을 확인한다.
계정 6개 명령과 이미지·후기 판독 규칙은 스킬에 남고, 내 사이즈 검색은 계정 실측→명시적 실측 필터로 연결된다.
개별 후기 본문을 읽지 않고 평점/개수만으로 요약하지 않는다. 기존 파일은 덮어쓰지 않고 새 설계·계획 파일을 사용한다.

추가 검증에 따른 보완: 검색 요청 조건은 서버 __NEXT_DATA__의 검색 queryKey 조건과 대조한다. 서버가 조건을 바꾸면 FILTER_NOT_APPLIED로 실패해 해당 조건의 결과로 표현하지 않는다. 추천 메뉴·배너·기본 탭 구조도 지원한다.


## 2026-10-02 프로젝트 위치 정정

사용자 지시에 따라 project-clot의 로컬 스킬로 옮겼다. 현재 원본은 `.agents/skills/ask-musinsa/`이고 `.claude/skills/ask-musinsa`는 그 원본의 상대 링크다. 위 구현·리뷰 기록 중 과거 Git 브랜치와 Python 논리회로실험 테스트는 잘못 선택했던 논회실 저장소의 이력이다. project-clot의 현재 검증이나 Git 이력으로 해석하지 않는다. 이번 위치 이동에서는 커밋하지 않는다.
