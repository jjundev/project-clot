# Musinsa estimate policy Implementation Plan

> Use TDD for tasks1/2 independently, controller integrates task3 then fresh whole-branch review.

**Goal:** API예외를명시한추정쿠폰가/직접확인가를구분하여매일30만조사를정상운영하고실제복구실행결과를갱신한다.
**Architecture:** strict walk health and additive source columns; shared coverage classification; fail-closed snapshot recovery.
**Tech Stack:** Node24,node:sqlite,node:test,Actions.
**Spec:** docs/superpowers/specs/2026-10-16-musinsa-estimate-policy-design.md

## Global Constraints

누락예외는경고로명시; 진짜실패불허; 일일200+200유지; 원래이력열보존; DIRECT는오늘/동일sale+extra; 추정가 확정하락알림금지.

## Review Focus

- exceptions중복/가짜숫자/failed ID상충이검사를우회하지않는다.
- 오래된캐시와변경된판매가를DIRECT로표시하지않는다.
- 이전출처미상/추정가격을기준으로확정쿠폰가하락알림을만들지않는다.
- 복구가오늘300000선택아닌DB나네트워크실패를성공으로전환하지않는다.
- additive migration으로과거값이재작성되지않는다.

### Task 1: 가격출처·알림·DB
Files src/musinsaWide/store.js,coupons.js and tests for both. setCouponPrices(prices,sources=Map), historyrow.source; applyCouponPrices return direct/estimated counts plus existing fields. Tests RED then GREEN: nullable migration, DIRECTsame-date/sameprice only and authoritative coupons, cachedpriceESTIMATED, historysource transitions and onlyDIRECT→DIRECTalerts; fullsuite report. Controllercommits.

### Task 2: 사용자표시
Files src/musinsaWide/digest.js,tests/musinsa-wide-digest.test.js. Expect coupons fields direct/estimated,pricingPolicy,exceptionCoupons, existingrefreshDeferred. Explicitestimate/directcounts, API예외 IDs and추가할인가능warning. No falseconfirmedcouponalerts; don't hidepublicsaleprice distinction. RED/GREEN tests. Controllercommits.

### Task 3: 목록분류·복구·통합
Files walk.js,coverage.js,track.js,recover.js(new),cli.js,workflow and correspondingtests. pricingCoverage(walk)->{coverage:'complete'|'estimate-with-exceptions',exceptionCoupons:number[]} throws on realincomplete. walk preservesexceptionsandfailedIDs across both passes. Recovery validates savedtodayrun+fulltarget, confirms exactlysuspectCount emptyIDsviaactualclient, reusesmaps+selection, applies newpricing, records metricsrecovery andnoaddedmembercalls. CLI --resume-pricing mutuallyexclusivewithpartial/init/backfill/dry-run; workflowmode resume-pricing pulls/resumes/pushes/verifies. Tests RED/GREEN, fullsuite andreview. Commit/push/merge then actualActionsmode resume-pricing. Validate resultDB/directchecks/historicaloriginalcolumns, updatefinalMD with honestrecoverydistinction; scoped docscommit. No fresh assumptionsaudit.
