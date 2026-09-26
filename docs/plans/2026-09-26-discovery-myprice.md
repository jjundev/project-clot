# Discovery 실제가(나의 할인가) 기록 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `discover`/`daily --with-discovery`가 카탈로그 스캔 뒤 discovery 상품 최대 120개의 실제가를 인증 HTTPS로 받아 `price_logs.my_price`에 기록하고, 추정가와 섞지 않고 비교·표시한다.

**Architecture:** `handleDiscover`를 "스캔 → 인증 → 기록" 3단계로 나눈다. 인증 단계는 기존 `collectAuthenticatedPrices`(순차 700ms, 1회 refresh, 연속 3회 차단기)를 그대로 재사용하고, 대상 선정·통계는 `src/discovery.js`의 순수 함수로 둔다. 목록 추정가는 지금처럼 `estimated_my_price`에 계속 기록하고, 실제가는 `my_price`에만 넣는다.

**Tech Stack:** Node 24 ESM, `node:sqlite`, `node:test`. 의존성 없음.

**Spec:** `docs/plans/2026-09-26-discovery-myprice-design.md`

## Global Constraints

- 작업은 `main`에서 worktree를 따서 한다. `.claude/worktrees/musinsa-429-bypass-018933`은 건드리지 않는다.
- 검증은 `npm test`만. `node src/cli.js daily`/`sync`/`discover`/`track`은 실행하지 않는다(수집·푸시·DB 변경).
- 테스트는 네트워크에 닿지 않는다: `discoverFn`, `authFetchFn`, `sessionProvider`를 주입하고 DB는 `new ClotDatabase(<임시 경로>)`, 내보내기는 `dataDir: <임시 디렉터리>`.
- 모든 테스트 파일의 첫 import는 `import './setup-env.js';` (tests/test-isolation.test.js가 강제).
- 쿠키·토큰 값은 로그, 에러 메시지, 테스트 출력에 남기지 않는다. 테스트의 가짜 쿠키는 `'app_atk=fake'` 같은 고정 문자열만.
- 무신사 요청은 순차, 700ms 간격 (`authDelayMs` 기본값 700 유지).
- 추정가와 실제가를 서로 비교하지 않는다. 입력이 불완전하면 추정하지 말고 `my_price`를 null로 둔다.
- 커밋은 Conventional Commits, 마지막 줄은 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- 인증 상한 기본값 120 (`--auth-limit`), discovery 실행은 수동 유지, discovery 하락은 콘솔 로그만.

## Review Focus

1. **여러 카테고리에 같은 상품이 나옴** — 인증 요청은 한 번, 기록도 한 번이어야 한다. → Task 4 테스트 `dedupes goods seen in two categories`.
2. **인증 응답이 단종(404, `{ discontinued: true }`)** — 크래시 없이 `my_price` null로 기록. → Task 4 테스트 `discontinued auth result records no my_price`.
3. **`--auth-limit` 0 / 음수 / 문자열** — 0은 인증 단계를 통째로 건너뛰고, 잘못된 값은 기본값 120. → Task 2 `parseAuthLimit` 테스트, Task 4 `authLimit 0 skips the auth stage`.
4. **discovery 스캔에 VIP 상품이 섞임** — VIP는 인증 요청 대상도 아니고 가격 기록도 바뀌지 않는다. → Task 4 테스트 `never auth-fetches or records VIP items`.
5. **VIP의 최신 기록에 추정가만 있는 날(deferred)** — 최저가 칸에 실제 최저가를 짝지어 보여 주지 않는다(`-`). → Task 3 테스트 `estimate-only latest does not pair with a real lowest`.

---

## File Structure

- `src/db.js` — `getLastMyPriceDates(goodsNos)` 추가, `updateLowestEstimatedPrice`의 날짜 덮어쓰기 막기.
- `src/discovery.js` — 순수 함수 `parseAuthLimit`, `selectDiscoveryAuthTargets`, `summarizeMyPriceGap`, 상수 `DEFAULT_DISCOVERY_AUTH_LIMIT`.
- `src/cli.js` — `pickDisplayPrices` 추가·적용, `handleDiscover` 재구성, daily/discover 배선, 도움말.
- `src/notifier.js` — `formatHotDealsSummary`에 실제가 표시.
- `tests/discovery-myprice.test.js` — 이번 작업의 새 테스트 전부.

---

### Task 1: DB — 마지막 실제가 날짜 조회와 최저가 날짜 보호

**Files:**
- Modify: `src/db.js` (`updateLowestEstimatedPrice` ~249-256, 그 아래에 새 메서드)
- Test: `tests/discovery-myprice.test.js` (새 파일)

**Interfaces:**
- Produces: `ClotDatabase#getLastMyPriceDates(goodsNos: number[]): Map<number, string>` — `my_price`가 있는 기록의 최신 `date`(YYYY-MM-DD). 기록이 없는 상품은 Map에 없다.
- Produces: `updateLowestEstimatedPrice(goodsNo, price, date)` — `lowest_my_price`가 NULL일 때만 `lowest_price_date`를 바꾼다.

- [ ] **Step 1: Write the failing tests**

`tests/discovery-myprice.test.js`:

```js
import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClotDatabase } from '../src/db.js';

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-disc-myprice-'));
  const db = new ClotDatabase(path.join(dir, 'test.db'));
  t.after(() => {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir };
}

test('db: getLastMyPriceDates returns latest date with a real my_price only', (t) => {
  const { db } = tempDb(t);
  for (const g of [1, 2, 3]) db.upsertItem({ goods_no: g, goods_name: `G${g}`, source: 'discovery' });
  db.recordPriceLog({ goods_no: 1, date: '2026-09-20', my_price: 1000, estimated_my_price: 1100 });
  db.recordPriceLog({ goods_no: 1, date: '2026-09-25', my_price: 900, estimated_my_price: 1000 });
  db.recordPriceLog({ goods_no: 1, date: '2026-09-26', my_price: null, estimated_my_price: 1000 });
  db.recordPriceLog({ goods_no: 2, date: '2026-09-26', my_price: null, estimated_my_price: 500 });

  const map = db.getLastMyPriceDates([1, 2, 3]);
  assert.equal(map.get(1), '2026-09-25');
  assert.equal(map.has(2), false);
  assert.equal(map.has(3), false);
  assert.equal(db.getLastMyPriceDates([]).size, 0);
});

test('db: estimated lowest update keeps the real lowest date once lowest_my_price exists', (t) => {
  const { db } = tempDb(t);
  db.upsertItem({ goods_no: 10, goods_name: 'A', source: 'discovery' });
  db.upsertItem({ goods_no: 11, goods_name: 'B', source: 'discovery' });
  db.updateLowestPrice(10, 1000, null, '2026-09-20');

  db.updateLowestEstimatedPrice(10, 900, '2026-09-26');
  db.updateLowestEstimatedPrice(11, 800, '2026-09-26');

  assert.equal(db.getItem(10).lowest_estimated_price, 900);
  assert.equal(db.getItem(10).lowest_price_date, '2026-09-20');
  assert.equal(db.getItem(11).lowest_estimated_price, 800);
  assert.equal(db.getItem(11).lowest_price_date, '2026-09-26');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/discovery-myprice.test.js`
Expected: FAIL — `db.getLastMyPriceDates is not a function`, 그리고 두 번째 테스트는 `lowest_price_date`가 `'2026-09-26'`이라 실패.

- [ ] **Step 3: Implement**

`src/db.js`의 `updateLowestEstimatedPrice`를 다음으로 바꾼다:

```js
  updateLowestEstimatedPrice(goodsNo, price, date) {
    // The date column is shared: once a real lowest exists, an estimate must not overwrite its date.
    const stmt = this.db.prepare(`
      UPDATE items
      SET lowest_estimated_price = ?,
          lowest_price_date = CASE WHEN lowest_my_price IS NULL THEN ? ELSE lowest_price_date END
      WHERE goods_no = ?
    `);
    stmt.run(price, date, Number(goodsNo));
  }

  /** Latest date with a real (authenticated) my_price per goods. Goods with none are absent. */
  getLastMyPriceDates(goodsNos = []) {
    const map = new Map();
    if (goodsNos.length === 0) return map;
    const placeholders = goodsNos.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT goods_no, MAX(date) AS last_date FROM price_logs
         WHERE my_price IS NOT NULL AND goods_no IN (${placeholders})
         GROUP BY goods_no`
      )
      .all(...goodsNos.map(Number));
    for (const r of rows) map.set(Number(r.goods_no), r.last_date);
    return map;
  }
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/discovery-myprice.test.js && npm test`
Expected: PASS (새 2개 + 기존 317개).

- [ ] **Step 5: Commit**

```bash
git add src/db.js tests/discovery-myprice.test.js
git commit -m "feat(db): look up last real my_price dates and keep the real lowest date from estimate updates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 순수 함수 — 상한 파싱, 대상 선정, 오차 통계

**Files:**
- Modify: `src/discovery.js` (파일 끝에 추가)
- Test: `tests/discovery-myprice.test.js`

**Interfaces:**
- Produces: `DEFAULT_DISCOVERY_AUTH_LIMIT = 120`
- Produces: `parseAuthLimit(val, defaultVal = 120): number` — `undefined`/`''`/`true`/NaN/음수 → 기본값, 그 외 `Math.floor(Number(val))`(0 허용).
- Produces: `selectDiscoveryAuthTargets(items: {goodsNo, isSoldOut}[], lastMyPriceDates: Map<number,string>, limit: number): { goodsNos: number[], eligible: number }` — 매진 제외, goodsNo 중복 제거, 마지막 실제가 날짜 오름차순(없으면 맨 앞), 동률은 goodsNo 오름차순, 앞에서 `limit`개.
- Produces: `summarizeMyPriceGap(pairs: {myPrice, estimatedMyPrice}[]): { n, medianDiff, belowEstimate }` — diff = myPrice − estimatedMyPrice. 짝수 개면 가운데 두 값 평균을 반올림. 빈 배열이면 `{ n: 0, medianDiff: null, belowEstimate: 0 }`.

- [ ] **Step 1: Write the failing tests** (같은 파일 끝에 추가)

