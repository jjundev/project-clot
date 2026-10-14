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
