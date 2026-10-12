# 4910 쿠폰 학습 병렬화와 숨김 원인별 요약 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `learnMarketCoupons`의 셀러 처리를 클라이언트 풀(동시 3)로 나눠 17분 걸리던 쿠폰 학습을 약 6분으로 줄이고, 텔레그램 요약의 숨김 셀러 수를 원인별(범위 한정 · 네이버 · 불일치)로 나눈다.

**Architecture:**
- `track.js`의 `clientPool`을 `src/pool.js`로 옮겨 export한다.
- `learnMarketCoupons`는 `withClient`와 `concurrency`를 주입받아 `mapConcurrent`로 셀러를 처리한다. `client`만 넘기면 동시 1로 동작해 기존 테스트가 그대로 통과한다.
- 범위 분류 캐시는 쿠폰 sno → Promise로 바꾼다. 토큰 만료는 공유 `stopped` 플래그와 다시 던지기로 전체를 멈춘다.
- 숨김 원인은 학습 중에 `couponSetOf` 결과와 오늘의 쿠폰 행으로 판정한다.

**Tech Stack:** Node 24 ESM, `node:sqlite`, `node:test`

**Spec:** `docs/specs/2026-10-11-4910-coupon-parallel.md`. 배경은 `docs/specs/2026-10-11-4910-top100-sellers.md`와 `docs/verify/4910-member-price.md`이다.

## Global Constraints
- 토큰 값은 로그, 에러 메시지, 텔레그램, 채팅 어디에도 출력하지 않는다.
- 로컬에서 `daily`, dry-run이 아닌 `track-4910`, `4910-db push`를 실행하지 않는다.
- 작업은 `origin/main`에서 만든 새 worktree와 브랜치 `perf/4910-coupon-parallel`에서 한다.
  - main 체크아웃은 건드리지 않는다. 로컬 main은 origin보다 뒤처져 있고, 추적되지 않은 docs가 pull과 충돌한다.
- push, PR 생성, workflow 실행은 사용자 승인을 받은 뒤에 한다.
- `npm test`(현재 668개 통과)는 각 task 끝에 모두 통과해야 한다.
- 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`를 붙인다.
- 문구(정확히 이대로):
  - 요약: `⚠️ 쿠폰가 숨김 셀러 ${N}곳 (범위 한정 ${a} · 네이버 ${b} · 불일치 ${c})` (숫자는 `fmt`)
  - 예산 로그: `⚠️ [4910] 실행 예산 초과 — 판매처 ${n}곳 쿠폰 확인 생략 (쿠폰가 없음)`

## Review Focus
1. 같은 `listed` 쿠폰을 쓰는 두 셀러가 동시에 처리될 때: 두 번째 셀러는 첫 셀러가 저장한 상품 목록으로 자가 검증하고 가격을 받아야 한다. → Task 2 `two sellers sharing a listed coupon…`
2. 두 셀러가 함께 기다리는 범위 분류에서 MEMBER_AUTH가 날 때: `expired`로 한 번만 끝나고 unhandled rejection이 없어야 한다. → Task 2 `a MEMBER_AUTH inside a shared scope lookup…`
3. 실행 중 예산이 지날 때: 진행 중인 셀러는 끝까지 처리하고, 시작 안 한 셀러만 세어 로그를 한 번 남겨야 한다. → Task 2 `the deadline passing mid-run…`
4. 한 셀러가 범위 한정 쿠폰과 네이버 쿠폰을 함께 가질 때: 범위 한정으로 한 번만 세어야 한다. → Task 1 `a seller with both a category and a naver coupon counts once, as scope`
5. track 전체 실행에서 쿠폰 학습이 클라이언트를 더 만들지 않아야 한다(`makeClient` 호출 ≤ `concurrency`). → Task 2 track 테스트

---

### Task 1: 숨김 원인별 숫자(`hidden`)

**Files:**
- Modify: `src/site4910/coupons.js` (`learnMarketCoupons` 결과 초기값 `:142`, mismatch 집계 `:216-236`, 새 헬퍼 `hiddenReason`)
- Modify: `src/site4910/track.js:115` (에러 대체 객체)
- Test: `tests/site4910-coupons.test.js`, `tests/site4910-track.test.js:229`

**Interfaces:**
- Produces: `learnMarketCoupons(...)`의 결과 → `{ memberStatus, wallet, walletChanges, emoney, eligible, mismatched, hidden: { scope: number, naver: number, mismatch: number } }`. `none`, `expired`, track `error`까지 모든 경로에 `hidden`이 있다. Task 3이 이 필드를 읽는다.

- [ ] **Step 1: worktree를 만들고 spec·plan을 커밋한다**

```bash
git -C /Users/hyunjun_macbook_pro/Documents/Private/project-clot fetch origin
git -C /Users/hyunjun_macbook_pro/Documents/Private/project-clot worktree add .claude/worktrees/4910-coupon-parallel -b perf/4910-coupon-parallel origin/main
```

main 체크아웃의 `docs/specs/2026-10-11-4910-coupon-parallel.md`와 `docs/plans/2026-10-11-4910-coupon-parallel.md`를 worktree의 같은 경로로 복사하고 `docs: 4910 coupon learning parallel spec and plan`으로 커밋한다. 이후 모든 명령은 worktree에서 실행한다. `npm test` → 668 pass.

- [ ] **Step 2: 실패하는 테스트를 쓴다** (`tests/site4910-coupons.test.js`, `outer20` 정의 아래)

```js
const NONE_HIDDEN = { scope: 0, naver: 0, mismatch: 0 };
const naver10 = { couponSno: 555, name: '[4910][네이버 전용]10% 쿠폰', discount: 8540, percent: 10, price: null, max: Infinity, min: 0 };

