# ask-musinsa Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프로젝트 로컬 `ask-musinsa` 스킬에서 무신사 OpenCLI의 조회 명령 10개를 라우팅하고, 필요한 경우 상품 상세 이미지와 후기 본문·사진을 읽게 한다.

**Architecture:** 추적되는 스킬 원본은 `.agents/skills/ask-musinsa/`에 두고 이 저장소의 관례대로 `.claude/skills/`에 상대 symlink를 둔다. 기존 OpenCLI 명령을 우선 사용하고, 구조화된 데이터에 답이 없을 때에만 브라우저 읽기 경로로 넘어간다. 새 어댑터 명령이나 파서는 만들지 않는다.

**Tech Stack:** Markdown skill, `opencli musinsa`, `opencli browser`, Codex 시각 판독, Python 스킬 검증 스크립트.

**Spec:** `docs/specs/2026-10-01-ask-musinsa.md`

## Global Constraints

- 프로젝트 로컬 스킬이다. 원본 `.agents/skills/ask-musinsa/SKILL.md`, Claude 발견 경로 `.claude/skills/ask-musinsa`를 사용한다.
- `likes`, `login`, `my-prices`, `mysize`, `options`, `orders`, `product`, `recommend`, `search`, `whoami`를 모두 사용할 수 있게 한다.
- 상세 PNG 등 이미지는 구조화된 결과만으로 답이 부족할 때 읽는다.
- 후기 본문은 질문에 중요할 때 읽고, 후기 사진은 필요한 경우에만 판독한다.
- 기존 OpenCLI 어댑터 수정, 구매·장바구니·좋아요 변경, 리뷰 작성은 범위 밖이다.
- 명령 옵션은 매번 `opencli musinsa --help -f yaml`에서 확인한다. 상품별 값이나 계정 정보는 스킬에 저장하지 않는다.
- 현재 작업 트리의 기존 변경(특히 data/prices.db)은 보존한다. 커밋·푸시는 별도 요청이 있을 때만 한다.

## Review Focus

- 상품 검색에 동명 상품·여러 옵션이 있을 때: 상품번호를 확정하기 전 가격·후기·치수를 합치지 않는다(Task 1, 3).
- 후기 점수·개수만 나오고 후기 본문이 열리지 않을 때: 후기 내용이나 여론을 만들어내지 않는다(Task 2, 3).
- PNG 표의 작은 글자 또는 이미지 로딩 실패: 확인 가능한 항목만 인용하고 나머지는 확인 불가로 표시한다(Task 2, 3).
- 로그인 필요·브라우저 세션 실패: 계정값은 미확인으로 두되 공개 상품값까지 실패로 처리하지 않는다(Task 1, 3).
- 가격·재고·후기 표본이 시간에 따라 바뀔 때: 조회 시점, 표본 수, 선택 기준을 답에 표시한다(Task 2, 3).

---

## File map

| Path | Responsibility |
|---|---|
| `.agents/skills/ask-musinsa/SKILL.md` | 발동 조건, 10개 명령 라우팅, 상품 식별·출처·실패 규칙 |
| `.agents/skills/ask-musinsa/references/detail-and-reviews.md` | 이미지·후기 브라우저 판독의 단계와 종료 조건 |
| `.claude/skills/ask-musinsa` | 위 스킬 원본으로 가는 로컬 상대 symlink |
| `docs/verify/ask-musinsa.md` | 실제 읽기 전용 검증의 명령, 선택 상품, 성공·제한 근거 |

기존 `.agents/skills/ask-uniqlo/` 원본과 `.claude/skills/ask-uniqlo` 상대 링크 구조를 따른다. 이 초기 문서 스킬 계획은 후속 HTTPS 전환 계획(docs/plans/2026-10-01-ask-musinsa-https.md)이 확장했다.

### Task 1: 로컬 스킬 발견과 OpenCLI 명령 라우팅

**Files:** Create `.agents/skills/ask-musinsa/SKILL.md`; create symlink `.claude/skills/ask-musinsa`.

