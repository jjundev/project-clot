# 대시보드 검색 정확성 개선 설계

## 의도와 결정 상태

브랜드·상품명을 자연스럽게 조합하거나 상품 URL을 붙여 넣어 현재 대시보드에 등록된 상품을 찾는다. 미등록·필터 제외 가능성·조회 실패·로딩 중을 구분한다. 기존 정적 대시보드 검색 흐름을 수정하는 bounded 작업이다.

2026-10-24 채팅의 grill-yourself 설계를 구현 근거로 보존한다. 사용자가 다음 단계인 writing-plans를 요청했으므로 미응답 결정 #1과 #2는 해당 스킬 규칙에 따라 **[confirmed by default]**다.

- #1: 검색 정확성을 먼저 개선한다. 대량 검색 성능 개편과 관련도 정렬은 후속 작업이다.
- #2: 상품번호·URL 직접 조회는 일반 검색 필터와 관계없이 상품을 표시한다. 필터 상태는 보관한다.

## 전역 제약

- 기존 Node.js ESM·정적 HTML·Web Worker 구조와 현재 Node.js 버전 요구사항을 유지한다.
- 새 런타임 의존성을 추가하지 않는다.
- HTTP Worker와 file:// 로컬 실행에서 검색 의미를 동일하게 유지한다.
- 직렬화되는 factory 함수는 외부 import나 자유 변수에 의존하지 않는다.
- 브랜드 식별용 brandKey와 표시 원문은 유지하고 검색 전용 정규화를 분리한다.
- 수집 대상·DB 스키마·쿠폰가·하락·최저가 판정은 변경하지 않는다.
- 검색 데이터의 기존 필드 순서와 v2 revision·크기 검증을 유지한다.
- 상품번호·URL 직접 조회는 일반 검색 필터와 관계없이 상품을 표시하고 필터 상태를 보관한다.
- 미확인 범위의 상품 부재를 단정하지 않고, 요청 실패를 미등록으로 표시하지 않는다.
- 변경 범위 밖의 파일과 실행 데이터는 수정·스테이징하지 않는다.

## 범위 밖

85MB 전체 검색 데이터의 형식·캐시 개편, 서버 검색 도입, 관련도 정렬, 오타·초성·유사어 검색, 외부 브랜드 사전, 자동 상품 추적 등록, 배포 workflow 메모리 문제는 포함하지 않는다. 일반 텍스트 검색의 초기 대기시간 개선은 완료 조건이 아니다.

## 현재 구조와 수정 지점

- `src/dashboard-model.js:3,11,40`: 브랜드 키 정규화, 검색 자료 구성, 전체 문구 includes 판정.
- `src/dashboard-index.js:4,48`: 위치 기반 검색 데이터 형식과 Worker 복원.
- `src/dashboard-musinsa.js:122`: 표시 브랜드만 전달해 원본 brand 코드가 사라지는 지점.
- `src/dashboard-runtime.js:161`: 최신 요청 보호, 검색 상태, 재시도.
- `src/dashboard-worker.js:219,279`: 범위 검색과 인덱스 없이 가능한 상품 lookup.
- `src/dashboard.template.html:889,979`: 결과 표시와 180ms 입력 지연.
- `src/visualizer.js:529`: model/runtime/transport를 함수 문자열로 HTML과 Worker에 삽입.

## 입력 해석 계약

`createDashboardModel()`이 다음 함수를 노출한다. 모든 함수는 factory 내부에 정의한다.

```ts
type SearchInput =
  | { type: 'empty' }
  | { type: 'text'; tokens: string[] }
  | { type: 'product'; key: string }
  | { type: 'invalid'; message: string };
parseSearchInput(input: string): SearchInput;
normalizeSearchText(value: unknown): string;
searchFields(item: object): string[];
matchesSearch(item: object, tokens: string[]): boolean;
```

판정 순서는 빈 입력 → 숫자 → 출처 접두어 → URL → 일반 문구다. 숫자는 NFKC 후 양의 안전한 정수로 검증하고 선행 0은 제거한다. 숫자 단독은 무신사다. `musinsa:<번호>`, `4910:<번호>`도 허용한다. 부호가 붙은 숫자, 0, 안전한 정수 범위 밖, 잘못된 지원 접두어는 invalid다. 접두어의 출처명은 대소문자를 구분하지 않는다.

