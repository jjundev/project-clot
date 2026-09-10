# Exact Musinsa Member Discount Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Project-Clot's mathematical member price estimation model in `src/discovery.js` and `src/collector.js` to match authentic Musinsa discount rules (10-won unit truncation, 1.5% Silver grade discount, sequential waterfall deduction, and grade discount restriction `isLimitedDc`).

**Architecture:** Replace the naive compound percentage formula (`price * 0.97 * 0.93`) with the verified Musinsa waterfall engine (`ix = (e) => 10 * Math.floor(e / 10)`), where grade discount (1.5%) is deducted first with 10-won truncation, followed by point pre-discount (7%) calculated on the remaining balance with 10-won truncation, honoring `isLimitedDc` and `isRestrictedUsePoint`.

**Tech Stack:** Node.js native standard libraries (`node:test`, `node:assert/strict`, `fetch`), zero external npm dependencies.

## Global Constraints

- Zero external npm dependencies: use only Node.js standard runtime modules.
- Strict 10-won truncation: all intermediate and final discount computations must truncate to 10-won units using `10 * Math.floor(val / 10)`.
- Sequential waterfall deduction: Grade discount is calculated from base coupon price, and point pre-discount is calculated on the remaining balance after grade discount.
- Silver grade rate alignment: default member grade discount rate is 1.5% (`0.015`), not 3%.
- Restriction compliance: `isLimitedDc: true` forces grade discount to 0. `isRestrictedUsePoint: true` forces point pre-discount to 0.
- All existing and updated tests must pass cleanly via `npm test`.

---

### Task 1: Update `src/discovery.js` with `floor10` and Exact Waterfall Formula & Tests

**Files:**
- Modify: `src/discovery.js:23-32, 160-165`
- Test: `tests/discovery.test.js`

**Interfaces:**
- Produces:
  - `floor10(val: number|string): number`
  - `estimateMemberPrice(couponPrice: number|string, isRestrictedUsePoint?: boolean, options?: { isLimitedDc?: boolean, gradeDiscountRate?: number, pointRate?: number }): number|null`

- [ ] **Step 1: Update failing tests in `tests/discovery.test.js`**

Update `tests/discovery.test.js` to test exact waterfall deduction, 10-won truncation, `isLimitedDc` flag, and export of `floor10`:

```javascript
// In tests/discovery.test.js:
import {
  isReleasedWithinYears,
  floor10,
  estimateMemberPrice,
  fetchLikeCountsBatch,
  fetchCategoryGoodsPage,
  discoverCategoryGoods,
} from '../src/discovery.js';

// In 'estimateMemberPrice calculates mathematical member price with Silver grade and points':
  await t.test('floor10 truncates values to 10-won unit', () => {
    assert.equal(floor10(1234), 1230);
    assert.equal(floor10(1239), 1230);
    assert.equal(floor10(1230), 1230);
    assert.equal(floor10(9), 0);
  });

  await t.test('estimateMemberPrice calculates exact waterfall member price with 10-won truncation', () => {
    // 100,000 KRW unrestricted:
    // Grade discount: floor10(100,000 * 0.015) = 1,500 -> balance 98,500
    // Point discount: floor10(98,500 * 0.07) = floor10(6,895) = 6,890
    // Final: 98,500 - 6,890 = 91,610
    const price1 = estimateMemberPrice(100000, false);
    assert.equal(price1, 91610);

    // Grade discount restricted (isLimitedDc: true):
    // Grade discount: 0 -> balance 100,000
    // Point discount: floor10(100,000 * 0.07) = 7,000
    // Final: 100,000 - 7,000 = 93,000
    const priceLimited = estimateMemberPrice(100000, false, { isLimitedDc: true });
    assert.equal(priceLimited, 93000);

    // Both points and grade restricted (Outlet item):
    // Both 0 -> 100,000
    const priceOutlet = estimateMemberPrice(100000, true, { isLimitedDc: true });
    assert.equal(priceOutlet, 100000);

    // Restricted points only: isRestrictedUsePoint = true, isLimitedDc = false:
    // Grade discount: 1,500 -> 98,500. Point discount: 0 -> 98,500
    const price2 = estimateMemberPrice(100000, true);
    assert.equal(price2, 98500);

    // Null or invalid input
    assert.equal(estimateMemberPrice(null), null);
    assert.equal(estimateMemberPrice(0), null);
    assert.equal(estimateMemberPrice('invalid'), null);

    // Numeric string coercion
    assert.equal(estimateMemberPrice('100000', false), 91610);
  });
```
Also update line 220 in `tests/discovery.test.js`:
For 45,000 KRW item in mock `discoverCategoryGoods`:
`floor10(45000 * 0.015) = 670` -> balance 44,330 -> `floor10(44330 * 0.07) = 3,100` -> final 41,230.
Update assertion from `assert.equal(results[0].estimatedMyPrice, 40595)` to `assert.equal(results[0].estimatedMyPrice, 41230)`.

