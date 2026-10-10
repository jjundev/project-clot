# 4910 Liked Items · Member Price on the Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every daily run syncs the user's 4910 liked items, records each one's display price, anonymous coupon price (new-member basis) and logged-in member price into `data/4910.db`, and the GitHub Pages dashboard shows those items next to the Musinsa items.

**Architecture:** `src/site4910/client.js` gains member-authenticated calls (goods detail, liked list). `src/site4910/store.js` gains two tables. A new `src/site4910/liked.js` holds token reading and the daily sync, which `run4910Step` in `src/cli.js` runs in its own try/catch after the scan. `src/visualizer.js` merges the liked items from `4910.db` into the dashboard payload under a `src`/`k` key, and `src/dashboard.template.html` renders them with a source filter.

**Tech Stack:** Node.js 24 ESM, global `fetch`, `node:sqlite` `DatabaseSync`, `node:test` + `node:assert/strict`, vanilla ES5 in the template, Chart.js 4.4.4 (already loaded).

**Spec:** `docs/specs/2026-10-10-4910-liked-member-price.md`

## Global Constraints

- Detail URL `https://api.a-bly.com/api/v2/goods/{sno}/`; liked URL `https://api.a-bly.com/aglo/api/members/me/liked-goods/?limit={limit}` plus `&last_sno={n}` only when non-null; liked page limit 100.
- Member calls send `Authorization: JWT <token>` and **never** `X-Anonymous-Token` (and never fetch an anonymous token). Other headers as today: `User-Agent` = `USER_AGENT` from `src/myprice.js`, `Origin: https://4910.kr`, `Referer: https://4910.kr/`, `Accept: application/json`. Same 300 ms spacing, 15 s timeout, 429/5xx retry as the list call.
- Member 401 or 403 → error with `code === 'MEMBER_AUTH'`, no retry.
- Token source: env `ABLY_JWT_TOKEN`, else `ABLY_JWT_TOKEN=` line in `<cwd>/.env`; the `.env` file is never read when `CLOT_NOTIFY_SANDBOX` is set. The token is never logged, never written to a DB, never placed in the dashboard payload.
- Coupon price is `goods.price` only when `goods.price_description.text === '쿠폰적용가'`; member price is the member call's `goods.price`.
- Dashboard "my" price for a 4910 item = `member_price ?? coupon_price ?? list_price`.
- Exact copy: `쿠폰적용가(신규회원 기준)`, `내 회원가`, `⚠️ 4910 로그인 만료 — ABLY_JWT_TOKEN 갱신 필요`, `찜 {N}개 · 가격 기록 {M}개`, `<b>💜 찜 상품 회원가 하락 (상위 {n}):</b>`, chip labels `전체` / `무신사` / `4910`, link text `4910에서 보기 ↗`.
- Liked sync time budget: 4 minutes (`LIKED_BUDGET_MS_4910 = 4 * 60_000`).
- `run4910Step` never throws; a liked-step failure never blocks the scan digest, the Musinsa commit, or Pages.
- Every new test file's first line is `import './setup-env.js';`.
- Never run `daily` or a non-`--dry-run` `track-4910` locally (Actions owns `data/4910.db` and pushes). Manual checks use temp DB paths via `CLOT_4910_DB_PATH`.
- Work on a branch (e.g. `feat/4910-liked-member-price`), not `main`.

## Review Focus

1. A liked-list call that comes back empty or dies after page 1 (API glitch) would mark every liked item UNLIKED and empty the 4910 section — likes must stay untouched. → Task 3 `an empty liked list unlikes nothing`, Task 4 `a liked-list failure after page 1 leaves likes untouched`.
2. The user pastes the token as `ably-jwt-token=...; other=...`, URL-encoded, or wrapped in quotes — it must still work. → Task 4 `readAblyToken normalizes cookie strings, quotes and URL encoding`.
3. A same-day rerun (workflow re-run) must not duplicate rows or report a drop against its own earlier row. → Task 3 `logLikedPrice keeps one row per sno and date`, Task 4 `a same-day rerun reports no drop against itself`.
4. A Musinsa `goods_no` equal to a 4910 `sno`, and old `?goods=<digits>` links, must still open the right item. → Task 6 `a Musinsa goods_no equal to a 4910 sno keeps distinct keys`.
5. Pages building from a `4910.db` that predates the liked tables (or has none) must still deploy the Musinsa dashboard. → Task 6 `a 4910.db without liked tables is skipped`.

