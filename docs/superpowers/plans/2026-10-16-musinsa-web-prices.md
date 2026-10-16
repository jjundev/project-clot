# Musinsa website prices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 웹사이트에 실제 30만 상품 수집 가격, 가격 출처 및 쿠폰 예외 경고를 배포한다.
**Architecture:** 읽기 전용 wide DB adapter가 가격 이력과 요약을 2,000개씩 내보낸다. 기존 catalog manifest/runtime에 무신사 분할을 합치고 검증기는 모든 요약과 상세의 일치를 검사한다.
**Tech Stack:** Node24 SQLite, static HTML/JS, Playwright, GitHub Pages.
**Spec:** docs/superpowers/specs/2026-10-16-musinsa-web-prices-design.md

## Global Constraints
- 기존 4910/필터/찜 DB를 유지한다. 운영 DB는 읽기 전용이다.
- 원시 회원 응답·쿠키를 배포하지 않는다.
- 가격 출처 불명은 DIRECT로 승격하지 않는다. 예외는 경고로 남긴다.

## Review Focus
- 동일 상품 중복과 기존 찜 가격 우선순위.
- 가격 기준/출처 변화와 오래된 쿠폰 가격의 잘못된 이월.
- 일부 요약/상세 누락과 revision 불일치.
- API 예외 표시 및 모바일 경고 줄바꿈.
- 대규모 검색·상세 링크와 자동 재배포.

### Task 1: DB adapter and catalog
Files: src/dashboard-musinsa.js, src/visualizer.js, src/dashboard-model.js, tests/dashboard-musinsa.test.js.
- [x] 실제 SQLite fixture로 중복·출처·기준 변경·이력/요약·민감정보 제외 테스트를 작성하고 실패 확인.
- [x] buildMusinsaCatalog(db,{outDir,revision})가 items 대신 parts/histories와 metadata, 중복 제외 ID를 반환하도록 구현.
- [x] 통합 catalog, lazy detail, 검증기를 확장하고 집중 테스트 통과.

### Task 2: browser and workflow
Files: src/dashboard-runtime.js, src/dashboard.template.html, scripts/verify-dashboard-build.js, .github/workflows/pages.yml, tests/browser/dashboard.test.js.
- [x] 무신사 분할 로드·재시도·가격 출처/예외 표시 브라우저 테스트 실패 확인.
- [x] 카드·상세·이력 가격 명칭과 예외 안내 추가. Release pull을 필수로 하고 wide 성공 후 배포 연결.
- [x] 전체 테스트, 브라우저, 실제 DB 빌드 전수 검증 및 데스크톱/모바일 점검.

### Task 3: publish and evidence
- [x] 독립 코드 리뷰와 필요한 회귀 수정 후 선별 커밋/PR/병합/배포.
- [x] 실제 사이트 요약 전체 수, 직접·추정 상세, 경고, 검색 및 모바일을 확인.
- [x] docs/verify/2026-10-16-musinsa-web-prices-final.md에 실행/배포와 한계 기록 및 push.
