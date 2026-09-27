# ask-uniqlo Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-local Claude skill `ask-uniqlo` that searches UNIQLO KR and returns product details (price, per-color/size online stock, size chart, material/care, reviews) as JSON via plain HTTPS.

**Architecture:** A standalone, dependency-free Node CLI (`scripts/uq.mjs`) inside the skill folder, modelled on `~/.claude/skills/ask-dc`. `lib/core.js` owns HTTP, errors and shared parsing; `lib/search.js`, `lib/detail.js`, `lib/reviews.js` each own one command; `lib/cli.js` parses arguments and maps errors to exit codes. The real files live in `.agents/skills/ask-uniqlo/`; `.claude/skills/ask-uniqlo` is a relative symlink so Claude Code discovers it.

**Tech Stack:** Node 18+ (repo runs v24) built-in `fetch`, `node:util` `parseArgs`, `node:test` + `node:assert/strict`. ESM `.js`/`.mjs`. No npm dependencies.

**Spec:** `docs/plans/2026-09-27-ask-uniqlo-design.md`

## Global Constraints

- Skill root: `.agents/skills/ask-uniqlo/` (real files); `.claude/skills/ask-uniqlo` → `../../.agents/skills/ask-uniqlo` (relative symlink).
- No npm dependencies; do not touch the repo's `package.json`, `src/`, or `tests/`.
- API base `https://www.uniqlo.com/kr/api/commerce/v5/ko`; every request carries `httpFailure=true`, a Chrome `User-Agent`, `Accept: application/json`.
- Pacing: 300 ms between request starts, one retry (1000 ms later) on network error or 5xx, 10 s timeout; all in the mutable `timing` object.
- Exit codes: 0 ok, 2 `ARG`, 3 `EMPTY`, 4 `NOT_FOUND`, 5 `BLOCKED`, 1 `NETWORK`/`INTERNAL`. Errors go to stderr as `{"error":{"code","message"}}`; success JSON goes to stdout.
- GU products excluded from search unless `--include-gu`. `discounted` = promo < base OR priceGroup ≠ `"00"`.
- Stock buckets by `statusCode`: `IN_STOCK`→`inStock`, `LOW_STOCK`→`lowStock`, anything else/missing→`soldOut`.
- Online stock only. No store stock, no Musinsa integration, no price tracking.
- Work on a branch (`git switch -c feat/ask-uniqlo`). The tracker daemon auto-commits `data/` on `main`, and `data/prices.db` is usually dirty: **always `git add` explicit paths, never `git add -A`/`.`**.
- Commit messages end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Invocation through the `.claude/skills` symlink** — `node .claude/skills/ask-uniqlo/scripts/uq.mjs …` must resolve `../lib/*.js` and behave the same as the real path. Test in Task 5 (temp symlink).
2. **Multi-word search without quotes** (`search 울트라 라이트 다운`) — positionals must be joined into one query, not rejected. Test in Task 5.
3. **Filters hiding a whole page** (all GU, or nothing on sale) — must fail as `EMPTY` with a message saying how many were hidden and which `--offset` to try, not print an empty list. Test in Task 2.
4. **Products with no size chart or a non-cm chart** (bags: `unit:""`, `22L`; unknown id: entry without `sizeChart`) — `sizeChart` is `null` or shows the raw value; never an error. Test in Task 3.
5. **Length variants (`pld` with `showFlag:true`)** — the same size appearing twice must be labelled `M (76cm)`, not collapsed into duplicate `M` entries. Test in Task 3.

---

### Task 1: Core HTTP and parsing helpers

**Files:**
- Create: `.agents/skills/ask-uniqlo/lib/core.js`
- Create: `.agents/skills/ask-uniqlo/tests/helpers.mjs`
- Test: `.agents/skills/ask-uniqlo/tests/core.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (all exported from `lib/core.js`):
  - `API_BASE: string`, `SITE_BASE: string`, `USER_AGENT: string`
  - `timing: { gapMs: number, retryDelayMs: number, timeoutMs: number }`
  - `class UqError extends Error { code: 'ARG'|'EMPTY'|'NOT_FOUND'|'BLOCKED'|'NETWORK' }` — `new UqError(code, message)`
  - `apiUrl(pathname: string, params?: object) → string`
  - `fetchJson(url: string) → Promise<any>` (returns the API's `result`)
  - `stripHtml(value: any) → string|null`
  - `parseProductRef(input: any) → { productId: string, priceGroup: string|null }`
  - `requirePriceGroup(value: any) → string`
  - `requireBoundedInteger(value, defaultValue, min, max, label) → number`
  - `priceInfo(prices: object|undefined, priceGroup: string) → { price: number|null, originalPrice: number|null, discounted: boolean }`
  - `colorLabel(color: { displayCode, name }) → string` (e.g. `"09 BLACK"`)
  - `productUrl(productId: string, priceGroup = '00') → string`
- Test helpers from `tests/helpers.mjs`: `ok(result) → Response`, `httpStatus(status, body?) → Response`, `stubFetch(handler: (url: URL, init) => Response) → calls: {url: URL, init}[]`, `restoreFetch()`. Importing it sets `timing.gapMs = timing.retryDelayMs = 0`.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/hyunjun_macbook_pro/Documents/Private/project-clot
git switch -c feat/ask-uniqlo
mkdir -p .agents/skills/ask-uniqlo/lib .agents/skills/ask-uniqlo/scripts .agents/skills/ask-uniqlo/tests
```

- [ ] **Step 2: Write the test helpers**

`.agents/skills/ask-uniqlo/tests/helpers.mjs`:

```js
// Shared test helpers: a fetch stub and canned API responses. Importing this module
// also zeroes the request pacing so tests run instantly.
import { timing } from '../lib/core.js';

const realFetch = globalThis.fetch;
timing.gapMs = 0;
timing.retryDelayMs = 0;

export function ok(result) {
    return new Response(JSON.stringify({ status: 'ok', result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

export function httpStatus(status, body = { status: 'nok' }) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// handler(url: URL, init) returns a Response (or throws to simulate a network error).
export function stubFetch(handler) {
    const calls = [];
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        calls.push({ url, init });
        return handler(url, init);
    };
    return calls;
}

export function restoreFetch() {
    globalThis.fetch = realFetch;
}
```

- [ ] **Step 3: Write the failing tests**

`.agents/skills/ask-uniqlo/tests/core.test.mjs`:

```js
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ok, httpStatus, stubFetch, restoreFetch } from './helpers.mjs';
import {
    API_BASE, USER_AGENT, apiUrl, fetchJson, stripHtml, parseProductRef, requirePriceGroup,
    requireBoundedInteger, priceInfo, colorLabel, productUrl,
} from '../lib/core.js';

afterEach(restoreFetch);

test('apiUrl appends httpFailure and skips empty params', () => {
    const url = new URL(apiUrl('/products', { q: '후리스', limit: 5, sort: undefined, path: '' }));
    assert.equal(url.origin + url.pathname, `${API_BASE}/products`);
    assert.equal(url.searchParams.get('q'), '후리스');
    assert.equal(url.searchParams.get('limit'), '5');
    assert.equal(url.searchParams.has('sort'), false);
    assert.equal(url.searchParams.has('path'), false);
    assert.equal(url.searchParams.get('httpFailure'), 'true');
});

test('fetchJson sends a browser User-Agent and returns result', async () => {
    const calls = stubFetch(() => ok({ items: [1] }));
    assert.deepEqual(await fetchJson(apiUrl('/products')), { items: [1] });
    assert.equal(calls[0].init.headers['User-Agent'], USER_AGENT);
    assert.equal(calls[0].init.headers.Accept, 'application/json');
});

test('fetchJson maps 404 to NOT_FOUND and 403 to BLOCKED', async () => {
    stubFetch(() => httpStatus(404));
    await assert.rejects(fetchJson(apiUrl('/x')), { code: 'NOT_FOUND' });
    stubFetch(() => httpStatus(403));
    await assert.rejects(fetchJson(apiUrl('/x')), { code: 'BLOCKED' });
});

test('fetchJson treats status "nok" in a 200 body as BLOCKED', async () => {
    stubFetch(() => httpStatus(200, { status: 'nok', error: { code: 0 } }));
    await assert.rejects(fetchJson(apiUrl('/x')), { code: 'BLOCKED' });
});

test('fetchJson rejects a non-JSON body as BLOCKED', async () => {
    stubFetch(() => new Response('<html>denied</html>', { status: 200 }));
    await assert.rejects(fetchJson(apiUrl('/x')), { code: 'BLOCKED' });
});

test('fetchJson retries once on 5xx', async () => {
    const calls = stubFetch(() => (calls.length === 1 ? httpStatus(503) : ok('second')));
    assert.equal(await fetchJson(apiUrl('/x')), 'second');
    assert.equal(calls.length, 2);
});

test('fetchJson retries a network error once, then reports NETWORK', async () => {
    const calls = stubFetch(() => {
        throw new TypeError('fetch failed');
    });
    await assert.rejects(fetchJson(apiUrl('/x')), { code: 'NETWORK' });
    assert.equal(calls.length, 2);
});

test('stripHtml turns <br> into newlines, drops tags, decodes entities', () => {
    assert.equal(stripHtml('- A<br>- B &amp; C<br/><b>D</b>&#39;s'), "- A\n- B & C\nD's");
    assert.equal(stripHtml('<br>'), null);
    assert.equal(stripHtml(''), null);
    assert.equal(stripHtml(undefined), null);
});

test('parseProductRef accepts ids, bare numbers, and product URLs', () => {
    assert.deepEqual(parseProductRef('E450195-000'), { productId: 'E450195-000', priceGroup: null });
    assert.deepEqual(parseProductRef('450195'), { productId: 'E450195-000', priceGroup: null });
    assert.deepEqual(parseProductRef('e450195'), { productId: 'E450195-000', priceGroup: null });
    assert.deepEqual(
        parseProductRef('https://www.uniqlo.com/kr/ko/products/E482279-000/01?colorDisplayCode=09&sizeDisplayCode=004'),
        { productId: 'E482279-000', priceGroup: '01' },
    );
});

test('parseProductRef rejects malformed ids', () => {
    for (const bad of ['', 'abc', '45019', 'E4501951', undefined]) {
        assert.throws(() => parseProductRef(bad), { code: 'ARG' }, String(bad));
    }
});

test('requirePriceGroup accepts two digits only', () => {
    assert.equal(requirePriceGroup('01'), '01');
    assert.throws(() => requirePriceGroup('1'), { code: 'ARG' });
    assert.throws(() => requirePriceGroup('ab'), { code: 'ARG' });
});

test('requireBoundedInteger applies default and bounds', () => {
    assert.equal(requireBoundedInteger(undefined, 20, 1, 100, 'limit'), 20);
    assert.equal(requireBoundedInteger('7', 20, 1, 100, 'limit'), 7);
    assert.throws(() => requireBoundedInteger('0', 20, 1, 100, 'limit'), { code: 'ARG' });
    assert.throws(() => requireBoundedInteger('2.5', 20, 1, 100, 'limit'), { code: 'ARG' });
});

test('priceInfo marks real promos and non-00 price groups as discounted', () => {
    const base = value => ({ base: { value }, promo: null });
    assert.deepEqual(priceInfo(base(39900), '00'), { price: 39900, originalPrice: 39900, discounted: false });
    assert.deepEqual(
        priceInfo({ base: { value: 49900 }, promo: { value: 49900 } }, '00'),
        { price: 49900, originalPrice: 49900, discounted: false },
    );
    assert.deepEqual(
        priceInfo({ base: { value: 49900 }, promo: { value: 39900 } }, '00'),
        { price: 39900, originalPrice: 49900, discounted: true },
    );
    assert.deepEqual(priceInfo(base(29900), '01'), { price: 29900, originalPrice: 29900, discounted: true });
    assert.deepEqual(priceInfo(undefined, '00'), { price: null, originalPrice: null, discounted: false });
});

test('colorLabel and productUrl', () => {
    assert.equal(colorLabel({ displayCode: '09', name: 'BLACK' }), '09 BLACK');
    assert.equal(productUrl('E450195-000', '01'), 'https://www.uniqlo.com/kr/ko/products/E450195-000/01');
    assert.equal(productUrl('E450195-000'), 'https://www.uniqlo.com/kr/ko/products/E450195-000/00');
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `node --test .agents/skills/ask-uniqlo/tests/core.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/core.js'`.

- [ ] **Step 5: Implement `lib/core.js`**

```js
// Shared HTTP + parsing helpers for the ask-uniqlo CLI. Needs only Node 18+ (built-in fetch).

export const API_BASE = 'https://www.uniqlo.com/kr/api/commerce/v5/ko';
export const SITE_BASE = 'https://www.uniqlo.com/kr/ko';
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

// Mutable so tests can drop the delays to zero.
export const timing = { gapMs: 300, retryDelayMs: 1000, timeoutMs: 10000 };

export class UqError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'UqError';
        this.code = code; // ARG | EMPTY | NOT_FOUND | BLOCKED | NETWORK
    }
}

// ---------- validation ----------

export function requireBoundedInteger(value, defaultValue, minimum, maximum, label) {
    const number = Number(value ?? defaultValue);
    if (!Number.isInteger(number)) throw new UqError('ARG', `${label} must be an integer`);
    if (number < minimum || number > maximum) {
        throw new UqError('ARG', `${label} must be between ${minimum} and ${maximum}`);
    }
    return number;
}

export function requirePriceGroup(value) {
    const priceGroup = String(value ?? '');
    if (!/^\d{2}$/.test(priceGroup)) throw new UqError('ARG', 'price group must be two digits, e.g. 00');
    return priceGroup;
}

const PRODUCT_ID = /(?<![0-9A-Za-z])E?(\d{6})(?:-(\d{3}))?(?!\d)/i;
const URL_PRICE_GROUP = /\/products\/E\d{6}-\d{3}\/(\d{2})(?!\d)/i;

export function parseProductRef(input) {
    const text = String(input ?? '').trim();
    const match = text.match(PRODUCT_ID);
    if (!match) {
        throw new UqError('ARG', 'product must look like E450195-000, 450195, or a uniqlo.com/kr product URL');
    }
    return {
        productId: `E${match[1]}-${match[2] ?? '000'}`,
        priceGroup: text.match(URL_PRICE_GROUP)?.[1] ?? null,
    };
}

// ---------- formatting ----------

export function productUrl(productId, priceGroup = '00') {
    return `${SITE_BASE}/products/${productId}/${priceGroup}`;
}

export function colorLabel(color) {
    return `${color.displayCode} ${color.name}`;
}

export function priceInfo(prices, priceGroup) {
    const originalPrice = prices?.base?.value ?? null;
    const promo = prices?.promo?.value ?? null;
    const promoLower = promo !== null && originalPrice !== null && promo < originalPrice;
    return {
        price: promoLower ? promo : originalPrice,
        originalPrice,
        discounted: promoLower || priceGroup !== '00',
    };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function stripHtml(value) {
    if (value === undefined || value === null) return null;
    const text = String(value)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
            if (name[0] === '#') {
                const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
                return String.fromCodePoint(code);
            }
            return ENTITIES[name.toLowerCase()] ?? entity;
        })
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n');
    return text || null;
}

// ---------- HTTP ----------

export function apiUrl(pathname, params = {}) {
    const url = new URL(API_BASE + pathname);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    url.searchParams.set('httpFailure', 'true');
    return url.toString();
}

const sleep = ms => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve());

// Spaces request starts timing.gapMs apart, even when callers run in parallel.
let nextSlotAt = 0;
async function waitForSlot() {
    const now = Date.now();
    const at = Math.max(now, nextSlotAt);
    nextSlotAt = at + timing.gapMs;
    await sleep(at - now);
}

export async function fetchJson(url) {
    for (let attempt = 0; ; attempt++) {
        await waitForSlot();
        let response;
        try {
            response = await globalThis.fetch(url, {
                headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Accept-Language': 'ko-KR,ko;q=0.9' },
                signal: AbortSignal.timeout(timing.timeoutMs),
            });
        } catch (error) {
            if (attempt === 0) {
                await sleep(timing.retryDelayMs);
                continue;
            }
            throw new UqError('NETWORK', `request failed: ${error.message} (${url})`);
        }
        if (response.status >= 500 && attempt === 0) {
            await sleep(timing.retryDelayMs);
            continue;
        }
        if (response.status === 404) throw new UqError('NOT_FOUND', `not found: ${url}`);
        if (response.status === 403) throw new UqError('BLOCKED', `blocked (HTTP 403): ${url}`);
        if (!response.ok) {
            throw new UqError(response.status >= 500 ? 'NETWORK' : 'BLOCKED', `HTTP ${response.status}: ${url}`);
        }
        let body;
        try {
            body = await response.json();
        } catch {
            throw new UqError('BLOCKED', `non-JSON response: ${url}`);
        }
        if (body?.status !== 'ok') throw new UqError('BLOCKED', `API returned status=${body?.status}: ${url}`);
        return body.result;
    }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test .agents/skills/ask-uniqlo/tests/core.test.mjs`
Expected: PASS (14 tests).

- [ ] **Step 7: Commit**

```bash
git add .agents/skills/ask-uniqlo/lib/core.js .agents/skills/ask-uniqlo/tests/helpers.mjs .agents/skills/ask-uniqlo/tests/core.test.mjs
git commit -m "feat(ask-uniqlo): add HTTP and parsing core" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `search`

**Files:**
- Create: `.agents/skills/ask-uniqlo/lib/search.js`
- Test: `.agents/skills/ask-uniqlo/tests/search.test.mjs`

**Interfaces:**
- Consumes: `UqError`, `apiUrl`, `colorLabel`, `fetchJson`, `priceInfo`, `productUrl`, `requireBoundedInteger` from `lib/core.js`.
- Produces:
  - `searchProducts(query: string, { limit?, offset?, gender?, sort?, sale?: boolean, includeGu?: boolean }) → Promise<{ meta: { query, total, offset, count, hidden }, items: SearchItem[] }>`
  - `SearchItem = { productId, priceGroup, name, brand: 'UNIQLO'|'GU', gender, price, originalPrice, discounted, rating: {average,count}|null, colors: string[], sizes: string[], url }`
  - `GENDER_PATHS`, `SORT_CODES`, `brandOf(name) → 'UNIQLO'|'GU'`, `normalizeSearchItem(item) → SearchItem`

- [ ] **Step 1: Write the failing tests**

`.agents/skills/ask-uniqlo/tests/search.test.mjs`:

```js
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ok, stubFetch, restoreFetch } from './helpers.mjs';
import { searchProducts } from '../lib/search.js';

