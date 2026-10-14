# 무신사 쿠폰 API 검증 (0단계 ①)

`getUsableCouponsByGoodsNo`를 **목록 값만**(`goodsNo, brand, comId=brand, salePrice=price`) 넣어 부른 결과가,
**상품 페이지 값**(`brand, comId, specialtyCodes`, 상품 페이지의 `salePrice`)을 넣어 부른 결과와 같은지 확인한다.
재현: `node scripts/musinsa-coupon-verify.js dump` → `logs/musinsa-coupon-verify.json` (gitignored). 실행일 2026-10-14.

## 1. 동등성 결과

표본: 대분류 5개(001, 002, 003, 103, 004) × `brand|cat` 키 6개 × 상품 3개(가격 최고·중앙·최저) = 90개. REVIEW 정렬 1–3페이지에서 상품 3개 이상인 키 중 상품 수가 많은 순.

```
동등: 90/90 (쿠폰 id 집합과 각 쿠폰 할인액이 같은 상품)   // 100%
```

- 같음의 기준: `couponNo` 집합과 `couponNo`별 `salePrice`(이 상품 할인액)가 같다. 90개 모두 같았다.
- 쿠폰이 하나도 없는 상품이 21개 있었고, 이것도 두 호출이 모두 빈 목록으로 같았다(동등에 포함).
- 상품 페이지의 `salePrice`는 90개 모두 목록 `price`와 같았다.
- `comId`가 `brand`와 다른 상품이 27개, `specialtyCodes`가 있는 상품이 25개(예: `outlet`)였지만 결과는 같았다.
  → 이 표본에서는 `comId`·`specialtyCodes`가 쿠폰 목록에 영향을 주지 않았다.

### 다른 경우: 발급 사본 수

`couponNo` 집합은 같지만 **같은 쿠폰의 발급 사본(`idx`) 개수**가 다른 상품이 1개 있었다(90개 중 1개).

| 상품번호 | brand | 목록 값 호출 | 상품 값 호출 (`comId=wordscorporation`) |
|---|---|---|---|
| 2442409 | `yale` (001) | 쿠폰 6개, `356009`(10월 이달의 예일 10% 쿠폰) 1장 | 쿠폰 8개, `356009`가 3장(`idx` 3개, `sameCouponCount: 3`) |

- 할인액(`salePrice` 2990)과 `couponNo` 집합은 같다. 사본 수만 달라 "쿠폰 id 집합 + 할인액" 기준으로는 동등이다.
- 사본 수까지 같게 보면 89/90. 같은 쿠폰을 여러 장 가진 경우에만 `comId`가 영향을 줬을 가능성이 있다(원인은 미확정, 표본 1건).
- 목록 값 호출·상품 값 호출 모두 한 응답 안에 같은 `couponNo`가 여러 번 나오는 경우가 있다(27개 목록). **`couponNo`로 중복 제거 후 최대 할인액만 쓰면 된다.**

**결론: 관문 A 통과(100% ≥ 95%).** 상품 페이지를 읽지 않고 목록 값만으로 쿠폰 API를 불러도 된다.

## 2. 쿠폰 원시 필드

응답 위치: `data.list[]`. 덤프의 쿠폰 원시 객체 1개(`goods[0].fullParamsCoupons[0]`, `salePrice`는 그 상품 가격 기준):

```json
{
  "idx": "14315060569",
  "couponNo": 359200,
  "couponName": "무탠다드 깜짝 15% 쿠폰",
  "couponUseType": "",
  "couponKind": "%",
  "couponValue": "15",
  "couponAmountKind": "P",
  "salePrice": 10480,
  "couponApply": "SB",
  "companyRate": "0",
  "pubCnt": -1,
  "pubDupYn": "N",
  "couponPubCnt": 215937,
  "useFromDate": "2026-10-12T00:00:00+09:00",
  "useToDate": "2026-10-15T23:59:59+09:00",
  "maxLimitAmount": 40000,
  "maxLimitQty": 0,
  "sameCouponCount": 1,
  "lowPrice": 1000,
  "label": [],
  "bestSalePriceYn": "Y",
  "downloadYn": "Y",
  "issuedYn": "N",
  "showMaxCouponDiscount": true,
  "couponChannel": "ONLINE"
}
```