test('hidden splits the hidden sellers by reason', async () => {
  seed(goods(1, 10, 199000), goods(2, 20, 85400), goods(3, 30, 85400), goods(4, 40, 85400));
  const client = fakeClient({
    best: { 10: outer20(39800), 20: naver10, 30: wallet20(17000), 40: wallet20(17080) },
    couponGoods: { 51345873: { total: 121000, pages: [[1]] } }, couponCats: { 51345873: ['아우터', '스포츠/레저'] },
  });
  const res = await learn(client, [10, 20, 30, 40]);
  assert.equal(res.mismatched, 3);
  assert.deepEqual(res.hidden, { scope: 1, naver: 1, mismatch: 1 });
});

test('a seller with both a category and a naver coupon counts once, as scope', async () => {
  seed(goods(1, 10, 199000), goods(2, 10, 85400));
  const client = fakeClient({
    best: { 10: outer20(39800), 20: naver10 },
    couponGoods: { 51345873: { total: 121000, pages: [[1]] } }, couponCats: { 51345873: ['아우터'] },
  });
  const res = await learn(client, [10]);
  assert.equal(res.mismatched, 1);
  assert.deepEqual(res.hidden, { scope: 1, naver: 0, mismatch: 0 });
});
```

기존 테스트도 고친다.
- `learnMarketCoupons records a seller-only coupon…`(`:174`)과 `no token returns none…`(`:257`, `:263`)의 `deepEqual` 기대값에 `hidden: NONE_HIDDEN`을 넣는다.
- `scope lookup failure hides the seller`에 `assert.deepEqual(res.hidden, { scope: 2, naver: 0, mismatch: 0 });`을 추가한다.
- `a listed coupon whose list is cut short hides the seller`에 `assert.equal(res.hidden.scope, 1);`을 추가한다.
- `tests/site4910-track.test.js:229`의 기대값에 `hidden: { scope: 0, naver: 0, mismatch: 0 }`을 넣는다.

- [ ] **Step 3: 실패를 확인한다**

Run: `node --test tests/site4910-coupons.test.js tests/site4910-track.test.js`
Expected: FAIL, 새 테스트 2개와 수정한 `deepEqual`들에서 `hidden`이 `undefined`

- [ ] **Step 4: 구현한다**
- 결과 초기값에 `hidden: { scope: 0, naver: 0, mismatch: 0 }`을 추가한다.
- `coupons.js`에 모듈 함수 `hiddenReason(snos, rows, date, walletSnos) → 'scope' | 'naver'`를 둔다. 판정 순서가 규칙이므로 본문을 고정한다.

```js
// Why couponSetOf hid a seller: a category-scoped, unclassified or unseen seller-only coupon reads as 'scope' before 'naver'.
function hiddenReason(snos, rows, date, walletSnos) {
  const scopes = snos.filter((sno) => !walletSnos.has(sno)).map((sno) => sellerCouponSeen(rows, sno, date)[0]?.scope ?? null);
  return scopes.some((s) => s === 'category' || s == null) || !scopes.includes('naver') ? 'scope' : 'naver';
}
```

- 집계 부분(`:236`)을 바꾼다. `if (mismatch) { result.mismatched++; result.hidden[setFor ? 'mismatch' : hiddenReason(snos, rows, date, walletSnos)]++; }`
  - `rows`는 `couponSetOf`에 넘긴 그 `store.getWallet()` 값을 변수로 받아 같이 쓴다.
- `track.js:115`의 대체 객체에 `hidden: { scope: 0, naver: 0, mismatch: 0 }`을 넣는다.

- [ ] **Step 5: 통과를 확인한다**

Run: `npm test`
Expected: 모두 PASS (670개)

- [ ] **Step 6: 커밋한다**

```bash
git add src/site4910/coupons.js src/site4910/track.js tests/site4910-coupons.test.js tests/site4910-track.test.js
git commit -m "feat(4910): count hidden coupon sellers by reason (scope, naver, mismatch)"
```

---

### Task 2: 셀러 단위 병렬 학습

**Files:**
- Modify: `src/pool.js` (`clientPool` 추가)
- Modify: `src/site4910/track.js:17-29` (`clientPool` 삭제 후 import), `:111` (호출 방식), `:53` 순서 주석
- Modify: `src/site4910/coupons.js:137-239` (`learnMarketCoupons`), 머리말 주석 `:1-4`
- Test: `tests/site4910-coupons.test.js`, `tests/site4910-track.test.js`

**Interfaces:**
- Consumes: Task 1의 `result.hidden`, `hiddenReason`
- Produces:
  - `export function clientPool(makeClient: () => Client): <T>(fn: (client: Client) => Promise<T>) => Promise<T>` (`src/pool.js`, 동작은 지금 `track.js` 것과 같음)
  - `learnMarketCoupons({ client, withClient = (fn) => fn(client), concurrency = 1, store, date, marketSnos, memberToken, deadline = Infinity, log = console.log })` → 반환 형태는 Task 1과 같음

- [ ] **Step 1: 실패하는 테스트를 쓴다** (`tests/site4910-coupons.test.js`)

import에 `import { clientPool } from '../src/pool.js';`를 추가하고, 헬퍼와 테스트를 넣는다.

```js
// Clients over one fake (shared config and calls): each request waits delayMs; stats track requests in flight,
// overall and per client, and how many clients were made.
function pooled(base, delayMs = 5) {
  const stats = { inFlight: 0, max: 0, perClientMax: 0, clients: 0 };
  const make = () => {
    stats.clients++;
    let mine = 0;
    const wrap = (fn) => async (...args) => {
      stats.inFlight++; mine++;
      stats.max = Math.max(stats.max, stats.inFlight);
      stats.perClientMax = Math.max(stats.perClientMax, mine);
      try { await new Promise((r) => setTimeout(r, delayMs)); return await fn(...args); } finally { stats.inFlight--; mine--; }
    };
    return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, typeof v === 'function' ? wrap(v) : v]));
  };
  return { withClient: clientPool(make), stats };
}
const sixSellers = () => seed(...[1, 2, 3, 4, 5, 6].map((i) => goods(i, i * 10, 85400)));