---

### Task 1: Verify the member-price assumptions (gate, no code)

**Files:** Modify: `docs/specs/2026-10-10-4910-liked-member-price.md` (Facts section only)

**Interfaces:** Produces: the liked endpoint's real top-level list key and cursor key, recorded in the spec; Task 2 uses them.

- [ ] **Step 1: Ask the user to put their token in `.env`**

The user copies the `ably-jwt-token` cookie value (4910.kr logged in → DevTools → Application → Cookies → `https://4910.kr`) into `.env` as `ABLY_JWT_TOKEN=<value>`. Do not ask for it in chat.

- [ ] **Step 2: Run a read-only probe from the scratchpad (not committed)**

Write a throwaway script outside the repo that reads `ABLY_JWT_TOKEN` from `.env`, then prints **names and numbers only, never the token**:
1. `GET` the liked URL with `limit=20` and the member headers → HTTP status, `Object.keys(body)`, the list length, the cursor value type.
2. For the first 3 liked `sno`s: anonymous detail `goods.price` and `price_description?.text`; member detail `goods.price`, `price_description?.text`, and `applied_coupon != null`.

Expected: liked status 200; for at least one item the member `goods.price` differs from the anonymous one, or `applied_coupon` is non-null.

- [ ] **Step 3: Decide**

If the liked call is not 200, or all three member prices equal the anonymous ones with `applied_coupon` null: **stop** and report to the user (the design needs a coupon-based member price instead). Otherwise record in the spec's Facts: liked list key, cursor key, and the member `price_description.text` value seen.

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-10-10-4910-liked-member-price.md
git commit -m "docs(4910): record verified liked-goods and member-price response shape"
```

---

### Task 2: Client — member-authenticated detail and liked list

**Files:**
- Modify: `src/site4910/client.js` (inside `createClient`, `:64-151`)
- Test: `tests/site4910-client.test.js`

**Interfaces:**
- Produces on the object returned by `createClient`:
  - `getGoodsDetail(sno: number, opts?: { memberToken?: string }) => Promise<GoodsDetail>` where `GoodsDetail = { sno: number, price: number|null, couponPrice: number|null, listPrice: number|null, originalPrice: number|null, isSoldout: boolean, isOpen: boolean }` (`price` = `goods.price`, `listPrice` = `goods.first_page_rendering.price`, `originalPrice` = `goods.linked_option.original_price`).
  - `listLikedGoods(opts: { memberToken: string, lastSno?: number|null, limit?: number }) => Promise<{ entries: object[], lastSno: number|null }>` (`limit` default 100; keys per Task 1, assumed `goods_list` / `last_sno`).
  - Member 401/403 rejects with `err.code === 'MEMBER_AUTH'`, `err.status`.

- [ ] **Step 1: Write the failing tests** (reuse the file's `fakeFetch`/`json`; detail fixture `{ goods: { price: 18360, price_description: { text: '쿠폰적용가' }, first_page_rendering: { price: 21600 }, linked_option: { original_price: 51300 }, is_soldout: false, is_open: true } }`)

```js
test('getGoodsDetail maps the anonymous detail', async () => {
  // fetch answers the detail fixture
  assert.deepEqual(await client.getGoodsDetail(71863924), {
    sno: 71863924, price: 18360, couponPrice: 18360, listPrice: 21600, originalPrice: 51300, isSoldout: false, isOpen: true,
  });
  assert.equal(calls.at(-1).url, 'https://api.a-bly.com/api/v2/goods/71863924/');
  assert.equal(calls.at(-1).headers['X-Anonymous-Token'], 'tok-1');
  assert.equal(calls.at(-1).headers.Authorization, undefined);
});
test('getGoodsDetail gives couponPrice null without the 쿠폰적용가 label', ...); // price_description: null → couponPrice null, price 18360
test('member calls send only Authorization: JWT and fetch no anonymous token', async () => {
  await client.getGoodsDetail(1, { memberToken: 'mem-tok' });
  assert.equal(calls.filter((c) => c.url.includes('/anonymous/token/')).length, 0);
  assert.equal(calls[0].headers.Authorization, 'JWT mem-tok');
  assert.equal(calls[0].headers['X-Anonymous-Token'], undefined);
});
test('a member 401 rejects with MEMBER_AUTH and no retry', async () => {
  await assert.rejects(client.getGoodsDetail(1, { memberToken: 't' }), { code: 'MEMBER_AUTH', status: 401 });
  assert.equal(calls.length, 1);
});
test('listLikedGoods pages with last_sno', async () => {
  // first call → { goods_list: [fixtureEntry], last_sno: 5 }, second → { goods_list: [], last_sno: null }
  assert.equal(calls[0].url, 'https://api.a-bly.com/aglo/api/members/me/liked-goods/?limit=100');
  assert.equal(calls[1].url, 'https://api.a-bly.com/aglo/api/members/me/liked-goods/?limit=100&last_sno=5');
  // first result: { entries: [fixtureEntry], lastSno: 5 }
});
test('a member 503 is retried like the list call', ...); // 503 then 200 → resolves, 2 calls
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/site4910-client.test.js`
Expected: FAIL — `client.getGoodsDetail is not a function`.

- [ ] **Step 3: Implement**

Pull the retry loop of `listBrandGoods` into one internal `getJson(url, { memberToken })` that all three calls use (shared request counter and delay). Branch on `memberToken`: member headers and `MEMBER_AUTH` on 401/403; otherwise today's anonymous path with its one token refresh on 401. Prices go through the existing `parsePrice`. `listBrandGoods` behavior and its tests stay unchanged.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/site4910-client.test.js tests/site4910-scan.test.js tests/site4910-track.test.js`
Expected: PASS (all old and new tests).