- [ ] **Step 2: Run test to verify failure**

Run: `node --test tests/discovery.test.js`
Expected: FAIL due to difference between old formula (90210 / 40595) and new formula (91610 / 41230).

- [ ] **Step 3: Implement `floor10` and new `estimateMemberPrice` in `src/discovery.js`**

In `src/discovery.js`:
```javascript
export function floor10(val) {
  return 10 * Math.floor(Number(val) / 10);
}

export function estimateMemberPrice(couponPrice, isRestrictedUsePoint = false, options = {}) {
  const price = Number(couponPrice);
  if (!price || isNaN(price) || price <= 0) return null;

  const isLimitedDc = Boolean(options.isLimitedDc);
  const gradeDiscountRate = isLimitedDc ? 0 : (options.gradeDiscountRate ?? 0.015);
  const pointRate = isRestrictedUsePoint ? 0 : (options.pointRate ?? 0.07);

  // Step 1: Grade discount (10-won truncation)
  const gradeDiscount = gradeDiscountRate > 0 ? floor10(price * gradeDiscountRate) : 0;
  const priceAfterGrade = Math.max(0, price - gradeDiscount);

  // Step 2: Point pre-discount (10-won truncation on remaining balance after grade discount)
  const pointDiscount = pointRate > 0 ? floor10(priceAfterGrade * pointRate) : 0;

  // Step 3: Final basic member price
  return Math.max(0, priceAfterGrade - pointDiscount);
}
```
And in `discoverCategoryGoods`:
```javascript
const isRestrictedUsePoint = Boolean(item.isRestrictedUsePoint ?? item.isRestictedUsePoint);
const isLimitedDc = Boolean(item.isLimitedDc ?? item.isRestrictedMemberDiscount);

discovered.push({
  goodsNo: Number(item.goodsNo),
  goodsName: item.goodsName || '',
  brandName: item.brandName || item.brand || '',
  url: item.goodsLinkUrl || `https://www.musinsa.com/products/${item.goodsNo}`,
  imageUrl: item.thumbnail || item.thumbnailImageUrl || '',
  normalPrice,
  salePrice,
  couponPrice,
  estimatedMyPrice: estimateMemberPrice(couponPrice, isRestrictedUsePoint, { isLimitedDc }),
  likeCount,
  isSoldOut: Boolean(item.isSoldOut),
  source: 'discovery',
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/discovery.test.js`
Expected: PASS

- [ ] **Step 5: Commit Task 1**

```bash
git add src/discovery.js tests/discovery.test.js
git commit -m "feat(discovery): update member price estimation to exact Musinsa waterfall rules"
```

---

### Task 2: Update `src/collector.js` with `isLimitedDc` & Test Suite Alignment

**Files:**
- Modify: `src/collector.js:61-74, 80-87, 220-226`
- Test: `tests/collector-parallel.test.js`

**Interfaces:**
- Consumes: `estimateMemberPrice(couponPrice, isRestrictedUsePoint, options)` from `src/discovery.js`
- Produces: `fetchProductPriceInfo` with `isLimitedDc` flag and exact `estimatedMyPrice`

- [ ] **Step 1: Update failing tests in `tests/collector-parallel.test.js`**

In `tests/collector-parallel.test.js`:
- For goods `999999` with 70,000 KRW coupon price:
  - `floor10(70000 * 0.015) = 1050` -> balance 68,950 -> `floor10(68950 * 0.07) = 4820` -> final `64130`.
  - Update assertion `assert.equal(info.estimatedMyPrice, 63147)` to `assert.equal(info.estimatedMyPrice, 64130)`.
- Add an explicit test case for `isLimitedDc: true` in `fetchProductPriceInfo`:
  - When `goodsPrice.isLimitedDc: true`, verify `info.isLimitedDc === true` and `info.estimatedMyPrice` calculates with 0% grade discount (e.g. 70,000 - floor10(70,000 * 0.07) = 65,100).
- For simulated discovery items in collector tests:
  - 45,000 KRW (line 384): update `estimatedMyPrice: 40595` to `41230`.
  - Also update downstream assertions at lines 401–412:
    - `assert.equal(drop.currentPrice, 41230);`
    - `assert.equal(drop.dropAmount, 49616 - 41230);`
    - `assert.equal(drop.dropRate, Math.round(((49616 - 41230) / 49616) * 100));`
    - `assert.equal(lowestEstUpdates[0].price, 41230);`
    - `assert.equal(recordedLogs[0].estimated_my_price, 41230);`
  - 20,000 KRW: `floor10(20000 * 0.015) = 300` -> balance 19,700 -> `floor10(19700 * 0.07) = 1370` -> final `18330` (replace `18042`).
  - 9,000 KRW: `floor10(9000 * 0.015) = 130` -> balance 8,870 -> `floor10(8870 * 0.07) = 620` -> final `8250` (replace `8119`).

- [ ] **Step 2: Run test to verify failure**

Run: `node --test tests/collector-parallel.test.js`
Expected: FAIL on price calculation mismatch.

- [ ] **Step 3: Update `src/collector.js`**

In `src/collector.js:fetchProductPriceInfo`:
1. In the fallback when `!detail` (lines 61–74), add `isLimitedDc: false`:
```javascript
      if (!detail) {
        return {
          goodsNo: Number(goodsNo),
          goodsName: 'Unknown Product',
          brandName: '',
          normalPrice: null,
          salePrice: null,
          couponPrice: null,
          saleRate: null,
          myPrice: null,
          estimatedMyPrice: null,
          isRestrictedUsePoint: false,
          isLimitedDc: false,
          isSoldOut: false,
        };
      }
