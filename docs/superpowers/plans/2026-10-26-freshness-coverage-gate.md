# Freshness Coverage Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pages 배포 전 검증이, 최근 정상 수집된 출처인데 ACTIVE 상품 대부분이 기본 화면(live tier)에서 빠진 빌드를 실패시켜 배포를 막는다.

**Architecture:** 출처 그룹 판정과 붕괴 규칙을 순수 모듈 `src/dashboard-coverage.js`에 둔다. 빌더는 tier를 나눌 때 그룹별 `active/live`를 세어 `manifest.coverage`에 기록하고, `visualizer.js`가 그룹별 마지막 정상 수집 시각을 넘긴다. `scripts/verify-dashboard-build.js`는 인덱스를 다시 세어 manifest와 대조한 뒤 규칙을 적용해 실패시킨다(Pages의 기존 "Verify generated dashboard" 단계).

**Tech Stack:** Node 24 (ESM, `node:sqlite`), `node:test`, 정적 대시보드 빌드.

**Spec:** 이 대화의 설계 "최신 가격 비율이 무너진 빌드의 배포 차단"(2026-10-26). 결정 #8–#10은 추천값으로 확정(by default): 배포 가드 방향 / 붕괴 시 배포 중단 / 기준 live 25%. 아래 Spec summary가 실행에 필요한 내용 전부다.

## Spec summary

- 배경: `210875a`(10-25 10:15Z) 이후 기본 화면은 `observation_json` 증거가 48시간 안인 상품만 보인다. 마지막 넓은 스캔(10-25 09:51Z)은 그 이전 코드라 열이 없었고, 무신사 넓은 스캔 316,299개가 전부 history가 됐는데 빌드 검증·배포가 모두 통과했다.
- 그룹: `musinsa-wide`(`kind==='wide'`), `musinsa-watched`(그 외 `src==='musinsa'`), `4910`(`src==='4910'`).
- 그룹 `lastRunAt`: musinsa-wide = 넓은 스캔 최신 `scan_runs.completed_at`(그 행 `complete=1`일 때만, 아니면 null), musinsa-watched = `daily_runs` 최신 `completed_at`, 4910 = 4910 DB 최신 `scan_runs` 중 `complete=1`인 행의 `completed_at`(없으면 null).
- 규칙: `lastRunAt` 파싱 가능 ∧ `0 <= asOfMs - lastRunAt <= PRICE_TTL_MS(48h)` ∧ `active >= 100` ∧ `live/active < 0.25` → 문제.
- 문제 메시지 형식(정확히): `freshness coverage collapse: <key> live <live>/<active> (last run <lastRunAt>)`.
- 수집이 48시간 넘게 멈췄거나 불완전 실행이면 검사하지 않는다. 로컬 `visualize`는 영향 없음(검증 스크립트에서만 실패).
- 검증 스크립트는 그룹별 수치를 `freshness coverage <key>: live <live>/<active> last run <lastRunAt|none>` 한 줄씩 stderr로 출력한다(stdout의 기존 JSON 한 줄은 유지).

## Global Constraints

- 작업 기준은 `origin/main`(5097cfa 이후). 로컬 `main`은 뒤처져 있으니 worktree를 `origin/main`에서 만든다. 로컬 미추적 파일(`data/4910-all.js`, `rea-musinsa/` 등)은 건드리지 않는다.
- TTL은 `createDashboardModel().PRICE_TTL_MS`를 재사용한다. 48h를 새로 정의하지 않는다.
- 상수: `minShare = 0.25`, `minActive = 100`.
- 원본 DB 변경, 수집, 알림, push, 배포 금지(검증은 임시 파일로만).
- 코드 스타일은 주변 파일을 따른다(이 저장소의 대시보드 파일은 압축된 한 줄 스타일이 많다).
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. 기존 테스트 fixture(상품 2~5개)는 `minActive` 미만이라 통과해야 한다 — Task 3의 기존 스위트 실행으로 확인.
2. 넓은 스캔 마지막 실행이 불완전(`complete=0`)이면 live가 0이어도 통과 — Task 2 테스트 `wide coverage ignores incomplete scan runs`.
3. `lastRunAt`이 미래(asOfMs보다 뒤)이거나 파싱 불가면 검사하지 않는다 — Task 1 테스트.
4. 4910 DB가 없는 빌드(`db4910Path:null`)에서 4910 그룹은 `lastRunAt:null` — Task 2 테스트.
5. manifest의 `coverage`를 조작한 빌드(수치 부풀리기)는 `coverage count mismatch`로 실패 — Task 3 테스트.