**Interfaces:**
- Consumes: 설치된 `opencli musinsa --help -f yaml`의 명령명·옵션. 특정 설치 버전의 옵션을 스킬에 복제하지 않는다.
- Produces: 상품·검색어·계정 질문을 10개 명령 중 필요한 명령으로 연결하는 `SKILL.md`. Task 2가 여기에 상세 참조 링크를 추가한다.

- [x] **Step 1: 현재 명령과 링크 관례를 읽는다.**

```bash
opencli musinsa --help -f yaml
readlink .claude/skills/ask-uniqlo
git ls-files .agents/skills/ask-uniqlo/SKILL.md .claude/skills/ask-uniqlo
```

Expected: 무신사 명령 10개, `../../.agents/skills/ask-uniqlo` 링크와 기존 스킬 추적 경로이 확인된다. 명령 목록이 다르면 그 차이를 기록하고 10개 고정 문구를 현재 설치 상태에 맞춰 설계와 함께 검토한다.

- [x] **Step 2: `SKILL.md`를 다음 내용으로 작성한다.**

```markdown
---
name: ask-musinsa
description: 무신사 상품 검색·비교, 상세 정보·이미지·후기, 사이즈·재고·할인 및 내 주문·찜 내역을 읽을 때 사용한다. 구매나 계정 변경은 하지 않는다.
---

# ask-musinsa

무신사 질문을 읽기 전용으로 해결한다. 먼저 `opencli musinsa --help -f yaml`로 현재 명령과 옵션을 확인한다. JSON 결과를 우선 사용하고, 질문의 답이 이미지나 후기 본문에 있을 때만 브라우저 판독으로 확장한다.

## 요청별 명령

| 요청 | 명령 |
|---|---|
| 검색어로 상품 찾기, 치수·사이즈 필터 | `opencli musinsa search <query> -f json` |
| 추천 목록 | `opencli musinsa recommend -f json` |
| 특정 상품의 가격·브랜드·요약 상세 | `opencli musinsa product <goodsNo-or-url> -f json` |
| 옵션·사이즈 재고·배송 일정 | `opencli musinsa options <goodsNo-or-url> -f json` |
| 내 회원 할인가 | `opencli musinsa my-prices <goodsNo> -f json` |
| 내 과거 구매 상품의 실측과 검색 필터 | `opencli musinsa mysize -f json` |
| 내 주문·구매 내역 | `opencli musinsa orders -f json` |
| 내 찜 상품·브랜드·스냅 | `opencli musinsa likes -f json` |
| 내 로그인 상태·회원 정보 | `opencli musinsa whoami -f json` |
| 사용자가 직접 로그인할 페이지 열기 | `opencli musinsa login` |

필요한 명령만 실행한다. 계정 관련 명령은 사용자 자신의 기록을 묻는 경우에만 사용한다. 로그인이 필요하면 로그인 페이지를 안내하고 사용자의 로그인을 기다린다. 비밀번호를 요청하거나 입력하지 않는다.

## 공통 판단

1. 검색 결과에서 상품번호, 상품명, 브랜드, 옵션을 확인한다. 동일 이름의 다른 상품·옵션 값을 섞지 않는다.
2. 상품의 구조화 필드는 `product`에서 읽는다. 재고·할인·실측이 질문에 필요하면 각각 해당 명령으로 더 확인한다. `product`의 후기 점수와 개수는 후기 본문을 읽었다는 뜻이 아니다.
3. 가격·재고에는 조회 시점을 붙인다. 상품별 사실과 사용자 경험을 구분하고 상품 URL을 근거로 제시한다.
4. 명령이 실패하거나 필드가 비어 있으면 그 필드만 미확인으로 둔다. `-`·빈 배열·후기 0건을 근거 없이 같은 뜻으로 취급하지 않는다.
5. 상세 이미지 또는 후기 내용이 필요하면 상세 판독 절차를 사용한다.

## 답변

질문에 필요한 사실만 간결하게 답한다. 구조화 필드, 상세 이미지, 후기 본문·사진 중 근거 종류를 구분한다. 읽지 못한 자료의 내용을 추정해 채우지 않는다.
```

- [x] **Step 3: 프로젝트 발견 링크를 만든다.**

