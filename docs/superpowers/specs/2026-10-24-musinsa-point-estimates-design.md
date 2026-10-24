# 무신사 일반 상품의 적립금 사용 예상가 설계

## 의도와 결정 상태

2026-10-24 이 채팅의 grill-yourself 설계를 구현 근거로 보존한다. 일반 상품의 적립금 사용 제한 정보를 익명 JSON API로 수집하고 쿠폰가와 별도로 최대 사용 예상가를 제공한다. writing-plans 요청으로 미응답 선택 #6~#8은 **[confirmed by default]**다.

- #0 B: 제한 정보 캐시와 별도 수집 작업을 사용한다.
- #6 적립금만 먼저 구현한다. 등급 할인은 포함하지 않는다.
- #7 기존 쿠폰가를 주 가격·정렬·차트·알림 기준으로 유지하고 예상가를 병기한다.
- #8 일부 상품부터 점진 지원한다. 캐시는 7일 미만 유효, 최초 검증 한도는 1,000회, 검증 후 설정으로 최대 5,000회/일까지 확대한다.

분류는 architectural이다. 수집, 캐시, 가격 이력, 표시가 하나의 기능 계약을 구성한다. 독립적인 등급 할인·검색 개선·전체 상품 처리량 확대는 이 설계에 포함하지 않는다. 설계/계획 작성은 구현·커밋·원격 실행·배포 권한이 아니다.

## 전역 제약

- Node.js 24, ESM, node:sqlite, 내장 fetch, 기존 node:test·Playwright를 사용하고 새 의존성은 추가하지 않는다.
- 이번에는 적립금 사용만 추가한다. 등급 할인·카드 할인·적립 예정 포인트 선할인은 제외한다.
- 개인 보유 적립금 잔액을 조회하지 않는다. 예상가는 필요한 적립금 전액 보유를 가정한다.
- 쿠폰가를 주 가격·정렬·차트·알림·역대 최저 판정 기준으로 유지한다.
- 과거 쿠폰가를 오늘의 제한 조건으로 재계산하지 않는다.
- 제한 여부 미확인·필드 누락·만료를 사용 가능으로 간주하지 않는다.
- 동시 요청은 1개, 요청 시작 간 최소 간격은 1,000ms, 요청 timeout은 최대 15,000ms다.
- 일일 요청 시도 한도는 기본 1,000회, 명시적 설정 상한은 5,000회, 네트워크 실행 예산은 85분이다.
- 성공·실패·재시도 모두 한도를 소비하며 같은 날 재실행해도 초기화하지 않는다.
- 429는 즉시 수집을 중단한다. 접근 거절을 우회하지 않는다.
- 캐시 유효기간은 확인 후 604,800,000ms 미만이며 현재 판매가·추가 할인액이 확인 당시 값과 같아야 한다.
- 새 workflow는 clot-daily 그룹을 사용하고 잠금 획득 후 최신 DB를 받아야 한다.
- 기존 DB·쿠폰 이력·scan_runs를 재작성하지 않고 새 테이블과 이름공간이 있는 meta 키만 추가한다.
- CLOT_MUSINSA_POINTS_ENABLED=1일 때만 활성화하고 그 외에는 새 수집·계산·표시를 비활성화한다.
- 쿠키·회원 API·텔레그램 발송을 새 수집 작업에서 사용하지 않는다.
- 테스트는 임시 DB와 주입한 fetch·시계·sleep만 사용하며 운영 DB와 원격 서비스에 쓰지 않는다.

## 현재 구조와 조사 근거