URL은 `http:`·`https:`와 `musinsa.com`, `www.musinsa.com`, `m.musinsa.com`만 허용한다. 경로는 `/products/<ASCII 숫자>`와 선택적 끝 `/`이며, 쿼리·해시는 무시한다. 사용자정보나 비표준 포트가 있으면 거부한다. 다른 출처 URL, 단축 링크, 잘못된 상품 경로는 invalid다. URL로 보이는 입력에는 `www.`로 시작하거나 스킴과 `:`로 시작하는 문자열도 포함하며, 지원하지 않는 형식을 일반 검색으로 흘리지 않는다. URL을 직접 요청하거나 추적 파라미터를 화면에 재출력하지 않는다.

일반 문구는 NFKC·소문자 변환 후 Unicode 문자·결합기호·숫자의 연속 구간으로 나누고 중복을 제거한다. 공백만 있으면 empty, 기호만 있으면 invalid다. `normalizeSearchText`는 NFKC·소문자 변환 후 문자·결합기호·숫자 이외를 제거한 비교용 문자열을 반환한다.

검색 필드는 `b`, `m`, `g`, `n`, `searchAliases` 각각이다. 모든 token이 필드 중 하나의 부분 문자열이면 일치한다. 서로 다른 token은 서로 다른 필드에서 일치해도 되지만 필드들을 이어 붙여 하나의 token을 만들지는 않는다. `queryCatalog()`는 일반 문구의 token AND를 집계 전에 적용한다. 숫자·URL의 직접 조회 분기는 UI/runtime에서 처리하며, `queryCatalog()`의 역할은 필터가 적용된 일반 목록 계산으로 유지한다.

## 별칭과 직렬화

`searchAliases: string[]`는 공개 원본 코드만 보존한다. 대량 무신사 adapter는 `goods.brand`를 별칭에 넣고 `b`는 기존처럼 `brand_name || brand`를 표시한다. 원본 코드가 없으면 빈 배열이다. 찜·4910에 근거 없는 별칭을 만들지 않는다.

`summarize()`와 `unpackIndex()`는 동일한 helper로 `_searchFields`를 만든다. query는 입력 상품을 변경하지 않는다. 기존 `_hay`는 호환을 위해 유지할 수 있으나 새로운 판정의 유일한 근거로 사용하지 않는다. 검색 index의 fields 끝에 `searchAliases`를 추가한다. 이전 짧은 row나 별칭 없는 카드에서는 `[]`로 복원한다. v2와 기존 필드 위치는 유지하고 새 배포는 기존 revision 검증으로 묶는다.

## 런타임과 취소 계약

기존 `query(state)`, `lookup(key)`, `getHistory(key)` API와 일반 검색 결과 모양은 유지한다. v2 runtime에 다음 public API를 추가한다.

```ts
searchProduct(key: string): Promise<{
  mode: 'product'; key: string; item: Summary | null
}>;
```

`Summary`는 기존 `summarize()` 결과다. `searchProduct()`와 `query()`는 동일한 최신 요청 번호를 공유한다. `state.phase`는 기존 `preview`·`query` 외에 `product`를 허용한다. retry는 마지막 operation과 인자를 보관해 같은 operation을 재실행한다. 저수준 `lookup()`은 상세 모달용 API로 유지하며 일반 검색 상태를 바꾸지 않는다.

scoped transport에 `cancelQuery(): Promise<void>`를 추가하고 Worker RPC 허용 목록에 등록한다. 이 함수는 generation을 증가시키고 현재 query promise를 STALE_RESULT로 종료하며, current와 불필요한 대기 index 요청을 무효화한다. 진행 중인 다운로드를 중단할 의무는 없고, 완료된 cache는 유지한다. 새 일반 query도 기존 취소 규칙을 그대로 적용한다.

scoped `searchProduct()`는 cancelQuery 후 lookup을 호출한다. 전체 index 준비·성공 여부와 독립적으로 routes/card만으로 완료되어야 한다. 이전 일반 검색 오류가 직접 조회 성공 상태를 덮지 못한다. non-scoped v2와 legacy v1은 기존 호환 경로를 보존하며 index 우회 성능 보장은 현재 배포 형식인 scoped v2에 적용한다.

## UI 계약

입력창의 placeholder는 `브랜드 · 상품명 · 상품번호 · URL 검색`, 접근성 이름은 `브랜드, 상품명, 상품번호 또는 URL 검색`으로 바꾼다.