test('six sellers on three clients: at most three at once, one request per client, wallet and points once', async () => {
  sixSellers();
  const base = fakeClient({ best: Object.fromEntries([10, 20, 30, 40, 50, 60].map((o) => [o, wallet20(17080)])) });
  const { withClient, stats } = pooled(base);
  const res = await learn(base, [10, 20, 30, 40, 50, 60], [], { withClient, concurrency: 3 });
  assert.equal(stats.max, 3);
  assert.equal(stats.clients, 3);
  assert.equal(stats.perClientMax, 1);
  assert.equal(base.calls.coupons, 1);
  assert.equal(base.calls.me, 1);
  assert.equal(res.eligible, 6);
  assert.equal(store.getMarketCoupons(DATE).size, 6);
});

test('two sellers sharing a listed coupon classify it once and both get the listed price', async () => {
  seed(goods(1, 10, 199000), goods(2, 20, 199000));
  const base = fakeClient({ wallet: W18, best: { 10: sports20(39800), 20: sports20(39800) }, couponGoods: { 777: { total: 2, pages: [[1, 2]] } } });
  let sets = 0;
  const setCouponGoods = store.setCouponGoods.bind(store);
  store.setCouponGoods = (...a) => { sets++; return setCouponGoods(...a); };
  const { withClient } = pooled(base);
  const res = await learn(base, [10, 20], [], { withClient, concurrency: 2 });
  assert.equal(base.calls.goodsPages.filter((p) => p.couponSno === 777 && p.limit === 1).length, 1);
  assert.equal(sets, 1);
  assert.equal(res.mismatched, 0);
  applyCouponPrices({ store, date: DATE });
  assert.equal(store.getGoods(1).coupon_price, 159200);
  assert.equal(store.getGoods(2).coupon_price, 159200);
});