- [ ] **Step 5: Commit**

```bash
git add src/site4910/client.js tests/site4910-client.test.js
git commit -m "feat(4910): member-authenticated goods detail and liked-goods list"
```

---

### Task 3: Store — liked goods and daily liked prices

**Files:**
- Modify: `src/site4910/store.js` (schema in constructor `:22-43`, new methods after `recordScanRun`)
- Test: `tests/site4910-store.test.js`

**Interfaces:**
- Produces on `Store4910`:
  - `syncLiked(rows: Array<{ sno, brand, name, market_name, category, url, image_url }>, date: string) => { added: number, unliked: number, active: number }`
  - `logLikedPrice(r: { sno, date, list_price, original_price, coupon_price, member_price, is_soldout: 0|1 }) => void`
  - `getActiveLiked() => Array<liked_goods row>` ordered by `sno`
  - `getPrevLikedPrice(sno: number, date: string) => liked_price_logs row | undefined` (latest row with `date <` the given date)

- [ ] **Step 1: Write the failing tests** (use a temp-file store as the file already does)

```js
test('syncLiked inserts ACTIVE rows with first_liked_date and last_seen_date', ...);
// syncLiked([a, b], '2026-10-11') → { added: 2, unliked: 0, active: 2 }; row a: status 'ACTIVE', first_liked_date and last_seen_date '2026-10-11'
test('a sno missing from the next sync becomes UNLIKED and returns ACTIVE when liked again', ...);
// day2 [a] → { added: 0, unliked: 1, active: 1 }; day3 [a, b] → b ACTIVE again, first_liked_date still '2026-10-11'
test('an empty liked list unlikes nothing', ...);
// after [a, b], syncLiked([], d) → { added: 0, unliked: 0, active: 2 }
test('logLikedPrice keeps one row per sno and date', ...);
// two writes for (a, '2026-10-11'): COUNT = 1 and member_price is the second value
test('getPrevLikedPrice returns the latest row before the date', ...);
// rows on 10-09 and 10-10 → getPrevLikedPrice(a, '2026-10-11').date === '2026-10-10'; getPrevLikedPrice(a, '2026-10-09') === undefined
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/site4910-store.test.js`
Expected: FAIL — `store.syncLiked is not a function`.