- empty/text: 기존 목록·필터·집계·정렬·페이징을 사용한다.
- product: 일반 KPI·필터·정렬·집계 영역은 숨기되 상태와 localStorage 값을 변경하지 않는다. `상품번호 조회 · 일반 검색 필터와 관계없이 표시합니다` 안내와 결과 카드 0~1개를 표시한다. 페이징은 숨긴다.
- invalid: 입력 안내만 표시하고 검색/lookup 요청은 시작하지 않는다. 이전 결과를 최신 결과처럼 표시하지 않는다. 이전 요청 응답은 UI token으로 무효화한다.
- product→text/empty: 보관한 일반 검색 필터와 정렬을 복원한다.
- 직접 조회 상세 모달: 기존 getHistory를 사용하고 결과 내 이전/다음 이동은 비활성화한다. 일반 검색으로 돌아가면 기존 탐색을 복원한다.

상품이 없으면 `현재 대시보드에 등록된 상품이 없습니다`를 표시한다. OUT_OF_SCOPE·미선정 등 원인을 단정하지 않는다. 실패하면 `상품을 조회하지 못했습니다`와 `다시 시도`를 표시한다. 이전 카드가 남을 경우 이전 결과라는 표시를 유지하며 미등록 메시지와 함께 표시하지 않는다.

일반 검색에는 현재 출처·카테고리·브랜드·가격 상태의 활성 조건을 결과 근처에 표시한다. `필터 해제`는 이 네 축만 초기화하고 q와 sort를 유지하며 저장된 필터도 갱신한다. 기존 `초기화`는 q까지 초기화하는 동작으로 유지한다. 미완료/실패 결과 건수는 `—`로 표시한다. 정상 0건은 `현재 조건에 맞는 상품이 없습니다`로 표시하고, 활성 필터가 있을 때만 필터 해제를 제공한다. 다른 미확인 범위에도 상품이 없다고 단정하지 않는다.

하락/최저가 필터에서는 `하락·최저가 필터는 직접 확인된 가격을 기준으로 합니다` 안내를 표시한다. 기존 가격 판정은 수정하지 않는다.

입력 중 debounce는 180ms다. compositionstart에서 대기 timer를 취소하고 조합 중 input은 검색하지 않는다. compositionend 후 최종 문자열로 180ms debounce를 예약한다. 뒤따르는 input이 timer를 재예약하더라도 최종 검색은 한 번이다. 필터 해제는 timer를 취소하고 입력창의 최신 문자열을 q에 반영한다. 전체 초기화는 조합 상태와 timer도 초기화한다.

## 수용 기준

고정 fixture는 `2156295`, 브랜드 `키뮤어`, 별칭 `kimuir`, 상품명 `[Drape Wool] 캐시미어블렌드 세미오버핏 발마칸 코트_블랙`, 아우터, ESTIMATED 가격을 가진다.

- `키뮤어 캐시미어`, 역순, `캐시미어 블렌드`, `발마칸 코트 블랙`, 전각 Drape, `kimuir`로 해당 상품을 찾는다.
- `키뮤어 존재하지않는단어`는 일치하지 않고 브랜드 ab/상품명 cd가 token bc와 일치하지 않는다.
- 숫자, musinsa 접두어, 긴 추적 URL은 같은 key를 반환한다. 4910 접두어는 출처를 구분한다.
- 입력 해석, model·index·카드·Worker·file:// 결과가 일치하고 별칭 없는 이전 row도 읽힌다.
- 인덱스를 차단해도 scoped 직접 조회가 성공한다. route/card 실패는 미등록과 구분되고 재시도할 수 있다.
- 저장된 하락 필터가 있어도 직접 조회는 표시되고, 일반 검색으로 복귀하면 해당 필터가 유지된다.
- 입력·범위·조회 모드를 빠르게 전환해도 오래된 성공/오류가 최신 결과를 덮지 않는다.
- 필터 해제는 검색어·정렬을 보존하고, IME 조합 중에는 검색을 실행하지 않는다.
- 기존 집계·정렬·페이징·상세 이력·브랜드 선택 회귀 검증이 통과한다.

## 승인 경계

이 파일과 구현 계획의 작성만 현재 요청에 포함된다. 구현, 커밋, push, 실제 수집, 데이터 재생성, 배포는 현재 턴에서 수행하지 않는다. 구현 시작은 계획 검토와 실행 방식 선택 이후다.