- `src/musinsaWide/coupons.js:73`: 판매가 − 추가 할인 − 최대 쿠폰 할인.
- `src/musinsaWide/track.js:20`: 목록 45분, 전체 165분 네트워크 예산.
- `src/musinsaWide/store.js:271`: 쿠폰 가격·출처의 변경분 이력.
- `src/dashboard-musinsa.js:109`: 쿠폰가를 공통 가격 이력 L로 변환.
- `src/dashboard-model.js:15`: L의 가격으로 할인율·최저가·정렬 값을 계산.
- `src/dashboard-index.js:4`: 위치 기반 v2 검색 인덱스 필드.
- `.github/workflows/musinsa-wide.yml:17`: clot-daily 직렬 실행과 Release pull/scan/push.
- `.github/workflows/pages.yml:18,63`: 지정 workflow 완료 후 최신 Release DB로 정적 사이트 빌드.

익명 GET `https://goods-detail.musinsa.com/api2/goods/{goodsNo}`는 공식 상품 페이지 JS가 사용하는 경로다. 이 채팅에서 14개 표본 모두 명시적 제한 여부를 받았고, 4개의 HTML 내 Detail 데이터와 다섯 조건 필드가 일치했다. 지속 처리량·서버 허용 속도·일괄 조회 API는 검증하지 않았다. 임시 조사 파일이 없어도 구현할 수 있도록 아래 고정 사례를 fixture로 작성한다.

| 상품 | isRestictedUsePoint | maxUsePointRate | isLimitedDc | isOutlet |
|---|---|---|---|---|
| 2156295 키뮤어 코트 | false | 0.07 | true | false |
| 595039 닥터마틴 | false | 0.07 | false | false |
| 3982118 어반에이지 | true | 0.07 | true | true |
| 1108007 무신사 스탠다드 | true | 0.07 | false | false |

## API 및 계산 계약

`point-policy.js`의 공개 계약은 다음과 같다. 모든 시간 인자는 epoch milliseconds이며 저장 시 ISO UTC 문자열로 바꾼다.

```ts
type PointPolicy = {
  goodsNo: number; restricted: boolean; maxUseRate: number;
  observedSalePrice: number; observedExtraDiscount: number; checkedAt: string;
};
type PointState = 'ELIGIBLE' | 'RESTRICTED' | 'UNKNOWN' | 'STALE'
  | 'POLICY_BASE_MISMATCH' | 'COUPON_UNAVAILABLE' | 'OUT_OF_SCOPE';
type CouponBasis = {
  goodsNo: number; status: string; salePrice: number; extraDiscount: number;
  couponPrice: number | null; couponSource: 'DIRECT' | 'ESTIMATED' | null;
};
type PointEstimate = {
  state: PointState; price: number | null; discount: number | null;
  checkedAt: string | null; maxUseRate: number | null;
};
parsePointPolicy(body: unknown, goodsNo: number, checkedAtMs: number): PointPolicy;
fetchPointPolicy(goodsNo: number, options?: {
  fetchFn?: typeof fetch; now?: () => number; timeoutMs?: number;
}): Promise<PointPolicy>;
evaluatePointEstimate(input: {
  basis: CouponBasis; policy: PointPolicy | null; asOfMs: number; couponFresh: boolean;
}): PointEstimate;
```

`parsePointPolicy`는 meta.result=SUCCESS, data.goodsNo 일치, boolean 제한 값, 유한한 0~1 사용률, 0 이상 안전 정수 가격, 명시적인 추가 할인액을 요구한다. 오타 필드 `isRestictedUsePoint`와 수정 철자 `isRestrictedUsePoint`를 허용하되 둘이 상충하면 SCHEMA_CHANGED다. false·0을 누락으로 오인하지 않는다. 상품번호·시각도 검증한다. `fetchPointPolicy`는 Cookie를 보내지 않고 고정 호스트·숫자 상품번호 URL만 구성하며 자동 재시도하지 않는다. HTTP 오류는 status, timeout/네트워크는 code를 노출하고 원문 본문은 오류 메시지에 넣지 않는다.