---

### Task 1: 커버리지 규칙 모듈

**Files:**
- Create: `src/dashboard-coverage.js`
- Test: `tests/dashboard-coverage.test.js`

**Interfaces:**
- Produces:
  - `coverageGroup(x: {src:string, kind:string}) -> 'musinsa-wide'|'musinsa-watched'|'4910'`
  - `countCoverage(items: Iterable<summary>, asOfMs:number, isLive:(x)=>boolean) -> Map<key,{active:number, live:number}>` — `active`는 `x.tracking?.status==='ACTIVE'`, `live`는 그중 `isLive(x)`.
  - `evaluateFreshnessCoverage(groups: Array<{key,active,live,lastRunAt:string|null}>, asOfMs:number, {ttlMs=PRICE_TTL_MS, minShare=0.25, minActive=100}={}) -> string[]`
  - `COVERAGE_KEYS = ['musinsa-wide','musinsa-watched','4910']`

- [ ] **Step 1: Write the failing tests**

```js
import './setup-env.js';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {coverageGroup,countCoverage,evaluateFreshnessCoverage} from '../src/dashboard-coverage.js';
const H=3600000,AS_OF=Date.parse('2026-10-26T02:00:00Z');
test('coverage groups split wide, watched and 4910',()=>{
 assert.equal(coverageGroup({src:'musinsa',kind:'wide'}),'musinsa-wide');
 assert.equal(coverageGroup({src:'musinsa',kind:'liked'}),'musinsa-watched');
 assert.equal(coverageGroup({src:'musinsa',kind:'musinsa'}),'musinsa-watched');
 assert.equal(coverageGroup({src:'4910',kind:'scan'}),'4910');
});
test('countCoverage counts only ACTIVE tracking as active',()=>{
 const items=[{src:'musinsa',kind:'wide',tracking:{status:'ACTIVE'},on:true},{src:'musinsa',kind:'wide',tracking:{status:'ACTIVE'},on:false},{src:'musinsa',kind:'wide',tracking:{status:'STOPPED'},on:false}];
 assert.deepEqual(countCoverage(items,AS_OF,x=>x.on).get('musinsa-wide'),{active:2,live:1});
});
test('incident numbers collapse',()=>{
 assert.deepEqual(evaluateFreshnessCoverage([{key:'musinsa-wide',active:300677,live:0,lastRunAt:'2026-10-25T09:51:44.611Z'}],AS_OF),
  ['freshness coverage collapse: musinsa-wide live 0/300677 (last run 2026-10-25T09:51:44.611Z)']);
});
test('boundaries: 25% passes, small groups, stale, future and missing runs are skipped',()=>{
 const run=new Date(AS_OF-1*H).toISOString(),g=o=>[{key:'4910',active:1000,live:250,lastRunAt:run,...o}];
 assert.deepEqual(evaluateFreshnessCoverage(g(),AS_OF),[]);
 assert.equal(evaluateFreshnessCoverage(g({live:249}),AS_OF).length,1);
 assert.deepEqual(evaluateFreshnessCoverage(g({active:99,live:0}),AS_OF),[]);
 assert.deepEqual(evaluateFreshnessCoverage(g({live:0,lastRunAt:new Date(AS_OF-48*H).toISOString()}),AS_OF).length,1);
 assert.deepEqual(evaluateFreshnessCoverage(g({live:0,lastRunAt:new Date(AS_OF-48*H-1).toISOString()}),AS_OF),[]);
 assert.deepEqual(evaluateFreshnessCoverage(g({live:0,lastRunAt:new Date(AS_OF+H).toISOString()}),AS_OF),[]);
 assert.deepEqual(evaluateFreshnessCoverage(g({live:0,lastRunAt:null}),AS_OF),[]);
 assert.deepEqual(evaluateFreshnessCoverage(g({live:0,lastRunAt:'2026-10-25'}),AS_OF),[]);
});
```