```bash
ln -s ../../.agents/skills/ask-musinsa .claude/skills/ask-musinsa
readlink .claude/skills/ask-musinsa
test -f .agents/skills/ask-musinsa/SKILL.md
```

Expected: `readlink`가 `../../.agents/skills/ask-musinsa`를 출력하고 `test`가 성공한다. 같은 이름의 링크가 이미 있으면 목적지를 검사하고 기존 항목을 덮어쓰지 않는다.

- [x] **Step 4: 형식과 라우팅을 검증한다.**

```bash
python3 /Users/hyunjun_macbook_pro/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/ask-musinsa
opencli musinsa --help -f yaml
git diff --check
```

Expected: `Skill is valid!`, 명령 목록과 표의 10개 명령이 일치, 공백 오류 없음. 링크가 무시되어 `git status`에 안 보이는 것은 정상이며 원본 `SKILL.md`는 추적 대상으로 보인다.

### Task 2: 상세 이미지·후기 판독 경로

**Files:** Create `.agents/skills/ask-musinsa/references/detail-and-reviews.md`; modify `.agents/skills/ask-musinsa/SKILL.md`.

**Interfaces:**
- Consumes: Task 1의 상품번호 식별과 `product` 결과의 상품 URL.
- Produces: `SKILL.md`의 상세 판독 링크와 이미지·후기 판독·출처·실패 기준. 새 코드 API는 없다.

- [x] **Step 1: 브라우저 기능의 현재 사용법을 확인한다.**

```bash
opencli browser help open
opencli browser help extract
opencli browser help state
opencli browser help screenshot
opencli browser help scroll
opencli browser help click
```

Expected: 브라우저 세션명, 화면 캡처 경로, `--full-page`, 요소 확인·스크롤 사용법이 확인된다. 옵션이 달라졌다면 아래 명령 예시를 해당 설치 버전에 맞춘다.

- [x] **Step 2: 참조 문서를 다음 내용으로 작성한다.**

````markdown
# 상세 이미지와 후기 판독

## 진입 조건

`product`·`options` 등으로 답이 충분하면 브라우저를 열지 않는다. 상세 표·문구가 이미지에만 있거나 텍스트와 충돌할 때 상세 이미지를 읽는다. 후기 내용·착용감·구매 판단을 물으면 후기 본문을 읽는다. 후기 사진은 질문의 판단에 영향을 줄 때만 본다.

## 상품 상세 이미지

1. 확정한 상품번호의 `https://www.musinsa.com/products/<goodsNo>`만 연다. 상품명과 브랜드가 `product` 결과와 같은지 확인한다.
2. 페이지의 상품 상세 영역을 열고 텍스트 추출을 먼저 시도한다. 누락된 이미지 표·문구는 화면에 표시한 뒤 캡처로 판독한다. 긴 이미지라면 글자가 읽히는 크기의 구간별 화면을 사용한다.
3. 캡처에서 확인한 문구·수치만 답에 넣고, 이미지 위치 또는 상품 URL을 근거로 단다. 구조화 필드와 충돌하면 두 값을 함께 제시하고 확정하지 않는다.
4. 이미지가 로드되지 않거나 글씨를 읽기 어려우면 해당 항목을 확인 불가로 표시한다. 썸네일만 보고 원단·치수·구성품을 단정하지 않는다.

## 후기 본문과 사진

1. 동일 상품의 후기 영역으로 이동해 실제 후기 본문을 읽는다. 평점·개수만 반환된 경우에는 본문을 읽었다고 표현하지 않는다.
2. 질문에 맞는 후기 필터·정렬을 우선 선택한다. 일반 평가는 최근 후기와 낮은 평점 후기를 각각 살피고, 필터가 없다면 화면에서 실제로 읽은 정렬을 기록한다. 동일 후기 중복은 한 건으로 센다.
3. 확인한 후기 수, 선택 기준, 확인 시점을 기록한다. 대표적인 공통점과 반례를 함께 살피며 표본 밖의 전체 구매자 의견으로 일반화하지 않는다.
4. 사진이 필요한 질문이면 해당 후기와 연결된 사진을 펼쳐 판독한다. 후기 사진은 판매자 상세 이미지와 별도 근거로 표시한다.
5. 후기 영역 접근 실패·로그인 장벽·본문 미표시·읽은 표본 0건은 각각 구분해 알린다. 본문을 못 읽었다면 평점·개수만 전달한다.