| 의미 | 필드 | 타입 | 비고 |
|---|---|---|---|
| 쿠폰 id | `couponNo` | number | 쿠폰 종류 id. 같은 쿠폰을 여러 장 가지면 응답에 여러 번 나온다. |
| 발급 사본 id | `idx` | string | 사본마다 다르다. 일부 쿠폰(`couponApply: "CP"`)은 빈 문자열(미발급). 키로 쓰지 말 것. |
| 이름 | `couponName` | string | 예: `무탠다드 깜짝 15% 쿠폰`, `10월 무신사 회원 정기 쿠폰 실버 등급` |
| 율(%) | `couponValue` | string | 숫자 문자열(`"15"`). `couponKind`가 `"%"`일 때 의미. |
| 정액 | (없음) | | 표본 437건 모두 `couponKind: "%"`, `couponAmountKind: "P"`. 정액 쿠폰은 관찰되지 않았다. |
| 최대 할인 | `maxLimitAmount` | number | 할인액 상한. **`0`이면 상한 없음**(SG 쿠폰 등). |
| 최소 구매액 | `lowPrice` | number | 이 값 미만 상품은 응답에서 이미 빠진다(표본 437건 중 `price < lowPrice` 0건). |
| 이 상품 할인액 | `salePrice` | number | 상품 가격 기준으로 서버가 계산한 값. `min(floor10(price × couponValue/100), maxLimitAmount)`, 상한 0은 무제한. 표본 437건 모두 이 식과 일치. 기존 코드(`src/myprice.js`)도 이 필드를 쓴다. |
| 적용 범위 | `couponApply` | string | 관찰값 `AG`(전체 317), `SB`(브랜드 76), `SG`(43), `CP`(1). |
| 최고 할인 표시 | `bestSalePriceYn` | `"Y"`/`"N"` | 상품별 최대 할인 쿠폰에 `Y`(쿠폰이 있는 69개 상품 모두 최대 `salePrice` 쿠폰이 `Y`). |
| 사용 기간 | `useFromDate`, `useToDate` | ISO 문자열(+09:00) | |
| 보유 수 | `sameCouponCount` | number | 같은 `couponNo`를 가진 장수. |
| 그 외 | `couponUseType`, `couponAmountKind`, `companyRate`, `pubCnt`, `pubDupYn`, `couponPubCnt`, `maxLimitQty`, `label`, `downloadYn`, `issuedYn`, `showMaxCouponDiscount`, `couponChannel` | | 이번 검증에서 쓰지 않음. |

원시 필드 전체(25개): `idx, couponNo, couponName, couponUseType, couponKind, couponValue, couponAmountKind, salePrice, couponApply, companyRate, pubCnt, pubDupYn, couponPubCnt, useFromDate, useToDate, maxLimitAmount, maxLimitQty, sameCouponCount, lowPrice, label, bestSalePriceYn, downloadYn, issuedYn, showMaxCouponDiscount, couponChannel`.

`parseCoupon`은 `couponNo`, `couponName`, `couponValue`(→ 숫자), `maxLimitAmount`, `lowPrice`, `salePrice`를 읽고 `couponNo`로 중복 제거하면 된다.

## 3. 계산식 재현과 키 단위 일치율 (0단계 ②)

재현: `node scripts/musinsa-coupon-verify.js evaluate` (오프라인, §1의 덤프를 읽는다). 코드: `src/musinsaWide/coupons.js`.
같은 덤프(30개 키 × 높음·중간·낮음 3개 = 90개 상품)를 쓴다. 쿠폰은 모두 `listingParamsCoupons`(목록 값 호출)이고 `couponNo`로 중복 제거한다.

```
식 재현: 435/435 (100.0%)
키 예측: 17/27 (숨김 3) (63.0%), 숨김 3/30 (10.0%)
```

### 식 재현

- 모든 상품 × 그 상품의 쿠폰 435건에서 `couponDiscountMusinsa(salePrice, parseCoupon(raw))`가 서버가 준 `salePrice`(이 상품 할인액)와 같았다.
- 식: 가격이 `lowPrice` 미만이면 0, 정률은 `floor10(가격 × 율/100)`, 그다음 `maxLimitAmount`(0이면 무제한)로 자른다.
- 정액 쿠폰은 관찰되지 않아 PRICE 경로는 이 데이터로 검증되지 않았다(단위 테스트만).

### 키 예측

키마다 높음·낮음 상품의 쿠폰으로 `keyCouponSet`을 만들고, 중간 상품의 최대 할인액을 예측해 중간 상품 쿠폰 목록의 최대 `salePrice`와 비교했다.
높음·낮음 사이에서 모순이 나 쿠폰 집합을 못 만든 키는 숨김(3개)으로 세고 분모에서 뺐다.

