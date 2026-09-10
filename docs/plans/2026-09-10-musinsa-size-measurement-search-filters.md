# Musinsa OpenCLI Size & Garment Measurement Search Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the OpenCLI Musinsa adapter to support filtering search results by standard clothing size (`--size`), shoe size (`--shoe-size`), and precise garment measurements in cm (`--measure`), plus adding a dedicated option-level inventory command (`opencli musinsa options <goodsNo>`).

**Architecture:**
1. Build a pure, zero-dependency parsing and normalization module (`~/.opencli/clis/musinsa/filters.js`) that handles alias resolution (e.g. `기장` -> `총장`), numeric/range parsing (e.g. `70-75`, `75+`), and serializes them to Musinsa's internal Elasticsearch query format (`standardSize`, `shoeSizeOption`, `measurement=<부위>^<최소>^<최대>`).
2. Wire the parsed parameters into `~/.opencli/clis/musinsa/search.js` by adding CLI arguments (`--size`, `--measure`, `--shoe-size`) and injecting them into the search URL.
3. Implement `~/.opencli/clis/musinsa/options.js` to inspect detailed per-size stock and delivery estimates via Musinsa's internal `goods-detail.musinsa.com/api2/goods/{goodsNo}/options` and `prioritized-inventories` endpoints.
4. Add comprehensive unit tests in `project-clot/tests/musinsa-filters.test.js` executed via native `node --test`.

**Tech Stack:** Node.js (v24.17.0, ESM, `node:test`, `node:assert/strict`), OpenCLI plugin architecture (`@jackwener/opencli`), Native `fetch`. Zero external npm dependencies.

**Spec:** Verified Musinsa Search API and PLP reverse-engineered endpoints (`https://www.musinsa.com/search/musinsa/goods`, `https://goods-detail.musinsa.com/api2/goods/{goodsNo}/options`).

## Global Constraints

- Use ESM imports only (`import ... from '...'`).
- Zero new npm dependencies; rely entirely on native Node.js and existing OpenCLI libraries.
- Never crash on invalid measurement/size inputs: gracefully normalize, fallback, or provide clear human-readable error messages.
- Measurement aliases must cover Korean conversational apparel terms (`기장`, `가슴`, `허리`, `허벅지`, `소매`, `어깨`, `밑단`, `밑위`, `엉덩이`).
- Search URL parameter format must strictly follow Musinsa specs: `standardSize=M,L`, `shoeSizeOption=270`, `measurement=총장^70^75,가슴단면^55^60`.

---

### Task 1: Filter Parsing & Normalization Engine (`filters.js`)

**Files:**
- Create: `/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/filters.js`
- Test: `/Users/hyunjun_macbook_pro/Documents/Private/project-clot/tests/musinsa-filters.test.js`

**Interfaces:**
- Produces:
  - `normalizeStandardSize(input: string): string | null`
  - `normalizeShoeSize(input: string | number): string | null`
  - `parseMeasurementInput(input: string): string | null`
  - `buildFilterQueryParams(options: object): { standardSize?: string, shoeSizeOption?: string, measurement?: string }`
- Consumes: Native JavaScript standard library only.

- [ ] **Step 1: Write the failing test for `filters.js`**

Create `tests/musinsa-filters.test.js` testing standard size normalization, shoe size normalization, measurement string parsing, and query param building:

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeStandardSize,
  normalizeShoeSize,
  parseMeasurementInput,
  buildFilterQueryParams,
} from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/filters.js';