test('a token expiring mid-run starts no further seller', async () => {
  sixSellers();
  const base = fakeClient({ best: { 10: authErr(), ...Object.fromEntries([20, 30, 40, 50, 60].map((o) => [o, wallet20(17080)])) } });
  const { withClient } = pooled(base);
  const res = await learn(base, [10, 20, 30, 40, 50, 60], [], { withClient, concurrency: 3 });
  assert.equal(res.memberStatus, 'expired');
  assert.deepEqual(base.calls.detail.filter((sno) => sno > 3), []);
  assert.deepEqual([...store.getMarketCoupons(DATE).keys()].filter((m) => m > 30), []);
});

test('a MEMBER_AUTH inside a shared scope lookup ends as expired once', async () => {
  seed(goods(1, 10, 85400), goods(2, 20, 85400));
  const own603 = { couponSno: 603, name: 'seller 603 5%', discount: 4270, percent: 5, price: null, max: Infinity, min: 0 };
  const base = fakeClient({ best: { 10: own603, 20: own603 }, couponGoods: { 603: authErr() } });
  const { withClient } = pooled(base);
  const logs = [];
  const res = await learn(base, [10, 20], logs, { withClient, concurrency: 2 });
  assert.equal(res.memberStatus, 'expired');
  assert.equal(base.calls.goodsPages.length, 1);
  assert.equal(store.getMarketCoupons(DATE).size, 0);
  assert.ok(logs.every((l) => !String(l).includes(SECRET)));
});

test('the deadline passing mid-run lets running sellers finish and logs the skipped count once', async () => {
  seed(goods(1, 10, 85400), goods(2, 20, 85400), goods(3, 30, 85400));
  const base = fakeClient({ best: { 10: wallet20(17080), 20: wallet20(17080), 30: wallet20(17080) } });
  // 50 ms a request: wallet + points end near 100 ms, sellers 10 and 20 start there and end near 200 ms, after the 150 ms deadline
  const { withClient } = pooled(base, 50);
  const logs = [];
  await learn(base, [10, 20, 30], logs, { withClient, concurrency: 2, deadline: Date.now() + 150 });
  assert.deepEqual([...base.calls.detail].sort(), [1, 2]);
  assert.deepEqual([...store.getMarketCoupons(DATE).keys()].sort(), [10, 20]);
  assert.deepEqual(logs.filter((l) => /예산/.test(l)), ['⚠️ [4910] 실행 예산 초과 — 판매처 1곳 쿠폰 확인 생략 (쿠폰가 없음)']);
});
```

`tests/site4910-track.test.js`의 `with a member token the qualified sellers get coupon prices`에 `assert.ok(makeClient.calls <= 3);`를 추가한다. 테스트 안의 `fakeClients(...)` 결과를 `makeClient` 변수로 받아 쓴다.

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test tests/site4910-coupons.test.js tests/site4910-track.test.js`
Expected: FAIL, `clientPool`이 `src/pool.js`에 없다는 SyntaxError(import)

