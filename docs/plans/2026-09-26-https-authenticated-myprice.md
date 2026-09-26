# HTTPS Authenticated myPrice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect the exact personalized "나의 할인가" (`myPrice`) for VIP items with plain HTTPS requests carrying a cached Musinsa login cookie, and fall back to OpenCLI `my-prices` only for items that the HTTPS path fails on.

**Architecture:** A pure calculator (`computeMyPrice`) reproduces the discount math that the Musinsa product page runs client-side. A fetcher (`fetchAuthenticatedPriceInfo`) gathers the inputs from three authenticated HTTPS calls. A session module caches the auth cookies outside the repo and fetches fresh ones through the OpenCLI browser bridge when needed. `collectPricesForActiveItems` gains a new first stage that prices VIP items over HTTPS. The existing OpenCLI stage, circuit breaker and direct parser then run only for the items that stage left behind.

**Tech Stack:** Node.js ESM (`"type": "module"`), global `fetch`, `node:test` + `node:assert/strict`, `better-sqlite3`-backed `db` (mocked in tests), OpenCLI CLI (`opencli browser …`).

**Spec:** The "Background" section below. It records findings verified on 2026-09-26 against all 109 active VIP items: 109/109 exact matches with OpenCLI `my-prices`.

## Background (Spec)

The Musinsa product page computes "나의 할인가" in the browser. No server endpoint returns it. All inputs are available over HTTPS when the request carries the auth cookies `app_atk`, `app_rtk` and `mss_mac`. All three are readable through `document.cookie`, so no HttpOnly access is needed.

