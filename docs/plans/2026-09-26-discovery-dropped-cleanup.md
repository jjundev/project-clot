# Discovery Dropped-Goods Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A discovery-owned goods that is missing from 2 consecutive *complete* discovery scans moves to a new status `DROPPED` (price history kept), comes back to `ACTIVE`/`SOLDOUT` the moment any scan lists it again, and is revived to `ACTIVE` when the user likes it.

**Architecture:** Three layers, one task each. `src/discovery.js` gets two pure predicates that decide whether a scan was complete. `src/db.js` gets an `items.discovery_misses` counter, `markDiscoverySeen` / `markDiscoveryUnseen`, and a `promoteItemToLike` that revives `DROPPED`. `handleDiscover` in `src/cli.js` records per-category `{ ok, count }`, reconciles the status of already-known discovery goods with the listing, then runs seen → (complete ? unseen : skip) before `exportDataForGit`, which gains `dropped_items`. Every tracking query already filters `status IN ('ACTIVE','SOLDOUT')`, so `DROPPED` rows drop out of them with no query changes.

**Tech Stack:** Node.js 24 ESM, `node:sqlite` `DatabaseSync` (JSON1 `json_each` verified available), `node:test` + `node:assert/strict`.

**Spec:** The "목록에서 빠진 discovery 상품 정리" design from 2026-09-26 (decisions #1–#8, with #8 confirmed as K = 2). Condensed in *Background (Spec)* below.

## Background (Spec)

Facts (verified against the post-discover DB copy and the code on 2026-09-26):

| Fact | Evidence |
|---|---|
| 904 discovery goods, all `ACTIVE`; 406 were absent from the 9/26 scan and hold a single 9/05 estimate. | DB copy |
| Tracking queries only read `status IN ('ACTIVE','SOLDOUT')`, so a new status disappears from them automatically. | `src/db.js:134` (`getActiveItems`), `src/db.js:144` (`getDiscoveredActiveItems`), `src/db.js:149` (`getActiveVipItems`), `src/visualizer.js:41` (`buildClotDataPayload`) |
| `upsertItem` only changes an existing row's status for `UNLIKED → ACTIVE`, so a known discovery goods that goes sold out in the listing stays `ACTIVE` (pre-existing bug). | `src/db.js:194` |
| `promoteItemToLike` only sets `source`. Without a fix, liking a `DROPPED` goods makes it VIP but untracked. Both `sync` (`src/sync.js:155`) and `track <goodsNo>` (`src/cli.js:895`) go through it. | `src/db.js:153` |
| `list` uses `getAllItems()` and already shows `UNLIKED` rows with their status. `DROPPED` rows will show the same way (the spec's "excluded from `list`" is corrected here: `list` shows every row with its status; not changed this round). | `src/cli.js:618` |
| Default scan: categories `001,002,003,103,004`, limit 100, min-likes 1000, years 2. `daily --with-discovery` passes the daily flags (`force`, `with-discovery`, `concurrency`, `auth-limit`) into `handleDiscover`. | `src/cli.js:180-188`, `src/cli.js:537` |
| `node:sqlite` has no transaction helper; use `exec('BEGIN')` / `COMMIT` / `ROLLBACK`. `.run().changes` is a number. | `node -e` probe |

Decisions:

1. Cleanup = new status `DROPPED`, never row deletion.
2. Misses are counted per complete scan, not per date.
3. A scan is complete only when: no `category`, `limit`, `min-likes`, `years` flag was given; every category succeeded; every category returned `>= 50%` of `limit`.
4. Any scan (complete or partial) that lists a goods revives it and resets its counter.
5. `promoteItemToLike` turns `DROPPED` into `ACTIVE` and resets the counter.
6. Every scan reconciles a known discovery goods' `ACTIVE`/`SOLDOUT` with the listing.
7. The existing 406 start at 0 misses (no backfill).
8. K = `DISCOVERY_DROP_AFTER_MISSES = 2`.

Not in this round: deleting rows, backfilling the 406, scheduling discovery.

## Global Constraints

- New status string: exactly `'DROPPED'`.
- New column: `items.discovery_misses INTEGER DEFAULT 0`, added via the existing `PRAGMA table_info` → `ALTER TABLE` pattern.
- `DISCOVERY_DROP_AFTER_MISSES = 2`, `DISCOVERY_MIN_CATEGORY_FILL = 0.5`, both exported from `src/discovery.js`.
- Scope flags that make a scan partial: exactly `category`, `limit`, `min-likes`, `years`. No other flag affects completeness.
- Complete-scan log line: `` `🧹 [Discovery] ${DISCOVERY_DROP_AFTER_MISSES}회 연속 미노출 ${dropped}개 → DROPPED, 재등장 ${revived}개 복귀` ``.
- Partial-scan log line: `🧹 [Discovery] 부분 스캔이라 정리를 건너뜀`, with `` ` (재등장 ${revived}개 복귀)` `` appended only when `revived > 0`.
- Order inside `handleDiscover`: record → cleanup → `exportDataForGit`.
- Only `source = 'discovery'` rows with status `ACTIVE`/`SOLDOUT` are ever counted or dropped. VIP (`like`) rows and `UNLIKED` rows are never touched.
- `price_logs` rows are never deleted or modified by cleanup.
- Every new test file starts with `import './setup-env.js';` (enforced by `tests/test-isolation.test.js`).
- Tests use `authLimit: 0` and a temp DB; no network.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. `daily --with-discovery --force --concurrency 4 --auth-limit 50` must still count as a default (cleanable) scan — only the four scope flags make it partial. Pinned in Task 1.
2. Exactly half the limit (`count === 50` for `limit 100`) counts as complete; 49 does not. Pinned in Task 1.
3. A database created before this change (no `discovery_misses` column, existing rows) must open, gain the column, and read `0` for old rows. Pinned in Task 2.
4. A goods listed in two categories in the same scan is seen once and not counted as a miss. Pinned in Task 3.
5. A goods missed once, then listed by a *partial* scan, must restart from 0 — so one later miss does not drop it. Pinned in Task 3.

---

## File Structure

- Modify `src/discovery.js` — completeness predicates and constants (pure, no I/O).
- Modify `src/db.js` — column migration, `markDiscoverySeen`, `markDiscoveryUnseen`, `promoteItemToLike`.
- Modify `src/cli.js` — `handleDiscover` wiring, `exportDataForGit` `dropped_items`.
- Create `tests/discovery-cleanup.test.js` — all tests for this feature (Tasks 1–3 each append to it).

---

### Task 1: Scan-completeness predicates

**Files:**
- Modify: `src/discovery.js` (append after `summarizeMyPriceGap`, end of file)
- Create: `tests/discovery-cleanup.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (all exported from `src/discovery.js`):
  - `DISCOVERY_DROP_AFTER_MISSES: number` (= 2)
  - `DISCOVERY_MIN_CATEGORY_FILL: number` (= 0.5)
  - `isDefaultDiscoveryScan(flags: object = {}): boolean`
  - `isCompleteDiscoveryScan(flags: object, categoryStats: Array<{ cat: string, ok: boolean, count: number }>, limit: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/discovery-cleanup.test.js`:

```js
import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISCOVERY_DROP_AFTER_MISSES,
  DISCOVERY_MIN_CATEGORY_FILL,
  isDefaultDiscoveryScan,
  isCompleteDiscoveryScan,
} from '../src/discovery.js';

const okStats = (counts) => counts.map((count, i) => ({ cat: `c${i}`, ok: true, count }));

test('cleanup constants match the confirmed design', () => {
  assert.equal(DISCOVERY_DROP_AFTER_MISSES, 2);
  assert.equal(DISCOVERY_MIN_CATEGORY_FILL, 0.5);
});

test('isDefaultDiscoveryScan: only the four scope flags make a scan non-default', () => {
  assert.equal(isDefaultDiscoveryScan({}), true);
  assert.equal(isDefaultDiscoveryScan(), true);
  // daily --with-discovery forwards its own flags; none of them narrow the scope
  assert.equal(
    isDefaultDiscoveryScan({ 'with-discovery': true, force: true, concurrency: '4', 'auth-limit': '50' }),
    true
  );
  assert.equal(isDefaultDiscoveryScan({ category: '001' }), false);
  assert.equal(isDefaultDiscoveryScan({ limit: '50' }), false);
  assert.equal(isDefaultDiscoveryScan({ limit: true }), false); // bare `--limit`
  assert.equal(isDefaultDiscoveryScan({ 'min-likes': '500' }), false);
  assert.equal(isDefaultDiscoveryScan({ years: '3' }), false);
});

test('isCompleteDiscoveryScan: default flags, all ok, each category >= 50% of limit', () => {
  assert.equal(isCompleteDiscoveryScan({}, okStats([100, 100, 100, 100, 100]), 100), true);
  assert.equal(isCompleteDiscoveryScan({}, okStats([100, 100, 100, 100, 50]), 100), true); // boundary
  assert.equal(isCompleteDiscoveryScan({}, okStats([100, 100, 100, 100, 49]), 100), false);
  assert.equal(
    isCompleteDiscoveryScan({}, [...okStats([100, 100]), { cat: '003', ok: false, count: 0 }], 100),
    false
  );
  assert.equal(isCompleteDiscoveryScan({ category: '001' }, okStats([100]), 100), false);
  assert.equal(isCompleteDiscoveryScan({}, [], 100), false); // nothing scanned is never complete
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/discovery-cleanup.test.js`
Expected: FAIL — `SyntaxError: The requested module '../src/discovery.js' does not provide an export named 'DISCOVERY_DROP_AFTER_MISSES'`

- [ ] **Step 3: Write minimal implementation**

Append to the end of `src/discovery.js`:

```js
/** A discovery goods missing from this many consecutive complete scans becomes DROPPED. */
export const DISCOVERY_DROP_AFTER_MISSES = 2;
/** A category returning less than this share of `limit` means the listing page probably broke. */
export const DISCOVERY_MIN_CATEGORY_FILL = 0.5;

// Changing any of these changes what the listing covers, so "missing" can't be told apart from "out of scope".
const DISCOVERY_SCOPE_FLAGS = ['category', 'limit', 'min-likes', 'years'];

export function isDefaultDiscoveryScan(flags = {}) {
  return DISCOVERY_SCOPE_FLAGS.every((k) => flags[k] === undefined);
}

/** Only a complete scan may count misses: default scope, every category ok and at least half full. */
export function isCompleteDiscoveryScan(flags, categoryStats = [], limit) {
  if (!isDefaultDiscoveryScan(flags) || categoryStats.length === 0) return false;
  return categoryStats.every((s) => s.ok && s.count >= limit * DISCOVERY_MIN_CATEGORY_FILL);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/discovery-cleanup.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/discovery.js tests/discovery-cleanup.test.js
git commit -m "feat(discovery): decide when a discovery scan is complete enough to count misses

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: DB miss counter, drop, and like-revival

**Files:**
- Modify: `src/db.js:29-44` (`CREATE TABLE items`), `src/db.js:100-113` (items migration block), `src/db.js:153-156` (`promoteItemToLike`); add two methods right after `promoteItemToLike`
- Test: `tests/discovery-cleanup.test.js` (append)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces (methods on `ClotDatabase`):
  - column `items.discovery_misses INTEGER DEFAULT 0`
  - `markDiscoverySeen(goodsNos: Array<number|string>): void` — sets `discovery_misses = 0` for those rows (any source).
  - `markDiscoveryUnseen(seenGoodsNos: Array<number|string>, threshold: number): { dropped: number }` — in one transaction: `+1` misses for `source='discovery' AND status IN ('ACTIVE','SOLDOUT')` rows not in the list, then sets `status='DROPPED'` where `discovery_misses >= threshold` among those same rows. (The spec's third `dateIso` parameter is dropped: nothing reads it.)
  - `promoteItemToLike(goodsNo)` — now also `DROPPED → ACTIVE` and `discovery_misses = 0`; other statuses unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `tests/discovery-cleanup.test.js`. First add these imports at the top of the file, below the existing ones:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ClotDatabase } from '../src/db.js';
import { buildClotDataPayload } from '../src/visualizer.js';
```

Then append:

```js
function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-disc-cleanup-'));
  const db = new ClotDatabase(path.join(dir, 'test.db'));
  t.after(() => {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir };
}

// upsertItem binds `url` without a default, so every fixture needs one.
const row = (goodsNo, extra = {}) => ({
  goods_no: goodsNo,
  goods_name: `G${goodsNo}`,
  brand_name: 'B',
  url: `https://www.musinsa.com/products/${goodsNo}`,
  source: 'discovery',
  ...extra,
});

test('db: an old items table gains discovery_misses = 0 for existing rows', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-disc-migrate-'));
  const dbPath = path.join(dir, 'old.db');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = new DatabaseSync(dbPath);
  raw.exec(`CREATE TABLE items (
    goods_no INTEGER PRIMARY KEY, goods_name TEXT NOT NULL, brand_name TEXT, url TEXT NOT NULL,
    image_url TEXT, source TEXT DEFAULT 'like', status TEXT DEFAULT 'ACTIVE',
    first_seen_at TEXT NOT NULL, last_checked_at TEXT,
    lowest_my_price INTEGER, lowest_sale_price INTEGER, lowest_price_date TEXT
  );
  INSERT INTO items (goods_no, goods_name, url, source, first_seen_at)
  VALUES (1, 'old', 'https://www.musinsa.com/products/1', 'discovery', '2026-09-05T00:00:00Z');`);
  raw.close();

  const db = new ClotDatabase(dbPath);
  t.after(() => { try { db.close(); } catch {} });
  assert.equal(db.getItem(1).discovery_misses, 0);
});

test('db: markDiscoveryUnseen counts misses and drops at the threshold', (t) => {
  const { db } = tempDb(t);
  db.upsertItem(row(1));
  db.upsertItem(row(2));
  db.upsertItem(row(3, { status: 'SOLDOUT' }));

  assert.deepEqual(db.markDiscoveryUnseen([2], 2), { dropped: 0 });
  assert.equal(db.getItem(1).discovery_misses, 1);
  assert.equal(db.getItem(1).status, 'ACTIVE');
  assert.equal(db.getItem(2).discovery_misses, 0);

  assert.deepEqual(db.markDiscoveryUnseen([2], 2), { dropped: 2 });
  assert.equal(db.getItem(1).status, 'DROPPED');
  assert.equal(db.getItem(3).status, 'DROPPED'); // SOLDOUT goods drop too
  assert.equal(db.getItem(2).status, 'ACTIVE');

  // Already DROPPED rows are left alone: no further counting, not re-reported.
  assert.deepEqual(db.markDiscoveryUnseen([2], 2), { dropped: 0 });
  assert.equal(db.getItem(1).discovery_misses, 2);
});

test('db: markDiscoveryUnseen never touches VIP or UNLIKED rows', (t) => {
  const { db } = tempDb(t);
  db.upsertItem(row(10, { source: 'like' }));
  db.upsertItem(row(11, { source: 'like', status: 'UNLIKED' }));
  db.markDiscoveryUnseen([], 1);
  db.markDiscoveryUnseen([], 1);
  assert.equal(db.getItem(10).status, 'ACTIVE');
  assert.equal(db.getItem(10).discovery_misses, 0);
  assert.equal(db.getItem(11).status, 'UNLIKED');
});

test('db: markDiscoverySeen resets the counter', (t) => {
  const { db } = tempDb(t);
  db.upsertItem(row(1));
  db.markDiscoveryUnseen([], 2);
  assert.equal(db.getItem(1).discovery_misses, 1);
  db.markDiscoverySeen([1]);
  assert.equal(db.getItem(1).discovery_misses, 0);
  db.markDiscoverySeen([]); // no-op, no throw
});

test('db: promoting a DROPPED goods revives it as a tracked VIP', (t) => {
  const { db } = tempDb(t);
  db.upsertItem(row(1));
  db.markDiscoveryUnseen([], 1);
  assert.equal(db.getItem(1).status, 'DROPPED');

  db.promoteItemToLike(1);
  const it = db.getItem(1);
  assert.equal(it.source, 'like');
  assert.equal(it.status, 'ACTIVE');
  assert.equal(it.discovery_misses, 0);
  assert.ok(db.getActiveVipItems().some((r) => r.goods_no === 1));
});

test('db: promoting keeps a non-DROPPED status as is', (t) => {
  const { db } = tempDb(t);
  db.upsertItem(row(2, { status: 'SOLDOUT' }));
  db.promoteItemToLike(2);
  assert.equal(db.getItem(2).status, 'SOLDOUT');
  assert.equal(db.getItem(2).source, 'like');
});

test('db: DROPPED goods leave every tracking query and the dashboard', (t) => {
  const { db } = tempDb(t);
  db.upsertItem(row(1));
  db.upsertItem(row(2));
  db.recordPriceLog({ goods_no: 1, date: '2026-09-05', sale_price: 10000, estimated_my_price: 9000 });
  db.markDiscoveryUnseen([2], 1);

  assert.equal(db.getItem(1).status, 'DROPPED');
  assert.equal(db.getPriceLogs(1).length, 1); // history kept
  assert.deepEqual(db.getActiveItems().map((r) => r.goods_no), [2]);
  assert.deepEqual(db.getDiscoveredActiveItems().map((r) => r.goods_no), [2]);
  assert.deepEqual(buildClotDataPayload(db.db).items.map((it) => it.n), [2]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/discovery-cleanup.test.js`
Expected: FAIL — migration test: `undefined !== 0`; others: `TypeError: db.markDiscoveryUnseen is not a function`

- [ ] **Step 3: Write minimal implementation**

In `src/db.js`, add the column to `CREATE TABLE IF NOT EXISTS items` after `lowest_price_date TEXT`:

```sql
        lowest_price_date TEXT,
        discovery_misses INTEGER DEFAULT 0
```

In the items migration block, after the `category` check (ends at `src/db.js:113`):

```js
    // Consecutive complete discovery scans that did not list this goods; drives DROPPED.
    if (!itemsCols.includes('discovery_misses')) {
      try {
        this.db.exec("ALTER TABLE items ADD COLUMN discovery_misses INTEGER DEFAULT 0;");
      } catch (e) {
        if (!e.message.includes('duplicate column name')) throw e;
      }
    }
```

Replace `promoteItemToLike` and add the two methods after it:

```js
  promoteItemToLike(goodsNo) {
    // A liked goods must be tracked again even if discovery had dropped it.
    const stmt = this.db.prepare(`
      UPDATE items SET
        source = 'like',
        status = CASE WHEN status = 'DROPPED' THEN 'ACTIVE' ELSE status END,
        discovery_misses = 0
      WHERE goods_no = ?
    `);
    stmt.run(Number(goodsNo));
  }

  markDiscoverySeen(goodsNos = []) {
    if (goodsNos.length === 0) return;
    this.db
      .prepare('UPDATE items SET discovery_misses = 0 WHERE goods_no IN (SELECT value FROM json_each(?))')
      .run(JSON.stringify(goodsNos.map(Number)));
  }

  /** Counts a miss for every tracked discovery goods not in the list, then drops those at the threshold. */
  markDiscoveryUnseen(seenGoodsNos = [], threshold) {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(`
          UPDATE items SET discovery_misses = COALESCE(discovery_misses, 0) + 1
          WHERE source = 'discovery' AND status IN ('ACTIVE', 'SOLDOUT')
            AND goods_no NOT IN (SELECT value FROM json_each(?))
        `)
        .run(JSON.stringify(seenGoodsNos.map(Number)));
      const res = this.db
        .prepare(`
          UPDATE items SET status = 'DROPPED'
          WHERE source = 'discovery' AND status IN ('ACTIVE', 'SOLDOUT') AND discovery_misses >= ?
        `)
        .run(threshold);
      this.db.exec('COMMIT');
      return { dropped: Number(res.changes) };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/discovery-cleanup.test.js && npm test`
Expected: PASS — new file all green; full suite `fail 0` (the existing `track command promotes discovery item to like` test in `tests/cli-discovery.test.js` still passes).

- [ ] **Step 5: Commit**

```bash
git add src/db.js tests/discovery-cleanup.test.js
git commit -m "feat(db): count discovery misses, drop at a threshold, and revive DROPPED goods on like

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Wire cleanup into `handleDiscover` and the export

**Files:**
- Modify: `src/cli.js:14` (import), `src/cli.js:98-112` (`exportDataForGit` summary), `src/cli.js:196-223` (scan loop), `src/cli.js:246-260` (record loop), insert cleanup after the record loop (before `if (gapPairs.length > 0)` at `src/cli.js:309`)
- Test: `tests/discovery-cleanup.test.js` (append)

**Interfaces:**
- Consumes: `isCompleteDiscoveryScan`, `DISCOVERY_DROP_AFTER_MISSES` (Task 1); `markDiscoverySeen`, `markDiscoveryUnseen` (Task 2); existing `updateItemStatus(goodsNo, status)`.
- Produces: `handleDiscover` return value unchanged (`allDiscovered`); `latest_prices.json` gains top-level `dropped_items: number`.

- [ ] **Step 1: Write the failing tests**

Add to the imports at the top of `tests/discovery-cleanup.test.js`:

```js
import { handleDiscover, exportDataForGit } from '../src/cli.js';
```

Then append:

```js
const CATEGORIES = ['001', '002', '003', '103', '004'];

const listing = (goodsNo, extra = {}) => ({
  goodsNo, goodsName: `G${goodsNo}`, brandName: 'B', url: `https://www.musinsa.com/products/${goodsNo}`,
  imageUrl: '', normalPrice: 20000, salePrice: 12000, couponPrice: 10000, estimatedMyPrice: 9200,
  likeCount: 5000, isSoldOut: false, source: 'discovery', ...extra,
});

// Each default category returns `counts[cat] ?? 60` filler goods (>= 50% of limit 100) plus `extra[cat]`.
function fullScan(extra = {}, { counts = {}, fail = [] } = {}) {
  return async ({ categoryCode }) => {
    if (fail.includes(categoryCode)) throw new Error(`HTTP 500 for ${categoryCode}`);
    const base = 100000 + CATEGORIES.indexOf(categoryCode) * 1000;
    const fillers = Array.from({ length: counts[categoryCode] ?? 60 }, (_, i) => listing(base + i));
    return [...fillers, ...(extra[categoryCode] || [])];
  };
}

/** Silences discover output and returns the captured console.log lines. Call once per test. */
function quiet(t) {
  const logs = [];
  t.mock.method(console, 'log', (...a) => logs.push(a.join(' ')));
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  return logs;
}

const discover = (db, dir, discoverFn, flags = {}) =>
  handleDiscover(flags, db, { discoverFn, authLimit: 0, dataDir: dir, today: '2026-09-26' });

const seed = (db, dir, goods) => discover(db, dir, fullScan({ '001': goods }));

test('discover: two consecutive complete misses drop a goods, one miss keeps it', async (t) => {
  const { db, dir } = tempDb(t);
  const logs = quiet(t);
  await seed(db, dir, [listing(1), listing(2)]);

  await discover(db, dir, fullScan({ '001': [listing(2)] }));
  assert.equal(db.getItem(1).status, 'ACTIVE');
  assert.equal(db.getItem(1).discovery_misses, 1);

  await discover(db, dir, fullScan({ '001': [listing(2)] }));
  assert.equal(db.getItem(1).status, 'DROPPED');
  assert.equal(db.getItem(2).status, 'ACTIVE');
  assert.equal(db.getItem(2).discovery_misses, 0);
  assert.equal(db.getPriceLogs(1).length, 1);
  assert.ok(logs.includes('🧹 [Discovery] 2회 연속 미노출 1개 → DROPPED, 재등장 0개 복귀'));
});

const PARTIAL_SCANS = [
  ['--category 001', { category: '001' }, fullScan({ '001': [listing(2)] })],
  ['--limit 50', { limit: '50' }, fullScan({ '001': [listing(2)] })],
  ['a failing category', {}, fullScan({ '001': [listing(2)] }, { fail: ['003'] })],
  ['a category under 50% of limit', {}, fullScan({ '001': [listing(2)] }, { counts: { '004': 49 } })],
];

for (const [label, flags, discoverFn] of PARTIAL_SCANS) {
  test(`discover: partial scan (${label}) changes no miss counts or statuses`, async (t) => {
    const { db, dir } = tempDb(t);
    const logs = quiet(t);
    await seed(db, dir, [listing(1), listing(2)]);

    await discover(db, dir, discoverFn, flags);
    await discover(db, dir, discoverFn, flags);
    assert.equal(db.getItem(1).status, 'ACTIVE');
    assert.equal(db.getItem(1).discovery_misses, 0);
    assert.ok(logs.includes('🧹 [Discovery] 부분 스캔이라 정리를 건너뜀'));
  });
}

async function dropGoods1(db, dir) {
  await seed(db, dir, [listing(1), listing(2)]);
  await discover(db, dir, fullScan({ '001': [listing(2)] }));
  await discover(db, dir, fullScan({ '001': [listing(2)] }));
  assert.equal(db.getItem(1).status, 'DROPPED');
}

test('discover: a DROPPED goods listed again comes back with the listing status', async (t) => {
  const { db, dir } = tempDb(t);
  const logs = quiet(t);
  await dropGoods1(db, dir);

  await discover(db, dir, fullScan({ '001': [listing(1, { isSoldOut: true }), listing(2)] }));
  assert.equal(db.getItem(1).status, 'SOLDOUT');
  assert.equal(db.getItem(1).discovery_misses, 0);
  assert.ok(logs.includes('🧹 [Discovery] 2회 연속 미노출 0개 → DROPPED, 재등장 1개 복귀'));
});

test('discover: a partial scan also revives a DROPPED goods', async (t) => {
  const { db, dir } = tempDb(t);
  const logs = quiet(t);
  await dropGoods1(db, dir);

  await discover(db, dir, fullScan({ '001': [listing(1)] }), { category: '001' });
  assert.equal(db.getItem(1).status, 'ACTIVE');
  assert.equal(db.getItem(1).discovery_misses, 0);
  assert.ok(logs.includes('🧹 [Discovery] 부분 스캔이라 정리를 건너뜀 (재등장 1개 복귀)'));
});

test('discover: a partial-scan sighting restarts the miss count', async (t) => {
  const { db, dir } = tempDb(t);
  quiet(t);
  await seed(db, dir, [listing(1), listing(2)]);
  await discover(db, dir, fullScan({ '001': [listing(2)] })); // miss 1
  await discover(db, dir, fullScan({ '001': [listing(1)] }), { category: '001' }); // seen, partial
  await discover(db, dir, fullScan({ '001': [listing(2)] })); // miss 1 again, not 2
  assert.equal(db.getItem(1).status, 'ACTIVE');
  assert.equal(db.getItem(1).discovery_misses, 1);
});

test('discover: a goods listed in two categories is seen once, never missed', async (t) => {
  const { db, dir } = tempDb(t);
  quiet(t);
  const both = fullScan({ '001': [listing(1)], '002': [listing(1)] });
  await discover(db, dir, both);
  await discover(db, dir, both);
  assert.equal(db.getItem(1).status, 'ACTIVE');
  assert.equal(db.getItem(1).discovery_misses, 0);
});

test('discover: VIP goods absent from complete scans are untouched', async (t) => {
  const { db, dir } = tempDb(t);
  quiet(t);
  db.upsertItem({ goods_no: 50, goods_name: 'VIP', url: 'https://www.musinsa.com/products/50', source: 'like' });
  await discover(db, dir, fullScan());
  await discover(db, dir, fullScan());
  assert.equal(db.getItem(50).status, 'ACTIVE');
  assert.equal(db.getItem(50).source, 'like');
  assert.equal(db.getItem(50).discovery_misses, 0);
});

test('discover: a known discovery goods follows the listing sold-out state', async (t) => {
  const { db, dir } = tempDb(t);
  quiet(t);
  await seed(db, dir, [listing(1)]);
  assert.equal(db.getItem(1).status, 'ACTIVE');

  await discover(db, dir, fullScan({ '001': [listing(1, { isSoldOut: true })] }));
  assert.equal(db.getItem(1).status, 'SOLDOUT');

  await discover(db, dir, fullScan({ '001': [listing(1)] }));
  assert.equal(db.getItem(1).status, 'ACTIVE');
});

test('export: DROPPED goods stay in latest_prices.json with their status and a count', async (t) => {
  const { db, dir } = tempDb(t);
  quiet(t);
  await dropGoods1(db, dir);

  const summary = JSON.parse(fs.readFileSync(exportDataForGit({ dbInstance: db, dataDir: dir }), 'utf-8'));
  assert.equal(summary.dropped_items, 1);
  assert.equal(summary.items.find((it) => it.goods_no === 1).status, 'DROPPED');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/discovery-cleanup.test.js`
Expected: FAIL — the drop test: `'ACTIVE' !== 'DROPPED'` / `undefined !== 1` for `discovery_misses`; the sold-out test: `'ACTIVE' !== 'SOLDOUT'`; export: `undefined !== 1`. (The partial-scan and VIP tests may already pass — they pin that nothing changes.)

- [ ] **Step 3: Write the implementation**

`src/cli.js:14` — extend the discovery import:

```js
import {
  discoverCategoryGoods,
  parseAuthLimit,
  selectDiscoveryAuthTargets,
  summarizeMyPriceGap,
  isCompleteDiscoveryScan,
  DISCOVERY_DROP_AFTER_MISSES,
} from './discovery.js';
```

`exportDataForGit` summary — add after `unliked_items`:

```js
    dropped_items: items.filter((it) => it.status === 'DROPPED').length,
```

Scan loop — declare `const categoryStats = [];` next to `const seen = new Set();`, then record each category's outcome:

```js
  for (const cat of categories) {
    try {
      console.log(`📂 Scanning category [${cat}]...`);
      const items = await discoverFn({ categoryCode: cat, limit, minLikes, years });
      console.log(`   ✓ Found ${items.length} items matching criteria in category [${cat}].`);
      categoryStats.push({ cat, ok: true, count: items.length });

      for (const item of items) {
        // ... unchanged ...
      }
    } catch (err) {
      categoryStats.push({ cat, ok: false, count: 0 });
      console.error(`❌ Failed scanning category ${cat}:`, err.message);
    }
  }
```

Record loop — declare `let revivedCount = 0;` next to `let myPriceDrops = 0;`. Right after the `dbInstance.upsertItem({...})` call add:

```js
    // upsertItem keeps an existing row's status, so align known discovery goods with the listing here.
    const listedStatus = item.isSoldOut ? 'SOLDOUT' : 'ACTIVE';
    if (existing && existing.status !== listedStatus && ['ACTIVE', 'SOLDOUT', 'DROPPED'].includes(existing.status)) {
      dbInstance.updateItemStatus(item.goodsNo, listedStatus);
      if (existing.status === 'DROPPED') revivedCount++;
    }
```

(`toRecord` only holds new goods or existing `source = 'discovery'` goods, so `existing` here is always discovery-owned.)

Directly after the record loop's closing brace, before `if (gapPairs.length > 0)`:

```js
  // 4. Cleanup. Seen goods restart their count on any scan; only a complete scan counts misses.
  const seenGoodsNos = [...seen];
  dbInstance.markDiscoverySeen(seenGoodsNos);
  if (isCompleteDiscoveryScan(flags, categoryStats, limit)) {
    const { dropped } = dbInstance.markDiscoveryUnseen(seenGoodsNos, DISCOVERY_DROP_AFTER_MISSES);
    console.log(`🧹 [Discovery] ${DISCOVERY_DROP_AFTER_MISSES}회 연속 미노출 ${dropped}개 → DROPPED, 재등장 ${revivedCount}개 복귀`);
  } else {
    const revivedNote = revivedCount > 0 ? ` (재등장 ${revivedCount}개 복귀)` : '';
    console.log(`🧹 [Discovery] 부분 스캔이라 정리를 건너뜀${revivedNote}`);
  }
```

`exportDataForGit({ dbInstance, dataDir })` at the end of `handleDiscover` stays where it is, so the order is record → cleanup → export.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/discovery-cleanup.test.js && npm test`
Expected: PASS — new file all green; full suite `fail 0` (existing `tests/discovery-myprice.test.js` runs use `{ category: '001' }`, so they take the partial path and only gain one log line).

- [ ] **Step 5: Commit**

```bash
git add src/cli.js tests/discovery-cleanup.test.js
git commit -m "feat(discover): drop discovery goods missing from two complete scans and revive them when listed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After merge (manual, not a task)

- Do **not** verify with `daily --force` (it re-collects and pushes to origin). Verify on a copy of `data/prices.db` via `CLOT_DB_PATH`.
- Two more default `discover` runs clear the existing 406 (misses 0 → 1 → 2). Runs on the same day count separately (decision #2 is count-based).