판정 순서는 OUT_OF_SCOPE → COUPON_UNAVAILABLE → UNKNOWN → STALE → POLICY_BASE_MISMATCH → RESTRICTED/ELIGIBLE이다. 미래 checkedAt도 STALE로 처리한다. 허용 상품은 `discount = 10 * floor(couponPrice * maxUseRate / 10)`, `price = couponPrice - discount`다. 제한 상품은 discount=0, price=couponPrice다. 나머지는 금액 null이다. 0원 쿠폰가도 유효하다. 등급 할인을 기본 적용하는 `estimateMemberPrice`를 그대로 호출하지 않는다.

## 저장·순환 계약

새 `PointPolicyStore(db, {initialize=false})`가 기존 store.db를 공유한다. initialize=true는 writer만 사용한다. read-only 빌드는 sqlite_master로 존재를 확인하고 테이블이 없으면 빈 정보로 처리한다.

- `goods_point_policy`: goods_no PK, restricted(nullable INTEGER CHECK 0/1), max_use_rate, observed_sale_price, observed_extra_discount, checked_at, last_attempt_at, next_retry_at, last_error_code, rotation_attempt_at. 정책 필드는 성공 시에만 교체하며 실패는 기존 checked_at을 갱신하지 않는다.
- `point_price_changes`: (goods_no,date) PK, state, sale_price, extra_discount, coupon_price, coupon_source, point_discount, point_price, policy_checked_at, max_use_rate, policy_version='points-max-use-v1'. 기본 가격과 상태까지 스냅샷으로 보존한다.
- 기존 meta의 `point_budget:<Asia/Seoul YYYY-MM-DD>`에 attempts를, `point_pacing:last`에 nextStartAtMs를, `point_run:last`에 실행 결과를 저장한다. 예약·집계는 트랜잭션으로 처리한다. KST 자정에 새 날짜의 quota를 쓰되 호출 간격은 날짜를 넘어도 유지한다.
- 날짜별 가격 이력 키는 기존 scan_runs와 같은 UTC YYYY-MM-DD를 유지한다. 새 작업은 scan_runs를 쓰지 않는다. 사용자에게 확인 시각을 표시할 때는 Asia/Seoul로 변환한다.
- 후보는 ACTIVE·미품절·유효 판매가 상품이다. 가격/추가 할인이 불일치하거나 미조회이면 urgent, 7일 이상 경과했거나 미조회이면 rotation 후보다. 한 실행에서 상품은 한 번만 선택하되 내부 재시도는 별도 시도로 센다.
- urgent/rotation에 시도 예산을 절반씩 배정한다(홀수는 urgent에 1회 추가). 재시도도 해당 lane 몫을 쓴다. 중복 후보 제외 후 lane이 비면 잔여 예산을 다른 lane이 사용한다.
- urgent는 마지막 시도 시각, 최초 발견일, goods_no 순; rotation은 rotation_attempt_at NULL 우선 후 오래된 순, 최초 발견일, goods_no 순으로 고른다. 실패도 rotation_attempt_at을 기록해 실패 상품에 순환 몫이 잠기지 않게 한다. next_retry_at까지는 제외한다.
- 가격 이력은 직전 날짜 이전의 금액/기준/상태/정책 버전과 다를 때만 기록한다. checkedAt만 달라졌으면 새 행을 만들지 않는다. 당일 재실행은 당일 행을 upsert하고 이전 상태로 돌아오면 당일 변경 행을 지운다. 첫 UNKNOWN은 생략하고, 이전에 계산된 상품이 미확인이 되면 금액 null 전환 행을 기록한다.

`PointPolicyStore` 메서드: `hasTables():boolean`, `getPolicy(goodsNo):PointPolicy|null`, `iteratePolicies():Iterable<PointPolicy>`, `pickCandidates({lane,limit,asOfMs,excludeGoodsNos}):CouponBasis[]`, `reserveAttempt({goodsNo,lane,atMs,dailyCap}):boolean`, `savePolicy(policy):void`, `saveFailure({goodsNo,atMs,code}):void`, `getAttempts(quotaDate):number`, `getNextStartAtMs():number`, `recordPrices({date,rows}):{written:number}`, `iterateLatestPrices():Iterable<PointPriceRow>`, `recordRun(result):void`. PointPriceRow은 위 가격 이력 열의 camelCase 매핑과 goodsNo/date를 갖는다. DB를 닫거나 Release를 조작하지 않는다.