`'2026-10-25'`(날짜만)는 시각 증거가 아니므로 skip — `dashboard-model.js`의 `instant()`처럼 `'T'` 포함 문자열만 인정한다.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/dashboard-coverage.test.js`
Expected: FAIL — `Cannot find module '../src/dashboard-coverage.js'`

- [ ] **Step 3: Implement `src/dashboard-coverage.js`**

`PRICE_TTL_MS`는 `createDashboardModel()`에서 꺼낸다. 시각 파싱은 `'T'`를 포함한 문자열만 `Date.parse`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/dashboard-coverage.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/dashboard-coverage.js tests/dashboard-coverage.test.js
git commit -m "feat(dashboard): add freshness coverage rule"
```

---

### Task 2: 빌드 결과에 출처별 커버리지 기록

**Files:**
- Modify: `src/dashboard-builder.js` (`finish()`의 tier 분할 루프 근처, 76행 부근; 반환 `catalog`에 `coverage` 추가)
- Modify: `src/dashboard-musinsa.js` (`metadata`에 `complete: run.complete===1` 추가, 58행 부근)
- Modify: `src/visualizer.js` (`generateDashboardHtml`: 넓은 스캔·daily_runs·4910 scan_runs의 lastRunAt 수집, `sink.finish()`에 전달 — 518행 부근; `payload.lastRun`을 512행에서 덮어쓰기 전에 daily 값을 보관)
- Test: `tests/dashboard-musinsa.test.js`

**Interfaces:**
- Consumes: Task 1의 `coverageGroup`, `countCoverage`, `COVERAGE_KEYS`.
- Produces:
  - `sink.finish({scanState, notice, musinsaCount, scanCount, runs})` — `runs: {'musinsa-wide'?:string|null, 'musinsa-watched'?:string|null, '4910'?:string|null}`(생략 = null).
  - `manifest.coverage: Array<{key, active, live, lastRunAt:string|null}>` — `COVERAGE_KEYS` 순서로 항상 3개 행(상품 0개 그룹도 `active:0, live:0`).
  - live 판정은 기존 tier 판정과 동일: `w=model.freshWindow(x); live=!!w && w.until>=asOfMs`.

- [ ] **Step 1: Write the failing tests** (`tests/dashboard-musinsa.test.js`, 기존 `fixture(t)` 재사용)

```js
test('generated manifest records per-group freshness coverage',async t=>{
 const {dir}=fixture(t);const {DatabaseSync}=await import('node:sqlite');const {generateDashboardHtml}=await import('../src/visualizer.js');
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(/* 기존 'generated dashboard replaces…' 테스트와 같은 items/price_logs 스키마 */);
 const output=path.join(dir,'index.html');generateDashboardHtml({db,db4910Path:null,dbMusinsaPath:path.join(dir,'wide.db'),outputPath:output,openBrowser:false});
 const m=JSON.parse(fs.readFileSync(output,'utf8').match(/window\.__CLOT_DATA__ = ([^\n]+);/)[1]).catalog;
 assert.deepEqual(m.coverage.map(r=>r.key),['musinsa-wide','musinsa-watched','4910']);
 assert.deepEqual(m.coverage[0],{key:'musinsa-wide',active:2,live:2,lastRunAt:'2026-10-16T04:50:00Z'});
 assert.equal(m.coverage[2].lastRunAt,null);
});
test('wide coverage ignores incomplete scan runs',async t=>{
 const {dir,store}=fixture(t);store.db.prepare('UPDATE scan_runs SET complete=0').run();
 /* 위와 같은 빌드 */
 assert.equal(m.coverage[0].lastRunAt,null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/dashboard-musinsa.test.js`