- [ ] **Step 3: `clientPool`을 옮긴다**

`track.js`의 `clientPool`을 주석과 함께 `src/pool.js`로 옮겨 `export`하고, `track.js`는 `import { mapConcurrent, clientPool } from '../pool.js'`로 가져온다.

- [ ] **Step 4: `learnMarketCoupons`를 병렬화한다** (`coupons.js`)
- 쿠폰함과 포인트 조회는 `await withClient(async (client) => { … })` 한 번 안에서 지금 순서 그대로 한다(`getMyCoupons` → `replaceWallet` → `getMe`).
- `scopes: Map<couponSno, Promise<scope>>`
  - 없으면 `classifyCoupon({ client, store, date, memberToken, best, log })`의 Promise를 넣고, 있으면 그것을 `await`한다.
  - `addMarketCoupon`은 await 뒤에 호출한다.
- 셀러 루프 본문을 내부 함수 `learnSeller(client, marketSno)`로 옮긴다. MEMBER_AUTH는 `return expired()` 대신 `stopped = true; throw err;`로 바꾼다. 처리 위치는 best-coupon과 범위 분류 두 군데다.
- 각 표본 처리 앞에 `if (stopped) return;`를 둔다.
- 셀러 처리 루프:

```js
let stopped = false;
let skipped = 0;
try {
  await mapConcurrent(marketSnos, concurrency, (marketSno) => {
    if (stopped) return;
    if (Date.now() > deadline) { skipped++; return; }
    return withClient((client) => learnSeller(client, marketSno));
  });
} catch (err) {
  if (err.code === 'MEMBER_AUTH') return expired();
  throw err;
}
if (skipped) log(`⚠️ [4910] 실행 예산 초과 — 판매처 ${skipped}곳 쿠폰 확인 생략 (쿠폰가 없음)`);
```

- 머리말 주석(`:1-4`)과 `learnMarketCoupons` JSDoc에 "셀러는 `withClient`의 클라이언트로 `concurrency`개씩 동시에 처리하고, 범위 분류는 쿠폰당 한 번"을 한 줄 넣는다.

- [ ] **Step 5: track이 풀을 넘기게 한다** (`track.js:111`)

바깥 `withClient(...)` 감싸기를 없애고 `learnMarketCoupons({ withClient, concurrency, store, date, marketSnos: [...qualified], memberToken, deadline: runDeadline, log })`로 호출한다. `:53` 순서 주석의 `coupons`를 `coupons (concurrent per seller)`로 바꾼다.

- [ ] **Step 6: 통과를 확인한다**

Run: `npm test`
Expected: 모두 PASS (675개). 기존 `MEMBER_AUTH returns expired and stops`(`best` 호출 `[10, 20]`)와 예산 테스트(로그 1개)도 그대로 통과한다.

- [ ] **Step 7: 커밋한다**

```bash
git add src/pool.js src/site4910/track.js src/site4910/coupons.js tests/site4910-coupons.test.js tests/site4910-track.test.js
git commit -m "perf(4910): learn seller coupons concurrently on the client pool"
```

---

### Task 3: 요약 문구

**Files:**
- Modify: `src/site4910/digest.js:34`
- Test: `tests/site4910-digest.test.js:188-192`, `:247`

**Interfaces:**
- Consumes: `coupons.hidden?: { scope, naver, mismatch }` (Task 1). 없으면 `{ scope: 0, naver: 0, mismatch: coupons.mismatched }`로 본다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`mismatch adds a warning line`을 다음으로 바꾼다.

