# 통합 가격 대시보드 검증 기록

2026-10-16 KST, 격리 워크트리 `codex/unified-price-dashboard`에서 검증했다. 원래 작업 폴더의 미추적 `data/4910-all.js`는 사용하거나 변경하지 않았다.

## 검증 범위

- 공유 순수 모델: 같은 숫자 ID의 출처 분리, 찜 우선 중복 제거, 가격 기준 변경, 무관측·0원, 변하지 않은 수집가, 7개 정렬, NFC 브랜드 키, 구형 저장값, 검색·출처·카테고리·다중 브랜드·빠른 필터의 교차 집계.
- 빌드와 로더: 2,000개 분할, 누락·짧은 추출·잘못된 revision·중복 manifest·상세 누락, 실패 후 재시도, 동시 요약 요청 최대 4개, 내장/브랜드 이력 캐시. 스캔 빌드 실패는 부분 파일을 폐기하고 내장 상품과 안내를 유지한다.
- 생성 페이지: 실제 임시 SQLite DB를 사용해 생성한 HTML을 HTTP와 file://로 열었다. 구형 링크와 숨은 필터 해제, 상세 실패·재시도, 뒤늦은 상세 완료, 브랜드 OR·출처 전환·0건 해제·Escape·초점 복귀·모바일 폭·다크 테마를 확인했다. Chart.js는 외부 CDN 요청을 대체하는 최소 스텁을 사용했으며 차트 라이브러리 자체의 시각적 회귀는 이 테스트 범위에 넣지 않았다.
- 합성 규모: 정확히 140,129개(무신사 626, 4910 139,503), 초기 카드 120개, 마지막 파트의 sentinel 검색, 상세 전까지 이력 요청 0회, 상세 뒤 건수 불변. 10회 UI 검색·정렬 측정 중앙값 261ms, 최대 278ms.
- 실제 DB: `4910-db pull`의 원래 모듈을 사용해 최신 Release 자산 100,261,888바이트를 `/tmp/clot-dashboard-live/4910.db`에 받았다. fallback이 아닌 latest 자산이다. `MAX(scan_runs.date)=2026-10-15`. 수집 ACTIVE 고유 ID 139,502, 찜 ACTIVE 9, 겹침 8이므로 4910 합집합은 139,503이다. 찜 제외 수집 요약은 139,494, 무신사 626과 합쳐 전체 140,129다. 스냅샷 이후 운영 DB 변동은 반영하지 않는다.
- 실제 DB 빌드 약 4.8초, 산출물 검증기 결과 `{"totalItems":140129,"total4910":139503,"scanState":"complete"}`. 모델 10회 중앙값 80ms/최대 107ms. 실제 페이지 UI 검색·정렬 10회 중앙값 389ms/최대 417ms, 페이지 오류 0건. 이 수치는 해당 머신의 로컬 측정이며 서비스 SLA가 아니다.

## 실행 명령과 결과

- 변경 전 `npm test`: 913/913 통과.
- `node --test tests/dashboard-model.test.js tests/dashboard-catalog.test.js tests/dashboard-runtime.test.js tests/dashboard-build.test.js tests/visualizer-data.test.js tests/visualizer-html.test.js tests/cli-visualize.test.js`: 집중 검증 통과.
- `CLOT_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:dashboard:browser`: 브라우저 9/9 통과, 건너뜀 없음.
- `node scripts/verify-dashboard-build.js /tmp/clot-dashboard-live/index.html`: 실제 DB 생성 산출물의 합계·revision·가격 요약/상세 일치 통과.
- 전체 테스트와 독립 리뷰의 최종 결과는 아래에 기록한다.

## 화면 점검

1440×1000과 390×844를 함께 점검했다. 첫 확인에서 모바일 그룹 라벨의 한 글자 줄바꿈과 정렬 행 낭비를 확인해 한 번에 수정하고 두 번째로 확인했다. 브랜드 창은 데스크톱 패널/모바일 하단 시트이며 리스트 내부에서 스크롤된다. 기존 카드와 색상 체계를 유지했다.

실제 데이터 캡처: `/tmp/clot-dashboard-live/desktop.png`, `/tmp/clot-dashboard-live/mobile-brands.png`. 재생성 가능한 검토용 HTML: `/tmp/clot-dashboard-live/index.html`. 이 임시 산출물과 DB는 Git에 추가하지 않았다.

Impeccable 정적 검사는 기존 최저가 표식의 두꺼운 border-top 1건과 안내성 항목을 표시했다. 기존 카드 스타일은 이번 범위에서 유지했다. 신규 dialog의 과도한 그림자 안내는 줄였고 boolean hidden은 display 규칙보다 우선하도록 했다.

## 구현 중 판단

계획의 무신사 나이키 예시를 90→100으로 명확히 했다. 계획이 요구한 최저가 3개·나이키 최저가 1개와 기존 가격 판정 규칙을 동시에 만족하는 픽스처다. 운영 가격 판정은 바꾸지 않았다.

Pages 워크플로에 의존 파일 경로와 npm ci, 집중 테스트, Chromium 설치·브라우저 테스트, 산출물 검증을 추가했다. 실제 push·main 병합·배포는 수행하지 않았다.