## 브라우저 명령 예시

한 작업에 고유한 세션명을 사용한다. 파일 저장 경로는 임시 폴더로 정하고 작업 후 필요 없는 캡처를 정리한다. 명령 옵션은 실행 직전 `opencli browser help <command>`로 확인한다.

```bash
opencli browser musinsa-research open 'https://www.musinsa.com/products/6596166' --window background
opencli browser musinsa-research state
opencli browser musinsa-research extract
opencli browser musinsa-research screenshot --full-page /tmp/musinsa-detail.png
opencli browser musinsa-research close
```

전체 페이지 캡처의 글씨가 너무 작으면 상세 영역으로 스크롤한 뒤 화면별로 다시 캡처한다. 캡처 이미지를 실제로 열어 판독하기 전에는 이미지 내용을 확인했다고 기록하지 않는다. 브라우저 명령이 접근에 실패하면 사용 가능한 UI 도구로 같은 상품 페이지를 읽되, 결과에서 사용한 경로와 한계를 밝힌다.
````

- [x] **Step 3: `SKILL.md`의 공통 판단 5번을 참조 링크로 바꾼다.**

```markdown
5. 상세 이미지 또는 후기 내용이 필요하면 [상세 이미지와 후기 판독](references/detail-and-reviews.md)을 읽고 그 절차를 따른다.
```

- [x] **Step 4: 형식·링크·변경 범위를 검증한다.**

```bash
python3 /Users/hyunjun_macbook_pro/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/ask-musinsa
test -f .agents/skills/ask-musinsa/references/detail-and-reviews.md
git diff --check
git status --short
```

Expected: 형식 검증과 링크 확인 성공. 변경 목록에 어댑터 코드나 기존 `output/` 파일의 수정은 없다.

### Task 3: 읽기 전용 실제 사용 검증과 근거 기록

**Files:** Create `docs/verify/ask-musinsa.md`; modify `.agents/skills/ask-musinsa/SKILL.md` 또는 참조 문서는 실제로 재현된 결함이 있을 때만.

**Interfaces:**
- Consumes: Task 1·2의 완성된 스킬과 현재 무신사 페이지.
- Produces: 세 경로의 실행 증거와 접근 제한을 기록한 검증 문서.

- [x] **Step 1: 검증 시작 상태와 상품 후보를 기록한다.**

```bash
git status --short
opencli musinsa search '티셔츠' --limit 3 -f json --window background > /tmp/ask-musinsa-search.json
jq -r '.[0] | [.goodsNo, .goodsName, .brandName, .url] | @tsv' /tmp/ask-musinsa-search.json
jq -r '.[0].goodsNo' /tmp/ask-musinsa-search.json > /tmp/ask-musinsa-goods-no
```

검색 결과 중 상품 URL이 열리는 하나를 선택해 상품번호·상품명·브랜드를 기록한다. 특정 상품번호의 재고나 후기 존재를 미리 가정하지 않는다. 기존 untracked `output/` 경로는 건드리지 않는다.

- [x] **Step 2: 구조화 필드 경로를 확인한다.**

```bash
goods_no="$(cat /tmp/ask-musinsa-goods-no)"
opencli musinsa product "$goods_no" -f json --window background
opencli musinsa options "$goods_no" -f json --window background
```

상품명·브랜드·URL이 일치하는지, `product`에 후기 본문·이미지 판독 결과가 없다는 점을 기록한다. `options`가 실패하거나 비어 있으면 실패를 그대로 기록한다.

- [x] **Step 3: 브라우저에서 상세 이미지와 후기 경로를 각각 확인한다.**

