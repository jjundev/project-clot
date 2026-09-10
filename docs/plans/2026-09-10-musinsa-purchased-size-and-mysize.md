# Musinsa Purchased Size & MySize Actual Garment Measurements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide full visibility into past purchased clothing sizes and actual garment measurements by upgrading `opencli musinsa orders` with clean size extraction, adding a new `opencli musinsa mysize` command to inspect registered and past-purchased actual garment measurements in cm, and bridging past measurements to `opencli musinsa search --my-size`.

**Architecture:**
1. **Order Option & Size Parser (`~/.opencli/clis/musinsa/order-parser.js`)**: Build a dedicated extraction parser that takes raw scraped text lines from Musinsa order cards, strips prefixes (`[옵션]`, `옵션 :`), separates the exact size token (`S/M/L/XL`, `270`, `32`) and color from quantity (`1개`), and outputs `{ size, option, qty }`.
2. **Orders Command Upgrade (`~/.opencli/clis/musinsa/orders.js`)**: Integrate `order-parser.js` into `opencli musinsa orders` so `size` is an explicit, first-class column alongside `brand`, `goodsName`, and `option`.
3. **MySize Measurements Command (`~/.opencli/clis/musinsa/mysize.js`)**: Implement a new `opencli musinsa mysize` command (`Strategy.COOKIE`) that queries Musinsa's internal MySize APIs (`/api/member/v1/mysize/detail` and `/api2/dp/v1/plp/goods/order`), returning past-purchased garments with their actual measured cm dimensions (`총장`, `가슴단면`, `허리단면`, `어깨너비` 등), plus an `--as-filter` option to generate `--measure` arguments for `opencli musinsa search`.
4. **Search Integration Bridge (`~/.opencli/clis/musinsa/search.js`)**: Allow `opencli musinsa search <keyword> --my-size [top|pants|outer]` to automatically apply past purchased garment measurements with a configurable tolerance (default ±2cm).

**Tech Stack:** Node.js (v24.17.0, ESM, `node:test`, `node:assert/strict`), OpenCLI plugin architecture (`@jackwener/opencli`), Native `fetch`. Zero external npm dependencies.

**Spec:** Verified Musinsa MySize internal APIs (`https://api.musinsa.com/api/member/v1/mysize/detail`, `https://api.musinsa.com/api/member/v1/mysize/order/sizeType/:sizeType`, `https://api2.musinsa.com/api2/dp/v1/plp/goods/order`) and Musinsa Order List DOM structure.

## Global Constraints

- Use ESM imports only (`import ... from '...'`).
- Zero new npm dependencies; rely entirely on native Node.js and existing OpenCLI libraries.
- Never crash on missing sizes or unknown formats; fallback gracefully to `-` or raw option string.
- If not logged in, raise `AuthRequiredError` guiding the user to log in via Chrome.
- Output columns must remain clean, predictable, and aligned.

---

### Task 1: Order Option & Size Parsing Engine (`order-parser.js` & `orders.js` Upgrade)

**Files:**
- Create: `/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/order-parser.js`
- Modify: `/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/orders.js`
- Test: `/Users/hyunjun_macbook_pro/Documents/Private/project-clot/tests/musinsa-order-parser.test.js`

**Interfaces:**
- Produces:
  - `parseOrderOptionAndSize(lines: string[]): { size: string, option: string, qty: string }`
  - `extractSizeToken(text: string): string`
  - Columns in `orders.js`: `['rank', 'orderDate', 'brand', 'goodsName', 'size', 'option', 'qty', 'price', 'status', 'url']`
- Consumes: Scraped text lines from order cards.

- [ ] **Step 1: Write unit tests for `parseOrderOptionAndSize`**

Create `tests/musinsa-order-parser.test.js`:

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrderOptionAndSize, extractSizeToken } from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/order-parser.js';

