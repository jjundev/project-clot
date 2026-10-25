# Dashboard Deploy Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 4910 검증 이력을 실제 대상 상품으로 제한해 대시보드 배포 OOM 을 수정하고 실제 데이터 생성·검증으로 확인한다.

**Architecture:** 기존 조회 함수에 정확한 ID 목록과 증빙 제외 옵션을 추가하고 필터를 교집합으로 적용한다. 스캔 adapter 는 이미 조회한 goods 를 목록으로 전달한다. Pages 는 생성과 검증을 분리해 각 프로세스의 최대 RSS 와 시간을 기록한다. 검증기 전체 재설계는 제외한다.

**Tech Stack:** Node.js 24 ESM, node:sqlite, node:test, 기존 Playwright, GitHub Actions Ubuntu 와 `/usr/bin/time -v`. 새 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-10-25-dashboard-deploy-memory-design.md` — 구현 전에 먼저 읽는다. 결정 #8 은 권장 범위로 confirmed by default 이며 2026-10-25 사용자가 Native 구현과 실데이터 생성·검증을 승인했다.

## Global Constraints

- Node.js 24, ESM, node:sqlite, node:test 와 기존 Playwright 구성을 사용하고 새 의존성을 추가하지 않는다.
- 전체 상품·전체 날짜별 가격 이력·가격 보정·최저가·하락 판정·공개 대시보드 v2 형식은 유지한다.
- DB 스키마·수집·이력 보관 정책·검증 증빙 원본은 변경하지 않는다.
- 운영 데이터 파일과 기존 미추적 `data/4910-all.js`는 수정·삭제·스테이징하지 않는다.
- 생산 경로의 상품 묶음과 목록 조회 SQL 의 상품 ID 수는 각각 최대 200 개로 유지한다.
- 실제 데이터의 생성과 검증은 각각 `--max-old-space-size=4096`으로 통과해야 한다. 힙 상한 증설이나 검증 생략으로 통과시키지 않는다.
- 회귀 메모리 실험은 자식 프로세스의 `--max-old-space-size=512`에서 수행한다.
- 기존의 선택적 4910 누락·부분 실패 안내와 롤백 동작은 유지하되, 실데이터 완료 검증에서는 4910 포함과 `scanState=complete`를 요구한다.

## Review Focus

1. 희소 ID 사이의 다른 브랜드·비활성·찜 상품: 출력만 필터링하지 않고 조회한 이력부터 제외한다 — Tasks 1–2.
2. 빈 목록·중복 ID·201 개 이상 목록·동시 필터: 전체 조회로 넓어지거나 조건을 잃지 않고 SQL 당 목록 ID 200 개 이하를 보장한다 — Task 1.
3. 과거 DB 와 증빙 의존 호출: 검증 테이블 누락은 빈 Map, 찜·재검증은 원본 증빙과 가격 의미를 유지한다 — Tasks 1–2.
4. 번호 범위 오류와 보정·미검증 이력: 잘못된 필터는 거부하고 unverified/invalid 가격을 확정가로 승격하지 않는다 — Tasks 1–2.
5. 생성/검증 실패와 배포 트리거: helper 만 바뀌어도 검사하며 실패를 업로드로 넘기지 않고 어느 프로세스가 실패했는지 남긴다 — Task 3.

---

## 실행 전 확인과 파일 구조

계획 작성 시 main HEAD 는 `c3ca69a`이고 `data/4910-all.js`만 기존 미추적 파일이다. 구현을 승인받은 뒤 using-git-worktrees 로 격리하고 AGENTS.md·git 상태를 재확인한다. 테스트는 각 파일 첫 줄의 `tests/setup-env.js`로 운영 DB 를 격리한다. 실행 시 baseline `npm test`를 기록하되 계획 작성 단계에서는 실행하지 않는다.

| 파일 | 책임 / 작업 |
|---|---|
| `src/site4910/price-validation.js` | 필터 교집합, ID 목록 분할, 증빙 projection, iterator 적재 / 1 |
| `tests/site4910-price-validation.test.js` | 공통 조회 계약과 가격 의미 회귀 / 1 |
| `src/visualizer.js` | 조회된 goods 의 정확한 ID 와 증빙 제외 옵션 전달 / 2 |
| `tests/visualizer-data.test.js` | 생산 adapter 의 조회 범위와 가격 이력 / 2 |
| `tests/dashboard-memory.test.js` (신규) | 512MiB 자식 프로세스 메모리 회귀 / 2 |
| `tests/helpers/dashboard-memory-probe.js` (신규) | 임시 DB 를 readOnly 로 열어 생산 adapter 를 실행하는 자식 CLI / 2 |
| `.github/workflows/pages.yml` | helper 트리거·가격 검사·생성/검증 분리·프로세스 계측 / 3 |
| `tests/dashboard-workflow.test.js` (신규) | 배포 실행 조건·검사 선택·단계 경계의 회귀 계약 / 3 |
| `docs/verify/2026-10-25-dashboard-deploy-memory.md` (구현 시 신규) | 입력 hash, 실제 생성/검증 결과와 한계 / 3 |

생산 파일 분리나 새 framework 는 추가하지 않는다. 아래 fixture 와 테스트 이름은 해당 task 에서 정의하며, 기존 test 이름과 helper 에는 의존하지 않는다. 각 task 는 red→green 뒤 지정 파일만 커밋한다.

### Task 1: 정확한 검증 이력 조회 계약

**Files:**
- Modify: `src/site4910/price-validation.js:20-59`
- Test: `tests/site4910-price-validation.test.js`

**Interfaces:**
- Consumes: `DatabaseSync`, `Store4910(':memory:').db`, 기존 `effective4910Price({raw,validation})`.
- Produces: `readPriceValidations(db, kind, {brandSno=null,sno=null,snoFrom=null,snoTo=null,snos=null,includeEvidence=true}={}): Map<string,ValidationRow>`.
- `ValidationRow`: 기존 SQLite row 전체 필드. `includeEvidence=false`에서는 `evidence_json` 속성만 제외한다. 필터와 오류 계약은 spec 과 동일하다.

- [x] **Step 1: 조회 계약 실패 테스트 작성**

기존 테스트 파일에 local `validationFixture()`를 정의한다. `Store4910(':memory:')`와 `t.after()` close 를 사용한다. 날짜는 `2026-10-24`; scan 검증은 각 1 행, 상태 verified, `corrected={sale_price:75900,coupon_price:72110}`, `reason='fixture'`, `evidence={observedDate:'2026-10-24',sentinel:'keep-evidence'}`다. goods 는 ID 1·100000/brand 10, 50000/brand 20, 60000/brand 10·DROPPED 이며, 각 검증 행을 넣는다. ID 1 에는 liked 검증도 추가한다. 아래 테스트를 선언한다.

```js
// filters compose instead of a range discarding the brand
assert.deepEqual([...readPriceValidations(db,'scan',{
  brandSno:10,snoFrom:1,snoTo:100000
}).keys()].sort(), ['100000:2026-10-24','1:2026-10-24','60000:2026-10-24'].sort());
// exact IDs do not infer ACTIVE status; the adapter supplies its active set
assert.deepEqual([...readPriceValidations(db,'scan',{
  snos:[1,100000,1],brandSno:10,snoFrom:1,snoTo:99999
}).keys()], ['1:2026-10-24']);
assert.equal(readPriceValidations(db,'scan',{snos:[]}).size,0);
assert.equal(readPriceValidations(db,'scan',{sno:1}).get('1:2026-10-24').evidence_json,
  JSON.stringify({observedDate:'2026-10-24',sentinel:'keep-evidence'}));
