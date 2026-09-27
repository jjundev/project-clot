---
name: ask-uniqlo
description: >
  MUST USE when the user wants to search UNIQLO Korea (유니클로, uniqlo.com/kr) products or check a
  UNIQLO product's price, discount, online stock by color/size, size chart (실측), material, care, or reviews —
  e.g. "유니클로 후리스 찾아줘", "유니클로 X 가격/할인 얼마야", "이 유니클로 상품 M 재고 있어?",
  "유니클로 X 실측 알려줘", "유니클로 X 리뷰 어때?", "/ask-uniqlo <키워드>".
  Only UNIQLO KR official data (GU excluded unless asked). Not for Musinsa (use the project's clot/opencli tools).
---

# ask-uniqlo — 유니클로 KR 상품 검색·상세 조회

유니클로 KR 공식 API를 HTTPS로 직접 호출하는 CLI(`scripts/uq.mjs`)로 상품 검색, 가격·할인, 컬러×사이즈 온라인 재고, 실측 사이즈표, 소재·세탁 정보, 리뷰를 가져와 비교표로 보고합니다.

## 원칙

1. **공식 데이터만**: 유니클로 KR API 결과만 사용합니다. 결과에 없는 정보(매장 재고, 다른 쇼핑몰 가격, 추측한 실측)는 만들지 않습니다.
2. **조회 시점 명시**: 가격·재고는 조회 시점 값입니다. 보고서에 조회 시각을 적습니다.
3. **온라인 재고만**: 매장 재고는 지원하지 않습니다. 물어보면 온라인 재고만 확인 가능하다고 답합니다.
4. **GU 제외가 기본**: 사용자가 GU를 원할 때만 `--include-gu`를 붙입니다.

## 0. 실행 환경

- 요구 사항: Node.js 18 이상. 브라우저·로그인·npm 설치가 필요 없습니다.
- 아래 `<skill-dir>`는 이 스킬의 Base directory입니다.
- 성공 시 stdout에 JSON, 실패 시 stderr에 `{"error":{"code","message"}}`.

| 종료 코드 | code | 의미 | 대응 |
| :--- | :--- | :--- | :--- |
| 0 | - | 성공 | - |
| 2 | `ARG` | 인자 오류 | 명령을 고쳐 다시 실행 |
| 3 | `EMPTY` | 결과 0건 (필터로 모두 숨겨진 경우 포함) | 메시지의 `--offset` / `--include-gu` 제안을 따르거나 검색어를 완화해 1회 재시도 |
| 4 | `NOT_FOUND` | 상품 없음 | 상품 ID 재확인, search로 다시 찾기 |
| 5 | `BLOCKED` | 403 또는 비정상 응답 | 잠시 후 1회 재시도, 계속되면 사용자에게 알림 |
| 1 | `NETWORK` / `INTERNAL` | 네트워크 오류 / 예기치 못한 오류 | 1회 재시도, 계속되면 메시지 그대로 보고 |

동작 확인: `node --test <skill-dir>/tests/*.test.mjs` (오프라인), `bash <skill-dir>/tests/smoke.sh` (실제 사이트)

## 1. 명령

```bash
# 검색 (여러 단어는 따옴표 없이 써도 됨)
node <skill-dir>/scripts/uq.mjs search <검색어...> [--limit 1-100 (기본 20)] [--offset N]
    [--gender men|women|kids|baby] [--sort recommended|price-asc|price-desc|rating|new]
    [--sale] [--include-gu]

# 상세: 가격(모든 가격 그룹) + 컬러별 재고 + 실측표 + 소재·세탁·원산지
node <skill-dir>/scripts/uq.mjs detail <productId|상품URL> [--pg 00] [--raw]

# 리뷰
node <skill-dir>/scripts/uq.mjs reviews <productId|상품URL> [--limit 1-50 (기본 10)] [--offset N] [--sort new|rating]
```

- `productId`는 `E450195-000`, `450195`, 상품 URL 모두 받습니다.
- `--gender men`은 UNISEX 상품도 포함합니다.
- **priceGroup**: 같은 상품이 `00`(정상가)과 `01` 등(가격 인하) 그룹으로 따로 존재할 수 있습니다. search는 그룹별로 한 줄씩, detail은 존재하는 그룹을 모두 `priceGroups`에 담습니다.
- `discounted: true`는 실제 할인가가 정가보다 낮거나 가격 그룹이 `00`이 아닌 경우입니다. `originalPrice`가 이미 인하된 값일 수 있으니, 할인 폭은 같은 상품의 `00` 그룹 가격과 비교해 설명합니다.
- detail의 `stock`은 컬러마다 `inStock`(재고 있음) / `lowStock`(재고 적음) / `soldOut`(품절) 사이즈 목록입니다. 수량이 필요하면 `--raw`.
- `sizeChart.garment`는 제품 실측, `sizeChart.body`는 권장 신체 치수입니다. 실측이 없는 상품은 `null`.

## 2. 워크플로우

1. **검색**: 사용자의 요청에서 검색어·성별·정렬·할인 여부를 뽑아 `search`를 실행합니다. `EMPTY`면 검색어를 더 일반적인 단어로 바꿔 1회만 재시도합니다(예: "오버핏 후리스 집업" → "후리스").
2. **후보 선정**: 요청에 가장 맞는 상품 1–3개를 고릅니다. 같은 이름이 여러 개면 가격·성별·평점으로 구분해 고릅니다.
3. **상세 조회**: 고른 상품마다 `detail`을 실행합니다.
4. **리뷰 (조건부)**: 사용자가 착용감·사이즈 선택·품질을 물을 때만 `reviews --limit 20`을 실행합니다. 구매 사이즈와 키·몸무게, `fit` 점수(1 작음 ~ 5 큼, 3이 정사이즈)를 사이즈 조언에 사용합니다.
5. **보고서 작성**: 아래 형식을 따릅니다.

사용자가 자기 치수(예: 가슴둘레 100cm, 평소 L)를 말하면 `sizeChart`와 비교해 맞는 사이즈를 제안합니다. 치수를 말하지 않았으면 추측하지 않습니다.

## 3. 보고서 형식

```markdown
## 유니클로 "<검색어>" 조회 결과 (<YYYY-MM-DD HH:mm> 기준)

| 상품 | 가격 | 평점 | 재고 있는 사이즈 | 핵심 실측 (M 기준) |
| :--- | :--- | :--- | :--- | :--- |
| [후리스풀집재킷](URL) E450195-000 | ₩39,900 | ★4.7 (996) | BLACK: S·M·L / NAVY: L | 총장 67.5 · 가슴너비 56 · 소매 82 |
| [상품명](URL) | ~~₩49,900~~ **₩29,900** (가격 인하) | ... | ... | ... |

### <상품명>
- 소재: ...
- 세탁: ... (주의사항 한 줄 요약)
- 원산지 / 제조: CN·VN / 2024. 01
- 참고: <notes 중 중요한 것, 예: "XS·XXL은 온라인 전용">
- 리뷰 요약 (조회한 경우): 핏 경향, 사이즈 조언, 대표 리뷰 1–2개 인용
```

- 재고 칸에는 `inStock`과 `lowStock`만 적고, `lowStock`은 "(적음)"으로 표시합니다. 모두 품절이면 "온라인 품절".
- 실측 칸은 사용자가 말한 사이즈, 없으면 M(또는 FREE) 기준으로 2–3개 부위만 적습니다. 전체 표가 필요하면 상품별 섹션에 표로 추가합니다.