## 수집 실행 계약

`collectPointPolicies({store,fetchPolicy,now,sleep,dailyCap=1000,budgetMs=5100000})`는 동시성 1로 실행한다. 반환값은 `{quotaDate,attempted,succeeded,failed,stop}`이며 stop은 complete/quota/deadline/rate_limited/blocked/error다. attempted는 이번 실행 시도 수, 한도는 영속 일일 합계다. quotaDate는 마지막 시도 시점의 KST 날짜(시도가 없으면 시작 날짜)이며 자정 이전·이후의 실제 집계는 각각의 meta 키에 보존한다.

매 시도 직전 남은 시간·간격·일일/lane 예산을 확인하고 예약을 먼저 저장한다. timeoutMs는 min(15000, 남은 예산)이다. 네트워크/timeout/5xx만 상품당 최대 3회(초기+재시도 2회), backoff 1000/2000ms로 재시도한다. 429 및 401/403은 즉시 전체 중단, 스키마 오류도 전체 중단한다. 기타 4xx는 상품 실패로 남기고 다음 후보를 진행한다. 최종 실패 next_retry_at은 실패 시점+1시간이며, 성공은 즉시 저장하고 실패 대기를 해제한다. 각 시도는 rotation 우선순위를 갱신한다.

수집이 quota/deadline/429 등으로 일부만 완료돼도 유효 결과와 중단 이유를 보존한다. 자동으로 동시성·속도·한도를 올리지 않는다. 하루 5,000회·캐시 7일의 이론적 유효 범위 상한은 35,000개이며 전 상품 지원으로 보고하지 않는다.

## 가격 계산과 신선도

`refreshPointEstimates({db,asOfMs,enabled}):{written,counts}`는 네트워크 없이 계산한다. 최신 scan_runs가 현재 UTC 날짜이고 기존 verifyDailyCoverage를 통과한 경우만 couponFresh=true다. 이 gate는 오래된 coupon_price가 남아 있는 실패/보류 날짜에 새 예상가를 붙이는 것을 막는다. DIRECT와 ESTIMATED 모두 기준으로 쓸 수 있지만 파생 예상가를 DIRECT로 승격하지 않는다.

`readPointEstimateViews({db,asOfMs,enabled}):{byGoods:Map<number,PointEstimate>,counts}`는 마지막 저장 예상가와 현재 정책·기준 가격을 읽기 전용으로 검증한다. counts는 `{active,eligible,restricted,unknown}`이다. 비활성화·테이블 미존재 시 Map은 비어 있고 전체 ACTIVE를 unknown으로 센다. 유효 이력이 없는 상품의 예상가를 빌드 중 새로 계산해 만들지 않는다. 정책·이력·상품 읽기는 bulk/streaming으로 처리하고 상품마다 테이블 확인이나 개별 SELECT를 반복하지 않는다.

별도 collector 종료 후와 기존 trackMusinsa의 recordScanRun 다음에 호출한다. 새 기능 실패는 기존 스캔/쿠폰 결과와 알림을 실패로 만들지 않는다. enabled=false면 no-op이다. 새 테이블 초기화는 collector에서만 하며 기존 스캔은 테이블 존재 시 계산만 한다. 대상은 현재 정책 또는 과거 point_price_changes가 있는 상품으로 한정해 첫날 30만 UNKNOWN 행을 만들지 않는다.

## 표시·호환·복구