afterEach(restoreFetch);

function item(overrides = {}) {
    return {
        productId: 'E450195-000',
        priceGroup: '00',
        name: '후리스풀집재킷',
        genderCategory: 'UNISEX',
        prices: { base: { value: 39900 }, promo: null },
        rating: { average: 4.7, count: 996 },
        colors: [{ displayCode: '09', name: 'BLACK' }, { displayCode: '69', name: 'NAVY' }],
        sizes: [{ name: 'S' }, { name: 'M' }],
        ...overrides,
    };
}

const page = (items, total = items.length) => ok({ items, pagination: { total, offset: 0, count: items.length } });

test('search builds the query URL from options', async () => {
    const calls = stubFetch(() => page([item()]));
    await searchProducts('후리스', { limit: '10', offset: '20', gender: 'men', sort: 'price-asc' });
    const url = calls[0].url;
    assert.equal(url.pathname, '/kr/api/commerce/v5/ko/products');
    assert.equal(url.searchParams.get('q'), '후리스');
    assert.equal(url.searchParams.get('limit'), '10');
    assert.equal(url.searchParams.get('offset'), '20');
    assert.equal(url.searchParams.get('path'), '57893');
    assert.equal(url.searchParams.get('sort'), '2');
});

test('search omits sort and path by default and uses limit 20', async () => {
    const calls = stubFetch(() => page([item()]));
    await searchProducts('후리스');
    assert.equal(calls[0].url.searchParams.has('sort'), false);
    assert.equal(calls[0].url.searchParams.has('path'), false);
    assert.equal(calls[0].url.searchParams.get('limit'), '20');
});

test('search normalizes items and reports meta', async () => {
    stubFetch(() => page([item()], 36));
    const out = await searchProducts('후리스');
    assert.deepEqual(out.meta, { query: '후리스', total: 36, offset: 0, count: 1, hidden: 0 });
    assert.deepEqual(out.items[0], {
        productId: 'E450195-000',
        priceGroup: '00',
        name: '후리스풀집재킷',
        brand: 'UNIQLO',
        gender: 'UNISEX',
        price: 39900,
        originalPrice: 39900,
        discounted: false,
        rating: { average: 4.7, count: 996 },
        colors: ['09 BLACK', '69 NAVY'],
        sizes: ['S', 'M'],
        url: 'https://www.uniqlo.com/kr/ko/products/E450195-000/00',
    });
});

test('search hides GU items unless includeGu', async () => {
    const items = [item(), item({ productId: 'E491807-000', name: 'GU 3D배럴레그진' })];
    stubFetch(() => page(items));
    const hidden = await searchProducts('진');
    assert.deepEqual(hidden.items.map(i => i.productId), ['E450195-000']);
    assert.equal(hidden.meta.hidden, 1);
    const shown = await searchProducts('진', { includeGu: true });
    assert.deepEqual(shown.items.map(i => i.brand), ['UNIQLO', 'GU']);
});

test('search sale keeps only discounted rows', async () => {
    const items = [
        item(),
        item({ productId: 'E1', prices: { base: { value: 49900 }, promo: { value: 49900 } } }),
        item({ productId: 'E2', prices: { base: { value: 49900 }, promo: { value: 29900 } } }),
        item({ productId: 'E3', priceGroup: '01' }),
    ];
    stubFetch(() => page(items));
    const out = await searchProducts('진', { sale: true });
    assert.deepEqual(out.items.map(i => i.productId), ['E2', 'E3']);
});

test('search with zero API results is EMPTY', async () => {
    stubFetch(() => page([]));
    await assert.rejects(searchProducts('zzqx'), { code: 'EMPTY' });
});

test('search where filters hide the whole page is EMPTY and says what to try', async () => {
    stubFetch(() => page([item({ name: 'GU 스웨트' })], 50));
    await assert.rejects(
        searchProducts('스웨트'),
        err => err.code === 'EMPTY' && /1 hidden by filters/.test(err.message) && /--offset 20/.test(err.message),
    );
});

