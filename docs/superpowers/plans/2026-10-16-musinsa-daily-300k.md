# Musinsa Daily 300k Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent Tasks1/2, then integrate and independently review the whole branch. Track completion in .superpowers/sdd/musinsa-daily-300k/progress.md.

**Goal:** 매일 고유30만 상품과 완전한 쿠폰 목록을 수집하고 실제 결과를 Markdown으로 기록한다.
**Architecture:** 동적분류 순회 모듈과 기존 대분류 저장을 분리하고 쿠폰은 combined 목록을 끝까지 읽는다. 단계별 마감과 전체 마감을 분리한다.
**Tech Stack:** Node24, node:sqlite, node:test, GitHub Actions.
**Spec:** docs/superpowers/specs/2026-10-16-musinsa-daily-300k-design.md

## Global Constraints

고유300,000; 저장cat=기존5대분류; 부분조사 호환; 회원200+200일일한도 유지; 수집45분/번호단계12분/판별단계15분/전체165분/Actions180분; 중단된 쿠폰은 기존매핑 보존; 기존DB보존.

## Review Focus

- 분류 발견 실패 또는 부분목록을 완전한 조사로 오인하지 않는다.
- 중복·이동 상품·목표 도달시 진행중 요청에서도 고유선택수를 넘지 않는다.
- 쿠폰 페이지의 역전·60페이지 이후·빈페이지+hasNext·반복페이지가 누락 성공으로 바뀌지 않는다.
- 수집이12분을 넘겨도 후속 단계 예산이 남는다.
- 재실행의 회원일일한도와 기존가격이력이 보존된다.

### Task 1: 분할 수집 모듈

**Files:** src/musinsaWide/partitions.js(new), src/musinsaWide/client.js, tests/musinsa-wide-partitions.test.js(new), tests/musinsa-wide-client.test.js
**Interfaces:** client.getCategoryPartitions(root)->[{code,root}], scanPartitions({withClient,categories,targetGoods,concurrency,deadline,now,log})->{scans:[{cat,rows:Map,pages,complete,problems}],selected,targetReached}. client.getCategoryPage(code,url) and toListingRow(item,root) reused.

- [ ] Tests first: dedup across partitions, exact target with inflight workers, top-level cat, malformed/missing taxonomy, empty+next, deadline and partial failure inhibit complete, all chains end below target.
- [ ] Run new tests RED, implement, run GREEN and suite.
- [ ] Return task-owned diff and evidence; controller commits.

### Task 2: 쿠폰 목록 완주

**Files:** src/musinsaWide/walk.js, tests/musinsa-wide-walk.test.js
**Interfaces:** Keep walkCoupon/client/store interfaces; combined-mode traversal to actual end. Ignore floors for termination. Preserve failure/deadline/throttle behavior and walk metrics.

- [ ] Tests first: >60 pages, review reversal beyond floor, missing floor, empty+hasNext, repeated page, safety limit, deadline/429 sibling and preserved mapping.
- [ ] Run RED, implement, run GREEN and suite. Update obsolete tests to final contract.
- [ ] Return task-owned diff and evidence; controller commits.

### Task 3: 일상 통합·시간 예산·보고

**Files:** src/musinsaWide/track.js, src/cli.js, tests/musinsa-wide-track.test.js, tests/cli-musinsa-wide.test.js, .github/workflows/musinsa-wide.yml, README.md, final docs/verify/2026-10-16-musinsa-daily-300k-final.md.
**Interfaces:** trackMusinsa accepts targetGoods=null for explicit legacy scope; default full CLI passes300000. scanPartitions returns root-compatible scans. Registry phase budgets start after scan and each preceding phase, bounded by global deadline.

- [ ] Tests first: CLI default target300000 and explicit partial unchanged, default track integration, incomplete selection and zero failure, phase relative budgets after >12minute scan.
- [ ] Run RED, integrate modules and budgets, run GREEN and whole suite; inspect changes.
- [ ] Independent whole-branch review and fixes; scoped commits/push/PR/merge with latest origin preserved.
- [ ] Trigger daily scan Actions; inspect full completion and downloaded result DB, existing history preservation, sample accuracy and no missed mapping from caps.
- [ ] Save final factual Markdown. If run fails/incomplete, repair and rerun; do not call an unperformed run complete.