**관문 B: 실패.** 식 재현 100%(≥95% 통과), 숨김 키 10%(≤20% 통과), **키 예측 63.0%(<90% 실패)**.

어긋난 10건과 원인:

| 키 | 중간 상품 | 예측 | 실제 | 원인 |
|---|---|---|---|---|
| musinsastandard\|001 | 854339 (27,990) | 4190 | 0 | 중간 상품의 쿠폰이 **하나도 없음**(전체 쿠폰 제외 상품). 높음에 있던 브랜드 15% 쿠폰을 예측해 틀림 |
| suare\|001 | 2723763 (27,640) | 1650 | 1380 | 낮음 상품이 쿠폰 0개(제외 상품)라 높음의 브랜드 6% 쿠폰을 "최소금액 22,401"로 읽었다. 중간 상품에는 그 쿠폰이 없음 |
| musinsastandardwoman\|001 | 1417715 (14,290) | 2140 | 2850 | 중간 상품에만 있는 `SG` 20% 쿠폰(상품 묶음 한정)을 높음·낮음에서 못 봄 |
| musinsastandard\|003 | 1669806 (44,890) | 6730 | 8970 | 위와 같음: 중간 상품에만 `SG` 20% 쿠폰 |
| xero\|003 | 1551839 (35,100) | 3510 | 1750 | 높음·낮음 둘 다 가진 브랜드 10% 쿠폰(`SB`)이 중간 상품에는 없음(상품 단위 제외) |
| brenson\|003 | 1844581 (23,900) | 1430 | 0 | 중간·낮음 상품 모두 쿠폰 0개. 높음의 브랜드 6% 쿠폰이 최소금액으로 읽혀 중간에 적용된다고 예측 |
| vans\|103 | 102619 (54,990) | 0 | 10990 | 높음·낮음 상품이 쿠폰 0개(제외 상품). 중간 상품에만 `CP` 20% 쿠폰(상품 한정)과 회원 쿠폰이 있음 |
| converse\|103 | 389453 (75,000) | 3750 | 0 | 중간·낮음 상품 쿠폰 0개, 높음만 회원·깜짝 쿠폰 있음 |
| drmartens\|103 | 595039 (229,000) | 11450 | 0 | 위와 같음 |
| masmarulez\|004 | 2320960 (47,000) | 9400 | 4700 | 높음에만 있는 `SG` 20% 쿠폰을 중간에도 적용된다고 예측. 중간 상품에는 `SG` 10%만 있음 |

원인 분류:

1. **쿠폰이 0개인 상품**(90개 중 21개, 30개 키 중 11개에 1개 이상): 회원 정기 쿠폰(`AG`)까지 없는 상품이 있어 "상품 단위 쿠폰 제외"로 보인다. 이런 상품이 표본이면 최소금액 추론이 틀리고, 중간 상품이면 예측이 0과 어긋난다. (6건)
2. **`SG`·`CP` 쿠폰(상품 묶음·상품 한정)**: 같은 브랜드 안에서도 상품마다 다르다. 높음·낮음 표본에 없거나 있어도 중간에 적용되지 않는다. (4건: 위 표에서 3, 4, 7, 10번째 행. 7번째 행은 1번 원인과 겹친다)
3. 브랜드 쿠폰(`SB`)도 상품 단위로 빠지는 경우가 있다(xero 1건).

참고(코드는 바꾸지 않았다. 설계 변경은 이 보고서의 몫이 아님): 같은 덤프에서 가정만 바꿔 다시 세어 본 값.

| 가정 | 키 예측 | 숨김 |
|---|---|---|
| 현재 (모든 쿠폰) | 17/27 (63%) | 3 |
| 중간 상품이 쿠폰 0개인 키 제외 | 14/20 (70%) | 3 |
| `AG`·`SB` 쿠폰만 사용 | 22/29 (76%) | 1 |
| `AG`·`SB`만 + 중간 상품 쿠폰 0개 제외 | 19/22 (86%) | 1 |

어느 가정도 90%에 이르지 못한다. 표본이 작아(키 27–30개) 수치의 오차가 크다.

**결론: 관문 B 미통과. 키 단위 쿠폰 집합 예측(높음·낮음 2개 표본)은 이 설계로 90%를 못 넘는다. Task 3으로 가지 않고 사용자에게 보고한다.**