```bash
goods_no="$(cat /tmp/ask-musinsa-goods-no)"
opencli browser musinsa-skill-check open "https://www.musinsa.com/products/$goods_no" --window background
opencli browser musinsa-skill-check state
opencli browser musinsa-skill-check extract
opencli browser musinsa-skill-check screenshot --full-page /tmp/musinsa-skill-check.png
opencli browser musinsa-skill-check close
```

실제 상세 이미지와 후기 영역이 있는지 보고, 적어도 한 이미지의 내용과 한 후기 본문을 시각·텍스트로 확인한다. 첫 상품에 해당 자료가 없으면 `/tmp/ask-musinsa-search.json`의 두 번째 상품번호로 같은 명령을 다시 실행한다. 접근 제한 또는 자료 부재라면 성공으로 표기하지 않고 제한을 적는다. 후기 사진은 해당 상품에 있고 질문에 필요한 경우에만 확인한다.

- [x] **Step 4: 검증 기록을 작성한다.**

```markdown
# ask-musinsa 검증

- 실행 일시: YYYY-MM-DD HH:MM KST
- 선택 상품: 상품번호 / 상품명 / 브랜드 / URL
- 구조화 정보: 실행 명령, 확인한 필드, 상품 식별 일치 여부
- 상세 이미지: 화면에서 확인한 위치·내용·판독 가능 여부
- 후기 본문: 실제 읽은 건수, 선택 기준, 확인 가능한 주장과 반례
- 후기 사진: 필요한 경우 확인한 범위; 필요 없으면 미실행
- 실패·제한: 로그인, 브라우저, 로딩, 작은 글씨, 자료 없음 중 해당 사항
- 판정: 검증됨 / 부분 검증 / 검증 불가와 그 이유
```

위 양식을 `docs/verify/ask-musinsa.md`에 실제 값으로 채운다. `YYYY-MM-DD` 같은 양식 문구를 그대로 남기지 않는다. 계정 고유 정보나 후기 작성자 식별자는 기록하지 않는다.

- [x] **Step 5: 최종 검증과 범위 확인을 한다.**

```bash
python3 /Users/hyunjun_macbook_pro/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/ask-musinsa
test -f .agents/skills/ask-musinsa/SKILL.md
test -f .agents/skills/ask-musinsa/references/detail-and-reviews.md
git diff --check
git status --short
```

Expected: 스킬 형식·발견 경로·참조 링크가 유효하고, 보고서의 판정은 실제로 확인한 범위와 일치한다. 사이트 접근 실패 시 스킬 자체의 형식 검증과 라이브 판독 미검증을 분리해 보고한다.

## Self-review before execution handoff

- Spec coverage: 로컬 발견, 10개 명령, 이미지·후기 판독, 후기 사진 조건, 출처·시점·실패 처리가 Task 1~3에 모두 대응한다.
- Placeholder scan: 코드 작성 단계에 미정 함수·구현 지시는 없다. 검증 기록 양식은 Task 3에서 실제 값으로 채운다.
- Interface consistency: Task 1의 상품번호와 `product` URL을 Task 2·3이 그대로 사용한다. 새 코드 타입·함수는 없다.
- Review Focus: 다섯 항목을 Task 1·2의 규칙과 Task 3의 실제 검증에 연결했다.

## Execution result

2026-10-01 Native 실행 완료. 스킬 형식, 프로젝트 발견 링크, 실제 상품 search/product/options, 상세 PNG·JPG 시각 판독과 개별 후기 본문을 확인했다. 계정 전용 명령은 도움말 기준으로만 검증했다. 상세 근거와 한계는 `docs/verify/ask-musinsa.md`에 기록했다.


## 2026-10-02 프로젝트 위치 정정

사용자 지시에 따라 project-clot의 로컬 스킬로 옮겼다. 현재 원본은 `.agents/skills/ask-musinsa/`이고 `.claude/skills/ask-musinsa`는 그 원본의 상대 링크다. 위 구현·리뷰 기록 중 과거 Git 브랜치와 Python 논리회로실험 테스트는 잘못 선택했던 논회실 저장소의 이력이다. project-clot의 현재 검증이나 Git 이력으로 해석하지 않는다. 이번 위치 이동에서는 커밋하지 않는다.