- [ ] **Step 3: Implement**

Add to the constructor's `exec`:

```sql
CREATE TABLE IF NOT EXISTS liked_goods (
  sno INTEGER PRIMARY KEY, name TEXT NOT NULL, brand TEXT, market_name TEXT, category TEXT,
  url TEXT NOT NULL, image_url TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE',
  first_liked_date TEXT NOT NULL, last_seen_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS liked_price_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sno INTEGER NOT NULL, date TEXT NOT NULL,
  list_price INTEGER, original_price INTEGER, coupon_price INTEGER, member_price INTEGER,
  is_soldout INTEGER NOT NULL DEFAULT 0, UNIQUE (sno, date)
);
```

`syncLiked` runs in one transaction: upsert each row as ACTIVE (keep `first_liked_date`), then mark ACTIVE rows not in `rows` as UNLIKED — skipped entirely when `rows` is empty. `logLikedPrice` uses `INSERT OR REPLACE`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/site4910-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/site4910/store.js tests/site4910-store.test.js
git commit -m "feat(4910): store liked goods and one liked price row per day"
```

---

### Task 4: Liked sync and token reading

**Files:**
- Create: `src/site4910/liked.js`
- Modify: `tests/setup-env.js` (add `'ABLY_JWT_TOKEN'` to the deleted keys list)
- Test: `tests/site4910-liked.test.js`

**Interfaces:**
- Consumes: Task 2 `getGoodsDetail`, `listLikedGoods`, `MEMBER_AUTH`; Task 3 store methods; `toRow` from `client.js`.
- Produces:
  - `LIKED_BUDGET_MS_4910 = 4 * 60_000`
  - `readAblyToken(opts?: { env?: object, envFile?: string }) => string|null` (defaults `process.env`, `<cwd>/.env`)
  - `tokenExpiry(token: string) => Date|null`
  - `syncLiked4910(opts: { client, store, date: string, memberToken: string|null, budgetMs?: number, log?: Function }) => Promise<LikedResult>` where `LikedResult = { memberStatus: 'ok'|'expired'|'none', liked: number, logged: number, drops: Array<{ sno, name, market_name, url, prevPrice: number, currentPrice: number }> }`

- [ ] **Step 1: Write the failing tests** (fake client = plain object whose `listLikedGoods`/`getGoodsDetail` read from maps; a real `Store4910` on a temp path; a log spy)

```js
test('readAblyToken prefers env, then the .env file', ...);
// env { ABLY_JWT_TOKEN: 'a' } → 'a'; env {} with envFile containing 'ABLY_JWT_TOKEN=b' → 'b'; neither → null
test('readAblyToken normalizes cookie strings, quotes and URL encoding', ...);
// 'ably-jwt-token=x.y.z; other=1' → 'x.y.z'; '"x.y.z"' → 'x.y.z'; 'x%2Ey.z' → 'x.y.z'; '  ' → null
test('readAblyToken ignores the .env file under CLOT_NOTIFY_SANDBOX', ...);
test('tokenExpiry reads exp and returns null without it', ...);
// payload {exp: 1791700000} → new Date(1791700000 * 1000); {iat: 1} → null; 'garbage' → null
test('no token makes no calls and returns none', ...);
// → { memberStatus: 'none', liked: 0, logged: 0, drops: [] }, client call count 0
test('syncs likes and logs one row per liked item', ...);
// 2 liked, anon {price:18360, couponPrice:18360, listPrice:21600, originalPrice:51300}, member {price:19440}
// → { memberStatus:'ok', liked:2, logged:2 }; row: list_price 21600, coupon_price 18360, member_price 19440, is_soldout 0
test('MEMBER_AUTH on the liked list returns expired and touches nothing', ...);
// → memberStatus 'expired'; liked_goods COUNT 0; no detail calls
test('a liked-list failure after page 1 leaves likes untouched', ...);
// page 1 ok (last_sno 5), page 2 rejects HTTP 500 → rejects; liked_goods statuses unchanged from before
test('MEMBER_AUTH mid-way stops logging and returns expired', ...);
// 3 liked, member detail of the 2nd rejects MEMBER_AUTH → logged 1, memberStatus 'expired', 3rd never requested
test('an anonymous detail failure skips only that item', ...);
// anon detail of item 1 rejects (status 404) → logged 1 of 2, no throw
test('a member price below the last day is a drop; member null falls back to coupon price', ...);
// prev row member 20000 → today member 19440 → drops [{ prevPrice: 20000, currentPrice: 19440, ... }]
// prev row member null coupon 18000 → today member null coupon 17000 → a drop 18000→17000
test('a same-day rerun reports no drop against itself', ...);
// run twice on the same date with the same prices → second run drops []
test('a spent budget logs nothing and says 시간 초과', ...);
// budgetMs: -1 → logged 0, a log line matches /찜 가격 기록 시간 초과/
test('the token never appears in logs', ...);
// across the runs above with memberToken 'SECRET-TOKEN', no log line contains it
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/site4910-liked.test.js`
Expected: FAIL — cannot find module `../src/site4910/liked.js`.

- [ ] **Step 3: Implement `syncLiked4910`**

1. No `memberToken` → return `{ memberStatus: 'none', liked: 0, logged: 0, drops: [] }`.
2. Page `listLikedGoods` until `lastSno` is null or a page is empty (cap 50 pages). Map with `toRow(entry, { sno: analytics.BRAND_SNO ?? null, name: analytics.BRAND_NAME ?? null })`, closed listings included. `MEMBER_AUTH` → return `expired` with zeros; any other error propagates (the caller logs it), so likes are written only after a full listing.
3. `store.syncLiked(rows, date)`.
4. For each `store.getActiveLiked()` until the deadline (on timeout log `⚠️ [4910] 찜 가격 기록 시간 초과 (logged/total)` and stop): anonymous detail (failure → log `sno` and status, skip), then member detail (`MEMBER_AUTH` → set `expired`, stop before logging this item; other failure → member price null). Log the row; compare `member_price ?? coupon_price` with `getPrevLikedPrice` the same way; a lower value is a drop.
5. Sort drops by `(prevPrice - currentPrice) / prevPrice` descending.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/site4910-liked.test.js tests/test-isolation.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/site4910/liked.js tests/site4910-liked.test.js tests/setup-env.js
git commit -m "feat(4910): sync liked items and record member and coupon prices daily"
```