assert.equal(Object.hasOwn(readPriceValidations(db,'scan',{
  snos:[1],includeEvidence:false
}).get('1:2026-10-24'),'evidence_json'),false);
```

`lists larger than 200 keep complete coverage without duplicate reads`는 독립 fixture 에 ID 1–201 을 넣는다. `[...ids,1]`의 Map 크기는 201 이고 SQL 실행을 관찰하는 `db.prepare` wrapper 에서 검증 SELECT 의 iterator 실행이 2 회, 각 실행의 목록 ID 가 200 개 이하이며 중복 행 yield 가 없음을 assertion 으로 고정한다. wrapper 는 실제 SQLite 메서드에 bind 하고 SQL 문자열 전체를 정답으로 비교하지 않는다.

`invalid filters cannot widen a validation read`에 아래 assertions 를 넣는다. `legacy missing table returns an empty map`에서는 별도 `DatabaseSync(':memory:')`에 테이블을 만들지 않고 size 0 을 검사한다. 기본/증빙 제외 결과의 `effective4910Price()`는 모두 72110 이어야 한다.

```js
for (const options of [{snoFrom:1},{snoTo:2},{snoFrom:2,snoTo:1}])
  assert.throws(()=>readPriceValidations(db,'scan',options),RangeError);
for (const snos of [[0],[-1],[1.5],[Number.MAX_SAFE_INTEGER+1]])
  assert.throws(()=>readPriceValidations(db,'scan',{snos}),TypeError);