```
2. When `detail` is present:
```javascript
const isSoldOut = Boolean(detail.isSoldOut || detail.goodsSaleType === 'SOLDOUT');
const isRestrictedUsePoint = Boolean(detail.isRestrictedUsePoint ?? detail.isRestictedUsePoint);
const isLimitedDc = Boolean(
  detail.isLimitedDc ??
  detail.goodsPrice?.isLimitedDc ??
  detail.isRestrictedMemberDiscount ??
  (detail.isGradeDiscountEligible === false)
);
const estimatedMyPrice = estimateMemberPrice(couponPrice, isRestrictedUsePoint, { isLimitedDc });
```
3. Return `isLimitedDc` in the return object of `fetchProductPriceInfo`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/collector-parallel.test.js`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All 59 tests pass across all 10 suites.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/collector.js tests/collector-parallel.test.js
git commit -m "feat(collector): integrate isLimitedDc into price collection and align test assertions"
```

---

## Verification Plan

### Automated Tests
- `node --test tests/discovery.test.js`
- `node --test tests/collector-parallel.test.js`
- `npm test`

### Manual / Integration Verification
- Verify that `npm test` executes all 10 test suites and 59 tests cleanly in < 1 second.
- Run `node src/cli.js visualize --no-open` to confirm dashboard payload compiles without any runtime errors.