```js
import {
  DEFAULT_DISCOVERY_AUTH_LIMIT,
  parseAuthLimit,
  selectDiscoveryAuthTargets,
  summarizeMyPriceGap,
} from '../src/discovery.js';

test('parseAuthLimit: default, zero, bad values', () => {
  assert.equal(DEFAULT_DISCOVERY_AUTH_LIMIT, 120);
  assert.equal(parseAuthLimit(undefined), 120);
  assert.equal(parseAuthLimit(''), 120);
  assert.equal(parseAuthLimit(true), 120);
  assert.equal(parseAuthLimit('abc'), 120);
  assert.equal(parseAuthLimit('-5'), 120);
  assert.equal(parseAuthLimit('0'), 0);
  assert.equal(parseAuthLimit('50'), 50);
  assert.equal(parseAuthLimit(7.9), 7);
});

test('selectDiscoveryAuthTargets: never-priced first, then oldest, skips sold out and duplicates', () => {
  const items = [
    { goodsNo: 5, isSoldOut: false },
    { goodsNo: 3, isSoldOut: false },
    { goodsNo: 4, isSoldOut: true },
    { goodsNo: 2, isSoldOut: false },
    { goodsNo: 1, isSoldOut: false },
    { goodsNo: 3, isSoldOut: false },
  ];
  const last = new Map([[5, '2026-09-20'], [2, '2026-09-10'], [1, '2026-09-20']]);

  const all = selectDiscoveryAuthTargets(items, last, 10);
  assert.deepEqual(all.goodsNos, [3, 2, 1, 5]);
  assert.equal(all.eligible, 4);

  const capped = selectDiscoveryAuthTargets(items, last, 2);
  assert.deepEqual(capped.goodsNos, [3, 2]);
  assert.equal(capped.eligible, 4);

  assert.deepEqual(selectDiscoveryAuthTargets(items, last, 0).goodsNos, []);
});

test('summarizeMyPriceGap: median of myPrice - estimate and count below estimate', () => {
  assert.deepEqual(summarizeMyPriceGap([]), { n: 0, medianDiff: null, belowEstimate: 0 });
  assert.deepEqual(
    summarizeMyPriceGap([
      { myPrice: 900, estimatedMyPrice: 1000 },
      { myPrice: 1000, estimatedMyPrice: 1000 },
      { myPrice: 700, estimatedMyPrice: 1000 },
    ]),
    { n: 3, medianDiff: -100, belowEstimate: 2 }
  );
  assert.deepEqual(
    summarizeMyPriceGap([
      { myPrice: 900, estimatedMyPrice: 1000 },
      { myPrice: 750, estimatedMyPrice: 1000 },
    ]),
    { n: 2, medianDiff: -175, belowEstimate: 2 }
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/discovery-myprice.test.js`
Expected: FAIL — `does not provide an export named 'DEFAULT_DISCOVERY_AUTH_LIMIT'`.

- [ ] **Step 3: Implement** (`src/discovery.js` 끝에 추가)

```js
export const DEFAULT_DISCOVERY_AUTH_LIMIT = 120;

/** `--auth-limit` value: 0 disables the auth stage; missing or invalid values use the default. */
export function parseAuthLimit(val, defaultVal = DEFAULT_DISCOVERY_AUTH_LIMIT) {
  if (typeof val === 'boolean' || val === undefined || val === null || val === '') return defaultVal;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) return defaultVal;
  return Math.floor(n);
}

/**
 * Picks which discovered goods get an authenticated price this run. Never-priced goods first,
 * then the ones whose last real price is oldest, so capped runs rotate through the catalog.
 */
export function selectDiscoveryAuthTargets(items = [], lastMyPriceDates = new Map(), limit = DEFAULT_DISCOVERY_AUTH_LIMIT) {
  const seen = new Set();
  const eligible = [];
  for (const it of items) {
    const goodsNo = Number(it.goodsNo);
    if (!goodsNo || it.isSoldOut || seen.has(goodsNo)) continue;
    seen.add(goodsNo);
    eligible.push(goodsNo);
  }
  eligible.sort((a, b) => {
    const da = lastMyPriceDates.get(a) ?? '';
    const db = lastMyPriceDates.get(b) ?? '';
    if (da !== db) return da < db ? -1 : 1;
    return a - b;
  });
  return { goodsNos: eligible.slice(0, Math.max(0, limit)), eligible: eligible.length };
}

/** Value-free stats of real price vs same-day listing estimate (diff = myPrice - estimate). */
export function summarizeMyPriceGap(pairs = []) {
  if (pairs.length === 0) return { n: 0, medianDiff: null, belowEstimate: 0 };
  const diffs = pairs.map((p) => p.myPrice - p.estimatedMyPrice).sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  const medianDiff = diffs.length % 2 ? diffs[mid] : Math.round((diffs[mid - 1] + diffs[mid]) / 2);
  return { n: diffs.length, medianDiff, belowEstimate: diffs.filter((d) => d < 0).length };
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/discovery-myprice.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/discovery.js tests/discovery-myprice.test.js
git commit -m "feat(discovery): pick rotating auth targets, parse the auth cap, and summarize real-vs-estimate gaps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 표시 가격 짝 맞추기 (`pickDisplayPrices`)

**Files:**
- Modify: `src/cli.js` — 새 export 함수(`exportDataForGit` 바로 위), `exportDataForGit`(~95-96), `handleList`(~548-549)
- Test: `tests/discovery-myprice.test.js`

**Interfaces:**
- Produces: `pickDisplayPrices(latest: priceLogRow|undefined, item: itemRow): { current: number|null, lowest: number|null }`
  - `latest.my_price` 있음 → `{ current: my_price, lowest: item.lowest_my_price ?? my_price }`
  - 아니고 `latest.estimated_my_price` 있음 → `{ current: estimated, lowest: item.lowest_estimated_price ?? null }`
  - 판매가만 있음 → `{ current: sale_price, lowest: item.lowest_sale_price || null }`
  - 가격 기록이 전혀 없음(`latest` 없음) → 기존 체인 유지: `{ current: null, lowest: lowest_my_price || lowest_estimated_price || lowest_sale_price || null }` (tests/cli-discovery.test.js의 export 테스트가 이 경우를 쓴다)

- [ ] **Step 1: Write the failing tests**

```js
import { pickDisplayPrices, exportDataForGit } from '../src/cli.js';

test('pickDisplayPrices: real latest pairs with real lowest', () => {
  assert.deepEqual(
    pickDisplayPrices({ my_price: 9000, estimated_my_price: 9500, sale_price: 10000 }, { lowest_my_price: 8500, lowest_estimated_price: 9000 }),
    { current: 9000, lowest: 8500 }
  );
  assert.deepEqual(pickDisplayPrices({ my_price: 9000 }, {}), { current: 9000, lowest: 9000 });
});

