# ask-musinsa HTTPS 전환 검증

- 조회 시각: 2026-10-01T21:55:09.167000+09:00.
- 초기 환경: macOS, Node.js v26.4.0 및 v24.17.0. 후속 추가 검증에서 Node.js v22.23.3도 42/42 통과했다.
- 격리 브랜치: codex/ask-musinsa-https. 전역 OpenCLI 어댑터는 수정하지 않았다.

## 초기 구현의 오프라인 검증

`node --test .agents/skills/ask-musinsa/scripts/tests/*.test.mjs`: 40 tests, 40 pass, 0 fail.
Node.js v24.17.0에서도 같은 40개 테스트가 통과했다.
HTTP 제한·재시도·시간 초과·접근 거부·리다이렉트, 입력/필터, 구조 변경/빈 결과,
상품 필드, 추천 비상품 모듈, 일부/전체 재고 실패, CLI 종료 코드·한글 경로·심볼릭 링크를 검증했다.
각 작업의 구현 전 실패와 구현 후 통과를 확인했다.
`quick_validate.py .agents/skills/ask-musinsa`: Skill is valid!.
공개 실행기의 소스에서 OpenCLI import와 계정 Cookie/Authorization 사용이 없음을 확인했다.

## 실제 조회와 원본 대조

```bash
node .agents/skills/ask-musinsa/scripts/musinsa.mjs search '티셔츠' --limit 3
node .agents/skills/ask-musinsa/scripts/musinsa.mjs product 6596166
node .agents/skills/ask-musinsa/scripts/musinsa.mjs options 6596166
node .agents/skills/ask-musinsa/scripts/musinsa.mjs recommend --limit 3
```

최초 검색은 기존 /search/musinsa/goods 주소의 308 때문에 REDIRECT로 종료했다.
Location에서 /search/goods?keyword=…를 확인했고 그 주소에서 200/__NEXT_DATA__/상품 61개를 확인했다.
검색 URL 생성만 현재 주소로 수정했다. HTTP 자동 리다이렉트 차단은 유지했다.
수정 후 위 명령은 모두 exit 0/ok. 상품 6596166은 상세 1행·옵션 4행을 반환했다.

추가로 검색 첫 상품 7090066(한화 이글스 릴렉스드 핏 베이스볼 져지)을 상세·옵션에 전달해 같은 상품임을 대조했다.
검색 3행, 상세 1행, 옵션 5행, 추천 3행을 반환했고 전부 ok였다.
실제 HTTPS 응답을 clone해 같은 응답의 원본 __NEXT_DATA__/API JSON과 반환값을 독립 대조했다.
검색의 상품번호·가격, 상세의 상품명·가격, 옵션 수와 variantId별 outOfStock,
추천의 상품번호·상품명을 원본과 대조했고 일치했다. 브라우저/계정 쿠키는 사용하지 않았다.

## 기존 기능 보존과 제한

계정 6개 명령과 상세 이미지·후기 본문 판독 경로는 스킬에 남겼다.
mysize 결과를 공개 search --measure로 연결하고 필터 문자열 전체를 쉘로 실행하지 않도록 명시했다.
공개 가격을 회원 할인가로 표현하지 않고 옵션 활성 여부를 실제 재고로 해석하지 않도록 했다.
계정 조회, 후기 정렬/본문, 이미지 판독은 이번에 재실행하지 않았다.
모든 상품 유형·필터의 서버 측 효과를 전부 검증한 것은 아니다.

## 기존 저장소 Python 테스트

변경 전 기존 .venv로 `python -m pytest -o addopts='' -q`를 실행했다.
시스템 Python에는 pytest가 없고 기존 venv에는 xdist가 없어 pytest.ini의 병렬 옵션을 끄고 실행했다.
결과: 1607 passed, 5 skipped, 1458 subtests passed, 1 failed.
실패: tests/test_trace_guide.py::Pdf::test_실험04_는_층마다_한_쪽 — PDF 16쪽, 예상 15쪽.
구현 후 전체 Python 테스트를 재실행했고 동일하게 1607 passed, 5 skipped, 1458 subtests passed, 같은 테스트 1개 실패(16 != 15)였다. 새로운 실패는 없었다. 이 실패는 구현 전에 발생한 기존 렌더/페이지 수 문제로 기록하며 이 변경에서 수정하지 않는다.

## 설계 판단

- 격리 작업 공간에서 검증 후 요청된 스킬과 신규 문서만 현재 프로젝트에 복사한다. Git merge/push는 하지 않는다.
- 기존 검색 주소의 리다이렉트 목적지를 직접 사용한다. 향후 주소가 바뀌면 명시적 오류가 발생할 수 있다.
- 계획의 subprocess 테스트는 URL.pathname 대신 fileURLToPath를 사용한다. 한글 경로 인코딩 오류를 바로잡은 것이다.

## 독립 리뷰와 회귀 수정

새 문맥의 리뷰어가 35개 테스트를 독립 실행하고 코드·스킬 라우팅을 검토했다.
지적 4건: 의류/신발 혼합 size의 일부 누락, 로그인 HTML 오분류, 출력 limit에 따른 잘못된 글로벌 rank,
프로토타입 키가 필터 별칭으로 허용되는 문제. 마지막 지적은 사용자 필터를 잘못 적용하므로 중요 문제로 재분류했다.
각 문제의 실패를 재현하고 입력 검사·정확한 로그인 증거·페이지 내 rank·own-property 검사를 적용했다.
수정 후 Node.js v26/v24에서 40/40 통과했다. 두 번째 리뷰를 요청하지 않고 회귀 테스트와 전체 Node 테스트로 수정 결과를 검증했다.
유보한 사소한 지적은 없다. 리뷰어의 Declined to judge 목록도 비어 있었다.
로그인 증거는 /auth/login Next.js 페이지 또는 해당 로그인 action+password input이며 단순 login 문구는 인증 요구로 추정하지 않는다.