```js
test('hidden sellers add one line split by reason', () => {
  const text = format4910Digest({ ...result, coupons: coupons({ mismatched: 64, hidden: { scope: 36, naver: 4, mismatch: 24 } }) });
  assert.match(text, /^⚠️ 쿠폰가 숨김 셀러 64곳 \(범위 한정 36 · 네이버 4 · 불일치 24\)$/m);
  const old = format4910Digest({ ...result, coupons: coupons({ mismatched: 3 }) });
  assert.match(old, /^⚠️ 쿠폰가 숨김 셀러 3곳 \(범위 한정 0 · 네이버 0 · 불일치 3\)$/m);
  assert.doesNotMatch(format4910Digest({ ...result, coupons: coupons() }), /숨김/);
});
```

`:247`의 `/쿠폰 계산 불일치/`는 `/쿠폰가 숨김 셀러 1곳/`로 바꾼다. `/불일치/`를 쓰는 부정 검사(`:203`, `:210`)는 그대로 둔다. error나 expired일 때는 숨김 줄이 없으므로 계속 통과한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test tests/site4910-digest.test.js`
Expected: FAIL, 새 문구를 찾지 못함

- [ ] **Step 3: `digest.js:34`를 Global Constraints의 요약 문구로 바꾼다** (`hidden`이 없으면 위 기본값 사용)

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test`
Expected: 모두 PASS

- [ ] **Step 5: 커밋한다**

```bash
git add src/site4910/digest.js tests/site4910-digest.test.js
git commit -m "feat(4910): digest shows hidden coupon sellers by reason"
```

---

### Task 4: 배포 확인과 정리 (사용자 승인 단계)

**Files:** 없음(저장소 변경 없음). 대조 스크립트는 세션 scratchpad에 둔다.

- [ ] **Step 1: push와 PR** — 사용자 승인 후 `git push -u origin perf/4910-coupon-parallel`, `gh pr create`(본문 끝에 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`). merge도 사용자가 한다.
- [ ] **Step 2: scan 실행** — merge 후 사용자 승인을 받고 `gh workflow run 4910.yml -f mode=scan`를 실행한다. 끝나면 `gh run view <id> --log`에서 다음을 확인한다.
  - `예산` 줄이 없다.
  - `4910 sellers:` 줄 시각에서 `💜` 줄 시각까지 약 6분(10분 이하)이다.
  - 텔레그램 요약에 `쿠폰가 숨김 셀러 N곳 (범위 한정 a · 네이버 b · 불일치 c)`가 나오고, a + b + c = N이다.
- [ ] **Step 3: 쿠폰가 대조** — `node src/cli.js 4910-db pull`로 받은 DB를 scratchpad로 복사한다. scratchpad에 스크립트를 써서 다음을 한다.
  - `coupon_price IS NOT NULL`인 ACTIVE 판매글을 셀러가 겹치지 않게 30개 고른다.
  - 각각 `createClient()`의 `getGoodsDetail(sno)`(비로그인)로 `listPrice`와 `optionSno`를 받는다.
  - `getBestCoupon(optionSno, { memberToken: process.env.ABLY_JWT_TOKEN })`으로 할인을 받는다.
  - `Math.ceil((listPrice − discount) / 10) * 10`을 `coupon_price`와 비교해 일치 수와 불일치 목록(sno, 셀러, 두 값)을 출력한다. 토큰은 출력하지 않는다.
  - 기준은 지난번 결과인 29/30 이상이다.
- [ ] **Step 4: 정리**
  - `git branch --merged origin/main`에 `feat/4910-top100-sellers`, `fix/4910-coupon-sets`, `perf/4910-coupon-parallel`이 있는지 확인한다.
  - `git worktree remove .claude/worktrees/4910-top100`, `… 4910-coupon-sets`, `… 4910-coupon-parallel`을 실행하고, `git branch -d`로 세 브랜치를 지운다.
  - `4910-top100` 안의 `.superpowers/sdd/…`는 추적되지 않는 파일이라 `remove`가 거부하면 사용자에게 확인한 뒤 `--force`를 쓴다.