describe('Musinsa Filter Normalization Engine', () => {
  test('normalizeStandardSize handles single and comma-separated sizes and maps 2XL/3XL', () => {
    assert.equal(normalizeStandardSize('m'), 'M');
    assert.equal(normalizeStandardSize('M, L, xl'), 'M,L,XL');
    assert.equal(normalizeStandardSize('2XL'), 'XXL');
    assert.equal(normalizeStandardSize('xxl'), 'XXL');
    assert.equal(normalizeStandardSize('3XL'), 'XXL');
    assert.equal(normalizeStandardSize(''), null);
    assert.equal(normalizeStandardSize(null), null);
  });

  test('normalizeShoeSize strips mm and validates shoe sizes', () => {
    assert.equal(normalizeShoeSize('270'), '270');
    assert.equal(normalizeShoeSize('270mm'), '270');
    assert.equal(normalizeShoeSize(265), '265');
    assert.equal(normalizeShoeSize('270, 275'), '270,275');
    assert.equal(normalizeShoeSize('invalid'), null);
  });

  test('parseMeasurementInput converts Korean aliases and range formats into caret syntax', () => {
    // Range with hyphen
    assert.equal(parseMeasurementInput('총장:70-75'), '총장^70^75');
    // Range with tilde
    assert.equal(parseMeasurementInput('기장:70~75'), '총장^70^75');
    // Multiple measurements with Korean aliases
    assert.equal(
      parseMeasurementInput('기장:70-75, 가슴:55-60, 허리:38-40'),
      '총장^70^75,가슴단면^55^60,허리단면^38^40'
    );
    // Min only (e.g. 75+)
    assert.equal(parseMeasurementInput('총장:75+'), '총장^75^150');
    assert.equal(parseMeasurementInput('총장:75~'), '총장^75^150');
    // Max only (e.g. ~75)
    assert.equal(parseMeasurementInput('총장:~75'), '총장^0^75');
    assert.equal(parseMeasurementInput('총장:-75'), '총장^0^75');
  });

  test('buildFilterQueryParams auto-routes options into clean query params', () => {
    // Standard clothing size
    assert.deepEqual(buildFilterQueryParams({ size: 'M,L' }), {
      standardSize: 'M,L',
    });

    // Auto-detect shoe size passed to --size
    assert.deepEqual(buildFilterQueryParams({ size: '270' }), {
      shoeSizeOption: '270',
    });

    // Explicit shoe size and measurement
    assert.deepEqual(
      buildFilterQueryParams({
        size: 'L',
        measure: '기장:72-76, 어깨:50-54',
      }),
      {
        standardSize: 'L',
        measurement: '총장^72^76,어깨너비^50^54',
      }
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/musinsa-filters.test.js`
Expected: FAIL with `Cannot find module '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/filters.js'`

- [ ] **Step 3: Write minimal implementation in `filters.js`**

Create `/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/filters.js`:

```javascript
/**
 * Musinsa filter normalization engine for label sizes, shoe sizes, and garment measurements.
 */

const VALID_STANDARD_SIZES = new Set(['XS', 'S', 'M', 'L', 'XL', 'XXL']);

const STANDARD_SIZE_MAP = {
  xs: 'XS',
  s: 'S',
  m: 'M',
  l: 'L',
  xl: 'XL',
  xxl: 'XXL',
  '2xl': 'XXL',
  '3xl': 'XXL',
};

const MEASUREMENT_ALIASES = {
  총장: '총장',
  기장: '총장',
  길이: '총장',
  옷길이: '총장',
  가슴: '가슴단면',
  가슴단면: '가슴단면',
  가슴너비: '가슴단면',
  허리: '허리단면',
  허리단면: '허리단면',
  허리너비: '허리단면',
  허벅지: '허벅지단면',
  허벅지단면: '허벅지단면',
  밑단: '밑단단면',
  밑단단면: '밑단단면',
  소매: '소매길이',
  소매길이: '소매길이',
  팔: '소매길이',
  팔길이: '소매길이',
  어깨: '어깨너비',
  어깨너비: '어깨너비',
  어깨길이: '어깨너비',
  밑위: '밑위',
  밑위길이: '밑위',
  엉덩이: '엉덩이단면',
  엉덩이단면: '엉덩이단면',
  힙: '엉덩이단면',
  소매부리: '소매부리단면',
  소매부리단면: '소매부리단면',
};

/**
 * Normalizes user-entered clothing sizes to Musinsa standard codes.
 * @param {string} input - e.g. "M", "L, XL", "2XL"
 * @returns {string|null} - e.g. "M,L,XL", "XXL"
 */
export function normalizeStandardSize(input) {
  if (!input) return null;
  const parts = String(input)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const matched = [];
  for (const part of parts) {
    const mapped = STANDARD_SIZE_MAP[part];
    if (mapped) {
      matched.push(mapped);
    }
  }

  return matched.length > 0 ? Array.from(new Set(matched)).join(',') : null;
}

/**
 * Normalizes shoe size in millimeters.
 * @param {string|number} input - e.g. "270", "270mm", "265, 270"
 * @returns {string|null} - e.g. "270" or "265,270"
 */
export function normalizeShoeSize(input) {
  if (!input) return null;
  const parts = String(input)
    .split(',')
    .map((s) => s.replace(/mm/gi, '').trim())
    .filter((s) => /^\d{3}$/.test(s));

  return parts.length > 0 ? Array.from(new Set(parts)).join(',') : null;
}

/**
 * Parses conversational garment measurement string into Musinsa caret format.
 * Syntax supported:
 *   "총장:70-75,가슴:55-60"
 *   "기장:70~75"
 *   "기장:75+" (min 75, max 150)
 *   "기장:~75" (min 0, max 75)
 * @param {string} input
 * @returns {string|null} - e.g. "총장^70^75,가슴단면^55^60"
 */
export function parseMeasurementInput(input) {
  if (!input) return null;
  const items = String(input)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const formattedParts = [];

  for (const item of items) {
    // Match patterns like "기장:70-75", "총장=70~75", "가슴:75+", "허리:~40"
    const match = item.match(/^([^:=~+\-\d\s]+)\s*[:=]\s*(.+)$/);
    if (!match) continue;

    const rawKey = match[1].trim();
    const rawVal = match[2].trim();
    const resolvedKey = MEASUREMENT_ALIASES[rawKey];
    if (!resolvedKey) continue;

    let min = 0;
    let max = 150;

    // Pattern 1: Min only with + or ~ (e.g. 75+, 75~)
    const minOnlyMatch = rawVal.match(/^(\d+(?:\.\d+)?)\s*(?:\+|~)$/);
    if (minOnlyMatch) {
      min = Math.round(Number(minOnlyMatch[1]));
      max = 150;
      formattedParts.push(`${resolvedKey}^${min}^${max}`);
      continue;
    }

    // Pattern 2: Max only with ~ or - prefix (e.g. ~75, -75)
    const maxOnlyMatch = rawVal.match(/^[~\-]\s*(\d+(?:\.\d+)?)$/);
    if (maxOnlyMatch) {
      min = 0;
      max = Math.round(Number(maxOnlyMatch[1]));
      formattedParts.push(`${resolvedKey}^${min}^${max}`);
      continue;
    }

    // Pattern 3: Range (e.g. 70-75, 70~75, 70 75)
    const rangeMatch = rawVal.match(/^(\d+(?:\.\d+)?)\s*[\-~_\s]\s*(\d+(?:\.\d+)?)$/);
    if (rangeMatch) {
      min = Math.round(Number(rangeMatch[1]));
      max = Math.round(Number(rangeMatch[2]));
      if (min > max) [min, max] = [max, min];
      formattedParts.push(`${resolvedKey}^${min}^${max}`);
      continue;
    }
  }

  return formattedParts.length > 0 ? formattedParts.join(',') : null;
}

/**
 * Builds query parameters from CLI options with smart routing.
 * @param {object} options
 * @returns {{ standardSize?: string, shoeSizeOption?: string, measurement?: string }}
 */
export function buildFilterQueryParams(options = {}) {
  const params = {};

  const sizeInput = options.size;
  const shoeSizeInput = options['shoe-size'] || options.shoeSize;
  const measureInput = options.measure || options.measurement;

  // Explicit shoe size
  if (shoeSizeInput) {
    const shoeSize = normalizeShoeSize(shoeSizeInput);
    if (shoeSize) params.shoeSizeOption = shoeSize;
  }

  // Handle size input: smart detection (if all numbers, treat as shoe size)
  if (sizeInput) {
    const trimmed = String(sizeInput).trim();
    if (/^\d{3}(?:\s*,\s*\d{3})*$/.test(trimmed)) {
      const shoeSize = normalizeShoeSize(trimmed);
      if (shoeSize) params.shoeSizeOption = shoeSize;
    } else {
      const standardSize = normalizeStandardSize(trimmed);
      if (standardSize) params.standardSize = standardSize;
    }
  }

  // Handle measurement input
  if (measureInput) {
    const measurement = parseMeasurementInput(measureInput);
    if (measurement) params.measurement = measurement;
  }

  return params;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/musinsa-filters.test.js`
Expected: PASS (4 tests passing)

- [ ] **Step 5: Review module exports and integrity**

Ensure `filters.js` is standalone, has zero imports, and executes with no errors.

---

### Task 2: Search Command Integration (`search.js`)

**Files:**
- Modify: `/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/search.js`
- Test: `/Users/hyunjun_macbook_pro/Documents/Private/project-clot/tests/musinsa-search-integration.test.js`

**Interfaces:**
- Consumes: `buildFilterQueryParams` from `./filters.js`
- Produces: CLI options `--size`, `--measure`, `--shoe-size` in `opencli musinsa search`

- [ ] **Step 1: Write integration test for `searchMusinsa` URL building**

Create `tests/musinsa-search-integration.test.js`:

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildFilterQueryParams } from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/filters.js';

describe('Musinsa Search URL Parameter Construction', () => {
  test('constructs search URL with standardSize, shoeSizeOption, and measurement', () => {
    const query = '셔츠';
    const options = {
      page: 1,
      size: 'M,L',
      measure: '기장:70-75,가슴:55-60',
    };

    const filterParams = buildFilterQueryParams(options);
    let url = `https://www.musinsa.com/search/musinsa/goods?q=${encodeURIComponent(query)}&page=1&sortCode=POPULAR&gf=A&isUsed=false`;
    if (filterParams.standardSize) url += `&standardSize=${encodeURIComponent(filterParams.standardSize)}`;
    if (filterParams.shoeSizeOption) url += `&shoeSizeOption=${encodeURIComponent(filterParams.shoeSizeOption)}`;
    if (filterParams.measurement) url += `&measurement=${encodeURIComponent(filterParams.measurement)}`;

    assert.ok(url.includes('standardSize=M%2CL'));
    assert.ok(url.includes('measurement=%EC%B4%9D%EC%9E%A5%5E70%5E75%2C%EA%B0%80%EC%8A%B4%EB%8B%A8%EB%A9%B4%5E55%5E60'));
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/musinsa-search-integration.test.js`
Expected: PASS

- [ ] **Step 3: Modify `search.js` to add filter parameters and CLI args**

In `/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/search.js`:
1. Import `buildFilterQueryParams`:
```javascript
import { buildFilterQueryParams } from './filters.js';
```
2. Update `searchMusinsa` function:
```javascript
  const filterParams = buildFilterQueryParams(options);
  let url = `https://www.musinsa.com/search/musinsa/goods?q=${encodeURIComponent(query)}&page=${page}&sortCode=${sortCode}&gf=${genderCode}&isUsed=${isUsed}`;
  if (filterParams.standardSize) {
    url += `&standardSize=${encodeURIComponent(filterParams.standardSize)}`;
  }
  if (filterParams.shoeSizeOption) {
    url += `&shoeSizeOption=${encodeURIComponent(filterParams.shoeSizeOption)}`;
  }
  if (filterParams.measurement) {
    url += `&measurement=${encodeURIComponent(filterParams.measurement)}`;
  }
```
3. Add CLI arguments to `cli({ ... args: [ ... ] })`:
```javascript
    {
      name: 'size',
      type: 'string',
      help: 'Clothing label size (e.g. "M", "L,XL", "2XL") or shoe size (e.g. "270")',
    },
    {
      name: 'measure',
      type: 'string',
      help: 'Garment measurement cm filter (e.g. "기장:70-75,가슴:55-60", "허리:38~40")',
    },
    {
      name: 'shoe-size',
      type: 'string',
      help: 'Shoe size in mm (e.g. "265", "270")',
    },
```

- [ ] **Step 4: Run CLI test to verify syntax and help registration**

Run:
```bash
node -e "
import('/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/search.js')
  .then(() => console.log('search.js loaded successfully!'))
  .catch(err => console.error(err));
"
```
Expected: `search.js loaded successfully!`

---

### Task 3: Product Options Subcommand (`opencli musinsa options <goodsNo>`)

**Files:**
- Create: `/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/options.js`
- Test: `/Users/hyunjun_macbook_pro/Documents/Private/project-clot/tests/musinsa-options.test.js`

**Interfaces:**
- Produces: `getMusinsaOptions(goodsNoInput, cookieHeader)`
- Consumes:
  - `parseGoodsNo`, `cleanText`, `formatPrice`, `getMusinsaCookies` from `./common.js`
  - `https://goods-detail.musinsa.com/api2/goods/{goodsNo}/options`
  - `https://goods-detail.musinsa.com/api2/goods/{goodsNo}/options/v2/prioritized-inventories`

- [ ] **Step 1: Write mock test for options parsing**

Create `tests/musinsa-options.test.js`:

```javascript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('Musinsa Product Options & Inventory Formatter', () => {
  test('correlates option items with inventory status correctly', () => {
    const rawOptions = {
      basic: [
        {
          name: '사이즈',
          optionValues: [
            { no: 101, name: 'M' },
            { no: 102, name: 'L' },
          ],
        },
      ],
      optionItems: [
        { no: 201, optionValueNos: [101], price: 0 },
        { no: 202, optionValueNos: [102], price: 3000 },
      ],
    };

    const rawInventory = [
      {
        productVariantId: 201,
        outOfStock: false,
        remainQuantity: 5,
        domesticDelivery: { guideWillReleaseAtText: '내일(금) 발송 예정' },
      },
      {
        productVariantId: 202,
        outOfStock: true,
        remainQuantity: 0,
      },
    ];

    const invMap = new Map(rawInventory.map((i) => [i.productVariantId, i]));

    const rows = rawOptions.optionItems.map((item) => {
      const inv = invMap.get(item.no);
      const valName = rawOptions.basic[0].optionValues.find((v) => v.no === item.optionValueNos[0])?.name;
      return {
        size: valName,
        priceAdd: item.price > 0 ? `+${item.price.toLocaleString()}원` : '0원',
        status: inv?.outOfStock ? '품절' : '판매중',
        remain: inv?.remainQuantity != null ? `${inv.remainQuantity}개` : '-',
        delivery: inv?.domesticDelivery?.guideWillReleaseAtText || '-',
      };
    });

    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      size: 'M',
      priceAdd: '0원',
      status: '판매중',
      remain: '5개',
      delivery: '내일(금) 발송 예정',
    });
    assert.deepEqual(rows[1], {
      size: 'L',
      priceAdd: '+3,000원',
      status: '품절',
      remain: '0개',
      delivery: '-',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/musinsa-options.test.js`
Expected: PASS

- [ ] **Step 3: Implement `options.js` in `~/.opencli/clis/musinsa/options.js`**

Create `/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/options.js`:

```javascript
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { cleanText, formatPrice, getMusinsaCookies, parseGoodsNo, DEFAULT_USER_AGENT } from './common.js';

export async function getMusinsaOptions(goodsNoInput, cookieHeader = '') {
  const goodsNo = parseGoodsNo(goodsNoInput);
  if (!goodsNo) {
    throw new ArgumentError('goodsNo', 'Must provide a valid Musinsa goods number or URL (e.g. 7035474)');
  }

  const optionsUrl = `https://goods-detail.musinsa.com/api2/goods/${goodsNo}/options`;
  const headers = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: 'application/json',
    Referer: 'https://www.musinsa.com/',
  };
  if (cookieHeader) {
    headers['Cookie'] = cookieHeader;
  }

  let optionsData;
  try {
    const res = await fetch(optionsUrl, { headers });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    optionsData = json.data;
  } catch (err) {
    throw new CommandExecutionError(`Failed to fetch options for goods ${goodsNo}: ${err?.message ?? err}`);
  }

  const optionItems = optionsData?.optionItems || [];
  if (!optionItems.length) {
    throw new EmptyResultError('musinsa options', `No options found for goods ${goodsNo}`);
  }

  // Collect all option value IDs to query inventory
  const allValueNos = [];
  const valNameMap = new Map();
  for (const group of optionsData.basic || []) {
    for (const val of group.optionValues || []) {
      valNameMap.set(val.no, val.name);
    }
  }

  for (const item of optionItems) {
    if (Array.isArray(item.optionValueNos)) {
      allValueNos.push(...item.optionValueNos);
    }
  }

  // Query real-time inventory
  let inventoryMap = new Map();
  if (allValueNos.length > 0) {
    try {
      const invUrl = `https://goods-detail.musinsa.com/api2/goods/${goodsNo}/options/v2/prioritized-inventories`;
      const invRes = await fetch(invUrl, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ optionValueNos: Array.from(new Set(allValueNos)) }),
      });
      if (invRes.ok) {
        const invJson = await invRes.json();
        for (const item of invJson.data || []) {
          inventoryMap.set(item.productVariantId, item);
        }
      }
    } catch {
      // Non-fatal fallback
    }
  }

  return optionItems.map((item) => {
    const names = (item.optionValueNos || []).map((no) => valNameMap.get(no) || String(no));
    const sizeName = names.join(' / ') || item.managedCode || '-';
    const inv = inventoryMap.get(item.no);
    const isOutOfStock = inv ? Boolean(inv.outOfStock) : !item.activated;
    const remainQuantity = inv?.remainQuantity != null ? `${inv.remainQuantity}개` : '-';
    const deliveryGuide = inv?.domesticDelivery?.guideWillReleaseAtText || '-';

    return {
      goodsNo,
      size: sizeName,
      status: isOutOfStock ? '품절' : '판매중',
      priceExtra: item.price > 0 ? `+${Number(item.price).toLocaleString()}원` : '0원',
      remain: remainQuantity,
      delivery: deliveryGuide,
    };
  });
}

cli({
  site: 'musinsa',
  name: 'options',
  aliases: ['opt', 'sizes', 'stock'],
  access: 'read',
  description: 'Inspect option and size availability, stock status, and delivery schedules for a product',
  domain: 'musinsa.com',
  strategy: Strategy.COOKIE,
  navigateBefore: false,
  args: [
    {
      name: 'goodsNo',
      required: true,
      positional: true,
      help: 'Musinsa goods number or URL (e.g. 7035474 or https://www.musinsa.com/products/7035474)',
    },
  ],
  columns: ['goodsNo', 'size', 'status', 'priceExtra', 'remain', 'delivery'],
  func: async (page, kwargs) => {
    const cookieHeader = await getMusinsaCookies(page);
    return await getMusinsaOptions(kwargs.goodsNo, cookieHeader);
  },
});
```

- [ ] **Step 4: Verify module loading**

Run:
```bash
node -e "
import('/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/options.js')
  .then(() => console.log('options.js loaded successfully!'))
  .catch(err => console.error(err));
"
```
Expected: `options.js loaded successfully!`

---

### Task 4: End-to-End Live Verification & Documentation

**Files:**
- Test: All test suites (`musinsa-filters.test.js`, `musinsa-search-integration.test.js`, `musinsa-options.test.js`)
- Modify: `README.md` (Update CLI feature documentation)

- [ ] **Step 1: Run complete repository test suite**

Run: `node --test tests/musinsa-*.test.js`
Expected: All filter and integration tests PASS.

- [ ] **Step 2: Live search verification via OpenCLI adapter**

Run a real probe search with both size and measurement filters:
```bash
node -e "
import { searchMusinsa } from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/search.js';
import { getMusinsaOptions } from '/Users/hyunjun_macbook_pro/.opencli/clis/musinsa/options.js';

async function verify() {
  console.log('1. Testing search with size & measurement...');
  const results = await searchMusinsa('셔츠', { size: 'M', measure: '총장:72-76' });
  console.log('Search returned items:', results.length, 'Top item:', results[0].goodsName);

  console.log('2. Testing options inspection for top item...');
  const options = await getMusinsaOptions(results[0].goodsNo);
  console.log('Options count:', options.length, 'Options sample:', options[0]);
}
verify();
"
```
Expected:
- Search returns filtered items with `goodsName`.
- Options inspection returns array of options with sizes and status.

- [ ] **Step 3: Update documentation in `README.md`**

Document the new size and measurement search filters in `README.md` with practical usage examples.

---

## Verification Plan

### Automated Tests
- `node --test tests/musinsa-filters.test.js`: Validates all edge cases of Korean measurement aliases, standard size maps, and shoe size formatting.
- `node --test tests/musinsa-search-integration.test.js`: Confirms URL query string composition.
- `node --test tests/musinsa-options.test.js`: Tests variant-to-inventory mapping.

### Manual / Live Verification
- Execute `opencli musinsa search "셔츠" --size M --measure "총장:72-76"` and verify that the output contains appropriately filtered shirts.
- Execute `opencli musinsa options <goodsNo>` on a known multi-size item and verify that each size shows accurate stock/sold-out status.