| Input | Source |
|---|---|
| `salePrice`, `extraDiscountAmount`, `memberDiscountRate`, `memberSavePointRate`, `savePoint`, `normalPrice`, `couponPrice` | `https://www.musinsa.com/products/{goodsNo}` → `<script id="__NEXT_DATA__">` → `props.pageProps.dehydratedState.queries[queryKey[0]==='Detail' && queryKey[1]===goodsNo].state.data.data.goodsPrice` |
| `isLimitedDc`, `isRestictedUsePoint` (Musinsa's typo), `maxUsePointRate`, `isPrePoint`, `isGivenPoint`, `point.memberPoint`, `brand`, `comId`, `specialtyCodes`, `isSoldOut`, `goodsSaleType` | same `Detail` object |
| logged-in flag | same page, query `queryKey = ['Detail','LoginStatus']` → `state.data.data.loggedIn` |
| best coupon discount | `GET https://api.musinsa.com/api2/coupon/coupons/getUsableCouponsByGoodsNo?goodsNo&brand&comId&salePrice[&specialtyCodes]` → `data.list[].salePrice` is the **discount amount** of each coupon; use the max |
| card instant discount | `GET https://goods-detail.musinsa.com/api2/goods/{goodsNo}/card-promotion?brand={brand}` → `data.promotions[]` with `isApplicable`, `minAmount`, `discountAmount` |

Verified formula (`floor10(x) = 10 * Math.floor(x / 10)`):

```
base        = salePrice − bestCouponDiscount − extraDiscountAmount
grade       = isLimitedDc ? 0 : floor10(base × memberDiscountRate / 100)
pointMax    = isRestictedUsePoint ? 0 : floor10((base − grade) × maxUsePointRate)
point       = min(pointMax, memberPoint)
basic       = base − grade − point
prePoint    = isPrePoint ? floor10(basic × memberSavePointRate / 100) + (isGivenPoint ? savePoint : 0) : 0
instant     = max discountAmount of promotions where isApplicable && (basic − prePoint) >= minAmount, else 0
myPrice     = basic − prePoint − instant
```

Verified reference cases (all equal to OpenCLI output):

| goodsNo | salePrice | coupon | extra | limitedDc | restrictedPt | memberPoint | prePoint(isGiven,savePoint) | promos | myPrice |
|---|---|---|---|---|---|---|---|---|---|
| 595039 | 229000 | 0 | 0 | no | no | 10899 | no | 5000 @ ≥100000 | **209671** |
| 2322315 | 64890 | 19460 | 0 | no | no | 10899 | no | 5000 @ ≥100000 | **41620** |
| 6047897 | 499000 | 34930 | 0 | no | no | 10899 | no | 5000 @ ≥100000, 15000 @ ≥300000 | **431211** |
| 4663718 | 86400 | 10360 | 8560 | yes | no | 10899 | no | none | **62760** |
| 3933001 | 119000 | 12000 | 0 | yes | no | 10899 | yes (given, 110) | 5000 @ ≥100000 | **97910** |
| 3982118 | 22800 | 0 | 4050 | yes | yes | 10899 | no | none | **18750** |

Operational findings:
- Sending product-page requests 4 at a time made Musinsa answer 200 **without** `__NEXT_DATA__` for 88/109 items. Sequential requests about 700 ms apart, with retry, succeeded 109/109.
- Without cookies the same page returns `memberDiscountRate: 0`, `memberPoint: 0` and `loggedIn: false`.
- `src/cli.js` `exportDataForGit()` runs `git add data/` and the daily run pushes to origin. **The cookie cache must never live inside the repo.**

## Global Constraints

- Node ESM only (`import`/`export`); tests use `node:test` + `node:assert/strict`; run all tests with `npm test`.
- Cookie cache path: `~/.clot/musinsa-session.json` (dir mode `0o700`, file mode `0o600`). Never under the repo, never under `data/`.
- Only the cookies `app_atk`, `app_rtk`, `mss_mac` are stored or sent. Never log cookie values.
- The HTTPS stage runs sequentially with `authDelayMs = 700` between items; no concurrent product-page requests in this stage.
- Price source priority for VIP items: HTTPS-auth → OpenCLI `my-prices` → direct public parser (`fetchProductPriceInfo`).
- `daily_runs.mode` values stay `'full' | 'deferred' | 'degraded'`. A run where every VIP item was priced over HTTPS is `'full'` even if the browser bridge was unusable.
- Do **not** run `node src/cli.js daily` (with or without `--force`) to verify: it re-collects and pushes to origin. Verify with `npm test` and the Task 5 manual comparison.
- Commit messages: Conventional Commits (`feat(scope): …`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Prerequisites

- The working tree currently has unrelated uncommitted work (`src/cli.js`, `src/db.js`, `README.md`, `package.json`, audit/skip files). Before Task 1, ask the user to commit or stash it so this plan's commits contain only its own changes. Then create a branch: `git switch -c feat/https-auth-myprice`.

## Review Focus

1. **Cookie cache committed to git.** `git add data/` runs on every daily. Expected: the cache path is outside the repo. Pinned by a Task 3 test asserting `DEFAULT_SESSION_PATH` is not inside the repo root.
2. **Rate-limited page (HTTP 200 without `__NEXT_DATA__`).** Expected: retry with backoff, then throw so the item falls back. Never record "Unknown Product" or a null price. Pinned by a Task 2 test.
3. **Coupon or card-promotion API failure.** Expected: throw, not compute a `myPrice` missing the coupon. A missing coupon would record a fake price rise and corrupt `lowest_my_price` history. Pinned by a Task 2 test.
4. **Session expires mid-run.** Expected: refresh the cookie once and retry the same item. If refresh fails, stop the HTTPS stage and let the remaining items take the existing OpenCLI/deferred path. No infinite loop. Pinned by Task 4 tests.
5. **Corrupt, empty or foreign cookie cache file.** Expected: treated as "no cookie", with no crash. Pinned by a Task 3 test.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/myprice.js` | Create | `computeMyPrice` (pure math), `extractProductDetail` (HTML → detail + loggedIn), `fetchAuthenticatedPriceInfo` (3 HTTPS calls → priceInfo), `SessionExpiredError` |
| `src/session.js` | Create | Cookie cache read/write/clear, cookie fetch via OpenCLI bridge, `makeSessionProvider` |
| `src/collector.js` | Modify | New exported `collectAuthenticatedPrices`; new HTTPS stage in `collectPricesForActiveItems`; OpenCLI stage limited to leftover VIP items; mode rule |
| `src/cli.js` | Modify | Pass `sessionProvider` in `daily` and `track` |
| `README.md` | Modify | Describe the new price-source order |
| `tests/myprice-compute.test.js` | Create | Formula cases |
| `tests/myprice-fetch.test.js` | Create | Fetcher behavior with mocked `fetch` |
| `tests/session.test.js` | Create | Cache + bridge + provider |
| `tests/collector-auth.test.js` | Create | Collector stage integration |

---

### Task 1: Pure myPrice calculator

**Files:**
- Create: `src/myprice.js`
- Test: `tests/myprice-compute.test.js`

**Interfaces:**
- Consumes: `floor10(val)` from `src/discovery.js` (exported, `10 * Math.floor(Number(val) / 10)`).
- Produces: `computeMyPrice(input) → { myPrice: number, breakdown: { base, gradeDiscount, pointDiscount, basicPrice, prePointDiscount, instantDiscount } }`, where `input = { salePrice, couponDiscount=0, extraDiscountAmount=0, memberDiscountRate=0, isLimitedDc=false, isRestrictedUsePoint=false, maxUsePointRate=0.07, memberPoint=0, isPrePoint=false, isGivenPoint=false, memberSavePointRate=0, savePoint=0, cardPromotions=[] }`, and `cardPromotions` items are `{ isApplicable: boolean, minAmount: number, discountAmount: number }`.

- [ ] **Step 1: Write the failing test**

Create `tests/myprice-compute.test.js`:

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeMyPrice } from '../src/myprice.js';

const PROMO_5K = { isApplicable: true, minAmount: 100000, discountAmount: 5000 };

describe('computeMyPrice (verified against OpenCLI my-prices on 2026-09-26)', () => {
  test('595039: grade 1.5% + point capped by memberPoint + card instant 5000', () => {
    const r = computeMyPrice({
      salePrice: 229000, memberDiscountRate: 1.5, memberPoint: 10899, cardPromotions: [PROMO_5K],
    });
    assert.equal(r.myPrice, 209671);
    assert.deepEqual(r.breakdown, {
      base: 229000, gradeDiscount: 3430, pointDiscount: 10899, basicPrice: 214671, prePointDiscount: 0, instantDiscount: 5000,
    });
  });

  test('2322315: best coupon applied, promo below minAmount ignored', () => {
    const r = computeMyPrice({
      salePrice: 64890, couponDiscount: 19460, memberDiscountRate: 1.5, memberPoint: 10899, cardPromotions: [PROMO_5K],
    });
    assert.equal(r.myPrice, 41620);
    assert.equal(r.breakdown.instantDiscount, 0);
  });

  test('6047897: picks the largest eligible promo', () => {
    const r = computeMyPrice({
      salePrice: 499000, couponDiscount: 34930, memberDiscountRate: 1.5, memberPoint: 10899,
      cardPromotions: [PROMO_5K, { isApplicable: true, minAmount: 300000, discountAmount: 15000 }],
    });
    assert.equal(r.myPrice, 431211);
  });

  test('4663718: extraDiscountAmount reduces the base before point usage; limited DC skips grade', () => {
    const r = computeMyPrice({
      salePrice: 86400, couponDiscount: 10360, extraDiscountAmount: 8560, memberDiscountRate: 1.5,
      isLimitedDc: true, memberPoint: 10899,
    });
    assert.equal(r.breakdown.pointDiscount, 4720);
    assert.equal(r.myPrice, 62760);
  });

  test('3933001: pre-point = floor10(basic × rate) + savePoint when isGivenPoint', () => {
    const r = computeMyPrice({
      salePrice: 119000, couponDiscount: 12000, memberDiscountRate: 1.5, isLimitedDc: true, memberPoint: 10899,
      isPrePoint: true, isGivenPoint: true, memberSavePointRate: 1.5, savePoint: 110, cardPromotions: [PROMO_5K],
    });
    assert.equal(r.breakdown.prePointDiscount, 1600);
    assert.equal(r.breakdown.instantDiscount, 0); // 97910 < 100000
    assert.equal(r.myPrice, 97910);
  });

  test('3982118: restricted point use + extra discount only', () => {
    const r = computeMyPrice({
      salePrice: 22800, extraDiscountAmount: 4050, isLimitedDc: true, isRestrictedUsePoint: true, memberPoint: 10899,
    });
    assert.equal(r.myPrice, 18750);
  });

  test('promotions with isApplicable=false are ignored', () => {
    const r = computeMyPrice({
      salePrice: 229000, memberPoint: 0, cardPromotions: [{ isApplicable: false, minAmount: 0, discountAmount: 9000 }],
    });
    assert.equal(r.breakdown.instantDiscount, 0);
    assert.equal(r.breakdown.pointDiscount, 0); // memberPoint 0 caps point usage at 0
    assert.equal(r.myPrice, 229000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/myprice-compute.test.js`
Expected: FAIL with `Cannot find module '.../src/myprice.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/myprice.js`:

```js
import { floor10 } from './discovery.js';

/**
 * Reproduces the "나의 할인가" math that the Musinsa product page runs client-side.
 * Verified 109/109 against OpenCLI `musinsa my-prices` on 2026-09-26.
 * @returns {{ myPrice: number, breakdown: object }}
 */
export function computeMyPrice({
  salePrice,
  couponDiscount = 0,
  extraDiscountAmount = 0,
  memberDiscountRate = 0,
  isLimitedDc = false,
  isRestrictedUsePoint = false,
  maxUsePointRate = 0.07,
  memberPoint = 0,
  isPrePoint = false,
  isGivenPoint = false,
  memberSavePointRate = 0,
  savePoint = 0,
  cardPromotions = [],
}) {
  const base = salePrice - couponDiscount - extraDiscountAmount;
  const gradeDiscount = isLimitedDc ? 0 : floor10((base * memberDiscountRate) / 100);
  const afterGrade = base - gradeDiscount;
  const pointMax = isRestrictedUsePoint ? 0 : floor10(afterGrade * maxUsePointRate);
  const pointDiscount = Math.min(pointMax, Math.max(0, memberPoint || 0));
  const basicPrice = afterGrade - pointDiscount;
  const prePointDiscount = isPrePoint
    ? floor10((basicPrice * memberSavePointRate) / 100) + (isGivenPoint ? savePoint || 0 : 0)
    : 0;
  const afterPrePoint = basicPrice - prePointDiscount;
  const eligible = (cardPromotions || []).filter(
    (p) => p && p.isApplicable && afterPrePoint >= (p.minAmount ?? 0)
  );
  const instantDiscount = eligible.length ? Math.max(...eligible.map((p) => p.discountAmount || 0)) : 0;

  return {
    myPrice: afterPrePoint - instantDiscount,
    breakdown: { base, gradeDiscount, pointDiscount, basicPrice, prePointDiscount, instantDiscount },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/myprice-compute.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/myprice.js tests/myprice-compute.test.js
git commit -m "feat(myprice): add pure calculator reproducing Musinsa 나의 할인가

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Authenticated HTTPS fetcher

**Files:**
- Modify: `src/myprice.js`
- Test: `tests/myprice-fetch.test.js`

**Interfaces:**
- Consumes: `computeMyPrice` (Task 1); `estimateMemberPrice(couponPrice, isRestrictedUsePoint, { isLimitedDc })` from `src/discovery.js`.
- Produces:
  - `class SessionExpiredError extends Error` (`name === 'SessionExpiredError'`)
  - `extractProductDetail(html: string, goodsNo: number) → { detail: object|null, loggedIn: boolean } | null`. Returns `null` when `__NEXT_DATA__` is absent.
  - `fetchAuthenticatedPriceInfo(goodsNo: number, { cookie: string, fetchFn = fetch, retries = 4, backoffBaseMs = 2000 }) → Promise<priceInfo>`. On 404 it resolves `{ status: 404, discontinued: true }`. It rejects with `SessionExpiredError` when the page says logged out, and rejects with `Error` on any other failure. `priceInfo` = `{ goodsNo, goodsName, brandName, imageUrl, url, normalPrice, salePrice, couponPrice, saleRate, myPrice, estimatedMyPrice, isRestrictedUsePoint, isLimitedDc, couponName, couponDiscount, isSoldOut, discontinued: false, priceSource: 'https-auth' }`. These are the same field names `collectPricesForActiveItems` already reads from `fetchProductPriceInfo`.

- [ ] **Step 1: Write the failing test**

Create `tests/myprice-fetch.test.js`:

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAuthenticatedPriceInfo, extractProductDetail, SessionExpiredError } from '../src/myprice.js';

const GOODS = 2322315;
const DETAIL = {
  goodsNm: 'M160 스트레이트 데님 팬츠', brand: 'waar', comId: 'waar', brandInfo: { brandName: '와르' },
  thumbnailImageUrl: 'https://image.msscdn.net/x.jpg', specialtyCodes: [], isSoldOut: false, goodsSaleType: 'SALE',
  isLimitedDc: false, isRestictedUsePoint: false, maxUsePointRate: 0.07, isPrePoint: false, isGivenPoint: false,
  point: { memberPoint: 10899 },
  goodsPrice: {
    normalPrice: 72100, salePrice: 64890, couponPrice: 45430, finalDiscount: 37, extraDiscountAmount: 0,
    memberDiscountRate: 1.5, memberSavePointRate: 1.5, savePoint: 0,
  },
};

function pageHtml({ goodsNo = GOODS, loggedIn = true, detail = DETAIL } = {}) {
  const nextData = { props: { pageProps: { dehydratedState: { queries: [
    { queryKey: ['Detail', goodsNo], state: { data: { data: detail } } },
    { queryKey: ['Detail', 'LoginStatus'], state: { data: { data: { loggedIn } } } },
  ] } } } };
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></html>`;
}

function res(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

const COUPONS = { data: { list: [{ couponName: '와르 추석 30%', salePrice: 19460 }, { couponName: '실버 5%', salePrice: 3240 }], count: 2 } };
const PROMOS = { data: { promotions: [{ isApplicable: true, minAmount: 100000, discountAmount: 5000 }] } };

function makeFetch({ pages = [pageHtml()], coupons = res(200, COUPONS), promos = res(200, PROMOS) } = {}) {
  const calls = [];
  let pageIdx = 0;
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (url.startsWith('https://www.musinsa.com/products/')) {
      const p = pages[Math.min(pageIdx++, pages.length - 1)];
      return typeof p === 'string' ? res(200, p) : p;
    }
    if (url.includes('/coupon/coupons/getUsableCouponsByGoodsNo')) return coupons;
    if (url.includes('/card-promotion')) return promos;
    throw new Error(`unexpected url ${url}`);
  };
  fn.calls = calls;
  return fn;
}

describe('extractProductDetail', () => {
  test('returns null when __NEXT_DATA__ is missing (rate-limited page)', () => {
    assert.equal(extractProductDetail('<html>blocked</html>', GOODS), null);
  });
  test('returns detail and loggedIn flag', () => {
    const r = extractProductDetail(pageHtml({ loggedIn: false }), GOODS);
    assert.equal(r.loggedIn, false);
    assert.equal(r.detail.brand, 'waar');
  });
});

describe('fetchAuthenticatedPriceInfo', () => {
  test('computes exact myPrice and sends the cookie on every request', async () => {
    const fetchFn = makeFetch();
    const info = await fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=a; app_rtk=b; mss_mac=c', fetchFn, backoffBaseMs: 0 });
    assert.equal(info.myPrice, 41620);
    assert.equal(info.salePrice, 64890);
    assert.equal(info.couponPrice, 45430);
    assert.equal(info.couponName, '와르 추석 30%');
    assert.equal(info.couponDiscount, 19460);
    assert.equal(info.priceSource, 'https-auth');
    assert.equal(info.discontinued, false);
    assert.equal(fetchFn.calls.length, 3);
    for (const c of fetchFn.calls) assert.equal(c.opts.headers.Cookie, 'app_atk=a; app_rtk=b; mss_mac=c');
    const couponUrl = new URL(fetchFn.calls.find((c) => c.url.includes('getUsableCoupons')).url);
    assert.equal(couponUrl.searchParams.get('goodsNo'), String(GOODS));
    assert.equal(couponUrl.searchParams.get('brand'), 'waar');
    assert.equal(couponUrl.searchParams.get('comId'), 'waar');
    assert.equal(couponUrl.searchParams.get('salePrice'), '64890');
    assert.equal(couponUrl.searchParams.has('specialtyCodes'), false);
  });

  test('rejects with SessionExpiredError when the page reports logged out', async () => {
    const fetchFn = makeFetch({ pages: [pageHtml({ loggedIn: false })] });
    await assert.rejects(
      fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=x', fetchFn, backoffBaseMs: 0 }),
      (err) => err instanceof SessionExpiredError && err.name === 'SessionExpiredError'
    );
  });

  test('404 resolves as discontinued without calling coupon/promo APIs', async () => {
    const fetchFn = makeFetch({ pages: [res(404, 'not found')] });
    const info = await fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=x', fetchFn, backoffBaseMs: 0 });
    assert.deepEqual(info, { status: 404, discontinued: true });
    assert.equal(fetchFn.calls.length, 1);
  });

  test('retries a 200 page without __NEXT_DATA__ (rate limit) and then succeeds', async () => {
    const fetchFn = makeFetch({ pages: ['<html>blocked</html>', res(429, ''), pageHtml()] });
    const info = await fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=x', fetchFn, backoffBaseMs: 0 });
    assert.equal(info.myPrice, 41620);
    assert.equal(fetchFn.calls.filter((c) => c.url.includes('/products/')).length, 3);
  });

  test('gives up after `retries` blocked pages instead of returning a bogus price', async () => {
    const fetchFn = makeFetch({ pages: ['<html>blocked</html>'] });
    await assert.rejects(
      fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=x', fetchFn, retries: 2, backoffBaseMs: 0 }),
      /unavailable after 2 attempts/
    );
  });

  test('coupon API failure rejects (never computes a price without coupons)', async () => {
    const fetchFn = makeFetch({ coupons: res(500, { error: 'x' }) });
    await assert.rejects(
      fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=x', fetchFn, backoffBaseMs: 0 }),
      /HTTP 500/
    );
  });

  test('card-promotion API failure rejects', async () => {
    const fetchFn = makeFetch({ promos: res(503, '') });
    await assert.rejects(
      fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=x', fetchFn, backoffBaseMs: 0 }),
      /HTTP 503/
    );
  });

  test('passes specialtyCodes to the coupon API when present', async () => {
    const fetchFn = makeFetch({ pages: [pageHtml({ detail: { ...DETAIL, specialtyCodes: ['sneaker'] } })] });
    await fetchAuthenticatedPriceInfo(GOODS, { cookie: 'app_atk=x', fetchFn, backoffBaseMs: 0 });
    const couponUrl = new URL(fetchFn.calls.find((c) => c.url.includes('getUsableCoupons')).url);
    assert.equal(couponUrl.searchParams.get('specialtyCodes'), 'sneaker');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/myprice-fetch.test.js`
Expected: FAIL with `does not provide an export named 'fetchAuthenticatedPriceInfo'`

- [ ] **Step 3: Write minimal implementation**

In `src/myprice.js`, change the import line to:

```js
import { floor10, estimateMemberPrice } from './discovery.js';
```

Append to `src/myprice.js`:

```js
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export class SessionExpiredError extends Error {
  constructor(message = 'Musinsa session expired (page reports logged out)') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/**
 * @returns {{ detail: object|null, loggedIn: boolean } | null} null when __NEXT_DATA__ is absent
 */
export function extractProductDetail(html, goodsNo) {
  const m = String(html || '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  const queries = JSON.parse(m[1]).props?.pageProps?.dehydratedState?.queries || [];
  const detail =
    queries.find((q) => q.queryKey?.[0] === 'Detail' && Number(q.queryKey?.[1]) === Number(goodsNo))?.state?.data
      ?.data ?? null;
  const loggedIn = Boolean(
    queries.find((q) => q.queryKey?.[0] === 'Detail' && q.queryKey?.[1] === 'LoginStatus')?.state?.data?.data?.loggedIn
  );
  return { detail, loggedIn };
}

async function fetchProductPage(goodsNo, headers, fetchFn, retries, backoffBaseMs) {
  const url = `https://www.musinsa.com/products/${goodsNo}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetchFn(url, { headers: { ...headers, Accept: 'text/html,application/xhtml+xml' } });
    if (res.status === 404) return { discontinued: true };
    if (res.ok) {
      const parsed = extractProductDetail(await res.text(), goodsNo);
      if (parsed) return parsed;
    } else if (res.status !== 429) {
      throw new Error(`HTTP ${res.status} when fetching goods ${goodsNo}`);
    }
    // 429 or a 200 page stripped of __NEXT_DATA__ (Musinsa's soft rate limit): back off and retry
    if (attempt < retries) await sleep(2 ** (attempt - 1) * backoffBaseMs);
  }
  throw new Error(`Product page for ${goodsNo} unavailable after ${retries} attempts (rate limited?)`);
}

async function fetchJson(url, headers, fetchFn) {
  const res = await fetchFn(url, { headers: { ...headers, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('?')[0]}`);
  return res.json();
}

/**
 * Exact personalized myPrice over HTTPS using the logged-in Musinsa cookie.
 * Throws (never guesses) when any input is missing so the caller can fall back.
 */
export async function fetchAuthenticatedPriceInfo(
  goodsNo,
  { cookie, fetchFn = fetch, retries = 4, backoffBaseMs = 2000 } = {}
) {
  const headers = { 'User-Agent': USER_AGENT, Referer: 'https://www.musinsa.com/', Cookie: cookie };

  const page = await fetchProductPage(goodsNo, headers, fetchFn, retries, backoffBaseMs);
  if (page.discontinued) return { status: 404, discontinued: true };
  if (!page.loggedIn) throw new SessionExpiredError();
  const det = page.detail;
  if (!det) throw new Error(`No Detail query for goods ${goodsNo}`);

  const gp = det.goodsPrice || {};
  const salePrice = gp.salePrice ?? gp.normalPrice;
  if (!salePrice) throw new Error(`No salePrice for goods ${goodsNo}`);

  const couponParams = new URLSearchParams({
    goodsNo: String(goodsNo),
    brand: det.brand || '',
    comId: det.comId || det.brand || '',
    salePrice: String(salePrice),
  });
  if (det.specialtyCodes?.length) couponParams.set('specialtyCodes', det.specialtyCodes.join(','));

  const [couponRes, promoRes] = await Promise.all([
    fetchJson(`https://api.musinsa.com/api2/coupon/coupons/getUsableCouponsByGoodsNo?${couponParams}`, headers, fetchFn),
    fetchJson(
      `https://goods-detail.musinsa.com/api2/goods/${goodsNo}/card-promotion?brand=${encodeURIComponent(det.brand || '')}`,
      headers,
      fetchFn
    ),
  ]);
  const coupons = couponRes?.data?.list;
  if (!Array.isArray(coupons)) throw new Error(`Unexpected coupon API response for goods ${goodsNo}`);
  const bestCoupon = coupons.reduce((best, c) => ((c.salePrice || 0) > (best?.salePrice || 0) ? c : best), null);

  const isLimitedDc = Boolean(det.isLimitedDc);
  const isRestrictedUsePoint = Boolean(det.isRestrictedUsePoint ?? det.isRestictedUsePoint);
  const { myPrice } = computeMyPrice({
    salePrice,
    couponDiscount: bestCoupon?.salePrice || 0,
    extraDiscountAmount: gp.extraDiscountAmount || 0,
    memberDiscountRate: gp.memberDiscountRate || 0,
    isLimitedDc,
    isRestrictedUsePoint,
    maxUsePointRate: det.maxUsePointRate ?? 0.07,
    memberPoint: det.point?.memberPoint ?? 0,
    isPrePoint: Boolean(det.isPrePoint),
    isGivenPoint: Boolean(det.isGivenPoint),
    memberSavePointRate: gp.memberSavePointRate || 0,
    savePoint: gp.savePoint || 0,
    cardPromotions: promoRes?.data?.promotions || [],
  });

  const couponPrice = gp.couponPrice ?? salePrice;
  return {
    goodsNo: Number(goodsNo),
    goodsName: det.goodsNm || '',
    brandName: det.brandInfo?.brandName || det.brand || '',
    imageUrl: det.thumbnailImageUrl || det.goodsImage || '',
    url: `https://www.musinsa.com/products/${goodsNo}`,
    normalPrice: gp.normalPrice ?? null,
    salePrice,
    couponPrice,
    saleRate: gp.finalDiscount ?? gp.discountRate ?? 0,
    myPrice,
    estimatedMyPrice: estimateMemberPrice(couponPrice, isRestrictedUsePoint, { isLimitedDc }),
    isRestrictedUsePoint,
    isLimitedDc,
    couponName: bestCoupon?.couponName || '나의 할인가',
    couponDiscount: bestCoupon?.salePrice || 0,
    isSoldOut: Boolean(det.isSoldOut || det.goodsSaleType === 'SOLDOUT'),
    discontinued: false,
    priceSource: 'https-auth',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/myprice-fetch.test.js tests/myprice-compute.test.js`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add src/myprice.js tests/myprice-fetch.test.js
git commit -m "feat(myprice): fetch exact myPrice over authenticated HTTPS

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Session cookie cache and provider

**Files:**
- Create: `src/session.js`
- Test: `tests/session.test.js`

**Interfaces:**
- Consumes: `getExecOptions(customOptions)` from `src/env.js`.
- Produces:
  - `DEFAULT_SESSION_PATH: string` (`~/.clot/musinsa-session.json`)
  - `pickAuthCookies(documentCookie: string) → string` (only `app_atk`/`app_rtk`/`mss_mac`, joined by `'; '`)
  - `readSessionCookie(path?) → string|null`, `writeSessionCookie(cookie, path?) → void`, `clearSessionCookie(path?) → void`
  - `fetchSessionCookieFromBridge({ execFn = execSync, session = 'clot-auth' }) → string|null`
  - `getSessionCookie({ path, allowBridge, fetchFromBridge }) → Promise<string|null>`
  - `refreshSessionCookie({ path, allowBridge, fetchFromBridge }) → Promise<string|null>`
  - `makeSessionProvider({ allowBridge, path, fetchFromBridge }) → async ({ refresh = false } = {}) => string|null`. This is the `sessionProvider` contract Task 4 consumes.

- [ ] **Step 1: Write the failing test**

Create `tests/session.test.js`:

```js
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SESSION_PATH, pickAuthCookies, readSessionCookie, writeSessionCookie, clearSessionCookie,
  fetchSessionCookieFromBridge, getSessionCookie, refreshSessionCookie, makeSessionProvider,
} from '../src/session.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE = 'app_atk=AAA; app_rtk=BBB; mss_mac=CCC';
let tmpPath;

beforeEach(() => {
  tmpPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clot-session-')), 'nested', 'session.json');
});

describe('session cache', () => {
  test('default cache path lives outside the repo (data/ is auto-committed)', () => {
    assert.equal(DEFAULT_SESSION_PATH.startsWith(REPO_ROOT + path.sep), false);
    assert.equal(DEFAULT_SESSION_PATH, path.join(os.homedir(), '.clot', 'musinsa-session.json'));
  });

  test('pickAuthCookies keeps only the three auth cookies', () => {
    assert.equal(pickAuthCookies('_ga=1; app_atk=AAA; cart_no=9; app_rtk=BBB; mss_mac=CCC; _fbp=2'), COOKIE);
    assert.equal(pickAuthCookies(''), '');
  });

  test('write then read round-trips, file mode is 0600', () => {
    writeSessionCookie(COOKIE, tmpPath);
    assert.equal(readSessionCookie(tmpPath), COOKIE);
    assert.equal(fs.statSync(tmpPath).mode & 0o777, 0o600);
  });

  test('missing, corrupt, or cookie-less cache files read as null', () => {
    assert.equal(readSessionCookie(tmpPath), null);
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, '{not json');
    assert.equal(readSessionCookie(tmpPath), null);
    fs.writeFileSync(tmpPath, JSON.stringify({ cookie: '_ga=1' }));
    assert.equal(readSessionCookie(tmpPath), null);
    fs.writeFileSync(tmpPath, '');
    assert.equal(readSessionCookie(tmpPath), null);
  });

  test('clearSessionCookie removes the file and tolerates absence', () => {
    writeSessionCookie(COOKIE, tmpPath);
    clearSessionCookie(tmpPath);
    assert.equal(fs.existsSync(tmpPath), false);
    clearSessionCookie(tmpPath);
  });
});

describe('fetchSessionCookieFromBridge', () => {
  test('opens musinsa, reads document.cookie (JSON-quoted), filters, and always closes', () => {
    const cmds = [];
    const execFn = (cmd) => {
      cmds.push(cmd);
      if (cmd.includes(' eval ')) return JSON.stringify('_ga=1; app_atk=AAA; app_rtk=BBB; mss_mac=CCC');
      return '';
    };
    assert.equal(fetchSessionCookieFromBridge({ execFn }), COOKIE);
    assert.match(cmds[0], /^opencli browser clot-auth open https:\/\/www\.musinsa\.com\/$/);
    assert.match(cmds.at(-1), /^opencli browser clot-auth close$/);
  });

  test('returns null when logged out (no app_atk) and still closes', () => {
    const cmds = [];
    const execFn = (cmd) => { cmds.push(cmd); return cmd.includes(' eval ') ? '"_ga=1"' : ''; };
    assert.equal(fetchSessionCookieFromBridge({ execFn }), null);
    assert.match(cmds.at(-1), /close$/);
  });

  test('returns null when the bridge throws', () => {
    const execFn = (cmd) => { if (cmd.includes(' open ')) throw new Error('ETIMEDOUT'); return ''; };
    assert.equal(fetchSessionCookieFromBridge({ execFn }), null);
  });
});

describe('getSessionCookie / refreshSessionCookie / makeSessionProvider', () => {
  test('cache hit does not touch the bridge', async () => {
    writeSessionCookie(COOKIE, tmpPath);
    let bridgeCalls = 0;
    const cookie = await getSessionCookie({ path: tmpPath, allowBridge: true, fetchFromBridge: () => { bridgeCalls++; return 'x'; } });
    assert.equal(cookie, COOKIE);
    assert.equal(bridgeCalls, 0);
  });

  test('cache miss + allowBridge fetches and caches', async () => {
    const cookie = await getSessionCookie({ path: tmpPath, allowBridge: true, fetchFromBridge: () => COOKIE });
    assert.equal(cookie, COOKIE);
    assert.equal(readSessionCookie(tmpPath), COOKIE);
  });

  test('cache miss + bridge not allowed returns null without calling the bridge', async () => {
    let bridgeCalls = 0;
    const cookie = await getSessionCookie({ path: tmpPath, allowBridge: false, fetchFromBridge: () => { bridgeCalls++; return COOKIE; } });
    assert.equal(cookie, null);
    assert.equal(bridgeCalls, 0);
  });

  test('refresh clears the stale cache even when the bridge is not allowed', async () => {
    writeSessionCookie(COOKIE, tmpPath);
    assert.equal(await refreshSessionCookie({ path: tmpPath, allowBridge: false, fetchFromBridge: () => 'x' }), null);
    assert.equal(readSessionCookie(tmpPath), null);
  });

  test('provider: refresh=false reads cache, refresh=true re-fetches', async () => {
    writeSessionCookie('app_atk=OLD', tmpPath);
    const provider = makeSessionProvider({ path: tmpPath, allowBridge: true, fetchFromBridge: () => 'app_atk=NEW' });
    assert.equal(await provider(), 'app_atk=OLD');
    assert.equal(await provider({ refresh: true }), 'app_atk=NEW');
    assert.equal(readSessionCookie(tmpPath), 'app_atk=NEW');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/session.test.js`
Expected: FAIL with `Cannot find module '.../src/session.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/session.js`:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getExecOptions } from './env.js';

/**
 * Musinsa login cookie cache for authenticated HTTPS price collection.
 * Lives under ~/.clot — never inside the repo, because the daily run does `git add data/` and pushes.
 */
export const DEFAULT_SESSION_PATH = path.join(os.homedir(), '.clot', 'musinsa-session.json');

const AUTH_COOKIE_RE = /^(app_atk|app_rtk|mss_mac)=/;

export function pickAuthCookies(documentCookie) {
  return String(documentCookie || '')
    .split(/;\s*/)
    .filter((c) => AUTH_COOKIE_RE.test(c))
    .join('; ');
}

export function readSessionCookie(sessionPath = DEFAULT_SESSION_PATH) {
  try {
    const { cookie } = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    return typeof cookie === 'string' && cookie.includes('app_atk=') ? cookie : null;
  } catch {
    return null;
  }
}

export function writeSessionCookie(cookie, sessionPath = DEFAULT_SESSION_PATH) {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sessionPath, JSON.stringify({ cookie, savedAt: new Date().toISOString() }), { mode: 0o600 });
  fs.chmodSync(sessionPath, 0o600);
}

export function clearSessionCookie(sessionPath = DEFAULT_SESSION_PATH) {
  fs.rmSync(sessionPath, { force: true });
}

/**
 * Reads the auth cookies from the logged-in Chrome through the OpenCLI browser bridge.
 * @returns {string|null} null when the bridge is unavailable or Chrome is logged out
 */
export function fetchSessionCookieFromBridge({ execFn = execSync, session = 'clot-auth' } = {}) {
  const opts = getExecOptions({ encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    execFn(`opencli browser ${session} open https://www.musinsa.com/`, opts);
    const raw = String(execFn(`opencli browser ${session} eval 'document.cookie'`, opts) || '').trim();
    let value = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') value = parsed;
    } catch {
      // plain (unquoted) output
    }
    const cookie = pickAuthCookies(value);
    return cookie.includes('app_atk=') ? cookie : null;
  } catch (err) {
    console.warn(`[Session Notice] Could not read Musinsa cookies from browser bridge: ${err.message}`);
    return null;
  } finally {
    try {
      execFn(`opencli browser ${session} close`, opts);
    } catch {
      // best effort
    }
  }
}

export async function getSessionCookie({
  path: sessionPath = DEFAULT_SESSION_PATH,
  allowBridge = true,
  fetchFromBridge = fetchSessionCookieFromBridge,
} = {}) {
  const cached = readSessionCookie(sessionPath);
  if (cached) return cached;
  if (!allowBridge) return null;
  const fresh = await fetchFromBridge();
  if (fresh) writeSessionCookie(fresh, sessionPath);
  return fresh || null;
}

export async function refreshSessionCookie({
  path: sessionPath = DEFAULT_SESSION_PATH,
  allowBridge = true,
  fetchFromBridge = fetchSessionCookieFromBridge,
} = {}) {
  clearSessionCookie(sessionPath);
  return getSessionCookie({ path: sessionPath, allowBridge, fetchFromBridge });
}

/** Builds the `sessionProvider` consumed by collectPricesForActiveItems. */
export function makeSessionProvider({ allowBridge = true, path: sessionPath = DEFAULT_SESSION_PATH, fetchFromBridge } = {}) {
  const opts = { path: sessionPath, allowBridge, ...(fetchFromBridge ? { fetchFromBridge } : {}) };
  return async ({ refresh = false } = {}) => (refresh ? refreshSessionCookie(opts) : getSessionCookie(opts));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/session.test.js`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add src/session.js tests/session.test.js
git commit -m "feat(session): cache Musinsa auth cookies outside the repo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Collector HTTPS stage with OpenCLI fallback

**Files:**
- Modify: `src/collector.js` (imports at top; `collectPricesForActiveItems` signature at about line 157; OpenCLI block at about lines 205–312; per-item branch at about lines 322–340)
- Test: `tests/collector-auth.test.js`

**Interfaces:**
- Consumes: `fetchAuthenticatedPriceInfo(goodsNo, { cookie })` and `SessionExpiredError` (Task 2); the `sessionProvider({ refresh })` contract (Task 3).
- Produces:
  - `collectAuthenticatedPrices({ goodsNos: number[], sessionProvider, authFetchFn = fetchAuthenticatedPriceInfo, authDelayMs = 700, into = new Map() }) → Promise<Map<number, priceInfo>>`
  - `collectPricesForActiveItems` accepts new options `sessionProvider = null`, `authFetchFn = fetchAuthenticatedPriceInfo`, `authDelayMs = 700`. `results.authPriced: number` is added.

- [ ] **Step 1: Write the failing test**

Create `tests/collector-auth.test.js`:

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collectPricesForActiveItems, collectAuthenticatedPrices } from '../src/collector.js';
import { SessionExpiredError } from '../src/myprice.js';

const items = [
  { goods_no: 1, goods_name: 'A', brand_name: 'B', status: 'ACTIVE', source: 'like' },
  { goods_no: 2, goods_name: 'C', brand_name: 'D', status: 'ACTIVE', source: 'like' },
];

function makeDb() {
  const recorded = { runs: [], logs: [] };
  const db = {
    getActiveItems: () => items,
    getLatestPrice: () => null,
    updateItemDetails: () => {},
    updateItemStatus: () => {},
    updateLowestPrice: () => {},
    recordPriceLog: (row) => recorded.logs.push(row),
    recordDailyRun: (row) => recorded.runs.push(row),
  };
  return { db, recorded };
}

const authInfo = (goodsNo, myPrice) => ({
  goodsNo, goodsName: `Name ${goodsNo}`, brandName: 'Brand', normalPrice: 20000, salePrice: 15000,
  couponPrice: 14000, myPrice, estimatedMyPrice: 12500, couponName: 'c', couponDiscount: 1000,
  isSoldOut: false, discontinued: false, priceSource: 'https-auth',
});

const directFetch = async (goodsNo) => ({
  goodsNo, goodsName: `Name ${goodsNo}`, brandName: 'Brand', normalPrice: 20000, salePrice: 15000,
  myPrice: null, isSoldOut: false, discontinued: false,
});

describe('collectAuthenticatedPrices', () => {
  test('no cookie -> no fetches, empty map', async () => {
    let calls = 0;
    const map = await collectAuthenticatedPrices({
      goodsNos: [1, 2], sessionProvider: async () => null, authFetchFn: async () => { calls++; }, authDelayMs: 0,
    });
    assert.equal(map.size, 0);
    assert.equal(calls, 0);
  });

  test('a throwing sessionProvider is treated as no cookie', async () => {
    const map = await collectAuthenticatedPrices({
      goodsNos: [1], sessionProvider: async () => { throw new Error('boom'); }, authFetchFn: async () => authInfo(1, 1), authDelayMs: 0,
    });
    assert.equal(map.size, 0);
  });

  test('expired session refreshes once and retries the same item', async () => {
    const providerCalls = [];
    const sessionProvider = async ({ refresh }) => { providerCalls.push(refresh); return refresh ? 'app_atk=new' : 'app_atk=old'; };
    const authFetchFn = async (g, { cookie }) => {
      if (cookie === 'app_atk=old') throw new SessionExpiredError();
      return authInfo(g, 13000 + g);
    };
    const map = await collectAuthenticatedPrices({ goodsNos: [1, 2], sessionProvider, authFetchFn, authDelayMs: 0 });
    assert.deepEqual(providerCalls, [false, true]);
    assert.deepEqual([...map.keys()], [1, 2]);
  });

  test('refresh that still yields an expired session stops the stage (no loop)', async () => {
    let fetches = 0;
    const map = await collectAuthenticatedPrices({
      goodsNos: [1, 2, 3],
      sessionProvider: async () => 'app_atk=x',
      authFetchFn: async () => { fetches++; throw new SessionExpiredError(); },
      authDelayMs: 0,
    });
    assert.equal(map.size, 0);
    assert.equal(fetches, 2); // original + one retry after refresh
  });
});

describe('collectPricesForActiveItems with sessionProvider', () => {
  test('all VIP items priced over HTTPS: no OpenCLI, no direct fetch, mode=full even when bridge unusable', async () => {
    const { db, recorded } = makeDb();
    let execCalls = 0;
    let directCalls = 0;
    const results = await collectPricesForActiveItems({
      dbInstance: db,
      execFn: () => { execCalls++; throw new Error('should not be called'); },
      fetchFn: async (g) => { directCalls++; return directFetch(g); },
      sessionProvider: async () => 'app_atk=x',
      authFetchFn: async (g) => authInfo(g, 13000 + g),
      authDelayMs: 0,
      skipOpenCli: true,
      delayMs: 0,
    });
    assert.equal(execCalls, 0);
    assert.equal(directCalls, 0);
    assert.equal(results.mode, 'full');
    assert.equal(results.authPriced, 2);
    assert.equal(recorded.runs[0].mode, 'full');
    assert.deepEqual(recorded.logs.map((l) => l.my_price).sort(), [13001, 13002]);
  });

  test('items that fail over HTTPS fall back to OpenCLI for just those items', async () => {
    const { db, recorded } = makeDb();
    const execCmds = [];
    const results = await collectPricesForActiveItems({
      dbInstance: db,
      execFn: (cmd) => {
        execCmds.push(cmd);
        return JSON.stringify([{ goodsNo: 2, normalPrice: '20,000', salePrice: '15,000', couponPrice: '14,000', myPrice: '12,000', status: '판매중' }]);
      },
      fetchFn: directFetch,
      sessionProvider: async () => 'app_atk=x',
      authFetchFn: async (g) => { if (g === 2) throw new Error('HTTP 500'); return authInfo(g, 13001); },
      authDelayMs: 0,
      openCliChunkSize: 2,
      delayMs: 0,
    });
    assert.equal(execCmds.length, 1);
    assert.match(execCmds[0], /my-prices "2"/);
    assert.equal(results.mode, 'full');
    const byGoods = Object.fromEntries(recorded.logs.map((l) => [l.goods_no, l.my_price]));
    assert.deepEqual(byGoods, { 1: 13001, 2: 12000 });
  });

  test('session unavailable while asleep: existing deferred path for all items', async () => {
    const { db, recorded } = makeDb();
    let directCalls = 0;
    const results = await collectPricesForActiveItems({
      dbInstance: db,
      execFn: () => { throw new Error('should not be called'); },
      fetchFn: async (g) => { directCalls++; return directFetch(g); },
      sessionProvider: async () => null,
      authFetchFn: async () => { throw new Error('should not be called'); },
      authDelayMs: 0,
      skipOpenCli: true,
      delayMs: 0,
    });
    assert.equal(directCalls, 2);
    assert.equal(results.mode, 'deferred');
    assert.equal(results.authPriced, 0);
    assert.equal(recorded.runs[0].mode, 'deferred');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/collector-auth.test.js`
Expected: FAIL with `does not provide an export named 'collectAuthenticatedPrices'`

- [ ] **Step 3: Write minimal implementation**

3a. In `src/collector.js`, add below the existing `import { estimateMemberPrice } from './discovery.js';`:

```js
import { fetchAuthenticatedPriceInfo } from './myprice.js';
```

3b. Add this exported function directly above `export async function collectPricesForActiveItems(`:

```js
/**
 * Stage 1 of VIP price collection: exact myPrice over authenticated HTTPS.
 * Sequential with a delay — concurrent product-page requests get soft rate-limited
 * (HTTP 200 without __NEXT_DATA__). On SessionExpiredError the cookie is refreshed once.
 */
export async function collectAuthenticatedPrices({
  goodsNos,
  sessionProvider,
  authFetchFn = fetchAuthenticatedPriceInfo,
  authDelayMs = 700,
  into = new Map(),
}) {
  const getCookie = async (refresh) => {
    try {
      return await sessionProvider({ refresh });
    } catch (err) {
      console.warn(`[HTTPS Auth Notice] Session provider failed: ${err.message}`);
      return null;
    }
  };

  let cookie = await getCookie(false);
  if (!cookie) return into;
  let refreshed = false;

  for (let i = 0; i < goodsNos.length; i++) {
    const goodsNo = goodsNos[i];
    try {
      into.set(goodsNo, await authFetchFn(goodsNo, { cookie }));
    } catch (err) {
      if (err?.name === 'SessionExpiredError') {
        if (refreshed) {
          console.warn('[HTTPS Auth Notice] Session still expired after refresh; falling back for remaining items.');
          break;
        }
        refreshed = true;
        cookie = await getCookie(true);
        if (!cookie) {
          console.warn('[HTTPS Auth Notice] Session expired and could not be refreshed; falling back for remaining items.');
          break;
        }
        i--; // retry the same item with the fresh cookie
        continue;
      }
      console.warn(`[HTTPS Auth Notice] ${goodsNo}: ${err.message}`);
    }
    if (authDelayMs > 0 && i < goodsNos.length - 1) {
      await new Promise((r) => setTimeout(r, authDelayMs));
    }
  }
  return into;
}
```

3c. In the `collectPricesForActiveItems` options object, add after `skipOpenCli = false,`:

```js
  sessionProvider = null,
  authFetchFn = fetchAuthenticatedPriceInfo,
  authDelayMs = 700,
```

3d. In `results`, add after `sessionWarningTriggered: false,`:

```js
    authPriced: 0,
```

3e. Replace these two lines:

```js
  const vipGoodsNos = vipItems.map((it) => it.goods_no);
  let consecutiveOpenCliErrors = 0;
```

with:

```js
  const vipGoodsNos = vipItems.map((it) => it.goods_no);
  let consecutiveOpenCliErrors = 0;

  // Stage 1: authenticated HTTPS with the cached Musinsa session (no browser needed).
  const authPriceMap = new Map();
  if (sessionProvider && vipGoodsNos.length > 0) {
    await collectAuthenticatedPrices({ goodsNos: vipGoodsNos, sessionProvider, authFetchFn, authDelayMs, into: authPriceMap });
    results.authPriced = authPriceMap.size;
    console.log(`🔐 [HTTPS Auth] ${authPriceMap.size}/${vipGoodsNos.length} VIP items priced via authenticated HTTPS.`);
  }
  // Stage 2 (OpenCLI) and Stage 3 (direct parser) only handle what Stage 1 left behind.
  const remainingVipGoodsNos = vipGoodsNos.filter((g) => !authPriceMap.has(g));
```

3f. From the line `if (skipOpenCli && vipGoodsNos.length > 0) {` down to and including the `for (let i = 0; skipOpenCli ? false : i < vipGoodsNos.length; …)` loop body, replace **every** occurrence of the identifier `vipGoodsNos` with `remainingVipGoodsNos`. There are 5 occurrences: the deferred warning condition and message, the pre-warm condition, the loop condition, the circuit-breaker message `vipGoodsNos.length - i`, and `vipGoodsNos.slice(i, i + openCliChunkSize)`. Verify with:

Run: `grep -n "vipGoodsNos" src/collector.js`
Expected: `vipGoodsNos` (without the `remaining` prefix) appears only in its declaration, in the Stage 1 block from 3e, and in the mode rule from 3g.

3g. Replace the mode assignment:

```js
  if (!skipOpenCli && vipGoodsNos.length > 0) {
    results.mode = results.sessionWarningTriggered || openCliPriceMap.size === 0 ? 'degraded' : 'full';
  }
```

with:

```js
  if (vipGoodsNos.length > 0 && remainingVipGoodsNos.length === 0) {
    results.mode = 'full'; // every VIP item has an authenticated HTTPS price
  } else if (!skipOpenCli && remainingVipGoodsNos.length > 0) {
    results.mode = results.sessionWarningTriggered || openCliPriceMap.size === 0 ? 'degraded' : 'full';
  }
```

3h. In the `mapConcurrent` callback, replace:

```js
      let priceInfo;
      const liveData = openCliPriceMap.get(item.goods_no);

      if (liveData && liveData.myPrice) {
```

with:

```js
      let priceInfo;
      const authData = authPriceMap.get(item.goods_no);
      const liveData = openCliPriceMap.get(item.goods_no);

      if (authData) {
        priceInfo = authData;
      } else if (liveData && liveData.myPrice) {
```

- [ ] **Step 4: Run tests to verify they pass (new and existing)**

Run: `node --test tests/collector-auth.test.js`
Expected: PASS (7 tests)

Run: `npm test`
Expected: PASS for the whole suite, including the unchanged `tests/collector-deferred.test.js` and `tests/collector-parallel.test.js`. Those call without `sessionProvider`, so their behavior must be identical.

- [ ] **Step 5: Commit**

```bash
git add src/collector.js tests/collector-auth.test.js
git commit -m "feat(collector): price VIP items via authenticated HTTPS before OpenCLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: CLI wiring, docs, and live verification

**Files:**
- Modify: `src/cli.js` (import block near line 10; `daily` collection call near line 370; `track` batch call near line 770)
- Modify: `README.md:13-18`

**Interfaces:**
- Consumes: `makeSessionProvider({ allowBridge })` (Task 3); `collectPricesForActiveItems({ sessionProvider })` (Task 4); `fetchAuthenticatedPriceInfo` and `getSessionCookie` for the manual check.
- Produces: nothing new for code; user-visible behavior change only.

- [ ] **Step 1: Wire the provider**

In `src/cli.js`, add after the `import { collectPricesForActiveItems, fetchProductPriceInfo, prewarmMusinsaSession } from './collector.js';` line:

```js
import { makeSessionProvider } from './session.js';
```

In the `daily` flow's `collectPricesForActiveItems({ source: 'like', … })` call, add after `skipOpenCli: deferred,`:

```js
    // Cached cookie works while asleep; only fetch a fresh one when the browser bridge is usable.
    sessionProvider: makeSessionProvider({ allowBridge: !deferred }),
```

In the `track` batch `collectPricesForActiveItems({ concurrency, … })` call, add after `prewarmFn: prewarmMusinsaSession,`:

```js
        sessionProvider: makeSessionProvider({ allowBridge: true }),
```

In the `daily` summary, replace:

```js
  console.log(`  • Mode: ${results.mode}${results.mode !== 'full' ? ' (public/estimated prices)' : ' (authenticated my-prices)'}`);
```

with:

```js
  console.log(`  • Mode: ${results.mode}${results.mode !== 'full' ? ' (public/estimated prices)' : ' (authenticated my-prices)'} — HTTPS auth: ${results.authPriced}`);
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Live comparison against OpenCLI (no DB writes, no git push)**

This needs the logged-in Chrome and OpenCLI bridge. It writes the cookie cache to `~/.clot/musinsa-session.json`.

Run:
```bash
node --input-type=module -e "
import { getSessionCookie } from './src/session.js';
import { fetchAuthenticatedPriceInfo } from './src/myprice.js';
const cookie = await getSessionCookie({ allowBridge: true });
if (!cookie) { console.log('NO COOKIE'); process.exit(1); }
for (const g of [595039, 2322315, 4663718, 3933001, 3982118]) {
  const info = await fetchAuthenticatedPriceInfo(g, { cookie });
  console.log(g, info.myPrice);
  await new Promise((r) => setTimeout(r, 700));
}"
```

Then run:
```bash
opencli musinsa my-prices "595039,2322315,4663718,3933001,3982118" -f json
```

Expected: each `myPrice` from the first command equals the `myPrice` from the second (prices can change between days, so compare the two outputs taken minutes apart, not the table in Background). If any differ, stop and report the item with both outputs. Do not adjust the formula to fit a single item without the page's breakdown (`opencli musinsa my-prices` JSON includes `dcCoupon`, `dcGrade`, `dcPoint`, `dcPrePoint`, `activeInstantDiscount`).

Run: `ls -l ~/.clot/musinsa-session.json && git status --short | grep -c musinsa-session || true`
Expected: file mode `-rw-------`; grep count `0` (the cache is not in the repo).

- [ ] **Step 4: Update README**

In `README.md`, under `2. **나의 할인가 & 쿠폰 추적 (`track`)**`, add a bullet after the existing one:

```markdown
   - **수집 경로**: 저장된 무신사 로그인 쿠키(`~/.clot/musinsa-session.json`, 저장소 밖)로 상품 페이지·쿠폰·카드 프로모션을 HTTPS로 직접 조회해 나의 할인가를 계산합니다(브라우저 불필요, 잠자기 중에도 동작). 쿠키가 없거나 만료되면 OpenCLI 브리지에서 새로 받아오고, 그래도 실패한 상품만 OpenCLI `my-prices` → 공개가 파서 순으로 폴백합니다.
```

- [ ] **Step 5: Commit**

```bash
git add src/cli.js README.md
git commit -m "feat(cli): use cached Musinsa session for HTTPS myPrice in daily and track

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Out of Scope (follow-ups, not in this plan)

- Pricing `source === 'discovery'` items over HTTPS. Their drop logic compares `estimated_my_price`, and switching them needs its own like-for-like baseline decision.
- Refactoring `fetchProductPriceInfo` to reuse `extractProductDetail`.
- Using `login-status`'s `authTokenInfo.accessToken` to extend the cookie lifetime (unverified).