- `pointEstimate`, `pointDiscount`, `pointState`, `pointCheckedAt`, `pointMaxUseRate`를 별도 선택 필드로 전달한다. 위치 기반 index 필드는 뒤에 추가하고 기존 v2 앞부분과 revision 검증은 보존한다. 구형 행의 누락값은 null이다.
- 기존 L 배열의 값·날짜 집합은 바꾸지 않는다. 적립금 수집만 일어난 날짜를 L에 추가하면 현재 dropAmt가 달라질 수 있다. 적립금 변동 이력은 별도 테이블에 저장하고 이번 UI는 현재 예상가·차감액·조건 시각을 표시한다. 별도 적립금 차트/전체 이력 UI는 후속 범위다.
- buildMusinsaCatalog는 initialize하지 않는 read-only adapter로 마지막 계산 행을 읽고, 현재 기준 가격 일치·캐시 나이·쿠폰 신선도를 재검사한다. 빌드가 지나간 날짜의 가격을 새로 만들지 않는다.
- 정확한 문구: ELIGIBLE는 `적립금 최대 사용 예상가`와 `적립금 {차감액}원 이상 보유 가정 · 등급·카드 할인 제외`, RESTRICTED는 `적립금 사용 불가`, 그 외는 `적립금 사용 조건 미확인`. 확인 시각이 있으면 KST 시각을 덧붙인다. 잔액 충분 가정은 금액 옆에 보인다.
- metadata.points는 enabled, active, eligible, restricted, unknown, attemptedToday, lastStop을 내보낸다. eligible+restricted+unknown=active이며 보유 기록 수와 유효 확보 수를 혼동하지 않는다.
- enabled=false면 추가 문구와 값은 숨긴다. 구형 DB/캐시 없는 상품도 기존 가격을 정상 표시한다. 4910·찜 상품의 가격 의미는 바꾸지 않는다.
- 새 workflow `Musinsa point policies`는 main의 `Musinsa wide scan` 성공 workflow_run 또는 수동 실행으로만 시작한다. 100분 timeout, 동일 clot-daily 잠금, 최신 Release pull → 수집·계산 → checkpoint/검증 → push → 부분 완료 상태 보고 순이다. pull 실패/prev fallback은 수집·push를 막는다.
- 이 순서를 테스트할 수 있게 `point-cli.js`의 `runPointPolicyJob({dbPath,pullFn,stepFn,checkFn,pushFn,flags,enabled,log})`로 조정하고 `scripts/run-musinsa-points.js`는 얇은 실행 진입점으로 둔다. 반환값은 `{ok,published,skipped?,result?,error?}`다. enabled=false는 pull도 하지 않고 skipped=true를 반환한다. pushFn은 기존 fresh-DB 거부 규칙을 해제하지 않는다.
- 구조적 DB 오류면 업로드하지 않는다. quota/429/deadline/개별 상품 실패는 부분 결과를 검증 후 업로드하고 summary에 상태를 남긴다. 실제 push가 실패하면 workflow는 실패한다. Pages는 새 workflow 성공 완료도 구독한다.
- 전용 collector는 scan_runs를 변경하지 않으므로 기존 latest 스냅샷 검증 의미를 유지한다. DB 합병이나 새 Release 체계는 만들지 않는다. 새 테이블은 기존 코드가 무시할 수 있어 변수 비활성화와 이전 코드로 복구할 수 있다.

## 완료 조건

4개 고정 사례와 미확인/만료/가격 불일치/필드 변경/0원/0%/KST 자정/429/부분 완료/재실행/구형 DB를 자동 검증한다. 임시 fixture DB에서 기존 가격·쿠폰 이력과 새 이력을 대조하고 HTTP Worker·file:// 양쪽 UI를 확인한다. 30만 ACTIVE 합성 자료에서도 후보 선택과 build가 무제한 N+1 SQL/원격 호출을 만들지 않는지 확인한다. 운영 파일·다른 채팅의 검색 계획은 수정하지 않는다. 구현 후 실제 1,000회 파일럿/Release 업로드/변수 활성화는 별도 사용자 지시 후 수행한다.