test('search validates arguments', async () => {
    stubFetch(() => page([item()]));
    await assert.rejects(searchProducts('  '), { code: 'ARG' });
    await assert.rejects(searchProducts('x', { gender: 'unisex' }), { code: 'ARG' });
    await assert.rejects(searchProducts('x', { gender: 'toString' }), { code: 'ARG' });
    await assert.rejects(searchProducts('x', { sort: 'cheap' }), { code: 'ARG' });
    await assert.rejects(searchProducts('x', { limit: '101' }), { code: 'ARG' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test .agents/skills/ask-uniqlo/tests/search.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/search.js'`.

- [ ] **Step 3: Implement `lib/search.js`**

```js
// `search` command: keyword search over UNIQLO KR products.
import { UqError, apiUrl, colorLabel, fetchJson, priceInfo, productUrl, requireBoundedInteger } from './core.js';

export const GENDER_PATHS = { women: '57892', men: '57893', kids: '57894', baby: '57925' };
export const SORT_CODES = { recommended: '1', 'price-asc': '2', 'price-desc': '3', rating: '4', new: '5' };

function pick(table, value, label) {
    if (value === undefined) return undefined;
    if (!Object.hasOwn(table, value)) {
        throw new UqError('ARG', `${label} must be one of: ${Object.keys(table).join(', ')}`);
    }
    return table[value];
}

export function brandOf(name) {
    return /^GU\s/.test(name ?? '') ? 'GU' : 'UNIQLO';
}

export function normalizeSearchItem(item) {
    return {
        productId: item.productId,
        priceGroup: item.priceGroup,
        name: item.name,
        brand: brandOf(item.name),
        gender: item.genderCategory ?? null,
        ...priceInfo(item.prices, item.priceGroup),
        rating: item.rating ? { average: item.rating.average, count: item.rating.count } : null,
        colors: (item.colors ?? []).map(colorLabel),
        sizes: (item.sizes ?? []).map(size => size.name),
        url: productUrl(item.productId, item.priceGroup),
    };
}

export async function searchProducts(query, { limit, offset, gender, sort, sale = false, includeGu = false } = {}) {
    const q = String(query ?? '').trim();
    if (!q) throw new UqError('ARG', 'search query must not be empty');
    const size = requireBoundedInteger(limit, 20, 1, 100, 'limit');
    const start = requireBoundedInteger(offset, 0, 0, 10000, 'offset');
    const path = pick(GENDER_PATHS, gender, 'gender');
    const sortCode = pick(SORT_CODES, sort, 'sort');

    const result = await fetchJson(apiUrl('/products', { q, limit: size, offset: start, sort: sortCode, path }));
    const all = (result.items ?? []).map(normalizeSearchItem);
    const items = all.filter(item => (includeGu || item.brand !== 'GU') && (!sale || item.discounted));
    const total = result.pagination?.total ?? all.length;

    if (items.length === 0) {
        let message = `no results for "${q}"`;
        if (all.length > 0) {
            message += ` on this page (${all.length} hidden by filters`;
            if (total > start + all.length) message += `; try --offset ${start + size}`;
            if (!includeGu) message += '; or --include-gu';
            message += ')';
        }
        throw new UqError('EMPTY', message);
    }
    return { meta: { query: q, total, offset: start, count: items.length, hidden: all.length - items.length }, items };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test .agents/skills/ask-uniqlo/tests/search.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add .agents/skills/ask-uniqlo/lib/search.js .agents/skills/ask-uniqlo/tests/search.test.mjs
git commit -m "feat(ask-uniqlo): add product search" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `detail` (details + stock + size chart)

**Files:**
- Create: `.agents/skills/ask-uniqlo/lib/detail.js`
- Test: `.agents/skills/ask-uniqlo/tests/detail.test.mjs`

**Interfaces:**
- Consumes: `UqError`, `apiUrl`, `colorLabel`, `fetchJson`, `parseProductRef`, `priceInfo`, `productUrl`, `requirePriceGroup`, `stripHtml` from `lib/core.js`.
- Produces:
  - `getProductDetail(ref: string, { priceGroup?: string, raw?: boolean }) → Promise<Detail>`
  - `Detail = { productId, name, gender, category, rating: {average,count,fit,distribution}|null, priceGroups: PriceGroup[], sizeChart: {garment, body}|null, material, washing, care, notes, description, origin: string[], manufacturingDate, image, url }`
  - `PriceGroup = { priceGroup, price, originalPrice, discounted, url, stock: { [colorLabel]: { inStock: string[], lowStock: string[], soldOut: string[] } }, variants?: Variant[] }`
  - `Variant = { color, size, l2Id, communicationCode, status, quantity, price }`
  - `PRICE_GROUPS`, `normalizeSizeChart(entry) → {garment, body}|null`, `summarizeStock(variants) → stock`

- [ ] **Step 1: Write the failing tests**

`.agents/skills/ask-uniqlo/tests/detail.test.mjs`:

```js
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ok, httpStatus, stubFetch, restoreFetch } from './helpers.mjs';
import { getProductDetail } from '../lib/detail.js';

afterEach(restoreFetch);

const details = {
    productId: 'E450195-000',
    name: '후리스풀집재킷',
    genderCategory: 'UNISEX',
    breadcrumbs: {
        gender: { locale: 'MEN' },
        class: { locale: '아우터' },
        category: { locale: '파카 & 블루종' },
        subcategory: { locale: '후리스' },
    },
    rating: { average: 4.7, count: 996, fit: 3.15, rateCount: { one: 27, two: 8, three: 17, four: 89, five: 855 } },
    prices: { base: { value: 39900 }, promo: null },
    colors: [{ displayCode: '09', name: 'BLACK' }, { displayCode: '69', name: 'NAVY' }],
    sizes: [{ displayCode: '003', name: 'S' }, { displayCode: '004', name: 'M' }, { displayCode: '005', name: 'L' }],
    plds: [{ displayCode: '000', name: '-', display: { showFlag: false } }],
    composition: '몸판: 100% 폴리에스터<br>',
    washingInformation: '세탁기 가능, 드라이클리닝 불가능',
    careInstruction: '- 단독세탁<br>- 세탁망 사용',
    freeInformation: '- XS는 온라인 전용입니다.',
    longDescription: '<br>',
    countriesOfOrigin: [{ code: 'CN' }, { code: 'VN' }],
    manufacturingDate: { localizedDate: '2024. 01' },
    representative: { color: { displayCode: '69' } },
    images: { main: { '09': { image: 'https://img/09.jpg' }, '69': { image: 'https://img/69.jpg' } } },
};

function l2(l2Id, color, size, pld = '000') {
    return {
        l2Id,
        color: { displayCode: color },
        size: { displayCode: size },
        pld: { displayCode: pld },
        communicationCode: `450195-${color}-${size}-${pld}`,
    };
}

const stockPayload = {
    // deliberately out of order; a4 has no stock entry
    l2s: [l2('a3', '69', '005'), l2('a1', '09', '004'), l2('a0', '09', '003'), l2('a2', '09', '005'), l2('a4', '69', '003')],
    stocks: {
        a0: { statusCode: 'IN_STOCK', quantity: 11 },
        a1: { statusCode: 'LOW_STOCK', quantity: 3 },
        a2: { statusCode: 'STOCK_OUT', quantity: 0 },
        a3: { statusCode: 'IN_STOCK', quantity: 8 },
    },
    prices: {
        a0: { base: { value: 39900 }, promo: null },
        a1: { base: { value: 39900 }, promo: null },
        a2: { base: { value: 39900 }, promo: null },
        a3: { base: { value: 39900 }, promo: { value: 29900 } },
    },
};

const sizeCharts = [{
    productId: 'E450195-000',
    sizeChart: [{
        name: 'M',
        sizeParts: [
            { name: '전체 길이', measurements: [{ value: '67.5', unit: 'cm' }, { value: '26 1/2', unit: 'inch' }] },
            { name: '가슴너비', measurements: [{ value: '56', unit: 'cm' }] },
        ],
    }],
    bodyMeasurements: [{ name: 'M', sizeParts: [{ name: '가슴', measurements: [{ value: '88-96', unit: 'cm' }] }] }],
}];

// groups: { '00': detailsPayload, ... }; charts: () => Response
function router({ groups = { '00': details }, stock = stockPayload, charts = () => ok(sizeCharts) } = {}) {
    return url => {
        const group = url.pathname.match(/price-groups\/(\d{2})\/details$/)?.[1];
        if (group) return groups[group] ? ok(groups[group]) : httpStatus(404);
        if (url.pathname.endsWith('/l2s')) return ok(stock);
        if (url.pathname.endsWith('/products/size-charts')) return charts();
        throw new Error(`unexpected request ${url}`);
    };
}

const detailCalls = calls => calls.filter(c => c.url.pathname.endsWith('/details')).map(c => c.url.pathname.match(/groups\/(\d\d)/)[1]);

test('detail returns the merged product for one price group', async () => {
    stubFetch(router());
    const out = await getProductDetail('E450195-000');
    assert.deepEqual(out, {
        productId: 'E450195-000',
        name: '후리스풀집재킷',
        gender: 'UNISEX',
        category: 'MEN > 아우터 > 파카 & 블루종 > 후리스',
        rating: { average: 4.7, count: 996, fit: 3.15, distribution: { one: 27, two: 8, three: 17, four: 89, five: 855 } },
        priceGroups: [{
            priceGroup: '00',
            price: 39900,
            originalPrice: 39900,
            discounted: false,
            url: 'https://www.uniqlo.com/kr/ko/products/E450195-000/00',
            stock: {
                '09 BLACK': { inStock: ['S'], lowStock: ['M'], soldOut: ['L'] },
                '69 NAVY': { inStock: ['L'], lowStock: [], soldOut: ['S'] },
            },
        }],
        sizeChart: {
            garment: { M: { '전체 길이': '67.5cm', 가슴너비: '56cm' } },
            body: { M: { 가슴: '88-96cm' } },
        },
        material: '몸판: 100% 폴리에스터',
        washing: '세탁기 가능, 드라이클리닝 불가능',
        care: '- 단독세탁\n- 세탁망 사용',
        notes: '- XS는 온라인 전용입니다.',
        description: null,
        origin: ['CN', 'VN'],
        manufacturingDate: '2024. 01',
        image: 'https://img/69.jpg',
        url: 'https://www.uniqlo.com/kr/ko/products/E450195-000/00',
    });
});

test('detail probes price groups 00-03 and returns every one that exists', async () => {
    const reduced = { ...details, prices: { base: { value: 29900 }, promo: null } };
    const calls = stubFetch(router({ groups: { '00': details, '01': reduced } }));
    const out = await getProductDetail('450195');
    assert.deepEqual(detailCalls(calls).sort(), ['00', '01', '02', '03']);
    assert.deepEqual(out.priceGroups.map(g => [g.priceGroup, g.price, g.discounted]), [['00', 39900, false], ['01', 29900, true]]);
    assert.equal(calls.filter(c => c.url.pathname.endsWith('/l2s')).length, 2);
    assert.equal(calls.filter(c => c.url.pathname.endsWith('/size-charts')).length, 1);
});

test('detail with priceGroup only asks for that group', async () => {
    const calls = stubFetch(router({ groups: { '00': details, '01': details } }));
    const out = await getProductDetail('E450195-000', { priceGroup: '01' });
    assert.deepEqual(detailCalls(calls), ['01']);
    assert.deepEqual(out.priceGroups.map(g => g.priceGroup), ['01']);
    assert.equal(out.url, 'https://www.uniqlo.com/kr/ko/products/E450195-000/01');
});

test('detail uses the price group from a product URL', async () => {
    const calls = stubFetch(router());
    await getProductDetail('https://www.uniqlo.com/kr/ko/products/E450195-000/00?colorDisplayCode=09');
    assert.deepEqual(detailCalls(calls), ['00']);
});

test('detail is NOT_FOUND when no price group exists', async () => {
    stubFetch(router({ groups: {} }));
    await assert.rejects(getProductDetail('E999999-000'), { code: 'NOT_FOUND' });
});

test('detail propagates a blocked probe instead of treating it as missing', async () => {
    stubFetch(url => (url.pathname.includes('/price-groups/02/') ? httpStatus(403) : router()(url)));
    await assert.rejects(getProductDetail('E450195-000'), { code: 'BLOCKED' });
});

test('detail rejects a malformed price group', async () => {
    stubFetch(router());
    await assert.rejects(getProductDetail('E450195-000', { priceGroup: '1' }), { code: 'ARG' });
});

test('detail labels visible length variants so sizes do not collide', async () => {
    const withLengths = {
        ...details,
        colors: [{ displayCode: '09', name: 'BLACK' }],
        plds: [{ displayCode: '076', name: '76cm', display: { showFlag: true } }, { displayCode: '079', name: '79cm', display: { showFlag: true } }],
    };
    const stock = {
        l2s: [l2('b1', '09', '004', '079'), l2('b0', '09', '004', '076')],
        stocks: { b0: { statusCode: 'IN_STOCK', quantity: 9 }, b1: { statusCode: 'STOCK_OUT', quantity: 0 } },
        prices: {},
    };
    stubFetch(router({ groups: { '00': withLengths }, stock }));
    const out = await getProductDetail('E450195-000', { priceGroup: '00' });
    assert.deepEqual(out.priceGroups[0].stock, { '09 BLACK': { inStock: ['M (76cm)'], lowStock: [], soldOut: ['M (79cm)'] } });
});

test('detail sizeChart is null when the API has no chart or 404s', async () => {
    stubFetch(router({ charts: () => ok([{ productId: 'E450195-000', imageUrl: '', colorCode: '' }]) }));
    assert.equal((await getProductDetail('E450195-000', { priceGroup: '00' })).sizeChart, null);
    stubFetch(router({ charts: () => httpStatus(404) }));
    assert.equal((await getProductDetail('E450195-000', { priceGroup: '00' })).sizeChart, null);
});

test('detail keeps unit-less measurements such as bag capacity', async () => {
    const bag = [{ sizeChart: [{ name: 'FREE', sizeParts: [
        { name: '용량', measurements: [{ value: '22L', unit: '' }] },
        { name: '높이', measurements: [{ value: '19', unit: 'inch' }, { value: '48', unit: 'cm' }] },
    ] }] }];
    stubFetch(router({ charts: () => ok(bag) }));
    const out = await getProductDetail('E450195-000', { priceGroup: '00' });
    assert.deepEqual(out.sizeChart, { garment: { FREE: { 용량: '22L', 높이: '48cm' } }, body: null });
});

test('detail raw adds ordered per-variant rows', async () => {
    stubFetch(router());
    const plain = await getProductDetail('E450195-000', { priceGroup: '00' });
    assert.equal('variants' in plain.priceGroups[0], false);
    const out = await getProductDetail('E450195-000', { priceGroup: '00', raw: true });
    const { variants } = out.priceGroups[0];
    assert.deepEqual(variants.map(v => v.l2Id), ['a0', 'a1', 'a2', 'a4', 'a3']);
    assert.deepEqual(variants[0], {
        color: '09 BLACK', size: 'S', l2Id: 'a0', communicationCode: '450195-09-003-000',
        status: 'IN_STOCK', quantity: 11, price: 39900,
    });
    assert.deepEqual(variants[3], {
        color: '69 NAVY', size: 'S', l2Id: 'a4', communicationCode: '450195-69-003-000',
        status: null, quantity: null, price: null,
    });
    assert.equal(variants[4].price, 29900);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test .agents/skills/ask-uniqlo/tests/detail.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/detail.js'`.

- [ ] **Step 3: Implement `lib/detail.js`**

```js
// `detail` command: product details + per-color/size online stock + size chart.
import {
    UqError, apiUrl, colorLabel, fetchJson, parseProductRef, priceInfo, productUrl, requirePriceGroup, stripHtml,
} from './core.js';

// `productIds=` lookups only return group 00, so other groups are found by probing.
export const PRICE_GROUPS = ['00', '01', '02', '03'];
const STOCK_BUCKETS = { IN_STOCK: 'inStock', LOW_STOCK: 'lowStock' };

async function findPriceGroups(productId, only) {
    const found = await Promise.all((only ? [only] : PRICE_GROUPS).map(async priceGroup => {
        try {
            return { priceGroup, details: await fetchJson(apiUrl(`/products/${productId}/price-groups/${priceGroup}/details`)) };
        } catch (error) {
            if (error.code === 'NOT_FOUND') return null;
            throw error;
        }
    }));
    const groups = found.filter(Boolean);
    if (groups.length === 0) {
        throw new UqError('NOT_FOUND', `product ${productId} not found${only ? ` in price group ${only}` : ''}`);
    }
    return groups;
}

function measurementText(measurements = []) {
    const measurement = measurements.find(m => m.unit === 'cm') ?? measurements[0];
    return measurement ? `${measurement.value}${measurement.unit ?? ''}` : null;
}

function sizeTable(rows) {
    if (!rows?.length) return null;
    return Object.fromEntries(rows.map(row => [
        row.name,
        Object.fromEntries((row.sizeParts ?? []).map(part => [part.name, measurementText(part.measurements)])),
    ]));
}

export function normalizeSizeChart(entry) {
    const garment = sizeTable(entry?.sizeChart);
    const body = sizeTable(entry?.bodyMeasurements);
    return garment || body ? { garment, body } : null;
}

async function fetchSizeChart(productId) {
    try {
        const result = await fetchJson(apiUrl('/products/size-charts', {
            productIdsWithColorCode: productId,
            includeBodyMeasurements: 'true',
        }));
        return normalizeSizeChart(Array.isArray(result) ? result[0] : null);
    } catch (error) {
        if (error.code === 'NOT_FOUND') return null;
        throw error;
    }
}

function variantRows(details, stockPayload, priceGroup) {
    const colors = details.colors ?? [];
    const sizes = details.sizes ?? [];
    const colorIndex = new Map(colors.map((color, i) => [color.displayCode, i]));
    const sizeIndex = new Map(sizes.map((size, i) => [size.displayCode, i]));
    const colorNames = new Map(colors.map(color => [color.displayCode, colorLabel(color)]));
    const sizeNames = new Map(sizes.map(size => [size.displayCode, size.name]));
    const lengthNames = new Map((details.plds ?? []).filter(p => p.display?.showFlag).map(p => [p.displayCode, p.name]));
    const rank = (index, key) => index.get(key) ?? Number.MAX_SAFE_INTEGER;

    return [...(stockPayload.l2s ?? [])]
        .sort((a, b) => rank(colorIndex, a.color.displayCode) - rank(colorIndex, b.color.displayCode)
            || rank(sizeIndex, a.size.displayCode) - rank(sizeIndex, b.size.displayCode)
            || String(a.pld?.displayCode).localeCompare(String(b.pld?.displayCode)))
        .map(l2 => {
            const stock = stockPayload.stocks?.[l2.l2Id];
            const sizeName = sizeNames.get(l2.size.displayCode) ?? l2.size.displayCode;
            const length = lengthNames.get(l2.pld?.displayCode);
            return {
                color: colorNames.get(l2.color.displayCode) ?? l2.color.displayCode,
                size: length ? `${sizeName} (${length})` : sizeName,
                l2Id: l2.l2Id,
                communicationCode: l2.communicationCode ?? null,
                status: stock?.statusCode ?? null,
                quantity: stock?.quantity ?? null,
                price: priceInfo(stockPayload.prices?.[l2.l2Id], priceGroup).price,
            };
        });
}

export function summarizeStock(variants) {
    const stock = {};
    for (const variant of variants) {
        stock[variant.color] ??= { inStock: [], lowStock: [], soldOut: [] };
        const bucket = Object.hasOwn(STOCK_BUCKETS, variant.status ?? '') ? STOCK_BUCKETS[variant.status] : 'soldOut';
        stock[variant.color][bucket].push(variant.size);
    }
    return stock;
}

export async function getProductDetail(ref, { priceGroup, raw = false } = {}) {
    const parsed = parseProductRef(ref);
    const only = priceGroup !== undefined ? requirePriceGroup(priceGroup) : parsed.priceGroup;
    const { productId } = parsed;

    const groups = await findPriceGroups(productId, only);
    const [stockPayloads, sizeChart] = await Promise.all([
        Promise.all(groups.map(group => fetchJson(apiUrl(`/products/${productId}/price-groups/${group.priceGroup}/l2s`, {
            withPrices: 'true',
            withStocks: 'true',
        })))),
        fetchSizeChart(productId),
    ]);

    const base = groups[0].details;
    const crumbs = base.breadcrumbs ?? {};
    const mainImages = base.images?.main ?? {};
    const representative = base.representative?.color?.displayCode;
    const rating = base.rating;

    return {
        productId,
        name: base.name,
        gender: base.genderCategory ?? null,
        category: ['gender', 'class', 'category', 'subcategory'].map(key => crumbs[key]?.locale).filter(Boolean).join(' > ') || null,
        rating: rating
            ? { average: rating.average, count: rating.count, fit: rating.fit ?? null, distribution: rating.rateCount ?? null }
            : null,
        priceGroups: groups.map((group, i) => {
            const variants = variantRows(group.details, stockPayloads[i], group.priceGroup);
            return {
                priceGroup: group.priceGroup,
                ...priceInfo(group.details.prices, group.priceGroup),
                url: productUrl(productId, group.priceGroup),
                stock: summarizeStock(variants),
                ...(raw ? { variants } : {}),
            };
        }),
        sizeChart,
        material: stripHtml(base.composition),
        washing: stripHtml(base.washingInformation),
        care: stripHtml(base.careInstruction),
        notes: stripHtml(base.freeInformation),
        description: stripHtml(base.longDescription),
        origin: (base.countriesOfOrigin ?? []).map(country => country.code),
        manufacturingDate: base.manufacturingDate?.localizedDate || null,
        image: mainImages[representative]?.image ?? Object.values(mainImages)[0]?.image ?? null,
        url: productUrl(productId, groups[0].priceGroup),
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test .agents/skills/ask-uniqlo/tests/detail.test.mjs`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add .agents/skills/ask-uniqlo/lib/detail.js .agents/skills/ask-uniqlo/tests/detail.test.mjs
git commit -m "feat(ask-uniqlo): add product detail with stock and size chart" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `reviews`

**Files:**
- Create: `.agents/skills/ask-uniqlo/lib/reviews.js`
- Test: `.agents/skills/ask-uniqlo/tests/reviews.test.mjs`

**Interfaces:**
- Consumes: `UqError`, `apiUrl`, `fetchJson`, `parseProductRef`, `requireBoundedInteger` from `lib/core.js`.
- Produces:
  - `getReviews(ref: string, { limit?, offset?, sort?: 'new'|'rating' }) → Promise<{ meta: { productId, total, offset, count, rating }, items: Review[] }>`
  - `Review = { rate, title, comment, purchasedSize, purchasedColor, fit, height, weight, gender, helpfulCount, date }` (`date` = `YYYY-MM-DD`, UTC)
  - `REVIEW_SORTS`, `normalizeReview(review) → Review`

- [ ] **Step 1: Write the failing tests**

`.agents/skills/ask-uniqlo/tests/reviews.test.mjs`:

```js
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ok, stubFetch, restoreFetch } from './helpers.mjs';
import { getReviews } from '../lib/reviews.js';

afterEach(restoreFetch);

const review = {
    rate: 5,
    title: '이거나오는날만 기다렸어요',
    comment: '따듯해요\n2사이즈 업하세요\n',
    purchasedSize: '3XL',
    purchasedColorName: '08 DARK GRAY',
    fit: 3,
    heightRange: '181 ~ 185cm',
    weightRange: '',
    gender: '남성',
    location: '-',
    name: '-',
    helpfulCount: 2,
    createDate: 1789535198,
};

const rating = { average: 4.7, count: 996, fit: 3.15, rateCount: { one: 27, two: 8, three: 17, four: 89, five: 855 } };
const payload = reviews => ok({ reviews, rating, pagination: { total: 996, offset: 0, count: reviews.length } });

test('reviews requests the product review endpoint with defaults', async () => {
    const calls = stubFetch(() => payload([review]));
    await getReviews('https://www.uniqlo.com/kr/ko/products/E450195-000/01');
    const url = calls[0].url;
    assert.equal(url.pathname, '/kr/api/commerce/v5/ko/products/E450195-000/reviews');
    assert.equal(url.searchParams.get('limit'), '10');
    assert.equal(url.searchParams.get('offset'), '0');
    assert.equal(url.searchParams.get('sort'), 'submission_time');
});

test('reviews maps sort=rating to the API value', async () => {
    const calls = stubFetch(() => payload([review]));
    await getReviews('E450195-000', { sort: 'rating', limit: '5', offset: '10' });
    assert.equal(calls[0].url.searchParams.get('sort'), 'rating');
    assert.equal(calls[0].url.searchParams.get('limit'), '5');
    assert.equal(calls[0].url.searchParams.get('offset'), '10');
});

test('reviews normalizes rows and meta', async () => {
    stubFetch(() => payload([review]));
    const out = await getReviews('E450195-000');
    assert.deepEqual(out.meta, {
        productId: 'E450195-000',
        total: 996,
        offset: 0,
        count: 1,
        rating: { average: 4.7, count: 996, fit: 3.15, distribution: { one: 27, two: 8, three: 17, four: 89, five: 855 } },
    });
    assert.deepEqual(out.items[0], {
        rate: 5,
        title: '이거나오는날만 기다렸어요',
        comment: '따듯해요\n2사이즈 업하세요',
        purchasedSize: '3XL',
        purchasedColor: '08 DARK GRAY',
        fit: 3,
        height: '181 ~ 185cm',
        weight: null,
        gender: '남성',
        helpfulCount: 2,
        date: '2026-09-16',
    });
});

test('reviews with no rows is EMPTY', async () => {
    stubFetch(() => payload([]));
    await assert.rejects(getReviews('E450195-000'), { code: 'EMPTY' });
});

test('reviews validates arguments', async () => {
    stubFetch(() => payload([review]));
    await assert.rejects(getReviews('E450195-000', { sort: 'helpful' }), { code: 'ARG' });
    await assert.rejects(getReviews('E450195-000', { limit: '51' }), { code: 'ARG' });
    await assert.rejects(getReviews('nope'), { code: 'ARG' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test .agents/skills/ask-uniqlo/tests/reviews.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/reviews.js'`.

- [ ] **Step 3: Implement `lib/reviews.js`**

```js
// `reviews` command: customer reviews for one product (not tied to a price group).
import { UqError, apiUrl, fetchJson, parseProductRef, requireBoundedInteger } from './core.js';

// Only the sort values the API was observed to accept; others return status "nok".
export const REVIEW_SORTS = { new: 'submission_time', rating: 'rating' };

const blank = value => (value === undefined || value === null || String(value).trim() === '' || value === '-' ? null : value);

export function normalizeReview(review) {
    return {
        rate: review.rate ?? null,
        title: blank(review.title),
        comment: blank(review.comment?.trim()),
        purchasedSize: blank(review.purchasedSize),
        purchasedColor: blank(review.purchasedColorName),
        fit: review.fit ?? null,
        height: blank(review.heightRange),
        weight: blank(review.weightRange),
        gender: blank(review.gender),
        helpfulCount: review.helpfulCount ?? 0,
        date: review.createDate ? new Date(review.createDate * 1000).toISOString().slice(0, 10) : null,
    };
}

export async function getReviews(ref, { limit, offset, sort = 'new' } = {}) {
    const { productId } = parseProductRef(ref);
    const size = requireBoundedInteger(limit, 10, 1, 50, 'limit');
    const start = requireBoundedInteger(offset, 0, 0, 100000, 'offset');
    if (!Object.hasOwn(REVIEW_SORTS, sort)) {
        throw new UqError('ARG', `sort must be one of: ${Object.keys(REVIEW_SORTS).join(', ')}`);
    }

    const result = await fetchJson(apiUrl(`/products/${productId}/reviews`, { limit: size, offset: start, sort: REVIEW_SORTS[sort] }));
    const items = (result.reviews ?? []).map(normalizeReview);
    if (items.length === 0) throw new UqError('EMPTY', `no reviews for ${productId}${start ? ` at offset ${start}` : ''}`);

    const rating = result.rating;
    return {
        meta: {
            productId,
            total: result.pagination?.total ?? items.length,
            offset: start,
            count: items.length,
            rating: rating
                ? { average: rating.average, count: rating.count, fit: rating.fit ?? null, distribution: rating.rateCount ?? null }
                : null,
        },
        items,
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test .agents/skills/ask-uniqlo/tests/reviews.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add .agents/skills/ask-uniqlo/lib/reviews.js .agents/skills/ask-uniqlo/tests/reviews.test.mjs
git commit -m "feat(ask-uniqlo): add product reviews" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: CLI entry point

**Files:**
- Create: `.agents/skills/ask-uniqlo/lib/cli.js`
- Create: `.agents/skills/ask-uniqlo/scripts/uq.mjs`
- Test: `.agents/skills/ask-uniqlo/tests/cli.test.mjs`

**Interfaces:**
- Consumes: `UqError` (core), `searchProducts` (Task 2), `getProductDetail` (Task 3), `getReviews` (Task 4).
- Produces:
  - `run(argv: string[]) → Promise<object>` — throws `UqError`
  - `main(argv?: string[], { stdout?, stderr? }) → Promise<number>` (exit code; writes JSON)
  - `EXIT_CODES = { ARG: 2, EMPTY: 3, NOT_FOUND: 4, BLOCKED: 5, NETWORK: 1 }`, `USAGE: string`
  - CLI: `node scripts/uq.mjs search|detail|reviews …`

- [ ] **Step 1: Write the failing tests**

`.agents/skills/ask-uniqlo/tests/cli.test.mjs`:

```js
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, stubFetch, restoreFetch } from './helpers.mjs';
import { main, run } from '../lib/cli.js';

afterEach(restoreFetch);

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sink() {
    const stream = { text: '', write(chunk) { stream.text += chunk; } };
    return stream;
}

function runScript(scriptPath, args) {
    return new Promise(resolve => {
        execFile(process.execPath, [scriptPath, ...args], (error, stdout, stderr) => {
            resolve({ code: error ? error.code : 0, stdout, stderr });
        });
    });
}

const searchPage = () => ok({
    items: [{ productId: 'E1', priceGroup: '00', name: '울트라라이트다운', prices: { base: { value: 79900 }, promo: null } }],
    pagination: { total: 1, offset: 0, count: 1 },
});

test('search joins unquoted words into one query', async () => {
    const calls = stubFetch(searchPage);
    await run(['search', '울트라', '라이트', '다운', '--limit', '5']);
    assert.equal(calls[0].url.searchParams.get('q'), '울트라 라이트 다운');
    assert.equal(calls[0].url.searchParams.get('limit'), '5');
});

test('search passes boolean flags through', async () => {
    stubFetch(searchPage);
    await assert.rejects(run(['search', '다운', '--sale']), { code: 'EMPTY' });
});

test('argument errors are ARG', async () => {
    await assert.rejects(run([]), { code: 'ARG' });
    await assert.rejects(run(['buy', 'x']), { code: 'ARG' });
    await assert.rejects(run(['search']), { code: 'ARG' });
    await assert.rejects(run(['detail', 'E450195-000', 'E450196-000']), { code: 'ARG' });
    await assert.rejects(run(['detail', 'E450195-000', '--color', '09']), { code: 'ARG' });
    await assert.rejects(run(['reviews']), { code: 'ARG' });
});

test('main prints JSON on success and returns 0', async () => {
    stubFetch(searchPage);
    const stdout = sink();
    const stderr = sink();
    assert.equal(await main(['search', '다운'], { stdout, stderr }), 0);
    assert.equal(JSON.parse(stdout.text).items[0].productId, 'E1');
    assert.equal(stderr.text, '');
});

test('main prints an error object and maps the exit code', async () => {
    stubFetch(() => ok({ items: [], pagination: { total: 0, offset: 0, count: 0 } }));
    const stdout = sink();
    const stderr = sink();
    assert.equal(await main(['search', 'zzqx'], { stdout, stderr }), 3);
    assert.equal(stdout.text, '');
    assert.equal(JSON.parse(stderr.text).error.code, 'EMPTY');
});

test('main reports unexpected errors as INTERNAL with exit 1', async () => {
    stubFetch(() => ok(null));
    const stderr = sink();
    assert.equal(await main(['search', '다운'], { stdout: sink(), stderr }), 1);
    assert.equal(JSON.parse(stderr.text).error.code, 'INTERNAL');
});

test('the script exits 2 with a JSON error for bad arguments', async () => {
    const { code, stdout, stderr } = await runScript(path.join(SKILL_DIR, 'scripts/uq.mjs'), ['detail']);
    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.equal(JSON.parse(stderr).error.code, 'ARG');
});

test('the script works when the skill folder is reached through a symlink', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ask-uniqlo-'));
    try {
        const link = path.join(dir, 'ask-uniqlo');
        symlinkSync(SKILL_DIR, link, 'dir');
        const { code, stderr } = await runScript(path.join(link, 'scripts/uq.mjs'), ['bogus']);
        assert.equal(code, 2);
        assert.equal(JSON.parse(stderr).error.code, 'ARG');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
```

Note: `ok(null)` makes `result.items` throw a `TypeError` inside `searchProducts`, which is the "unexpected error" path.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test .agents/skills/ask-uniqlo/tests/cli.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/cli.js'`.

- [ ] **Step 3: Implement `lib/cli.js`**

```js
// Argument parsing and error → exit-code mapping for scripts/uq.mjs.
import { parseArgs } from 'node:util';
import { UqError } from './core.js';
import { searchProducts } from './search.js';
import { getProductDetail } from './detail.js';
import { getReviews } from './reviews.js';

export const EXIT_CODES = { ARG: 2, EMPTY: 3, NOT_FOUND: 4, BLOCKED: 5, NETWORK: 1 };

export const USAGE = `usage:
  uq.mjs search <검색어...> [--limit <1-100>] [--offset <n>] [--gender men|women|kids|baby]
                           [--sort recommended|price-asc|price-desc|rating|new] [--sale] [--include-gu]
  uq.mjs detail <productId|URL> [--pg <00-03>] [--raw]
  uq.mjs reviews <productId|URL> [--limit <1-50>] [--offset <n>] [--sort new|rating]`;

const COMMANDS = {
    search: {
        options: {
            limit: { type: 'string' },
            offset: { type: 'string' },
            gender: { type: 'string' },
            sort: { type: 'string' },
            sale: { type: 'boolean' },
            'include-gu': { type: 'boolean' },
        },
        arity: [1, Infinity],
        run: (positionals, values) => searchProducts(positionals.join(' '), {
            limit: values.limit,
            offset: values.offset,
            gender: values.gender,
            sort: values.sort,
            sale: values.sale,
            includeGu: values['include-gu'],
        }),
    },
    detail: {
        options: { pg: { type: 'string' }, raw: { type: 'boolean' } },
        arity: [1, 1],
        run: ([ref], values) => getProductDetail(ref, { priceGroup: values.pg, raw: values.raw }),
    },
    reviews: {
        options: { limit: { type: 'string' }, offset: { type: 'string' }, sort: { type: 'string' } },
        arity: [1, 1],
        run: ([ref], values) => getReviews(ref, { limit: values.limit, offset: values.offset, sort: values.sort }),
    },
};

export async function run([command, ...args] = []) {
    if (!Object.hasOwn(COMMANDS, command ?? '')) {
        throw new UqError('ARG', `unknown command: ${command ?? '(none)'}\n${USAGE}`);
    }
    const spec = COMMANDS[command];
    let parsed;
    try {
        parsed = parseArgs({ args, options: spec.options, allowPositionals: true, strict: true });
    } catch (error) {
        throw new UqError('ARG', `${error.message}\n${USAGE}`);
    }
    const { values, positionals } = parsed;
    const [minimum, maximum] = spec.arity;
    if (positionals.length < minimum || positionals.length > maximum) {
        throw new UqError('ARG', `${command}: wrong number of arguments\n${USAGE}`);
    }
    return spec.run(positionals, values);
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
    try {
        const output = await run(argv);
        stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        return 0;
    } catch (error) {
        const code = error instanceof UqError ? error.code : 'INTERNAL';
        stderr.write(`${JSON.stringify({ error: { code, message: error.message } })}\n`);
        return EXIT_CODES[code] ?? 1;
    }
}
```

- [ ] **Step 4: Implement `scripts/uq.mjs`**

```js
#!/usr/bin/env node
// Standalone UNIQLO KR reader for the ask-uniqlo skill. Needs only Node 18+ (built-in fetch).
//   node uq.mjs search <검색어...> [--limit N] [--offset N] [--gender G] [--sort S] [--sale] [--include-gu]
//   node uq.mjs detail <productId|URL> [--pg 00] [--raw]
//   node uq.mjs reviews <productId|URL> [--limit N] [--offset N] [--sort new|rating]
// Prints JSON on stdout. On failure prints {"error":{code,message}} on stderr.
import { main } from '../lib/cli.js';

process.exitCode = await main();
```

Then: `chmod +x .agents/skills/ask-uniqlo/scripts/uq.mjs`

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test .agents/skills/ask-uniqlo/tests/cli.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 6: Run the whole offline suite**

Run: `node --test .agents/skills/ask-uniqlo/tests/*.test.mjs`
Expected: PASS (46 tests, 0 fail).

- [ ] **Step 7: Commit**

```bash
git add .agents/skills/ask-uniqlo/lib/cli.js .agents/skills/ask-uniqlo/scripts/uq.mjs .agents/skills/ask-uniqlo/tests/cli.test.mjs
git commit -m "feat(ask-uniqlo): add uq.mjs CLI entry point" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: SKILL.md, Claude Code link, live smoke test

**Files:**
- Create: `.agents/skills/ask-uniqlo/SKILL.md`
- Create: `.agents/skills/ask-uniqlo/tests/smoke.sh`
- Create: `.claude/skills/ask-uniqlo` (symlink → `../../.agents/skills/ask-uniqlo`)

**Interfaces:**
- Consumes: the CLI from Task 5 (`node <skill-dir>/scripts/uq.mjs …`) and its JSON shapes from Tasks 2–4.
- Produces: a skill Claude Code discovers as `ask-uniqlo`.

- [ ] **Step 1: Write the live smoke test**

`.agents/skills/ask-uniqlo/tests/smoke.sh`:

```bash
#!/usr/bin/env bash
# Live checks against www.uniqlo.com/kr. Run manually; needs network.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UQ=(node "${DIR}/scripts/uq.mjs")
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }
# js '<arrow fn>' — apply a JS function to the JSON on stdin and print the result.
js() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(eval(process.argv[1])(JSON.parse(s))))' "$1"; }

n=$("${UQ[@]}" search 후리스 --limit 5 | js 'o=>o.items.length'); [ "$n" -ge 1 ] && pass "search ($n items)" || fail "search"
w=$("${UQ[@]}" search 후리스 --gender men --limit 40 | js 'o=>o.items.filter(i=>i.gender==="WOMEN").length'); [ "$w" -eq 0 ] && pass "gender filter" || fail "gender filter: $w WOMEN rows"
g=$("${UQ[@]}" search 청바지 --limit 40 | js 'o=>o.items.filter(i=>i.brand==="GU").length'); [ "$g" -eq 0 ] && pass "GU excluded" || fail "GU excluded: $g GU rows"
detail=$("${UQ[@]}" detail E450195-000)
m=$(echo "$detail" | js 'o=>Object.keys(o.sizeChart?.garment??{}).length'); [ "$m" -ge 3 ] && pass "detail size chart ($m sizes)" || fail "detail size chart"
s=$(echo "$detail" | js 'o=>Object.keys(o.priceGroups[0].stock).length'); [ "$s" -ge 1 ] && pass "detail stock ($s colors)" || fail "detail stock"
r=$("${UQ[@]}" reviews E450195-000 --limit 5 | js 'o=>o.items.length'); [ "$r" -ge 1 ] && pass "reviews ($r rows)" || fail "reviews"
set +e; "${UQ[@]}" detail E999999-000 >/dev/null 2>&1; code=$?; set -e
[ "$code" -eq 4 ] && pass "missing product exits 4" || fail "missing product exit $code"
set +e; "${UQ[@]}" search 존재하지않는검색어zzqx >/dev/null 2>&1; code=$?; set -e
[ "$code" -eq 3 ] && pass "zero results exits 3" || fail "zero results exit $code"
echo "All smoke checks passed."
```

Then: `chmod +x .agents/skills/ask-uniqlo/tests/smoke.sh`

- [ ] **Step 2: Run the smoke test**

Run: `bash .agents/skills/ask-uniqlo/tests/smoke.sh`
Expected: eight `PASS:` lines then `All smoke checks passed.` If a check fails because the live catalogue changed (for example E450195-000 is delisted → exit 4), pick a current product with `node .agents/skills/ask-uniqlo/scripts/uq.mjs search 후리스 --limit 3` and substitute its `productId` in the script; do not loosen the assertions.

- [ ] **Step 3: Write `SKILL.md`**

`.agents/skills/ask-uniqlo/SKILL.md`:

````markdown
---
name: ask-uniqlo
description: >
  MUST USE when the user wants to search UNIQLO Korea (유니클로, uniqlo.com/kr) products or check a
  UNIQLO product's price, discount, online stock by color/size, size chart (실측), material, care, or reviews —
  e.g. "유니클로 후리스 찾아줘", "유니클로 X 가격/할인 얼마야", "이 유니클로 상품 M 재고 있어?",
  "유니클로 X 실측 알려줘", "유니클로 X 리뷰 어때?", "/ask-uniqlo <키워드>".
  Only UNIQLO KR official data (GU excluded unless asked). Not for Musinsa (use the project's clot/opencli tools).
---

# ask-uniqlo — 유니클로 KR 상품 검색·상세 조회

유니클로 KR 공식 API를 HTTPS로 직접 호출하는 CLI(`scripts/uq.mjs`)로 상품 검색, 가격·할인, 컬러×사이즈 온라인 재고, 실측 사이즈표, 소재·세탁 정보, 리뷰를 가져와 비교표로 보고합니다.

## 원칙

1. **공식 데이터만**: 유니클로 KR API 결과만 사용합니다. 결과에 없는 정보(매장 재고, 다른 쇼핑몰 가격, 추측한 실측)는 만들지 않습니다.
2. **조회 시점 명시**: 가격·재고는 조회 시점 값입니다. 보고서에 조회 시각을 적습니다.
3. **온라인 재고만**: 매장 재고는 지원하지 않습니다. 물어보면 온라인 재고만 확인 가능하다고 답합니다.
4. **GU 제외가 기본**: 사용자가 GU를 원할 때만 `--include-gu`를 붙입니다.

## 0. 실행 환경

- 요구 사항: Node.js 18 이상. 브라우저·로그인·npm 설치가 필요 없습니다.
- 아래 `<skill-dir>`는 이 스킬의 Base directory입니다.
- 성공 시 stdout에 JSON, 실패 시 stderr에 `{"error":{"code","message"}}`.

| 종료 코드 | code | 의미 | 대응 |
| :--- | :--- | :--- | :--- |
| 0 | - | 성공 | - |
| 2 | `ARG` | 인자 오류 | 명령을 고쳐 다시 실행 |
| 3 | `EMPTY` | 결과 0건 (필터로 모두 숨겨진 경우 포함) | 메시지의 `--offset` / `--include-gu` 제안을 따르거나 검색어를 완화해 1회 재시도 |
| 4 | `NOT_FOUND` | 상품 없음 | 상품 ID 재확인, search로 다시 찾기 |
| 5 | `BLOCKED` | 403 또는 비정상 응답 | 잠시 후 1회 재시도, 계속되면 사용자에게 알림 |
| 1 | `NETWORK` / `INTERNAL` | 네트워크 오류 / 예기치 못한 오류 | 1회 재시도, 계속되면 메시지 그대로 보고 |

동작 확인: `node --test <skill-dir>/tests/*.test.mjs` (오프라인), `bash <skill-dir>/tests/smoke.sh` (실제 사이트)

## 1. 명령

```bash
# 검색 (여러 단어는 따옴표 없이 써도 됨)
node <skill-dir>/scripts/uq.mjs search <검색어...> [--limit 1-100 (기본 20)] [--offset N]
    [--gender men|women|kids|baby] [--sort recommended|price-asc|price-desc|rating|new]
    [--sale] [--include-gu]

# 상세: 가격(모든 가격 그룹) + 컬러별 재고 + 실측표 + 소재·세탁·원산지
node <skill-dir>/scripts/uq.mjs detail <productId|상품URL> [--pg 00] [--raw]

# 리뷰
node <skill-dir>/scripts/uq.mjs reviews <productId|상품URL> [--limit 1-50 (기본 10)] [--offset N] [--sort new|rating]
```

- `productId`는 `E450195-000`, `450195`, 상품 URL 모두 받습니다.
- `--gender men`은 UNISEX 상품도 포함합니다.
- **priceGroup**: 같은 상품이 `00`(정상가)과 `01` 등(가격 인하) 그룹으로 따로 존재할 수 있습니다. search는 그룹별로 한 줄씩, detail은 존재하는 그룹을 모두 `priceGroups`에 담습니다.
- `discounted: true`는 실제 할인가가 정가보다 낮거나 가격 그룹이 `00`이 아닌 경우입니다. `originalPrice`가 이미 인하된 값일 수 있으니, 할인 폭은 같은 상품의 `00` 그룹 가격과 비교해 설명합니다.
- detail의 `stock`은 컬러마다 `inStock`(재고 있음) / `lowStock`(재고 적음) / `soldOut`(품절) 사이즈 목록입니다. 수량이 필요하면 `--raw`.
- `sizeChart.garment`는 제품 실측, `sizeChart.body`는 권장 신체 치수입니다. 실측이 없는 상품은 `null`.

## 2. 워크플로우

1. **검색**: 사용자의 요청에서 검색어·성별·정렬·할인 여부를 뽑아 `search`를 실행합니다. `EMPTY`면 검색어를 더 일반적인 단어로 바꿔 1회만 재시도합니다(예: "오버핏 후리스 집업" → "후리스").
2. **후보 선정**: 요청에 가장 맞는 상품 1–3개를 고릅니다. 같은 이름이 여러 개면 가격·성별·평점으로 구분해 고릅니다.
3. **상세 조회**: 고른 상품마다 `detail`을 실행합니다.
4. **리뷰 (조건부)**: 사용자가 착용감·사이즈 선택·품질을 물을 때만 `reviews --limit 20`을 실행합니다. 구매 사이즈와 키·몸무게, `fit` 점수(1 작음 ~ 5 큼, 3이 정사이즈)를 사이즈 조언에 사용합니다.
5. **보고서 작성**: 아래 형식을 따릅니다.

사용자가 자기 치수(예: 가슴둘레 100cm, 평소 L)를 말하면 `sizeChart`와 비교해 맞는 사이즈를 제안합니다. 치수를 말하지 않았으면 추측하지 않습니다.

## 3. 보고서 형식

```markdown
## 유니클로 "<검색어>" 조회 결과 (<YYYY-MM-DD HH:mm> 기준)

| 상품 | 가격 | 평점 | 재고 있는 사이즈 | 핵심 실측 (M 기준) |
| :--- | :--- | :--- | :--- | :--- |
| [후리스풀집재킷](URL) E450195-000 | ₩39,900 | ★4.7 (996) | BLACK: S·M·L / NAVY: L | 총장 67.5 · 가슴너비 56 · 소매 82 |
| [상품명](URL) | ~~₩49,900~~ **₩29,900** (가격 인하) | ... | ... | ... |

### <상품명>
- 소재: ...
- 세탁: ... (주의사항 한 줄 요약)
- 원산지 / 제조: CN·VN / 2024. 01
- 참고: <notes 중 중요한 것, 예: "XS·XXL은 온라인 전용">
- 리뷰 요약 (조회한 경우): 핏 경향, 사이즈 조언, 대표 리뷰 1–2개 인용
```

- 재고 칸에는 `inStock`과 `lowStock`만 적고, `lowStock`은 "(적음)"으로 표시합니다. 모두 품절이면 "온라인 품절".
- 실측 칸은 사용자가 말한 사이즈, 없으면 M(또는 FREE) 기준으로 2–3개 부위만 적습니다. 전체 표가 필요하면 상품별 섹션에 표로 추가합니다.
````

- [ ] **Step 4: Link the skill into Claude Code's project skills folder**

```bash
mkdir -p .claude/skills
ln -s ../../.agents/skills/ask-uniqlo .claude/skills/ask-uniqlo
```

Verify:

```bash
ls -l .claude/skills/ask-uniqlo
head -3 .claude/skills/ask-uniqlo/SKILL.md
node .claude/skills/ask-uniqlo/scripts/uq.mjs search 후리스 --limit 1
```

Expected: the `ls` line shows `-> ../../.agents/skills/ask-uniqlo`; `head` prints `---` / `name: ask-uniqlo`; the search prints a JSON object with one item.

- [ ] **Step 5: Run the full offline suite once more**

Run: `node --test .agents/skills/ask-uniqlo/tests/*.test.mjs`
Expected: PASS (46 tests, 0 fail).

- [ ] **Step 6: Commit**

```bash
git add .agents/skills/ask-uniqlo/SKILL.md .agents/skills/ask-uniqlo/tests/smoke.sh .claude/skills/ask-uniqlo
git commit -m "feat(ask-uniqlo): add skill instructions, smoke test, and Claude Code link" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Confirm nothing else was staged**

Run: `git show --stat HEAD~5..HEAD`
Expected: only paths under `.agents/skills/ask-uniqlo/` and `.claude/skills/ask-uniqlo`; no `data/` files.
