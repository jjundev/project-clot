---
name: ask-musinsa
description: 무신사 상품 검색·비교, 상세 정보·이미지·후기, 사이즈·재고·할인 및 내 주문·찜 내역을 읽을 때 사용한다. 구매나 계정 변경은 하지 않는다.
---

# ask-musinsa

무신사 질문을 읽기 전용으로 해결한다. 공개 상품 조회는 스킬에 포함된 HTTPS 실행기를 사용한다. Node.js 22 이상이 필요하며 추가 npm 패키지는 필요 없다. `SKILL_DIR`은 이 SKILL.md가 있는 디렉터리의 절대 경로로 치환한다(발견용 심볼릭 링크 경로도 사용 가능).

먼저 `node "<SKILL_DIR>/scripts/musinsa.mjs" --help`로 공개 명령을 확인한다. 계정 조회는 실행할 명령의 `opencli musinsa <명령> --help -f yaml`을 확인한다. JSON 결과를 우선 읽고 상세 이미지·후기 본문이 필요할 때 브라우저 판독으로 확장한다. 옵션·결과·오류 해석이 필요하면 [HTTPS 명령 안내](references/https-commands.md)를 읽는다.

## 요청별 명령

| 요청 | 명령 |
|---|---|
| 검색어로 상품 찾기, 치수·사이즈 필터 | `node "<SKILL_DIR>/scripts/musinsa.mjs" search <query>` |
| 추천 목록 | `node "<SKILL_DIR>/scripts/musinsa.mjs" recommend` |
| 특정 상품의 가격·브랜드·요약 상세 | `node "<SKILL_DIR>/scripts/musinsa.mjs" product <goodsNo-or-url>` |
| 옵션·사이즈 재고·배송 일정 | `node "<SKILL_DIR>/scripts/musinsa.mjs" options <goodsNo-or-url>` |
| 내 회원 할인가 | `opencli musinsa my-prices <goodsNo> -f json` |
| 내 과거 구매 상품의 실측과 검색 필터 | `opencli musinsa mysize -f json` |
| 내 주문·구매 내역 | `opencli musinsa orders -f json` |
| 내 찜 상품·브랜드·스냅 | `opencli musinsa likes -f json` |
| 내 로그인 상태·회원 정보 | `opencli musinsa whoami -f json` |
| 사용자가 직접 로그인할 페이지 열기 | `opencli musinsa login` |

필요한 명령만 실행한다. 계정 관련 명령은 사용자 자신의 기록을 묻는 경우에만 사용한다. 로그인이 필요하면 로그인 페이지를 안내하고 사용자의 로그인을 기다린다. 비밀번호를 요청하거나 입력하지 않는다.

내 사이즈 기준 검색은 `opencli musinsa mysize --as-filter -f json`으로 과거 구매 실측을 얻은 뒤 해당 `filterArgs`의 실측 값만 새 `search --measure <값>`에 전달한다. JSON에서 필요한 값을 읽어 인자로 전달하고 `filterArgs` 전체를 쉘 명령으로 실행하지 않는다. 계정 실측을 얻지 못하면 내 사이즈 필터를 적용했다고 답하지 않는다. 공개 실행기는 `--my-size`를 받지 않는다.

## 공통 판단

1. 검색 결과에서 상품번호, 상품명, 브랜드, 옵션을 확인한다. 동일 이름의 다른 상품·옵션 값을 섞지 않는다.
2. 상품의 구조화 필드는 `product`에서 읽는다. 재고·할인·실측이 질문에 필요하면 각각 해당 명령으로 더 확인한다. `product`의 후기 점수와 개수는 후기 본문을 읽었다는 뜻이 아니다.
   `mysize`는 과거 구매 상품의 실측이다. 지금 보는 상품의 사이즈별 cm 값은 상품 페이지의 실측 표에서 확인한다. '내 사이즈' 비교 행을 상품의 S/M/L 행으로 오인하지 않도록 행 이름과 단위를 화면에서 대조한다.
3. 공개 실행기의 `fetchedAt`을 Asia/Seoul 시점으로 변환해 가격·재고에 붙인다. `price`는 공개 조회 가격이며 내 회원 할인가로 표현하지 않는다. `soldOut`은 상품/옵션 문맥을 구분하고 옵션의 `activated`는 실제 재고로 해석하지 않는다. 상품별 사실과 사용자 경험을 구분하고 상품 URL을 근거로 제시한다.
4. `status: partial`이면 `warnings`의 실패 범위를 확인하고 확보한 정보만 답한다. `null`은 미확인이며 0과 다르다. 정상 `data: []`는 해당 조회 결과가 빈 목록인 경우이고 `SCHEMA_CHANGED`는 응답 구조를 읽지 못한 오류다. `FILTER_NOT_APPLIED`이면 해당 조건으로 검색했다고 답하지 않는다. 명령이 실패하거나 필드가 비어 있으면 그 필드만 미확인으로 둔다. `-`·빈 배열·후기 0건을 근거 없이 같은 뜻으로 취급하지 않는다.
5. 상세 이미지 또는 후기 내용이 필요하면 [상세 이미지와 후기 판독](references/detail-and-reviews.md)을 읽고 그 절차를 따른다.

## 답변

질문에 필요한 사실만 간결하게 답한다. 구조화 필드, 상세 이미지, 후기 본문·사진 중 근거 종류를 구분한다. 읽지 못한 자료의 내용을 추정해 채우지 않는다.