describe('Musinsa Order Option & Size Parser', () => {
  test('extracts size, option, and qty from prefixed single line', () => {
    const lines = ['배송완료', '포터리', '컴포트 셔츠 (SAX BLUE)', '[옵션] SAX BLUE / 3 / 1개', '118,000원'];
    const result = parseOrderOptionAndSize(lines);
    assert.deepEqual(result, {
      size: '3',
      option: 'SAX BLUE / 3',
      qty: '1개',
    });
  });

  test('extracts shoe size and color when formatted with colon', () => {
    const lines = ['구매확정', '아디다스', '가젤 인도어', '옵션 : BLUE / 270 / 1개', '139,000원'];
    const result = parseOrderOptionAndSize(lines);
    assert.deepEqual(result, {
      size: '270',
      option: 'BLUE / 270',
      qty: '1개',
    });
  });

  test('extracts clothing standard size when option and qty are on separate lines', () => {
    const lines = ['배송완료', '무신사 스탠다드', '릴렉스드 티셔츠', '화이트 / XL', '1개', '19,900원'];
    const result = parseOrderOptionAndSize(lines);
    assert.deepEqual(result, {
      size: 'XL',
      option: '화이트 / XL',
      qty: '1개',
    });
  });

  test('extracts waist size from pants option', () => {
    const lines = ['배송완료', '브랜디드', '와이드 데님', '블랙 / 32', '1개', '69,000원'];
    const result = parseOrderOptionAndSize(lines);
    assert.deepEqual(result, {
      size: '32',
      option: '블랙 / 32',
      qty: '1개',
    });
  });

  test('falls back gracefully when only quantity is present', () => {
    const lines = ['주문완료', '브랜드', '단일 옵션 상품', '1개', '15,000원'];
    const result = parseOrderOptionAndSize(lines);
    assert.deepEqual(result, {
      size: '-',
      option: '-',
      qty: '1개',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/musinsa-order-parser.test.js`
Expected: FAIL with `Cannot find module ... order-parser.js`

- [ ] **Step 3: Implement `order-parser.js`**

Create `/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/order-parser.js`:

```javascript
/**
 * Parses raw order item card lines into clean size, option description, and quantity.
 */

const STANDARD_SIZE_REGEX = /\b(XXX?L|XXL|XL|L|M|S|XS|FREE|ONE\s*SIZE)\b/i;
const SHOE_SIZE_REGEX = /\b(2[1-9]\d|300)(?:mm)?\b/i;

/**
 * Extracts size token from an option string or array of chunks.
 * @param {string} text
 * @returns {string} - e.g. "L", "270", "32", or "-"
 */
export function extractSizeToken(text) {
  if (!text || text === '-') return '-';
  const chunks = text
    .split('/')
    .map((s) => s.trim())
    .filter((s) => !/^\d+\s*(?:개|box|ea)$/i.test(s));

  // Check chunks in reverse order (size usually comes after color, e.g. "블랙 / L")
  for (let i = chunks.length - 1; i >= 0; i--) {
    const c = chunks[i];
    const stdMatch = c.match(STANDARD_SIZE_REGEX);
    if (stdMatch) return stdMatch[1].toUpperCase();

    const shoeMatch = c.match(SHOE_SIZE_REGEX);
    if (shoeMatch) return shoeMatch[1];

    // Numbers like pants size (28, 30, 32) or numeric sizes (1, 2, 3)
    if (/^(?:[1-4]?\d|2[4-9]|3[0-8]|4[0-4])$/.test(c)) {
      return c;
    }
  }

  return '-';
}

/**
 * Parses lines from a Musinsa order item card.
 * @param {string[]} lines
 * @returns {{ size: string, option: string, qty: string }}
 */
export function parseOrderOptionAndSize(lines = []) {
  let rawOptionLine = '';
  let qty = '1개';

  for (const line of lines) {
    const l = String(line || '').trim();

    // Pattern 1: Explicit option prefix e.g. "[옵션] 블랙 / L / 1개" or "옵션 : 블랙 / L"
    if (/^\[?옵션\]?\s*[:=]?/i.test(l)) {
      rawOptionLine = l.replace(/^\[?옵션\]?\s*[:=]?\s*/i, '').trim();
      break;
    }

    // Pattern 2: Slash-separated line with color/size e.g. "블랙 / L / 1개" or "화이트 / M"
    if (l.includes('/') && !rawOptionLine && !l.includes('원') && !l.includes('배송')) {
      rawOptionLine = l;
    }

    // Pattern 3: Standalone quantity line e.g. "1개"
    const qtyMatch = l.match(/^(\d+)\s*(?:개|box|ea)$/i);
    if (qtyMatch) {
      qty = `${qtyMatch[1]}개`;
    }
  }

  // Extract qty from rawOptionLine if it was embedded (e.g. "... / 1개")
  if (rawOptionLine) {
    const embeddedQty = rawOptionLine.match(/\/\s*(\d+)\s*(?:개|box|ea)\s*$/i);
    if (embeddedQty) {
      qty = `${embeddedQty[1]}개`;
      rawOptionLine = rawOptionLine.replace(/\/\s*\d+\s*(?:개|box|ea)\s*$/i, '').trim();
    }
  }

  const cleanOption = rawOptionLine.replace(/\/\s*$/, '').trim() || '-';
  const size = extractSizeToken(cleanOption);

  return {
    size,
    option: cleanOption,
    qty,
  };
}
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `node --test tests/musinsa-order-parser.test.js`
Expected: PASS (5 tests passing)

- [ ] **Step 5: Integrate `parseOrderOptionAndSize` into `orders.js`**

In `/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/orders.js`:
1. Import `parseOrderOptionAndSize`:
```javascript
import { parseOrderOptionAndSize } from './order-parser.js';
```
2. In `page.evaluate`: include `lines` in the extracted item:
```javascript
          orders.push({
            orderDate,
            orderNo,
            status: status || '주문완료',
            brand: brand || '-',
            goodsName: goodsName || '-',
            lines,
            price: price || '-',
            url: href,
          });
```
3. In `extractOrdersFromPage` mapping:
```javascript
  return rows.slice(0, limit).map((r, i) => {
    const parsed = parseOrderOptionAndSize(r.lines || [r.option]);
    return {
      rank: i + 1,
      orderDate: cleanText(r.orderDate) || '-',
      status: cleanText(r.status) || '주문완료',
      brand: cleanText(r.brand) || '-',
      goodsName: cleanText(r.goodsName) || '-',
      size: parsed.size,
      option: parsed.option,
      qty: parsed.qty,
      price: cleanText(r.price) || '-',
      url: r.url || '-',
    };
  });
```
4. Update `columns` in CLI registry:
```javascript
  columns: [
    'rank',
    'orderDate',
    'status',
    'brand',
    'goodsName',
    'size',
    'option',
    'qty',
    'price',
    'url',
  ],
```

- [ ] **Step 6: Verify `orders.js` syntax and CLI registration**

Run:
```bash
node -e "
import('/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/orders.js')
  .then(() => console.log('orders.js loaded successfully!'))
  .catch(err => console.error(err));
"
```
Expected: `orders.js loaded successfully!`

---

### Task 2: MySize (Purchased Garment Measurements) CLI Subcommand (`mysize.js`)

**Files:**
- Create: `/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/mysize.js`
- Test: `/Users/hyunjun_macbook_pro/Documents/Private/project-clot/tests/musinsa-mysize.test.js`

**Interfaces:**
- Produces:
  - `normalizeMySizeRows(list: Array<object>): Array<object>`
  - `formatMySizeToFilterString(row: object, tolerance?: number): string`
  - `getMusinsaMySize(options: object, cookieHeader: string): Promise<Array<object>>`
  - CLI command `opencli musinsa mysize` (aliases: `my-size`, `measurements`)
  - Columns: `['goodsNo', 'brand', 'goodsName', 'size', 'category', 'length', 'chest', 'waist', 'shoulder', 'sleeve', 'thigh']`
- Consumes:
  - `getMusinsaCookies` from `./common.js`
  - `https://api.musinsa.com/api2/dp/v1/plp/goods/order?categoryCodes=...`

- [ ] **Step 1: Write unit tests for MySize data normalization**

Create `tests/musinsa-mysize.test.js`:

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatMySizeToFilterString, normalizeMySizeRows } from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/mysize.js';

describe('Musinsa MySize Data Formatter & Filter Converter', () => {
  test('normalizes raw purchased garment measurements into clean rows', () => {
    const rawApiList = [
      {
        goodsNo: 501234,
        goodsName: '릴렉스드 옥스포드 셔츠',
        brandName: '포터리',
        sizeName: '3',
        sizeType: 'TOP',
        measurements: [
          { name: '총장', value: 75.5 },
          { name: '가슴단면', value: 59.0 },
          { name: '어깨너비', value: 51.5 },
          { name: '소매길이', value: 63.0 },
        ],
      },
    ];

    const rows = normalizeMySizeRows(rawApiList);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      goodsNo: 501234,
      brand: '포터리',
      goodsName: '릴렉스드 옥스포드 셔츠',
      size: '3',
      category: '상의',
      length: '75.5cm',
      chest: '59cm',
      waist: '-',
      shoulder: '51.5cm',
      sleeve: '63cm',
      thigh: '-',
    });
  });

  test('formats MySize measurement rows into --measure filter string with tolerance', () => {
    const row = {
      length: '75cm',
      chest: '59cm',
      shoulder: '51cm',
    };

    // Default tolerance ±2cm
    const filterStr = formatMySizeToFilterString(row, 2);
    assert.equal(filterStr, '총장:73-77,가슴:57-61,어깨:49-53');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/musinsa-mysize.test.js`
Expected: FAIL with `Cannot find module ... mysize.js`

- [ ] **Step 3: Implement `mysize.js`**

Create `/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/mysize.js`:

```javascript
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { cleanText, getMusinsaCookies, DEFAULT_USER_AGENT } from './common.js';

const CATEGORY_CODE_MAP = {
  top: '001002,107001001002,105001001004,001003,001001,001010,112001010,107001001001,106004011,001005',
  pants: '003004,107001003002,003007,003002,017042002001,107011002004,107001003001,003008,017045002001,107001003005',
  outer: '002022,107001002001,002001,002002,002007,002025,002016,002023,002012,002019',
};

const SIZE_TYPE_LABELS = {
  TOP: '상의',
  PANTS: '하의',
  OUTER: '아우터',
  SHOES: '신발',
};

/**
 * Normalizes raw purchased garment measurements into clean tabular rows.
 * @param {Array<object>} list
 * @returns {Array<object>}
 */
export function normalizeMySizeRows(list = []) {
  return list.map((item) => {
    const measureMap = new Map();
    for (const m of item.measurements || item.measurementList || []) {
      const val = m.value ?? m.sizeValue ?? m.val;
      if (val != null) {
        measureMap.set(m.name || m.title || m.displayText, val);
      }
    }

    const fmt = (key) => {
      const v = measureMap.get(key);
      return v != null ? `${Number(v).toFixed(1).replace(/\.0$/, '')}cm` : '-';
    };

    const typeCode = (item.sizeType || 'TOP').toUpperCase();
    return {
      goodsNo: item.goodsNo || item.productId || '-',
      brand: cleanText(item.brandName || item.brand) || '-',
      goodsName: cleanText(item.goodsName || item.productName) || '-',
      size: cleanText(item.sizeName || item.optionName || item.size) || '-',
      category: SIZE_TYPE_LABELS[typeCode] || typeCode,
      length: fmt('총장'),
      chest: fmt('가슴단면'),
      waist: fmt('허리단면'),
      shoulder: fmt('어깨너비'),
      sleeve: fmt('소매길이'),
      thigh: fmt('허벅지단면'),
    };
  });
}

/**
 * Converts a measurement row into a search filter string with tolerance in cm.
 * @param {object} row
 * @param {number} tolerance
 * @returns {string}
 */
export function formatMySizeToFilterString(row = {}, tolerance = 2) {
  const parts = [];
  const parseVal = (str) => {
    if (!str || str === '-') return null;
    const num = parseFloat(str.replace(/cm/gi, '').trim());
    return isNaN(num) ? null : num;
  };

  const addPart = (label, valStr) => {
    const val = parseVal(valStr);
    if (val != null) {
      const min = Math.max(0, Math.round(val - tolerance));
      const max = Math.round(val + tolerance);
      parts.push(`${label}:${min}-${max}`);
    }
  };

  addPart('총장', row.length);
  addPart('가슴', row.chest);
  addPart('허리', row.waist);
  addPart('어깨', row.shoulder);
  addPart('소매', row.sleeve);
  addPart('허벅지', row.thigh);

  return parts.join(',');
}

/**
 * Fetches the user's purchased items and actual measurements.
 */
export async function getMusinsaMySize(options = {}, cookieHeader = '') {
  const type = String(options.type || 'all').toLowerCase();
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
  const tolerance = Number(options.tolerance) || 2;

  let categoryCodes = CATEGORY_CODE_MAP[type];
  if (!categoryCodes) {
    categoryCodes = [CATEGORY_CODE_MAP.top, CATEGORY_CODE_MAP.pants, CATEGORY_CODE_MAP.outer].join(',');
  }

  const url = `https://api.musinsa.com/api2/dp/v1/plp/goods/order?categoryCodes=${categoryCodes}`;
  const headers = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: 'application/json',
    Referer: 'https://www.musinsa.com/',
  };
  if (cookieHeader) {
    headers['Cookie'] = cookieHeader;
  }

  let json;
  try {
    const res = await fetch(url, { headers });
    if (res.status === 401) {
      throw new AuthRequiredError('musinsa.com', '로그인이 필요합니다. Chrome에서 무신사에 로그인해 주세요.');
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    json = await res.json();
  } catch (err) {
    if (err instanceof AuthRequiredError) throw err;
    throw new CommandExecutionError(`Failed to fetch MySize items: ${err?.message ?? err}`);
  }

  const items = json?.data?.list || [];
  if (!items.length) {
    throw new EmptyResultError('musinsa mysize', '구매 내역 기반 실측 데이터가 없습니다. (무신사에서 구매한 의류가 없거나 실측이 지원되지 않는 상품입니다)');
  }

  const rows = normalizeMySizeRows(items.slice(0, limit));

  if (options['as-filter'] || options.asFilter) {
    return rows.map((r) => ({
      goodsNo: r.goodsNo,
      goodsName: r.goodsName,
      size: r.size,
      filterArgs: `--measure "${formatMySizeToFilterString(r, tolerance)}"`,
    }));
  }

  return rows;
}

cli({
  site: 'musinsa',
  name: 'mysize',
  aliases: ['my-size', 'measurements'],
  access: 'read',
  description: 'Inspect actual cm measurements of your past-purchased garments (총장, 가슴, 허리, 어깨 등) and generate search filter strings',
  domain: 'musinsa.com',
  strategy: Strategy.COOKIE,
  navigateBefore: false,
  args: [
    {
      name: 'type',
      type: 'string',
      default: 'all',
      help: 'Category type filter: all, top, pants, outer',
    },
    {
      name: 'limit',
      type: 'int',
      default: 20,
      help: 'Maximum number of items to return (default 20)',
    },
    {
      name: 'tolerance',
      type: 'int',
      default: 2,
      help: 'Search filter tolerance range in cm (default ±2cm)',
    },
    {
      name: 'as-filter',
      type: 'bool',
      default: false,
      help: 'Output formatted --measure string ready to paste into opencli musinsa search',
    },
  ],
  columns: ['goodsNo', 'brand', 'goodsName', 'size', 'category', 'length', 'chest', 'waist', 'shoulder', 'sleeve', 'thigh'],
  func: async (page, kwargs) => {
    const cookieHeader = await getMusinsaCookies(page);
    return await getMusinsaMySize(kwargs, cookieHeader);
  },
});
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `node --test tests/musinsa-mysize.test.js`
Expected: PASS (2 tests passing)

- [ ] **Step 5: Verify `mysize.js` module loading and help registration**

Run:
```bash
node -e "
import('/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/mysize.js')
  .then(() => console.log('mysize.js loaded successfully!'))
  .catch(err => console.error(err));
"
```
Expected: `mysize.js loaded successfully!`

---

### Task 3: Search Bridge (`--my-size` Option in `search.js`)

**Files:**
- Modify: `/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/search.js`
- Test: `/Users/hyunjun_macbook_pro/Documents/Private/project-clot/tests/musinsa-search-mysize.test.js`

**Interfaces:**
- Consumes: `getMusinsaMySize`, `formatMySizeToFilterString` from `./mysize.js`
- Produces: CLI argument `--my-size [top|pants|outer]` in `opencli musinsa search`

- [ ] **Step 1: Write integration test for `--my-size` flag**

Create `tests/musinsa-search-mysize.test.js`:

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatMySizeToFilterString } from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/mysize.js';
import { buildFilterQueryParams } from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/filters.js';

describe('Search MySize Bridge', () => {
  test('converts my-size row measurements into search query parameters', () => {
    const mySizeRow = {
      length: '74cm',
      chest: '58cm',
    };

    const measureStr = formatMySizeToFilterString(mySizeRow, 2);
    assert.equal(measureStr, '총장:72-76,가슴:56-60');

    const filterParams = buildFilterQueryParams({ measure: measureStr });
    assert.equal(filterParams.measurement, '총장^72^76,가슴단면^56^60');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/musinsa-search-mysize.test.js`
Expected: PASS

- [ ] **Step 3: Update `search.js` with `--my-size` argument**

In `/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/search.js`:
Add import:
```javascript
import { getMusinsaMySize, formatMySizeToFilterString } from './mysize.js';
```
Add CLI argument in `args`:
```javascript
    {
      name: 'my-size',
      type: 'string',
      help: 'Automatically apply measurements from your past purchased item (e.g. "top", "pants", "outer")',
    },
```
And in `func`: if `kwargs['my-size']` is passed, dynamically apply past purchased garment measurement:
```javascript
  func: async (page, kwargs) => {
    const query = String(kwargs.query || '');
    const cookieHeader = await getMusinsaCookies(page);
    if (kwargs['my-size'] && !kwargs.measure) {
      try {
        const items = await getMusinsaMySize({ type: kwargs['my-size'], limit: 1 }, cookieHeader);
        if (items.length > 0) {
          kwargs.measure = formatMySizeToFilterString(items[0]);
        }
      } catch (err) {
        // Fallback gracefully without blocking search
      }
    }
    return await searchMusinsa(query, kwargs, cookieHeader);
  },
```

- [ ] **Step 4: Verify search.js loads cleanly**

Run:
```bash
node -e "
import('/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/search.js')
  .then(() => console.log('search.js loaded cleanly!'))
  .catch(err => console.error(err));
"
```
Expected: `search.js loaded cleanly!`

---

### Task 4: Full Test Suite Verification & Documentation

**Files:**
- Test: All tests (`NODE_TEST_CONCURRENCY=1 npm test`)
- Modify: `README.md` (Document purchased size extraction and `mysize` commands)

- [ ] **Step 1: Run complete repository test suite**

Run: `NODE_TEST_CONCURRENCY=1 npm test`
Expected: All test suites pass cleanly.

- [ ] **Step 2: Update `README.md`**

Document:
1. `opencli musinsa orders`: Explain the `size` column and how size/color/quantity are cleanly isolated.
2. `opencli musinsa mysize`: Document how to view past garment cm measurements (`총장`, `가슴`, `허리` 등) and use `--as-filter`.
3. `opencli musinsa search <keyword> --my-size <category>`: Document automatic sizing from past purchases.

---

## Verification Plan

### Automated Tests
- `node --test tests/musinsa-order-parser.test.js`: Verifies extraction of standard sizes, shoe sizes, waist numbers, and multi-line options.
- `node --test tests/musinsa-mysize.test.js`: Verifies measurement normalization and `--measure` string generation.
- `node --test tests/musinsa-search-mysize.test.js`: Verifies bridge between past purchase measurements and search queries.

### Manual / CLI Verification
- `opencli musinsa orders --limit 5` ➔ Confirms `size` column displays clean sizes (`L`, `270`, etc.).
- `opencli musinsa mysize --type top` ➔ Displays past purchased tops with their cm measurements.
- `opencli musinsa mysize --type top --as-filter` ➔ Generates copy-pastable `--measure` flag.