회귀 수정 후 라이브 조회 재실행: 2026-10-01T22:02:08.854000+09:00, 공개 4개 모두 ok, 원본 대조 PASS.

추가 설계 판단: rank는 페이지 내 위치다. 전체 검색 순위가 필요하면 서버 페이지 메타데이터를 추가로 확인해야 한다.


## 2026-10-01 추가 검증

Node.js v22.23.3 공식 macOS arm64 배포 파일을 임시 폴더에 받고 SHASUMS256으로 확인했다.
수정 전 40/40, 수정 후 42/42 테스트 통과. 전역 Node 설치는 변경하지 않았다.
공개 라이브 40개 시나리오: 정렬 6종, 성별·페이지·중고·의류/신발/실측 필터,
빈 검색, 상의/청바지/운동화/백팩/목걸이/립스틱의 검색·상세·옵션, 추천 스토어 5종과 F/A 성별.
상의·바지·신발·가방·액세서리·화장품 상세·옵션은 모두 성공했다.
추가 메뉴 QUICKMENU·배너 BANNER_PROMOTION·탭 CAROUSEL_TWOROW_TAB 때문에 추천 5개 변형이 처음 실패했다.
실제 구조를 확인해 메뉴·배너를 제외하고 기본 탭의 상품을 파싱하도록 수정했으며 회귀 테스트 RED→GREEN을 확인했다.
수정 후 39개 시나리오는 ok, is-used=true 1개는 서버가 isUsed:false를 반환하여 FILTER_NOT_APPLIED로 종료한다.
이 조건을 일반 상품으로 성공 처리하던 문제를 수정했다. 현재 공개 경로에서 중고 상품 포함 검색이 가능하다고 주장하지 않는다.
서버가 확인한 keyword/page/sortCode/gf/size/measurement 값도 요청값과 대조한다.
이 대조는 모든 검색 결과의 실제 cm 값이나 모든 옵션 재고를 수동으로 검증했다는 뜻은 아니다.

로그인된 현재 계정에서 whoami, mysize(limit2), likes(limit2), orders(limit2/1y), my-prices(6596166)는 전부 exit0과 데이터 반환을 확인했다.
계정 식별자·구매 상품·가격 등의 개인 값은 저장소에 기록하지 않고 명령 성공과 행 수만 확인했다.
로그인 명령은 새 로그인/계정 변경이 필요하지 않아 실행하지 않았다.
상품 5983841의 브라우저 후기 경로에서 유용한순 개별 후기 6건의 본문·구매옵션·후기 링크를 읽었다.
AI 요약/평점/사진 갤러리는 개별 본문과 별도로 구분했다. 임시 화면 캡처는 저장소에 넣지 않았다.

추가 후기 검증: 최신순과 낮은 평점순 메뉴를 실제 DOM에서 확인해 선택했고, 버튼 표시가 바뀐 것과 해당 본문 목록을 확인했다. 각 목록의 개별 후기 2건을 직접 읽었다. 전체 10행이 추출되었지만 전부 상세 판독했다고 기록하지 않는다.
의미 기반 click이 clicked:true를 반환하면서 정렬 표시가 바뀌지 않는 경우를 재현했다. 관측한 DOM 선택자로 다시 선택하면 전환되므로 실제 표시/목록 변경 확인 규칙을 참조 문서에 추가했다.
mysize --as-filter limit1의 문자열을 shlex로 분리해 --measure 값만 HTTPS search에 전달하는 연결도 exit0/ok/1행으로 확인했다.

판매자 상세 이미지도 테스트했다. 상품 5983841의 정보 탭/상품 정보 더보기에서 현재 DOM의 alt=content-img-03과 이미지 URL을 확인했다. 해당 URL을 브라우저에서 열어 캡처를 직접 판독했고 레귤러 핏·면 코마사 싱글 저지 문구를 확인했다. 혼용률 숫자는 이 이미지에 없다. 원격 이미지 파일을 내려받거나 개인 정보가 포함된 상품 화면을 저장소에 넣지 않았다.
Python 스킬 문서 회귀 테스트: tests/test_skill_docs.py 86 passed, 228 subtests passed.

추가 수정 후 전체 Python 재실행도 1607 passed, 5 skipped, 1458 subtests passed, 기존 trace_guide PDF 페이지 수 실패 1건(16 != 15)으로 동일했다. 신규 실패는 없었다.


## 2026-10-02 프로젝트 위치 정정

사용자 지시에 따라 project-clot의 로컬 스킬로 옮겼다. 현재 원본은 `.agents/skills/ask-musinsa/`이고 `.claude/skills/ask-musinsa`는 그 원본의 상대 링크다. 위 구현·리뷰 기록 중 과거 Git 브랜치와 Python 논리회로실험 테스트는 잘못 선택했던 논회실 저장소의 이력이다. project-clot의 현재 검증이나 Git 이력으로 해석하지 않는다. 이번 위치 이동에서는 커밋하지 않는다.

## project-clot 위치 이동 검증 (2026-10-02)

원본 .agents/skills/ask-musinsa, Claude 링크 .claude/skills/ask-musinsa -> ../../.agents/skills/ask-musinsa.
이 위치에서 스킬 테스트 42개와 project-clot npm test 376개 모두 통과했다.
Claude 링크 경로로도 --help 실행이 성공하고 스킬 형식 검증이 통과했다.
기존 data/prices.db 내용 해시와 두 저장소 HEAD는 이동 전후 동일하다. 커밋/스테이징은 하지 않았다.