---

### Task 5: Daily wiring and Telegram digest

**Files:**
- Modify: `src/cli.js` (`run4910Step`, `:485-536`)
- Modify: `src/site4910/digest.js` (`format4910Digest`, `:20-35`)
- Test: `tests/cli-4910.test.js`, `tests/site4910-digest.test.js`

**Interfaces:**
- Consumes: Task 4 `syncLiked4910`, `readAblyToken`, `LikedResult`.
- Produces: `format4910Digest(result, opts?: { limit?: number, liked?: LikedResult|null }) => string`; `run4910Step` gains injectables `syncLikedFn = syncLiked4910`, `readToken = readAblyToken`, and its return gains `liked: LikedResult|null`.

- [ ] **Step 1: Write the failing tests**

```js
// site4910-digest.test.js
test('liked ok adds the count line and a 💜 drop section', ...);
// liked { memberStatus:'ok', liked: 12, logged: 11, drops: [one] } → contains '찜 12개 · 가격 기록 11개' and
// '<b>💜 찜 상품 회원가 하락 (상위 1):</b>' and '🔻 [모에모에] ... — 20,000→19,440원'
test('liked expired adds the expiry warning', ...);   // contains '⚠️ 4910 로그인 만료 — ABLY_JWT_TOKEN 갱신 필요'
test('liked none or null adds nothing', ...);         // output equals format4910Digest(result)
test('over 4096 chars drops scan lines before liked lines', ...);

// cli-4910.test.js
test('run4910Step runs the liked sync after the scan and passes it to the digest', ...);
// readToken: () => 'T', syncLikedFn spy → args { client, store, date: TODAY, memberToken: 'T' };
// notify text contains '찜 3개 · 가격 기록 3개'; res.liked is the spy result
test('run4910Step without a token skips the liked sync', ...);
// readToken: () => null → syncLikedFn not called, a log line matches /ABLY_JWT_TOKEN 없음/
test('a liked sync failure still sends the scan digest', ...);
// syncLikedFn throws → res.ok true, notify called once, log matches /⚠️ \[4910\] 찜 가격 기록 실패/
test('a failed scan still runs the liked sync but sends no digest', ...);
// trackFn throws → syncLikedFn called once, notify 0 calls, res.ok false
test('--dry-run never runs the liked sync', ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/cli-4910.test.js tests/site4910-digest.test.js`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement**