Expected: FAIL — `m.coverage` is undefined

- [ ] **Step 3: Implement**

- `dashboard-musinsa.js`: metadata에 `complete`.
- `visualizer.js`: `runs['musinsa-wide'] = wide?.metadata.complete ? wide.metadata.completedAt : null`; `runs['musinsa-watched']` = `exportDashboardBase`가 돌려준 `payload.lastRun`(512행 덮어쓰기 전 값); `runs['4910']` = 열린 `db4910`에서 `SELECT completed_at FROM scan_runs WHERE complete=1 ORDER BY date DESC LIMIT 1`(db4910 없거나 실패 시 null). 4910 조회는 db4910이 열려 있는 기존 try 블록 안에서 한다.
- `dashboard-builder.js`: tier 루프에서 계산한 live 여부로 `countCoverage`를 채우고(같은 `freshWindow` 결과 재사용, 두 번 계산하지 않음) `catalog.coverage`를 만든다.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/dashboard-musinsa.test.js tests/dashboard-*.test.js tests/visualizer-data.test.js`
Expected: PASS (기존 테스트 포함)

- [ ] **Step 5: Commit**

```bash
git add src/dashboard-builder.js src/dashboard-musinsa.js src/visualizer.js tests/dashboard-musinsa.test.js
git commit -m "feat(dashboard): record freshness coverage per source group"
```

---

### Task 3: 검증 스크립트의 커버리지 게이트

**Files:**
- Modify: `scripts/verify-dashboard-build.js` (`verifyV2`: 182–196행 인덱스 순회에서 그룹별 재집계, 함수 끝 `return` 직전에 대조·게이트; CLI 블록에서 커버리지 줄 출력)
- Test: `tests/dashboard-build.test.js`, `tests/dashboard-musinsa.test.js`

**Interfaces:**
- Consumes: Task 1 `countCoverage`/`coverageGroup`/`evaluateFreshnessCoverage`, Task 2 `manifest.coverage`.
- Produces: `verifyDashboardBuild()` 반환값에 `coverage`(manifest와 같은 배열) 추가. 실패 메시지: 재집계 불일치 `coverage count mismatch`, 게이트 실패 시 Spec summary의 문제 메시지들을 `'; '`로 이은 문자열.

- [ ] **Step 1: Write the failing tests**

`tests/dashboard-build.test.js` — 기존 `deepEqual(verifyDashboardBuild(output),{totalItems:5,…})` 두 곳은 `coverage` 필드가 생기므로 비교 대상을 `{totalItems,total4910,scanState}`만 뽑아 비교하도록 고친다. 새 테스트:

```js
test('verifier rejects a manifest whose coverage disagrees with the index',t=>{
 /* 기존 mutate 패턴 */ mutate(m=>{m.coverage[0].live+=1;});assert.throws(()=>verifyDashboardBuild(file),/coverage count mismatch/);
});
```

`tests/dashboard-musinsa.test.js` — 사고 재현:

```js
test('verifier blocks a build that hides a freshly scanned wide catalog',async t=>{
 const {dir,store}=fixture(t);
 // 120 ACTIVE goods without observation evidence, scan finished one hour before the build.
 for(let n=10;n<130;n++)store.db.prepare("INSERT INTO goods(goods_no,cat,name,url,brand_name,sale_price,normal_price,coupon_price,coupon_price_source,first_seen_date) VALUES(?,?,?,?,?,?,?,?,?,?)").run(n,'001','상품 '+n,'https://www.musinsa.com/products/'+n,'브랜드',100,200,90,'ESTIMATED','2026-10-15');
 const asOfMs=Date.now();store.db.prepare('UPDATE scan_runs SET complete=1,completed_at=?').run(new Date(asOfMs-3600000).toISOString());
 /* generateDashboardHtml({...,asOfMs}) 후 */
 assert.throws(()=>verifyDashboardBuild(output),/freshness coverage collapse: musinsa-wide live 2\/122/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/dashboard-build.test.js tests/dashboard-musinsa.test.js`
Expected: FAIL — 새 두 테스트가 throw되지 않음

- [ ] **Step 3: Implement**

`scoped` 루프에서 이미 계산하는 `live`로 `countCoverage`에 해당하는 집계를 같이 쌓고(재계산 금지), 루프 후 `manifest.coverage`의 각 행 `active/live`와 비교 → 다르면 `coverage count mismatch`. 그다음 `evaluateFreshnessCoverage(m.coverage, m.asOfMs)`가 비어 있지 않으면 throw. `m.coverage`가 없는 manifest(이전 빌드)는 `coverage count mismatch`로 실패시킨다(v2 빌더는 항상 기록하므로). CLI 블록은 결과의 `coverage`를 Spec summary 형식으로 stderr에 한 줄씩 쓰고 기존 JSON을 stdout에 그대로 쓴다.

- [ ] **Step 4: Run the Pages test set**

Run: `node --test tests/dashboard-*.test.js tests/tracking-freshness.test.js tests/site4910-price-validation.test.js tests/visualizer-data.test.js tests/visualizer-html.test.js tests/cli-visualize.test.js && npm run test:dashboard:browser`
Expected: 모두 PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-dashboard-build.js tests/dashboard-build.test.js tests/dashboard-musinsa.test.js
git commit -m "feat(dashboard): block deploys whose fresh catalog coverage collapsed"
```

---

### Task 4: 실제 스냅샷으로 확인하고 기록

**Files:**
- Create: `docs/verify/2026-10-26-freshness-coverage-gate.md`

- [ ] **Step 1: 사고 당시 스냅샷으로 빌드 → 실패 확인**

`gh release download data-musinsa -p musinsa-wide.db.2026-10-25.gz`를 임시 디렉터리에 받아 풀고, `node src/cli.js 4910-db pull`로 받은 4910 DB와 함께 Pages와 같은 명령으로 빌드:

```bash
CLOT_MUSINSA_WIDE_DB_PATH=<tmp>/musinsa-wide.db CLOT_REQUIRE_MUSINSA_WIDE=1 CLOT_DASHBOARD_PATH=<tmp>/site/index.html node --max-old-space-size=4096 src/cli.js visualize --no-open
node --max-old-space-size=4096 scripts/verify-dashboard-build.js <tmp>/site/index.html
```

빌드 시각은 현재이므로 10-25 09:51Z 실행이 48h 안일 때(10-27 09:51Z 전) 수행한다. 그 뒤라면 결과가 skip으로 바뀌는 것이 정상이며 문서에 그렇게 적는다.
Expected: exit≠0, stderr에 `freshness coverage collapse: musinsa-wide live 0/…`

- [ ] **Step 2: 최신 스냅샷(observation 기록 후)으로 빌드 → 통과 확인**

`musinsa-wide.db.gz`(오늘 넓은 스캔 완료 뒤 버전)로 같은 명령. 아직 오늘 스캔 전이면 이 단계는 보류로 표시하고 Step 1만 기록한다.
Expected: exit 0, `musinsa-wide` live 비율 25% 이상

- [ ] **Step 3: 결과 기록 후 Commit**

문서에 그룹별 `live/active/lastRunAt` 표, 두 빌드의 exit code, 회복 후 무신사 live 증가에 따라 로딩 재측정이 필요하다는 메모를 남긴다.

```bash
git add docs/verify/2026-10-26-freshness-coverage-gate.md docs/superpowers/plans/2026-10-26-freshness-coverage-gate.md
git commit -m "docs: verify freshness coverage gate on real snapshots"
```