```

- [x] **Step 2: 실패 확인**

Run: `node --test tests/site4910-price-validation.test.js`
Expected: 브랜드와 범위 교집합 또는 새 목록/projection 계약에서 FAIL. 환경 오류나 unrelated 기존 실패는 red 증거로 쓰지 않는다.

- [x] **Step 3: 공통 조회 함수 구현**

Task 1 의 시그니처를 그대로 구현한다. 옵션을 검증한 뒤 공통 WHERE 에 모든 조건을 AND 로 구성한다. 목록은 Set 으로 중복 제거 후 200 개씩 분리하고 값을 바인딩한다. `snos=null`은 목록 없이 한 query 를 실행한다. spec 의 두 SELECT projection 을 선택하고 `.iterate()` 결과를 Map 에 직접 넣는다. 없는 테이블 처리를 유지하고 `effective4910Price()`는 수정하지 않는다.

- [x] **Step 4: 조회와 공유 호출 회귀 통과 확인**

Run: `node --test tests/site4910-price-validation.test.js tests/site4910-revalidate.test.js tests/site4910-full-verification.test.js tests/visualizer-data.test.js`
Expected: 모든 테스트 PASS. 기존 증빙·보정·미검증 가격 의미가 유지된다.

- [x] **Step 5: 커밋**

```bash
git add src/site4910/price-validation.js tests/site4910-price-validation.test.js
git commit -m "fix(4910): bound validation reads to requested products"
```

### Task 2: 생산 스캔 경로 연결과 메모리 회귀

**Files:**
- Modify: `src/visualizer.js:176-239`
- Test: `tests/visualizer-data.test.js`
- Create: `tests/dashboard-memory.test.js`
- Create: `tests/helpers/dashboard-memory-probe.js`

**Interfaces:**
- Consumes: Task 1 의 `readPriceValidations(...,{snos,includeEvidence:false})`.
- Produces: 기존 `buildScan4910Payload(db,{brandSno=null,snoFrom=null,snoTo=null,context=null}={})`와 반환 `{v,brandSno,lastScan,imgBase,b,m,r}`를 보존한다.
- Produces: 자식 CLI `node tests/helpers/dashboard-memory-probe.js <dbPath>`; readOnly DB 에서 brand 10, 범위 1–100000 의 adapter 를 실행한다. stdout 마지막 줄은 JSON `{ids:[1,100000],historyRows:2}`; 실패는 nonzero 다. historyRows 는 대상 각 1 개 날짜의 합이다.

- [x] **Step 1: 생산 경로 실패 테스트 작성**

`scan validation reads match the selected active non-liked goods`를 `tests/visualizer-data.test.js`에 추가한다. goods 는 ID 1·100000/brand 10 ACTIVE, 50000/brand 20 ACTIVE, 60000/brand 10 DROPPED, 70000/brand 10 ACTIVE liked 로 구성한다. 날짜 `2026-10-24`에 각 price change 와 scan validation 을 넣는다. 대상 1·100000 의 보정 값은 Task 1 과 같다. 마지막 scan 날짜도 같은 날로 둔다.

`db.prepare`를 감싼 실제 SQLite wrapper 로 **iterator 가 반환한 검증 key**와 반환 row 의 속성을 관찰한다. 반환 payload 의 ID 와 읽힌 scan validation ID 가 모두 `[1,100000]`이고 scan validation row 에 evidence_json 속성이 없음을 검사한다. dropped/liked 제외는 adapter 의 기존 goods 조건에 맡긴다. 각 대상의 마지막 history 는 아래와 같다.

```js
assert.deepEqual(payload.r.map(r=>r[0]),[1,100000]);
assert.deepEqual([...observedScanIds].sort((a,b)=>a-b),[1,100000]);
assert.equal(observedEvidenceColumn,false);
assert.deepEqual(payload.r.map(r=>r[7]),[
  [['2026-10-24',90000,75900,72110]],
  [['2026-10-24',90000,75900,72110]],
]);
```

`empty selected goods never reads scan validations`에서는 같은 adapter 를 존재하지 않는 브랜드로 호출해 r 이 비어 있고 검증행 yield 가 0 임을 검사한다. 기존 invalid/unverified, 올바른 가격보정과 raw DB 불변 테스트도 유지한다.

- [x] **Step 2: 512MiB 메모리 회귀 fixture 와 자식 프로세스 추가**

`tests/dashboard-memory.test.js`는 `import './setup-env.js';`로 시작한다. `fs.mkdtempSync()` 아래 파일 DB 에 대상 goods 1·100000/brand 10 을 만들고 각각 하루의 정가 90000/판매가 85200·보정판매가 75900/보정가격 72110 을 넣는다. 무관한 ID 50000–50319/brand 20 의 검증 320 행에는 재사용하는 `JSON.stringify({padding:'가'.repeat(1048576)})`를 증빙으로 저장한다. 거대 문자열 배열은 만들지 않고 transaction 에서 한 행씩 쓰며 Store 를 닫은 뒤 자식을 실행한다. 약 1GiB 임시 DB 이므로 `t.after()`에서 사이드카를 포함해 정리한다.

자식 helper 는 첫 줄에서 `../setup-env.js`를 import 하고 지정 DB 만 readOnly 로 연다. Task 2 의 CLI 계약에 맞는 결과를 검사한 뒤 JSON 을 출력한다. `spawnSync(process.execPath,['--max-old-space-size=512',probePath,dbPath],{encoding:'utf8',timeout:120000,maxBuffer:1048576})`를 사용하고 error 없음·signal 없음·status 0·JSON 일치를 검사한다. 128MiB 등 다른 상한이나 실행시간의 절대 기준은 추가하지 않는다. 의도적으로 OOM/core dump 를 만드는 구버전 비교는 일반 CI 에 넣지 않는다.

- [x] **Step 3: 연결 전 실패 확인**

Run: `node --test --test-name-pattern='scan validation reads match|empty selected goods' tests/visualizer-data.test.js`
Expected: 정확한 읽기 대상 또는 evidence projection assertion 에서 FAIL. Task 1 이 이미 범위 밖 브랜드를 제외하므로, 512MiB 테스트 단독으로 연결 전부터 통과하더라도 이 red 확인을 대신하지 않는다.

- [x] **Step 4: adapter 연결**

`src/visualizer.js`의 `buildScan4910Payload()` 안에서 조회된 goods 로 `goods.map(g=>Number(g.sno))`를 만들고 `readPriceValidations(db4910,'scan',{snos,includeEvidence:false})`에 전달한다. 인수의 범위로 대상을 다시 추측하지 않는다. 상품·가격이력 SQL, 가격 계산, 200 개 iterateBrand, liked export 와 재검증 호출은 유지한다.

- [x] **Step 5: 메모리와 출력 계약 통과 확인**

Run: `node --test tests/visualizer-data.test.js tests/site4910-price-validation.test.js tests/dashboard-memory.test.js tests/dashboard-v2.test.js tests/dashboard-build.test.js tests/dashboard-musinsa.test.js`
Expected: 전체 PASS, 자식 프로세스 status 0, 대상 2 상품·2 이력, 기존 v2 verifier 통과. 실제 대규모 데이터 전체를 512MiB 에서 생성할 수 있다는 뜻은 아니다.

- [x] **Step 6: 커밋**

```bash
git add src/visualizer.js tests/visualizer-data.test.js tests/dashboard-memory.test.js tests/helpers/dashboard-memory-probe.js
git commit -m "fix(dashboard): read only selected scan validation rows"
```

### Task 3: Pages 실행 조건·계측과 실데이터 완료 검증

**Files:**
- Modify: `.github/workflows/pages.yml:5-17,52-79`
- Create: `tests/dashboard-workflow.test.js`
- Create: `docs/verify/2026-10-25-dashboard-deploy-memory.md`

**Interfaces:**
- Consumes: Task 2 의 기존 `node src/cli.js visualize --no-open`, 기존 `node scripts/verify-dashboard-build.js <output>`.
- Produces: named steps `Build dashboard from watched and wide snapshots`, `Verify generated dashboard`. 두 Node 에 `--max-old-space-size=4096`을 지정하고 각 프로세스를 `/usr/bin/time -v`로 계측한다.
- Produces: 현재와 같은 `_site/index.html`, assets, worker, robots 와 Pages artifact. 검증 기록은 입력 hash·상품/key 대조·exit code·최대 RSS·시간·공개 확인 상태를 담는다.

- [x] **Step 1: workflow 계약 실패 테스트 추가**

`tests/dashboard-workflow.test.js`를 setup-env import 로 시작한다. 기존 `tests/musinsa-point-workflow.test.js`처럼 YAML text 를 readFile 한다. `deploy observes the validation helper and runs its regression tests`에서 push paths 안의 `src/site4910/price-validation.js`와 테스트 run 안의 `tests/site4910-price-validation.test.js`를 검사한다. `build and verification keep separate measured failure boundaries`에서는 두 named step, 각 Node 의 4096 지정·time wrapper, 생성 step 의 `CLOT_REQUIRE_MUSINSA_WIDE: '1'`과 opt-in env, 검증 step 이 upload 앞에 있음을 검사한다. 대상 step 에 `continue-on-error`나 실패를 숨기는 `|| true`가 없는지도 검사한다. 기존 4910 pull 의 warning fallback 에는 적용하지 않는다.

- [x] **Step 2: 실패 확인**

Run: `node --test tests/dashboard-workflow.test.js`
Expected: helper trigger 또는 분리된 검증 step 누락으로 FAIL.

- [x] **Step 3: workflow 변경**

push paths 에 helper 의 정확한 path 를 추가하고 기존 node:test run 에 가격검증 test 를 추가한다. `tests/dashboard-*.test.js`가 신규 memory/workflow tests 를 이미 포함하므로 중복 추가하지 않는다. 생성 step 의 환경변수를 유지하고 `/usr/bin/time -v node --max-old-space-size=4096 src/cli.js visualize --no-open`으로 실행한다. robots/HTML/worker 존재 검사를 유지한다. 별도 step `Verify generated dashboard`는 `/usr/bin/time -v node --max-old-space-size=4096 scripts/verify-dashboard-build.js _site/index.html`로 실행한다. 셸의 실패 전파를 유지하고 계측 출력을 stdout/stderr 에서 숨기지 않는다. 20 분 timeout 과 permissions, 기존 Release 취득은 유지한다.

- [x] **Step 4: 자동 검사**

Run: `npm test`
Expected: 전체 PASS. 신규 helper 가 단독 test 로 발견되지 않는지도 확인한다.

Run: `npm run test:dashboard:browser`
Expected: 전체 PASS. 필요한 기존 Chromium 이 없는 경우만 `npx playwright install chromium`을 먼저 실행한다. fixture 준비·테스트 실패는 기록하고 수정 전 baseline 과 구분한다.

- [x] **Step 5: 고정한 실데이터로 생성과 검증 계측**

실행 시 `/tmp/` 아래 새 작업 디렉터리를 만들고 watched DB 의 일관된 복사본, Release 의 `4910.db.gz`와 `musinsa-wide.db.gz`를 준비한다. GitHub 취득은 `gh release download -R jjundev/project-clot ...`을 사용한다. 압축 해제한 3 입력의 날짜·size·SHA-256 과 취득한 asset 을 기록하고 이후 같은 복사본을 쓴다. 조사 시의 `/tmp/clot-dashboard-oom.Yy6NQ1/4910.db`는 존재·hash 가 일치하면 재사용할 수 있으나 필수 입력으로 삼지 않는다.

CLI 가 watched singleton 을 초기화하므로 `CLOT_DB_PATH`는 반드시 복사본을 가리켜야 한다. `CLOT_4910_DB_PATH`, `CLOT_MUSINSA_WIDE_DB_PATH`, `CLOT_DASHBOARD_PATH`도 모두 임시 절대 path 로 설정하고 `CLOT_REQUIRE_MUSINSA_WIDE=1`과 실제 opt-in 설정값을 전달한다. 모든 DB 의 최신일과 source 별 대상 건수를 SQL 로 독립 계산한다. 대상은 wide ACTIVE, 거기에 없는 watched ACTIVE/SOLDOUT, 4910 ACTIVE liked, 거기에 없는 4910 ACTIVE scan 이며 key 는 retailer 로 이름공간을 나눈다.

Ubuntu 에서는 Step 3 의 두 명령을 쓴다. macOS 에서는 같은 Node 인수에 `/usr/bin/time -l`을 붙이고 RSS 의 bytes 를 KiB 로 환산해 기록한다. 4GiB 는 V8 힙 상한이며 RSS 상한으로 취급하지 않는다.

Expected: 생성 exit 0, verifier exit 0, scanState complete, 상품총수·source 별 건수·전체 key 집합이 독립 SQL 기대값과 일치. key 집합은 indexParts 를 unpack 해서 비교하고 count 일치만으로 끝내지 않는다. 가격/전체이력 정합성은 기존 verifier 와 Task 2 의 알려진 fixture 를 모두 사용해 확인한다. 생성파일의 byte 일치는 revision 등이 달라지므로 요구하지 않는다.

Expected: 입력 DB 원본 hash 불변. watched 복사본만 CLI 초기화 가능성이 있으므로 실행 전후를 구분한다. 생성·검증 어느 쪽이든 OOM, 4910 이 제외된 partial 성공, 20 분 timeout 초과가 있으면 미완료로 계측값을 기록하고 검증기 재설계나 timeout 변경을 임의로 추가하지 않는다.

- [x] **Step 6: 검증 기록 작성과 커밋**

`docs/verify/2026-10-25-dashboard-deploy-memory.md`에 baseline/변경 후 테스트, 고정입력 hash 와 기대건수·key 대조, 생성/검증 각각의 시간·최대 RSS·exit code 를 기록한다. 이전 OOM 로그는 관측값으로 인용하고 측정하지 않은 개선배율을 만들지 않는다. 원본의 거대한 증빙, 비밀정보, DB 본체는 추가하지 않는다.

```bash
git add .github/workflows/pages.yml tests/dashboard-workflow.test.js docs/verify/2026-10-25-dashboard-deploy-memory.md
git commit -m "ci(dashboard): measure build and verification memory separately"
```

- [x] **Step 7: 통합과 공개 상태 인계**

차분 리뷰 후 선택된 실행방식과 finishing-a-development-branch 에 따라 통합한다. push/merge/운영 deploy 는 기존 사용자 승인범위를 확인한다. 승인이 있으면 Pages 실행의 생성·검증·upload·deploy 각각의 성공과 공개 URL 을 확인한다. 미승인이라면 로컬 수정검증 완료·공개 미확인을 명확히 구분하고 공개 성공을 주장하지 않는다.

## 자체 검토

- Spec coverage: 필터·projection 은 Task 1, 실제 대상 연결·512MiB 는 Task 2, trigger·time·4096MiB 실데이터 검증은 Task 3 에 배정했다. 검증기 재설계는 제외를 유지한다.
- Step scan: fixture 의 ID·날짜·값, 함수 인수·반환값, 명령과 성공조건을 지정했다. 구현 본체를 옮겨 쓰지 않고 기존 모듈 안에서 완료한다.
- Type consistency: `snos`, `includeEvidence`, Map key, 자식 JSON 이름을 모든 task 에서 통일했다.
- Review Focus: 다섯 항목 모두 담당 task 의 테스트가 있다. 메모리 test 는 production 연결의 읽기 관찰과 함께 사용한다.
- Proportion: 공통 helper·adapter·CI 의 세 작업으로 나눴고 UI 변경이나 미확인 검증기 최적화를 섞지 않았다.

## 실행 방식

세 task 가 같은 helper 계약을 순서대로 사용하므로 Native 를 권장한다. 구현과 개별 검증은 이 세션의 담당이 진행하고 마지막에 독립된 전체차분 리뷰를 수행한다. Subagent-driven 을 선택하면 각 task 의 구현·리뷰를 분리한다. 2026-10-25 사용자가 Native 방식으로 구현하고 실제 데이터 생성·검증까지 수행하도록 승인했다.


## 실행 결과

Native 구현과 로컬 실데이터 생성·검증을 완료했다. 세부 수치와 입력 hash는 `docs/verify/2026-10-25-dashboard-deploy-memory.md`에 기록한다. 최종 독립 리뷰에서 지적사항이 없었다. 원격 배포는 아직 실행하지 않았으며 main 통합·PR·브랜치 보존 중 선택을 사용자에게 인계한다.