Digest: liked lines go right after the counts line, the 💜 section (at most `limit` drops) after the scan drop section, using the existing `🔻 [market] name — prev→cur원\n  • <a href>바로가기</a>` line format. The truncation loop pops scan drop lines first, then liked drop lines.

`run4910Step`: create the client once and share it with the scan and the liked sync. Run the scan in its own try/catch (failure log unchanged). If a store is open, run the liked sync in a second try/catch. With no token, log `[4910] ABLY_JWT_TOKEN 없음 — 찜 가격 기록 건너뜀`. On success log `💜 [4910] 찜 {liked}개 · 가격 기록 {logged}개 ({memberStatus})`. Send the digest only when the scan succeeded. Leave checkpoint/close in `finally` as is.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS (whole suite, including the existing `run4910Step` tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli.js src/site4910/digest.js tests/cli-4910.test.js tests/site4910-digest.test.js
git commit -m "feat(4910): run the liked sync in the daily 4910 step and report it"
```

---

### Task 6: Dashboard payload — merge liked 4910 items

**Files:**
- Modify: `src/visualizer.js` (`buildClotDataPayload` `:28-130`, `generateDashboardHtml` `:142-220`)
- Test: `tests/visualizer-data.test.js`, `tests/visualizer-html.test.js`

**Interfaces:**
- Consumes: Task 3 tables (read-only SQL, not `Store4910` methods).
- Produces:
  - `buildClotDataPayload(db, opts?: { targetGoodsNo?, db4910?: DatabaseSync|null })`. Every item gains `k: string` and `src: 'musinsa'|'4910'`. Musinsa: `k = String(goods_no)`. 4910 items: `{ n: sno, k: '4910:' + sno, src: '4910', b: brand || market_name || '4910', m: market_name, g: name, u: url, i: image_url, s: 'ACTIVE', c: classifyCategory(name, brand), fs: first_liked_date, L }`, ACTIVE liked rows only.
  - 4910 tuple: `[date, original_price, list_price, my, is_soldout, member_price != null ? '내 회원가' : '쿠폰적용가(신규회원 기준)', list_price != null && my != null ? Math.max(list_price - my, 0) : 0, coupon_price]` with `my = member_price ?? coupon_price ?? list_price`.
  - `dates` = sorted union of both sources' dates.
  - `generateDashboardHtml({ ..., db4910Path = process.env.CLOT_4910_DB_PATH || <repo>/data/4910.db })` opens the file read-only only if it exists and closes it in `finally`.

- [ ] **Step 1: Write the failing tests**

```js
// visualizer-data.test.js (4910 side: new Store4910(':memory:') + syncLiked/logLikedPrice, pass store.db as db4910)
test('without a 4910 DB, Musinsa items only gain k and src', ...);
// items[0].k === '1001', items[0].src === 'musinsa'; no item with src '4910'
test('liked 4910 items join with 8-slot tuples', ...);
// member row → ['2026-10-11', 51300, 21600, 19440, 0, '내 회원가', 2160, 18360]
// member-null row → [..., 18360, 0, '쿠폰적용가(신규회원 기준)', 3240, 18360]; item.k === '4910:71863924'
test('UNLIKED 4910 items are left out', ...);
test('a 4910.db without liked tables is skipped', ...);
// db4910 = in-memory DB with only a goods table → no throw, no 4910 items
test('a Musinsa goods_no equal to a 4910 sno keeps distinct keys', ...);
// Musinsa 71863924 and 4910 sno 71863924 → keys '71863924' and '4910:71863924'

// visualizer-html.test.js
test('generateDashboardHtml merges the 4910.db at db4910Path', ...);
// file DB via new Store4910(tmpPath) with one liked row → output HTML contains '"k":"4910:71863924"'
test('generateDashboardHtml without a 4910.db still renders', ...); // db4910Path to a missing file
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/visualizer-data.test.js tests/visualizer-html.test.js`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement as specified in Interfaces**

Detect the liked tables with `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('liked_goods','liked_price_logs')`; both must be present.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/visualizer-data.test.js tests/visualizer-html.test.js tests/cli-visualize.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/visualizer.js tests/visualizer-data.test.js tests/visualizer-html.test.js
git commit -m "feat(dashboard): merge liked 4910 items into the dashboard payload"
```

---

### Task 7: Dashboard template — source filter and 4910 cards

**Files:**
- Modify: `src/dashboard.template.html` (chips `:533-539`, prep `:661-687`, state/matches `:716-735`, `cardHtml` `:768-793`, grid click and modal `:908-950`, `fillModal` `:985-1017`, `drawChart` `:1060-1120`, `fillTable` `:1160-1182`, deep link `:1186-1187`, history table and legend markup `:600-620`)
- Test: `tests/visualizer-html.test.js`

**Interfaces:** Consumes: Task 6 payload (`k`, `src`, `m`, tuple slot `[7]`).

- [ ] **Step 1: Write the failing test**

```js
test('template has the source chips and the new-member column', ...);
// generated HTML contains 'data-src="4910"', 'data-src="musinsa"', 'class="nb-col"'
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/visualizer-html.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement (ES5, matching the file's style)**

- Source chips: a second `.chips` group (`aria-label="출처 필터"`) before the quick filters, buttons `data-src="all|musinsa|4910"` with counts `#sAll/#sMusinsa/#s4910`. `state.src` persisted with `store('src')`; `matches` filters on `it.src`; the counts and KPIs use the source-scoped pool the same way category does.
- Prep: `it._hay` adds `it.m`; `it.newbie = last.length > 7 ? last[7] : null`.
- Card: `data-k` instead of `data-n` (`data-od-id="product-card-" + it.k`); for 4910 a `<span class="cat-tag">4910</span>` badge; when `it.newbie != null && it.newbie !== it.my`, add `<div class="was num">쿠폰적용가(신규회원 기준) {won}</div>`.
- Lookup by key: grid click → `openModal(c.dataset.k)`; `openModal(key)` matches `x.k === String(key)`; `setUrl('?goods=' + it.k)` in both places; deep link `openModal(dl)`. Old `?goods=<digits>` still opens the Musinsa item, because Musinsa `k` equals the digits.
- Modal: link text `4910에서 보기 ↗` for 4910 (else unchanged); fact `4910 표시가` instead of `무신사 판매가` for 4910; fact `쿠폰적용가(신규회원 기준)` when `newbie != null`.
- Chart: dataset 1 label follows the same 4910/Musinsa rule; for 4910 add a 4th dataset `쿠폰적용가(신규회원)` from `r[7]` (muted, 1.5 px, small points), and include those values in the y-axis minimum.
- Table: static header and legend `무신사 판매가` → `판매가`; add `<th class="nb-col">신규회원가</th>` and a matching `<td class="nb-col num">` per row; CSS `.nb-col{display:none}` and `.is-4910 .nb-col{display:table-cell}`; `fillModal` toggles `is-4910` on `#sheet`; empty-state `colspan` 6 → 7.

- [ ] **Step 4: Run the test**

Run: `node --test tests/visualizer-html.test.js`
Expected: PASS.

- [ ] **Step 5: Check it in the browser pane**

Build a fixture: a temp `4910.db` via `new Store4910(<scratch>/4910.db)` with two liked items and rows on two dates (one with a member price, one with only a coupon price, the second date lower). Then:

```bash
CLOT_4910_DB_PATH=<scratch>/4910.db CLOT_DASHBOARD_PATH=<scratch>/dash.html node src/cli.js visualize --no-open
```

Open `<scratch>/dash.html` in the browser pane and check:
- the `4910` chip shows only the two items and the counts update
- cards show the 4910 badge and the 신규회원 line
- the 하락 filter catches the lowered item
- the modal opens via `?goods=4910:<sno>`, and the chart has 4 lines with the 신규회원가 column visible
- a Musinsa item's modal has no 신규회원가 column

Check at 375 px width as well.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard.template.html tests/visualizer-html.test.js
git commit -m "feat(dashboard): source filter and 4910 member-price cards"
```

---

### Task 8: Actions, probe, and docs

**Files:**
- Modify: `src/site4910/track.js` (`probe4910`, `:54-75`), `scripts/actions-probe.js:85`
- Modify: `.github/workflows/daily.yml` (steps "Probe Musinsa from this runner" and "Daily run"), `.github/workflows/pages.yml` (`paths`)
- Modify: `README.md` (§9 feature at `:41-48`, §5 table at `:223-234`, §6 at `:241-249`), `.env.example`
- Test: `tests/site4910-track.test.js`

**Interfaces:**
- Consumes: Task 2 `listLikedGoods`, Task 4 `readAblyToken`, `tokenExpiry`.
- Produces: `probe4910({ client, memberToken = null })`. When a token is given it appends `{ name: '4910 member login', ok, detail }` with detail `liked page ok, exp in {d}d` or `liked page ok, no exp` (on failure: `{status}: {message}`). With no token there is no extra check, so the two existing probe tests stay as they are.

- [ ] **Step 1: Write the failing tests**

```js
test('probe4910 adds a member login check when a token is given', ...);
// fetch: token/list ok, liked → 200 → third check ['4910 member login', true]; no detail contains the token
test('probe4910 reports an expired member token', ...);
// liked → 401 → ['4910 member login', false], detail matches /401/
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/site4910-track.test.js`
Expected: FAIL on the two new tests.

- [ ] **Step 3: Implement the probe, then wire config and docs**

- `actions-probe.js`: `probe4910({ client: createClient(), memberToken: readAblyToken() })`.
- `daily.yml`: add `ABLY_JWT_TOKEN: ${{ secrets.ABLY_JWT_TOKEN }}` to the `env` of both steps.
- `pages.yml`: add `- data/4910.db` under `paths`.
- `.env.example`: a commented `ABLY_JWT_TOKEN=` (4910.kr `ably-jwt-token` cookie; for liked-item member prices).
- README:
  - §9 bullet: liked items, three prices, the dashboard 4910 filter, the expiry warning.
  - §5 table row: `ABLY_JWT_TOKEN | Secret | 4910.kr 로그인 쿠키 ably-jwt-token 값 (찜 상품 회원가, 선택)`.
  - §5 commands: how to copy the cookie from DevTools, plus `gh secret set ABLY_JWT_TOKEN` (prompts, no echo).
  - §6 note: `data/4910.db`, including the liked list, is public like `prices.db`.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/site4910/track.js scripts/actions-probe.js .github/workflows/daily.yml .github/workflows/pages.yml README.md .env.example tests/site4910-track.test.js
git commit -m "feat(4910): ABLY_JWT_TOKEN in Actions, member login probe, docs"
```

- [ ] **Step 6: Hand-off note (no action by the agent)**

Tell the user the remaining manual steps:

```bash
gh secret set ABLY_JWT_TOKEN
```

```bash
gh workflow run daily.yml -f mode=probe
```

Expected: the probe shows `4910 member login` ok. After merge, the next scheduled run fills the 4910 section.