test('pickDisplayPrices: estimate-only latest does not pair with a real lowest', () => {
  assert.deepEqual(
    pickDisplayPrices({ my_price: null, estimated_my_price: 9500, sale_price: 10000 }, { lowest_my_price: 8500, lowest_estimated_price: 9200 }),
    { current: 9500, lowest: 9200 }
  );
  assert.deepEqual(
    pickDisplayPrices({ my_price: null, estimated_my_price: 9500 }, { lowest_my_price: 8500 }),
    { current: 9500, lowest: null }
  );
});

test('pickDisplayPrices: sale-only and missing latest', () => {
  assert.deepEqual(pickDisplayPrices({ sale_price: 10000 }, { lowest_sale_price: 9000 }), { current: 10000, lowest: 9000 });
  assert.deepEqual(pickDisplayPrices(undefined, {}), { current: null, lowest: null });
  // No price log yet: keep the old fallback chain (existing export test relies on it)
  assert.deepEqual(pickDisplayPrices(undefined, { lowest_my_price: 45000, lowest_sale_price: 48000 }), { current: null, lowest: 45000 });
  assert.deepEqual(pickDisplayPrices(undefined, { lowest_estimated_price: 72000 }), { current: null, lowest: 72000 });
});

test('exportDataForGit uses paired display prices', (t) => {
  const { db, dir } = tempDb(t);
  db.upsertItem({ goods_no: 20, goods_name: 'X', source: 'discovery', status: 'ACTIVE' });
  db.recordPriceLog({ goods_no: 20, date: '2026-09-26', my_price: null, estimated_my_price: 9500, sale_price: 10000 });
  db.updateLowestPrice(20, 8500, null, '2026-09-20');
  db.updateLowestEstimatedPrice(20, 9200, '2026-09-26');

  const jsonPath = exportDataForGit({ dbInstance: db, dataDir: dir });
  const row = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')).items.find((it) => it.goods_no === 20);
  assert.equal(row.current_price, 9500);
  assert.equal(row.lowest_price, 9200);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/discovery-myprice.test.js`
Expected: FAIL — `does not provide an export named 'pickDisplayPrices'`.

- [ ] **Step 3: Implement**

`src/cli.js`, `exportDataForGit` 위에 추가:

```js
/**
 * Current and lowest price of the same kind: real with real, estimate with estimate,
 * so a real lowest is never shown next to an estimated current price.
 */
export function pickDisplayPrices(latest, item = {}) {
  if (latest?.my_price) return { current: latest.my_price, lowest: item.lowest_my_price ?? latest.my_price };
  if (latest?.estimated_my_price) return { current: latest.estimated_my_price, lowest: item.lowest_estimated_price ?? null };
  if (latest?.sale_price) return { current: latest.sale_price, lowest: item.lowest_sale_price || null };
  // No price log yet: nothing to pair with, keep the old fallback chain.
  return { current: null, lowest: item.lowest_my_price || item.lowest_estimated_price || item.lowest_sale_price || null };
}
```

`exportDataForGit`의 `items.map` 콜백:

```js
    items: items.map((it) => {
      const latest = dbInstance.getLatestPrice(it.goods_no);
      const { current, lowest } = pickDisplayPrices(latest, it);
      const tag = it.source === 'discovery' ? '[탐색]' : '[VIP]';
      const cleanName = (it.goods_name || '').replace(/^\[(VIP|탐색)\]\s*/, '');
      return {
        goods_no: it.goods_no,
        goods_name: `${tag} ${cleanName}`,
        brand_name: it.brand_name,
        source: it.source,
        status: it.status,
        url: it.url,
        current_price: current,
        lowest_price: lowest,
        lowest_price_date: it.lowest_price_date || null,
        is_sold_out: Boolean(latest?.is_sold_out),
        last_checked: it.last_checked_at,
      };
    }),
```

`handleList`의 두 줄:

```js
    const { current: activePrice, lowest: lowestPrice } = pickDisplayPrices(latest, it);
```

(기존 `const activePrice = ...`와 `const lowestPrice = ...` 두 줄을 이 한 줄로 바꾼다.)

- [ ] **Step 4: Run tests**

Run: `node --test tests/discovery-myprice.test.js && npm test`
Expected: PASS. `tests/cli-discovery.test.js`의 `exportDataForGit correctly tags items...`(가격 기록 없는 상품의 최저가 45000/72000)도 그대로 통과해야 한다.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js tests/discovery-myprice.test.js
git commit -m "fix(cli): pair current and lowest prices of the same kind in list and export

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `handleDiscover` — 스캔 → 인증 → 기록

**Files:**
- Modify: `src/cli.js` — imports(~10-13), `handleDiscover` 전체(~140-270)
- Test: `tests/discovery-myprice.test.js`

**Interfaces:**
- Consumes: `getLastMyPriceDates` (Task 1), `parseAuthLimit`, `selectDiscoveryAuthTargets`, `summarizeMyPriceGap` (Task 2), `collectAuthenticatedPrices({ goodsNos, sessionProvider, authFetchFn, authDelayMs }) → Promise<Map<number, priceInfo>>` (`src/collector.js`, 기존), `fetchAuthenticatedPriceInfo` (`src/myprice.js`, 기존).
- Produces: `handleDiscover(flags = {}, dbInstance = db, { discoverFn, sessionProvider = null, authFetchFn, authDelayMs = 700, authLimit, dataDir = DATA_DIR, today } = {}) → Promise<discoveredItem[]>`. 반환 항목에는 `myPrice: number|null`이 붙는다(VIP로 건너뛴 항목은 `undefined`).

- [ ] **Step 1: Write the failing tests**

```js
import { handleDiscover } from '../src/cli.js';
import { SessionExpiredError } from '../src/myprice.js';

const listing = (goodsNo, extra = {}) => ({
  goodsNo, goodsName: `G${goodsNo}`, brandName: 'B', url: `https://www.musinsa.com/products/${goodsNo}`,
  imageUrl: '', normalPrice: 20000, salePrice: 12000, couponPrice: 10000, estimatedMyPrice: 9200,
  likeCount: 5000, isSoldOut: false, source: 'discovery', ...extra,
});
const authInfo = (goodsNo, myPrice) => ({
  goodsNo, goodsName: `G${goodsNo}`, brandName: 'B', normalPrice: 20000, salePrice: 12000, couponPrice: 10000,
  myPrice, estimatedMyPrice: 9300, isSoldOut: false, discontinued: false, priceSource: 'https-auth',
});
const byCategory = (map) => async ({ categoryCode }) => map[categoryCode] || [];

function runDiscover(t, db, dir, overrides = {}) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  return handleDiscover({ category: '001' }, db, {
    discoverFn: byCategory({ '001': [listing(1), listing(2)] }),
    sessionProvider: async () => 'app_atk=fake',
    authFetchFn: async (g) => authInfo(g, 8000 + g),
    authDelayMs: 0,
    dataDir: dir,
    today: '2026-09-26',
    ...overrides,
  });
}

test('discover: records real my_price next to the listing estimate', async (t) => {
  const { db, dir } = tempDb(t);
  const out = await runDiscover(t, db, dir);
  const log = db.getLatestPrice(1);
  assert.equal(log.my_price, 8001);
  assert.equal(log.estimated_my_price, 9200); // listing estimate, not the auth one (9300)
  assert.equal(db.getItem(1).lowest_my_price, 8001);
  assert.equal(db.getItem(1).lowest_estimated_price, 9200);
  assert.equal(out.find((it) => it.goodsNo === 2).myPrice, 8002);
});

test('discover: no session provider keeps today behavior (estimate only)', async (t) => {
  const { db, dir } = tempDb(t);
  let calls = 0;
  await runDiscover(t, db, dir, { sessionProvider: null, authFetchFn: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(db.getLatestPrice(1).my_price, null);
  assert.equal(db.getLatestPrice(1).estimated_my_price, 9200);
  assert.equal(db.getItem(1).lowest_my_price, null);
});

test('discover: authLimit 0 skips the auth stage', async (t) => {
  const { db, dir } = tempDb(t);
  let calls = 0;
  await runDiscover(t, db, dir, { authLimit: 0, authFetchFn: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(db.getLatestPrice(1).my_price, null);
});

test('discover: expired session with failed refresh leaves the rest estimate-only', async (t) => {
  const { db, dir } = tempDb(t);
  await runDiscover(t, db, dir, {
    discoverFn: byCategory({ '001': [listing(1), listing(2), listing(3)] }),
    sessionProvider: async ({ refresh } = {}) => (refresh ? null : 'app_atk=fake'),
    authFetchFn: async (g) => { if (g === 2) throw new SessionExpiredError(); return authInfo(g, 8000 + g); },
  });
  assert.equal(db.getLatestPrice(1).my_price, 8001);
  assert.equal(db.getLatestPrice(2).my_price, null);
  assert.equal(db.getLatestPrice(3).my_price, null);
  assert.equal(db.getLatestPrice(3).estimated_my_price, 9200);
});

test('discover: same-day rerun without auth keeps the real price', async (t) => {
  const { db, dir } = tempDb(t);
  await runDiscover(t, db, dir);
  await runDiscover(t, db, dir, { sessionProvider: null });
  assert.equal(db.getLatestPrice(1).my_price, 8001);
});

test('discover: never auth-fetches or records VIP items', async (t) => {
  const { db, dir } = tempDb(t);
  db.upsertItem({ goods_no: 2, goods_name: 'VIP', source: 'like', status: 'ACTIVE' });
  db.recordPriceLog({ goods_no: 2, date: '2026-09-26', my_price: 7000, sale_price: 12000 });
  const fetched = [];
  await runDiscover(t, db, dir, { authFetchFn: async (g) => { fetched.push(g); return authInfo(g, 8000 + g); } });
  assert.deepEqual(fetched, [1]);
  assert.equal(db.getLatestPrice(2).my_price, 7000);
  assert.equal(db.getItem(2).source, 'like');
});

test('discover: dedupes goods seen in two categories', async (t) => {
  const { db, dir } = tempDb(t);
  const fetched = [];
  await handleDiscover({ category: '001,002' }, db, {
    discoverFn: byCategory({ '001': [listing(1)], '002': [listing(1), listing(2)] }),
    sessionProvider: async () => 'app_atk=fake',
    authFetchFn: async (g) => { fetched.push(g); return authInfo(g, 8000 + g); },
    authDelayMs: 0, dataDir: dir, today: '2026-09-26',
  });
  assert.deepEqual(fetched.sort(), [1, 2]);
  assert.equal(db.getLatestPrice(1).my_price, 8001);
});

test('discover: discontinued auth result records no my_price', async (t) => {
  const { db, dir } = tempDb(t);
  await runDiscover(t, db, dir, {
    authFetchFn: async (g) => (g === 1 ? { status: 404, discontinued: true } : authInfo(g, 8002)),
  });
  assert.equal(db.getLatestPrice(1).my_price, null);
  assert.equal(db.getLatestPrice(1).estimated_my_price, 9200);
  assert.equal(db.getLatestPrice(2).my_price, 8002);
});

test('discover: prioritizes goods never priced, respects the cap, logs drops like-for-like', async (t) => {
  const { db, dir } = tempDb(t);
  db.upsertItem({ goods_no: 1, goods_name: 'G1', source: 'discovery', status: 'ACTIVE' });
  db.recordPriceLog({ goods_no: 1, date: '2026-09-25', my_price: 9000, estimated_my_price: 9200 });
  db.upsertItem({ goods_no: 2, goods_name: 'G2', source: 'discovery', status: 'ACTIVE' });
  db.recordPriceLog({ goods_no: 2, date: '2026-09-25', my_price: null, estimated_my_price: 9900 });

  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'warn', () => {});
  const fetched = [];
  await handleDiscover({ category: '001' }, db, {
    discoverFn: byCategory({ '001': [listing(1), listing(2), listing(3)] }),
    sessionProvider: async () => 'app_atk=fake',
    authFetchFn: async (g) => { fetched.push(g); return authInfo(g, 8000 + g); },
    authDelayMs: 0, authLimit: 2, dataDir: dir, today: '2026-09-26',
  });

  assert.deepEqual(fetched, [2, 3]); // goods 1 was priced most recently -> deferred
  assert.ok(lines.some((l) => l.includes('[Discovery Auth] 2/2 priced (cap 2, 1 deferred')));
  assert.ok(lines.some((l) => l.includes('myPrice drops vs last myPrice: 0'))); // goods 2 had no real baseline
});

test('discover: counts a real drop only against a previous real price', async (t) => {
  const { db, dir } = tempDb(t);
  db.upsertItem({ goods_no: 1, goods_name: 'G1', source: 'discovery', status: 'ACTIVE' });
  db.recordPriceLog({ goods_no: 1, date: '2026-09-25', my_price: 9000, estimated_my_price: 9200 });
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'warn', () => {});
  await handleDiscover({ category: '001' }, db, {
    discoverFn: byCategory({ '001': [listing(1)] }),
    sessionProvider: async () => 'app_atk=fake',
    authFetchFn: async (g) => authInfo(g, 8500),
    authDelayMs: 0, dataDir: dir, today: '2026-09-26',
  });
  assert.ok(lines.some((l) => l.includes('myPrice drops vs last myPrice: 1')));
  assert.ok(lines.some((l) => l.includes('myPrice vs estimate: n=1')));
  assert.ok(!lines.some((l) => l.includes('app_atk')));
});
```

- [ ] **Step 2: Run to verify failure**

⚠️ 지금의 `handleDiscover`는 `discoverFn`을 무시하고 실제 무신사에 요청한다. 테스트를 돌리기 **전에** 먼저 최소 변경만 한다: 시그니처에 세 번째 인자 `{ discoverFn = discoverCategoryGoods, dataDir = DATA_DIR, today = new Date().toISOString().split('T')[0] } = {}`를 추가하고, 스캔 루프의 `discoverCategoryGoods({...})`를 `discoverFn({...})`로, 끝의 `exportDataForGit({ dbInstance })`를 `exportDataForGit({ dbInstance, dataDir })`로 바꾸고, 함수 안의 `const today = ...`를 지운다.

Run: `node --test tests/discovery-myprice.test.js`
Expected: FAIL — `my_price`가 null이라 `8001` 단언 실패, 로그 단언 실패. (`no session provider`, `authLimit 0` 테스트는 이 시점에 통과할 수 있다.)

- [ ] **Step 3: Implement**

`src/cli.js` imports 변경:

```js
import { collectPricesForActiveItems, collectAuthenticatedPrices, fetchProductPriceInfo, prewarmMusinsaSession } from './collector.js';
import { fetchAuthenticatedPriceInfo } from './myprice.js';
import { discoverCategoryGoods, parseAuthLimit, selectDiscoveryAuthTargets, summarizeMyPriceGap } from './discovery.js';
```

`handleDiscover`를 다음으로 교체한다(요약 통계 블록과 끝부분 로그는 기존 그대로 둔다):

```js
export async function handleDiscover(
  flags = {},
  dbInstance = db,
  {
    discoverFn = discoverCategoryGoods,
    sessionProvider = null,
    authFetchFn = fetchAuthenticatedPriceInfo,
    authDelayMs = 700,
    authLimit = parseAuthLimit(flags['auth-limit']),
    dataDir = DATA_DIR,
    today = new Date().toISOString().split('T')[0],
  } = {}
) {
  const limit = (typeof flags.limit === 'string' || typeof flags.limit === 'number') ? Number(flags.limit) : 100;
  const minLikes = (typeof flags['min-likes'] === 'string' || typeof flags['min-likes'] === 'number') ? Number(flags['min-likes']) : 1000;
  const years = (typeof flags.years === 'string' || typeof flags.years === 'number') ? Number(flags.years) : 2;
  const categoryRaw = typeof flags.category === 'string' ? flags.category : '001,002,003,103,004';
  const categoryAliases = { '007': '103', '008': '004' };
  const categories = categoryRaw
    .split(',')
    .map((c) => c.trim())
    .map((c) => categoryAliases[c] || c)
    .filter(Boolean);

  console.log(`\n========================================`);
  console.log(`🔍 [Project-Clot] Discovering Category Goods`);
  console.log(`   Categories: ${categories.join(', ')}`);
  console.log(`   Limit per category: ${limit} (Min likes: ${minLikes.toLocaleString()})`);
  console.log(`========================================\n`);

  // 1. Scan every category first so the auth stage can prioritize across the whole catalog.
  const allDiscovered = [];
  const toRecord = []; // discovery-owned goods, one entry per goodsNo
  const seen = new Set();
  let newlyIngestedCount = 0;

  for (const cat of categories) {
    try {
      console.log(`📂 Scanning category [${cat}]...`);
      const items = await discoverFn({ categoryCode: cat, limit, minLikes, years });
      console.log(`   ✓ Found ${items.length} items matching criteria in category [${cat}].`);

      for (const item of items) {
        allDiscovered.push(item);
        if (seen.has(item.goodsNo)) continue;
        seen.add(item.goodsNo);
        const existing = dbInstance.getItem(item.goodsNo);
        if (!existing) newlyIngestedCount++;
        // Do not overwrite price_logs for VIP items during discovery scan
        if (existing && existing.source !== 'discovery') continue;
        toRecord.push({ item, existing, cat });
      }
    } catch (err) {
      console.error(`❌ Failed scanning category ${cat}:`, err.message);
    }
  }

  // 2. Authenticated real prices for a rotating, capped subset. Anything missing stays estimate-only.
  let authMap = new Map();
  if (sessionProvider && authLimit > 0 && toRecord.length > 0) {
    try {
      const lastDates = dbInstance.getLastMyPriceDates(toRecord.map((e) => e.item.goodsNo));
      const { goodsNos, eligible } = selectDiscoveryAuthTargets(toRecord.map((e) => e.item), lastDates, authLimit);
      authMap = await collectAuthenticatedPrices({ goodsNos, sessionProvider, authFetchFn, authDelayMs });
      const priced = [...authMap.values()].filter((a) => a && !a.discontinued && a.myPrice).length;
      console.log(
        `🔐 [Discovery Auth] ${priced}/${goodsNos.length} priced (cap ${authLimit}, ${eligible - goodsNos.length} deferred to later runs).`
      );
    } catch (err) {
      console.warn(`⚠️ [Discovery Auth] Skipped: ${err.message}`);
      authMap = new Map();
    }
  }
  const realPriceOf = (goodsNo) => {
    const a = authMap.get(goodsNo);
    return a && !a.discontinued && a.myPrice ? a.myPrice : null;
  };

  // 3. Record. Real prices only compare with real prices; the listing estimate keeps its own series.
  const gapPairs = [];
  let myPriceDrops = 0;
  for (const { item, existing, cat } of toRecord) {
    const myPrice = realPriceOf(item.goodsNo);
    item.myPrice = myPrice;

    dbInstance.upsertItem({
      goods_no: item.goodsNo,
      goods_name: item.goodsName,
      brand_name: item.brandName,
      url: item.url,
      image_url: item.imageUrl,
      source: existing ? existing.source : 'discovery',
      status: item.isSoldOut ? 'SOLDOUT' : 'ACTIVE',
      category: classifyCategory(item.goodsName, item.brandName, cat),
    });

    if (myPrice) {
      const baseline = dbInstance.getLatestPriceBefore(item.goodsNo, today);
      if (baseline?.my_price && myPrice < baseline.my_price) myPriceDrops++;
      if (item.estimatedMyPrice) gapPairs.push({ myPrice, estimatedMyPrice: item.estimatedMyPrice });
    }

    dbInstance.recordPriceLog({
      goods_no: item.goodsNo,
      date: today,
      normal_price: item.normalPrice,
      sale_price: item.salePrice,
      coupon_price: item.couponPrice,
      sale_rate:
        item.normalPrice && item.salePrice && item.normalPrice > item.salePrice
          ? Math.round(((item.normalPrice - item.salePrice) / item.normalPrice) * 100)
          : 0,
      my_price: myPrice,
      estimated_my_price: item.estimatedMyPrice,
      coupon_name:
        item.couponPrice && item.salePrice && item.couponPrice < item.salePrice
          ? '쿠폰 적용가'
          : null,
      coupon_discount:
        item.couponPrice && item.salePrice && item.couponPrice < item.salePrice
          ? item.salePrice - item.couponPrice
          : 0,
      is_sold_out: item.isSoldOut ? 1 : 0,
    });

    // Real lowest first: the estimated update below then keeps the real lowest's date.
    if (myPrice && (!existing?.lowest_my_price || myPrice < existing.lowest_my_price)) {
      dbInstance.updateLowestPrice(item.goodsNo, myPrice, existing?.lowest_sale_price ?? null, today);
    }
    if (
      !existing ||
      !existing.lowest_estimated_price ||
      (item.estimatedMyPrice && item.estimatedMyPrice < existing.lowest_estimated_price)
    ) {
      dbInstance.updateLowestEstimatedPrice(item.goodsNo, item.estimatedMyPrice, today);
    }
  }

  if (gapPairs.length > 0) {
    const gap = summarizeMyPriceGap(gapPairs);
    console.log(
      `📐 [Discovery Auth] myPrice vs estimate: n=${gap.n}, median ${gap.medianDiff.toLocaleString()}원, myPrice<estimate ${gap.belowEstimate}`
    );
  }
  if (authMap.size > 0) {
    console.log(`📉 [Discovery] myPrice drops vs last myPrice: ${myPriceDrops}`);
  }

  // ... 기존 "Summary statistics" 블록(effPrice, avgDiscount, priceRangeStr, 요약 console.log)을 그대로 둔다 ...

  exportDataForGit({ dbInstance, dataDir });
  return allDiscovered;
}
```

주의: 기존 `const today = ...` 선언(옛 코드 안)은 지운다. 이제 옵션에서 온다.

- [ ] **Step 4: Run tests**

Run: `node --test tests/discovery-myprice.test.js && npm test`
Expected: PASS, 전체 통과.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js tests/discovery-myprice.test.js
git commit -m "feat(discover): record authenticated real prices for a rotating capped subset of discovered goods

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 핫딜 Top 5에 실제가 표시

**Files:**
- Modify: `src/notifier.js` — `formatHotDealsSummary` (~119-170)
- Test: `tests/discovery-myprice.test.js`

**Interfaces:**
- Consumes: 반환 항목의 `myPrice` (Task 4). DB 행 형태의 입력은 `my_price`.
- Produces: 순위·할인율은 기존대로 추정가 기준. `myPrice`가 있으면 해당 줄의 `(추정회원가: <b>X원</b>)` 뒤에 ` · 나의 할인가 <b>Y원</b>`.

- [ ] **Step 1: Write the failing test**

```js
import { formatHotDealsSummary } from '../src/notifier.js';

test('hot deals: ranks by estimate and shows the real price when present', () => {
  const msg = formatHotDealsSummary([
    { goodsNo: 1, goodsName: 'Cheap by estimate', brandName: 'B', normalPrice: 20000, estimatedMyPrice: 10000, myPrice: 9500 },
    { goodsNo: 2, goodsName: 'Only real is cheap', brandName: 'B', normalPrice: 20000, estimatedMyPrice: 15000, myPrice: 5000 },
    { goodsNo: 3, goodsName: 'No real price', brandName: 'B', normalPrice: 20000, estimatedMyPrice: 12000, myPrice: null },
  ]);
  const lines = msg.split('\n').filter((l) => /^\d\./.test(l));
  assert.match(lines[0], /Cheap by estimate/);
  assert.match(lines[0], /나의 할인가 <b>9,500원<\/b>/);
  assert.match(lines[1], /No real price/);
  assert.doesNotMatch(lines[1], /나의 할인가/);
  assert.match(lines[2], /Only real is cheap/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/discovery-myprice.test.js`
Expected: FAIL — 첫 줄에 `나의 할인가`가 없음.

- [ ] **Step 3: Implement**

`formatHotDealsSummary`의 `top5.forEach` 안:

```js
    const priceStr = item.targetPrice ? `${item.targetPrice.toLocaleString()}원` : '-';
    const myPrice = item.myPrice ?? item.my_price ?? null;
    const realStr = myPrice ? ` · 나의 할인가 <b>${myPrice.toLocaleString()}원</b>` : '';

    lines.push(
      `${rank}. <b>[${brand}]</b> ${name} - 정가 대비 <b>${item.discountRate}%</b> 할인 (추정회원가: <b>${priceStr}</b>)${realStr}\n` +
        `   • <a href="${url}">상품 바로가기</a>`
    );
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/discovery-myprice.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/notifier.js tests/discovery-myprice.test.js
git commit -m "feat(notifier): show the real price beside the estimate in the discovery hot deals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 배선 — daily/discover에 세션 제공자 넘기기, `--auth-limit` 도움말

**Files:**
- Modify: `src/cli.js` — `handleDailyRun`의 `--with-discovery` 블록(~450-462), `main()`의 `case 'discover'`(~776-778), 도움말(~930)
- Test: `tests/discovery-myprice.test.js`

**Interfaces:**
- Consumes: `handleDiscover(flags, dbInstance, { sessionProvider })` (Task 4), `makeSessionProvider`, `sessionProbeOptions` (기존).

- [ ] **Step 1: Write the failing test**

```js
import { parseArgs } from '../src/cli.js';

test('parseArgs + parseAuthLimit: --auth-limit reaches handleDiscover as a number', () => {
  assert.equal(parseAuthLimit(parseArgs(['discover', '--auth-limit', '50']).flags['auth-limit']), 50);
  assert.equal(parseAuthLimit(parseArgs(['discover', '--auth-limit=0']).flags['auth-limit']), 0);
  assert.equal(parseAuthLimit(parseArgs(['discover']).flags['auth-limit']), 120);
});

test('help text documents --auth-limit', () => {
  const src = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf-8');
  assert.match(src, /discover \[--category <codes>\] \[--limit <n>\] \[--min-likes <n>\] \[--auth-limit <n>\]/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/discovery-myprice.test.js`
Expected: 첫 테스트는 PASS일 수 있다(파싱은 이미 동작). 두 번째는 FAIL — 도움말에 `--auth-limit` 없음.

- [ ] **Step 3: Implement**

`handleDailyRun`의 discovery 블록:

```js
      // Shares the daily provider: one refresh budget, and deferred runs stay bridge-free.
      const discovered = await handleDiscover(flags, db, { sessionProvider });
```

`main()`:

```js
    case 'discover':
      await handleDiscover(flags, db, {
        sessionProvider: makeSessionProvider({ allowBridge: true, probe: sessionProbeOptions() }),
      });
      break;
```

도움말 줄:

```
  discover [--category <codes>] [--limit <n>] [--min-likes <n>] [--auth-limit <n>]  Discover popular products; real prices for up to <n> of them (default 120, 0 = off)
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS 전체.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js tests/discovery-myprice.test.js
git commit -m "feat(cli): pass the session provider to discovery and document --auth-limit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 마무리 확인

- [ ] **Step 1:** `npm test` 전체 통과 확인 (317 + 새 테스트).
- [ ] **Step 2:** `git status`로 `data/`에 변경이 없고 `data/prices.db-shm`/`-wal`이 생기지 않았는지 확인.
- [ ] **Step 3:** `git grep -n "app_atk=" -- src` 결과가 기존과 같고, 새 로그 문자열에 쿠키가 들어가지 않는지 확인.
- [ ] **Step 4:** 설계 문서의 Behavior when done 항목을 하나씩 대조하고, 빠진 것이 있으면 해당 Task로 돌아간다.
