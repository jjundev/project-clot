# 좋아요 목록 동기화 HTTPS화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `syncLikedItemsFromMusinsa`가 캐시된 인증 쿠키로 무신사 좋아요 API를 HTTPS로 직접 읽고, 목록이 불완전하면 OpenCLI로 폴백하게 한다. deferred(Mac 수면) 실행에서도 좋아요 동기화를 한다.

**Architecture:** 새 모듈 `src/likes-https.js`는 좋아요 목록 전체를 가져오고, 전체 개수와 맞지 않거나 스키마가 다르면 던진다. `src/sync.js`는 세션 제공자로 쿠키를 받아 HTTPS를 먼저 시도한다. 401이면 refresh 후 한 번 더 시도하고, 실패하면 OpenCLI로 폴백한다. 이후의 DB 반영과 안전 가드는 그대로 둔다. `src/collector.js`는 `likesSynced`를 받아 deferred 실행을 `'full'`로 기록할 수 있게 하고, `src/cli.js`가 이것들을 연결한다.

**Tech Stack:** Node 24 ESM, 의존성 없음, `node:test`, `node:sqlite`, 전역 `fetch`.

**Spec:** `docs/plans/2026-09-26-https-likes-sync-design.md` (결정표 #1–#14, #10은 사용자 확정)

## Global Constraints

- `node src/cli.js daily`(`--force` 포함)나 `node src/cli.js sync`로 검증하지 않는다. 검증은 `npm test`, `node src/cli.js power-status`, 일회성 `node -e`로 한다.
- 쿠키·토큰 값, 커서 쿼리를 로그, 에러 메시지, 테스트 출력에 남기지 않는다. 이름, 불리언, 상태 코드, URL **경로**만 쓴다.
- 무신사 요청은 순차로 보내고 요청 사이에 700ms 간격을 둔다(`delayMs` 기본값 700).
- 입력이 불완전하면 추정하지 말고 결과 전체를 버린 뒤 폴백한다. 부분 목록은 좋아요 상품을 대량 UNLIKED로 만든다.
- 안전 가드(ACTIVE like ≥ 10이고 원격 < 40%이면 UNLIKED 처리 생략)와 요약 반환 형식은 유지한다. 요약에는 `source`만 추가한다.
- 모든 테스트 파일은 첫 줄에 `import './setup-env.js';`를 둔다(`tests/test-isolation.test.js`가 강제한다).
- 커밋은 Conventional Commits 형식으로 쓰고, 마지막 줄을 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`으로 끝낸다.
- 작업은 main에서 딴 worktree에서 한다. 설계 문서와 이 계획 문서는 main에 untracked로 있으니, worktree로 복사해 Task 1의 커밋에 함께 넣는다.

## Review Focus

1. **페이지를 받는 도중 좋아요 목록이 바뀜**(받은 고유 수 ≠ 전체 개수): 결과를 버리고 OpenCLI로 폴백해야 한다. UNLIKED로 바뀌는 상품이 없어야 한다. → Task 1 "count mismatch", Task 2 "incomplete → OpenCLI"
2. **2페이지에서 쿠키 만료(401)**: 이미 받은 1페이지와 이어 붙이지 말고, refresh한 뒤 1페이지부터 다시 받아야 한다. → Task 2 "refresh restarts from scratch"
3. **deferred에서 HTTPS 실패**: OpenCLI, prewarm, Chrome을 건드리지 않고 DB도 바꾸지 않은 채 에러를 던진다. daily는 경고만 하고 계속한다. → Task 2 "allowOpenCli=false"
4. **좋아요가 0개인 계정**: `tab.data.goods === 0`이고 빈 페이지가 오면 에러 없이 `[]`를 반환한다. → Task 1 "empty account"
5. **에러 메시지 유출**: 5xx 같은 실패 메시지에 커서 쿼리나 쿠키 값이 들어가면 안 된다. 경로만 남긴다. → Task 1 "error messages carry path only"

---

### Task 1: `fetchLikedGoodsViaHttps` — 좋아요 목록 HTTPS 수집기

**Files:**
- Create: `src/likes-https.js`
- Test: `tests/likes-https.test.js`
- Add (복사): `docs/plans/2026-09-26-https-likes-sync-design.md`, `docs/plans/2026-09-26-https-likes-sync.md`

**Interfaces:**
- Consumes: `USER_AGENT`, `SessionExpiredError` from `src/myprice.js`
- Produces:
  - `export const LIKES_TAB_URL = 'https://like.musinsa.com/api2/like/like-page/v1/tab'`
  - `export const LIKED_GOODS_URL = 'https://like.musinsa.com/api2/like/like-page/v1/tab/goods'`
  - `export class LikesIncompleteError extends Error` (`name === 'LikesIncompleteError'`)
  - `export async function fetchLikedGoodsViaHttps(cookie: string, { fetchFn = fetch, delayMs = 700, retryDelayMs = 2000, pageSize = 30, maxPages = 50, onSetCookie = null } = {}): Promise<Array<{ goodsNo: number, goodsName: string, brandName: string, url: string, status: '품절'|'판매중' }>>`
  - 던지는 에러: 로그아웃이면 `SessionExpiredError`, 개수·스키마·페이지 이상이면 `LikesIncompleteError`, 그 밖의 HTTP 실패는 `Error`

- [ ] **Step 1: Write the failing tests**

`tests/likes-https.test.js`:

```js
import './setup-env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchLikedGoodsViaHttps,
  LikesIncompleteError,
  LIKES_TAB_URL,
  LIKED_GOODS_URL,
} from '../src/likes-https.js';
import { SessionExpiredError } from '../src/myprice.js';

const COOKIE = 'app_atk=secret-atk; app_rtk=secret-rtk';
const FIRST = `${LIKED_GOODS_URL}?size=30`;
const PAGE2 = `${LIKED_GOODS_URL}?size=30&cursor=c2&lastIndex=30`;

const goods = (n, extra = {}) => ({
  itemType: 'GOODS', goodsNo: n, goodsName: `Goods ${n}`, brandName: `Brand ${n}`, isSoldOut: false, ...extra,
});
const page = (data, next = null) => ({ body: { meta: { result: 'SUCCESS' }, data, link: { prev: null, next } } });
const tab = (count) => ({ body: { meta: { result: 'SUCCESS' }, data: { goods: count, brand: 0, snap: 0, folder: 0 } } });
const loggedOut = { status: 401, body: { meta: { result: 'FAIL', errorCode: 'LIKE-000-0001' }, data: null } };

/** route(url, callNo) -> { status?, body?, setCookie? }; body undefined = non-JSON response */
function fakeFetch(route) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const r = route(url, calls.length);
    const status = r.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { getSetCookie: () => r.setCookie ?? [] },
      json: async () => {
        if (r.body === undefined) throw new SyntaxError('Unexpected token <');
        return r.body;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

/** pages: { [url]: response }, plus the tab count */
const routes = (count, pages) => (url) => (url === LIKES_TAB_URL ? tab(count) : pages[url] ?? { status: 404, body: null });
const opts = (fetchFn, extra = {}) => ({ fetchFn, delayMs: 0, retryDelayMs: 0, ...extra });

describe('fetchLikedGoodsViaHttps', () => {
  test('follows link.next, keeps only GOODS, maps to the sync shape', async () => {
    const fetchFn = fakeFetch(routes(3, {
      [FIRST]: page([goods(1), { itemType: 'BANNERS' }, goods(2, { isSoldOut: true })], PAGE2),
      [PAGE2]: page([goods(3), { itemType: 'AD_GOODS', content: [goods(99)] }]),
    }));
    const items = await fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn));
    assert.deepEqual(items, [
      { goodsNo: 1, goodsName: 'Goods 1', brandName: 'Brand 1', url: 'https://www.musinsa.com/products/1', status: '판매중' },
      { goodsNo: 2, goodsName: 'Goods 2', brandName: 'Brand 2', url: 'https://www.musinsa.com/products/2', status: '품절' },
      { goodsNo: 3, goodsName: 'Goods 3', brandName: 'Brand 3', url: 'https://www.musinsa.com/products/3', status: '판매중' },
    ]);
    assert.deepEqual(fetchFn.calls.map((c) => c.url), [LIKES_TAB_URL, FIRST, PAGE2]);
    for (const c of fetchFn.calls) {
      assert.equal(c.headers.Cookie, COOKIE);
      assert.equal(c.headers.Accept, 'application/json');
      assert.equal(c.headers.Referer, 'https://www.musinsa.com/');
    }
  });

  test('dedupes a goodsNo repeated across pages', async () => {
    const fetchFn = fakeFetch(routes(2, {
      [FIRST]: page([goods(1), goods(2)], PAGE2),
      [PAGE2]: page([goods(2)]),
    }));
    const items = await fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn));
    assert.deepEqual(items.map((i) => i.goodsNo), [1, 2]);
  });

  test('empty account: total 0 and an empty page -> []', async () => {
    const fetchFn = fakeFetch(routes(0, { [FIRST]: page([]) }));
    assert.deepEqual(await fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn)), []);
  });

  test('count mismatch -> LikesIncompleteError', async () => {
    const fetchFn = fakeFetch(routes(3, { [FIRST]: page([goods(1), goods(2)]) }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn)), (err) => {
      assert.ok(err instanceof LikesIncompleteError);
      assert.match(err.message, /2 of 3/);
      return true;
    });
  });

  test('missing total -> LikesIncompleteError before any goods page', async () => {
    const fetchFn = fakeFetch((url) => (url === LIKES_TAB_URL ? { body: { meta: { result: 'SUCCESS' }, data: {} } } : page([])));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn)), LikesIncompleteError);
    assert.equal(fetchFn.calls.length, 1);
  });

  test('GOODS item with a wrong schema -> LikesIncompleteError', async () => {
    for (const bad of [goods('5'), goods(0), { itemType: 'GOODS', goodsNo: 5, goodsName: 'x' }]) {
      const fetchFn = fakeFetch(routes(1, { [FIRST]: page([bad]) }));
      await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn)), LikesIncompleteError);
    }
  });

  test('page without a data array, or meta.result != SUCCESS -> LikesIncompleteError', async () => {
    const noArray = fakeFetch(routes(1, { [FIRST]: { body: { meta: { result: 'SUCCESS' }, data: null, link: {} } } }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(noArray)), LikesIncompleteError);
    const failed = fakeFetch(routes(1, { [FIRST]: { body: { meta: { result: 'FAIL', errorCode: 'LIKE-999' }, data: [] } } }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(failed)), LikesIncompleteError);
  });

  test('401 or LIKE-000-0001 -> SessionExpiredError', async () => {
    const onPage = fakeFetch(routes(1, { [FIRST]: loggedOut }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(onPage)), SessionExpiredError);
    const onTab = fakeFetch(() => ({ status: 200, body: { meta: { result: 'FAIL', errorCode: 'LIKE-000-0001' } } }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(onTab)), SessionExpiredError);
  });

  test('429 is retried once on the same URL; a second 429 fails', async () => {
    let firstHits = 0;
    const once = fakeFetch((url) => {
      if (url === LIKES_TAB_URL) return tab(1);
      return ++firstHits === 1 ? { status: 429 } : page([goods(1)]);
    });
    assert.equal((await fetchLikedGoodsViaHttps(COOKIE, opts(once))).length, 1);
    assert.deepEqual(once.calls.map((c) => c.url), [LIKES_TAB_URL, FIRST, FIRST]);

    const twice = fakeFetch((url) => (url === LIKES_TAB_URL ? tab(1) : { status: 429 }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(twice)), /HTTP 429/);
    assert.equal(twice.calls.length, 3);
  });

  test('error messages carry the path only, never the cursor or cookie', async () => {
    const fetchFn = fakeFetch(routes(2, { [FIRST]: page([goods(1)], PAGE2), [PAGE2]: { status: 500 } }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn)), (err) => {
      assert.match(err.message, /HTTP 500/);
      assert.match(err.message, /\/api2\/like\/like-page\/v1\/tab\/goods/);
      assert.doesNotMatch(err.message, /cursor|c2|secret|app_atk/);
      return true;
    });
  });

  test('next on another host, a repeated next, or too many pages -> LikesIncompleteError', async () => {
    const offHost = fakeFetch(routes(2, { [FIRST]: page([goods(1)], 'https://evil.example.com/tab/goods?cursor=x') }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(offHost)), LikesIncompleteError);

    const loop = fakeFetch(routes(9, { [FIRST]: page([goods(1)], PAGE2), [PAGE2]: page([goods(2)], PAGE2) }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(loop)), LikesIncompleteError);

    const endless = fakeFetch((url, n) => (url === LIKES_TAB_URL ? tab(99) : page([goods(n)], `${LIKED_GOODS_URL}?cursor=${n}`)));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(endless, { maxPages: 3 })), /more than 3 pages/);
    assert.equal(endless.calls.length, 4); // tab + 3 pages, never a 4th page
  });

  test('passes Set-Cookie headers to onSetCookie', async () => {
    const seen = [];
    const fetchFn = fakeFetch((url) => (url === LIKES_TAB_URL ? { ...tab(1), setCookie: ['__cf_bm=x; Path=/'] } : page([goods(1)])));
    await fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn, { onSetCookie: (h) => seen.push(h) }));
    assert.deepEqual(seen, [['__cf_bm=x; Path=/']]);
  });

  test('waits delayMs before every goods page (sequential)', async () => {
    const fetchFn = fakeFetch(routes(2, { [FIRST]: page([goods(1)], PAGE2), [PAGE2]: page([goods(2)]) }));
    const started = Date.now();
    await fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn, { delayMs: 40 }));
    assert.ok(Date.now() - started >= 75, 'two 40ms gaps: tab->page1, page1->page2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/likes-https.test.js`
Expected: FAIL — `Cannot find module '.../src/likes-https.js'`

- [ ] **Step 3: Write the implementation**

`src/likes-https.js`:

```js
import { USER_AGENT, SessionExpiredError } from './myprice.js';

export const LIKES_TAB_URL = 'https://like.musinsa.com/api2/like/like-page/v1/tab';
export const LIKED_GOODS_URL = 'https://like.musinsa.com/api2/like/like-page/v1/tab/goods';
const LIKE_HOST = 'like.musinsa.com';
const LOGGED_OUT_CODE = 'LIKE-000-0001';

/** The liked list came back incomplete or in an unexpected shape: discard it, never apply it partially. */
export class LikesIncompleteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LikesIncompleteError';
  }
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// Error messages name the path only: the query carries the cursor, headers carry the cookie.
const pathOf = (url) => new URL(url).pathname;

async function getLikeJson(url, headers, { fetchFn, onSetCookie, retryDelayMs }) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetchFn(url, { headers });
    const setCookies = res.headers?.getSetCookie?.() ?? [];
    if (onSetCookie && setCookies.length) onSetCookie(setCookies);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.status === 401 || body?.meta?.errorCode === LOGGED_OUT_CODE) {
      throw new SessionExpiredError('Musinsa like API reports logged out');
    }
    if ((res.status === 429 || res.status >= 500) && attempt === 1) {
      await sleep(retryDelayMs);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${pathOf(url)}`);
    if (body?.meta?.result !== 'SUCCESS') {
      throw new LikesIncompleteError(`like API result ${body?.meta?.result ?? 'missing'} for ${pathOf(url)}`);
    }
    return body;
  }
}

function checkedNext(next, seen) {
  if (next === null || next === undefined) return null;
  let parsed;
  try {
    parsed = new URL(next);
  } catch {
    throw new LikesIncompleteError('unexpected next link (not a URL)');
  }
  if (parsed.protocol !== 'https:' || parsed.host !== LIKE_HOST) {
    throw new LikesIncompleteError(`unexpected next link host ${parsed.host}`);
  }
  if (seen.has(next)) throw new LikesIncompleteError('next link repeats an earlier page');
  return next;
}

/**
 * Every liked goods item over authenticated HTTPS (like.musinsa.com), sequentially.
 * Throws instead of returning a partial list: the caller would otherwise mark the
 * missing items UNLIKED.
 */
export async function fetchLikedGoodsViaHttps(
  cookie,
  { fetchFn = fetch, delayMs = 700, retryDelayMs = 2000, pageSize = 30, maxPages = 50, onSetCookie = null } = {}
) {
  const headers = {
    'User-Agent': USER_AGENT,
    Referer: 'https://www.musinsa.com/',
    Origin: 'https://www.musinsa.com',
    Accept: 'application/json',
    Cookie: cookie,
  };
  const reqOpts = { fetchFn, onSetCookie, retryDelayMs };

  const expected = (await getLikeJson(LIKES_TAB_URL, headers, reqOpts))?.data?.goods;
  if (!Number.isInteger(expected) || expected < 0) throw new LikesIncompleteError('like tab has no goods total');

  const byGoodsNo = new Map();
  const seen = new Set();
  let url = `${LIKED_GOODS_URL}?size=${pageSize}`;
  for (let pageNo = 1; url; pageNo++) {
    if (pageNo > maxPages) throw new LikesIncompleteError(`more than ${maxPages} pages`);
    seen.add(url);
    await sleep(delayMs);
    const body = await getLikeJson(url, headers, reqOpts);
    if (!Array.isArray(body.data)) throw new LikesIncompleteError(`page ${pageNo} has no data array`);
    for (const it of body.data) {
      if (it?.itemType !== 'GOODS') continue; // banners and ads are not likes
      if (
        !Number.isInteger(it.goodsNo) ||
        it.goodsNo <= 0 ||
        typeof it.goodsName !== 'string' ||
        typeof it.brandName !== 'string'
      ) {
        throw new LikesIncompleteError(`page ${pageNo}: unexpected GOODS item schema`);
      }
      if (!byGoodsNo.has(it.goodsNo)) {
        byGoodsNo.set(it.goodsNo, {
          goodsNo: it.goodsNo,
          goodsName: it.goodsName,
          brandName: it.brandName,
          url: `https://www.musinsa.com/products/${it.goodsNo}`,
          status: it.isSoldOut ? '품절' : '판매중',
        });
      }
    }
    url = checkedNext(body.link?.next, seen);
  }

  if (byGoodsNo.size !== expected) {
    throw new LikesIncompleteError(`received ${byGoodsNo.size} of ${expected} liked goods`);
  }
  return [...byGoodsNo.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/likes-https.test.js`
Expected: PASS (13 tests)

Run: `npm test`
Expected: 기존 293개 + 새 테스트 전부 PASS

- [ ] **Step 5: Commit**

```bash
git add src/likes-https.js tests/likes-https.test.js docs/plans/2026-09-26-https-likes-sync-design.md docs/plans/2026-09-26-https-likes-sync.md
git commit -m "$(cat <<'EOF'
feat(likes): fetch the full liked-goods list over authenticated HTTPS

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `syncLikedItemsFromMusinsa` — HTTPS 우선, OpenCLI 폴백

**Files:**
- Modify: `src/sync.js` (전체 교체. DB 반영과 안전 가드 블록 `src/sync.js:71-135`는 글자 그대로 유지)
- Test: `tests/sync-https.test.js`

**Interfaces:**
- Consumes: `fetchLikedGoodsViaHttps(cookie, { delayMs, onSetCookie })` from Task 1. 세션 제공자 계약(`src/session.js:616` `makeSessionProvider`): `provider({ refresh: false })` 또는 `provider({ refresh: true, failedCookie })` → `Promise<string|null>`, 선택적으로 `provider.absorb(setCookieHeaders)`
- Produces:
  - `syncLikedItemsFromMusinsa({ limit = 300, dbInstance = db, execFn = execSync, prewarmFn = null, sessionProvider = null, httpsFetchFn = fetchLikedGoodsViaHttps, httpsDelayMs = 700, allowOpenCli = true } = {})` → 기존 요약 + `source: 'https' | 'opencli'`
  - `allowOpenCli === false`이고 HTTPS가 실패하면 `Error('Liked items unavailable via HTTPS and OpenCLI is not allowed (browser bridge unavailable)')`를 던진다. DB는 바꾸지 않는다.

- [ ] **Step 1: Write the failing tests**

`tests/sync-https.test.js`:

```js
import './setup-env.js';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClotDatabase } from '../src/db.js';
import { syncLikedItemsFromMusinsa } from '../src/sync.js';
import { SessionExpiredError } from '../src/myprice.js';
import { LikesIncompleteError } from '../src/likes-https.js';

let tempDir;
let dbi;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-sync-https-'));
  dbi = new ClotDatabase(path.join(tempDir, 'prices.db'));
});
afterEach(() => {
  dbi.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const remote = (...nos) =>
  nos.map((n) => ({ goodsNo: n, goodsName: `Goods ${n}`, brandName: `Brand ${n}`, url: `https://www.musinsa.com/products/${n}`, status: '판매중' }));
const seedLikes = (...nos) =>
  nos.forEach((n) =>
    dbi.upsertItem({ goods_no: n, goods_name: `Goods ${n}`, brand_name: `Brand ${n}`, url: `https://www.musinsa.com/products/${n}`, source: 'like', status: 'ACTIVE' })
  );
const statusOf = (n) => dbi.getItem(n)?.status;

/** Returns cookies[i] on the i-th call (last one repeats). */
function provider(cookies = ['old']) {
  const calls = [];
  const absorbed = [];
  const p = async (o = {}) => {
    calls.push(o);
    return cookies[Math.min(calls.length - 1, cookies.length - 1)];
  };
  p.absorb = (h) => { absorbed.push(h); return { cookie: null, revoked: false }; };
  p.calls = calls;
  p.absorbed = absorbed;
  return p;
}
const counter = () => { const c = { n: 0 }; c.fn = async () => { c.n++; }; return c; };
const noExec = () => { throw new Error('OpenCLI must not run'); };
const execReturning = (items) => { const e = () => JSON.stringify(items); return e; };
const base = (extra) => ({ dbInstance: dbi, httpsDelayMs: 0, ...extra });

describe('syncLikedItemsFromMusinsa over HTTPS', () => {
  test('HTTPS success: no OpenCLI, no prewarm, applies adds and unlikes, source=https', async () => {
    seedLikes(1, 2);
    const prewarm = counter();
    const seen = [];
    const res = await syncLikedItemsFromMusinsa(base({
      sessionProvider: provider(),
      httpsFetchFn: async (cookie, o) => { seen.push({ cookie, delayMs: o.delayMs }); return remote(1, 3); },
      execFn: noExec,
      prewarmFn: prewarm.fn,
    }));
    assert.equal(res.source, 'https');
    assert.deepEqual(seen, [{ cookie: 'old', delayMs: 0 }]);
    assert.equal(prewarm.n, 0);
    assert.deepEqual(res.newItems.map((i) => i.goodsNo), [3]);
    assert.deepEqual(res.unlikedItems.map((i) => i.goods_no), [2]);
    assert.equal(statusOf(2), 'UNLIKED');
    assert.equal(res.totalRemote, 2);
  });

  test('incomplete HTTPS list -> falls back to OpenCLI (with prewarm), nothing from HTTPS applied', async () => {
    seedLikes(1, 2);
    const prewarm = counter();
    const res = await syncLikedItemsFromMusinsa(base({
      sessionProvider: provider(),
      httpsFetchFn: async () => { throw new LikesIncompleteError('received 1 of 2 liked goods'); },
      execFn: execReturning(remote(1, 2)),
      prewarmFn: prewarm.fn,
    }));
    assert.equal(res.source, 'opencli');
    assert.equal(prewarm.n, 1);
    assert.equal(res.unlikedItems.length, 0);
    assert.equal(statusOf(1), 'ACTIVE');
    assert.equal(statusOf(2), 'ACTIVE');
  });

  test('refresh restarts from scratch: first SessionExpired -> refresh(failedCookie) -> full retry', async () => {
    const p = provider(['old', 'new']);
    const cookies = [];
    const res = await syncLikedItemsFromMusinsa(base({
      sessionProvider: p,
      httpsFetchFn: async (cookie) => {
        cookies.push(cookie);
        if (cookie === 'old') throw new SessionExpiredError();
        return remote(1);
      },
      execFn: noExec,
    }));
    assert.equal(res.source, 'https');
    assert.deepEqual(cookies, ['old', 'new']);
    assert.deepEqual(p.calls, [{ refresh: false }, { refresh: true, failedCookie: 'old' }]);
  });

  test('SessionExpired twice -> OpenCLI fallback', async () => {
    const res = await syncLikedItemsFromMusinsa(base({
      sessionProvider: provider(['old', 'new']),
      httpsFetchFn: async () => { throw new SessionExpiredError(); },
      execFn: execReturning(remote(1)),
    }));
    assert.equal(res.source, 'opencli');
  });

  test('provider returns null or throws -> HTTPS not attempted, OpenCLI fallback', async () => {
    for (const sessionProvider of [async () => null, async () => { throw new Error('bridge down'); }]) {
      let httpsCalls = 0;
      const res = await syncLikedItemsFromMusinsa(base({
        sessionProvider,
        httpsFetchFn: async () => { httpsCalls++; return remote(1); },
        execFn: execReturning(remote(1)),
      }));
      assert.equal(httpsCalls, 0);
      assert.equal(res.source, 'opencli');
    }
  });

  test('allowOpenCli=false: HTTPS failure throws, no exec, no prewarm, DB untouched', async () => {
    seedLikes(1, 2);
    const prewarm = counter();
    await assert.rejects(
      syncLikedItemsFromMusinsa(base({
        sessionProvider: provider(),
        httpsFetchFn: async () => { throw new Error('HTTP 500 for /api2/like/like-page/v1/tab/goods'); },
        execFn: noExec,
        prewarmFn: prewarm.fn,
        allowOpenCli: false,
      })),
      /unavailable via HTTPS/
    );
    assert.equal(prewarm.n, 0);
    assert.equal(statusOf(1), 'ACTIVE');
    assert.equal(statusOf(2), 'ACTIVE');
  });

  test('safety guardrail still applies to the HTTPS path', async () => {
    seedLikes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
    const res = await syncLikedItemsFromMusinsa(base({
      sessionProvider: provider(),
      httpsFetchFn: async () => remote(1, 2, 3),
      execFn: noExec,
    }));
    assert.equal(res.unlikedItems.length, 0);
    assert.equal(statusOf(10), 'ACTIVE');
  });

  test('onSetCookie is wired to provider.absorb', async () => {
    const p = provider();
    await syncLikedItemsFromMusinsa(base({
      sessionProvider: p,
      httpsFetchFn: async (_c, o) => { o.onSetCookie(['__cf_bm=x']); return remote(1); },
      execFn: noExec,
    }));
    assert.deepEqual(p.absorbed, [['__cf_bm=x']]);
  });

  test('no sessionProvider: OpenCLI path as before, source=opencli', async () => {
    const res = await syncLikedItemsFromMusinsa(base({ execFn: execReturning(remote(7)) }));
    assert.equal(res.source, 'opencli');
    assert.deepEqual(res.newItems.map((i) => i.goodsNo), [7]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/sync-https.test.js`
Expected: FAIL — `res.source`가 `undefined`이고, 첫 테스트에서 `OpenCLI must not run`

- [ ] **Step 3: Write the implementation**

`src/sync.js` 전체를 다음으로 바꾼다. `// 1. Process remote likes`부터 `return summary;`까지의 본문은 기존 코드 그대로이고, `summary`에 `source`만 추가했다.

```js
import { execSync } from 'node:child_process';
import { db } from './db.js';
import { getExecOptions } from './env.js';
import { fetchLikedGoodsViaHttps } from './likes-https.js';

/**
 * Liked list over authenticated HTTPS. Returns null (caller falls back) on any failure;
 * a SessionExpiredError refreshes the cookie once and restarts from the first page.
 */
async function fetchRemoteLikesViaHttps({ sessionProvider, httpsFetchFn, httpsDelayMs }) {
  const getCookie = async (opts) => {
    try {
      return await sessionProvider(opts);
    } catch (err) {
      console.warn(`[Sync HTTPS Notice] Session provider failed: ${err.message}`);
      return null;
    }
  };
  const onSetCookie = sessionProvider.absorb ? (headers) => sessionProvider.absorb(headers) : null;

  let cookie = await getCookie({ refresh: false });
  if (!cookie) {
    console.warn('[Sync HTTPS Notice] No Musinsa session; skipping HTTPS likes.');
    return null;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await httpsFetchFn(cookie, { delayMs: httpsDelayMs, onSetCookie });
    } catch (err) {
      if (err?.name === 'SessionExpiredError' && attempt === 1) {
        cookie = await getCookie({ refresh: true, failedCookie: cookie });
        if (!cookie) {
          console.warn('[Sync HTTPS Notice] Session expired and could not be refreshed.');
          return null;
        }
        continue;
      }
      console.warn(`[Sync HTTPS Notice] Liked list discarded: ${err.message}`);
      return null;
    }
  }
  return null;
}

function runOpenCliLikes(execFn, limit) {
  return execFn(
    `opencli musinsa likes --limit ${limit} -f json`,
    getExecOptions({
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  );
}

async function fetchRemoteLikesViaOpenCli({ limit, execFn, prewarmFn }) {
  if (prewarmFn) {
    try {
      await prewarmFn({ waitMs: process.env.NODE_ENV === 'test' ? 0 : 3000 });
    } catch {}
  }

  let rawOutput = '';
  try {
    rawOutput = runOpenCliLikes(execFn, limit);
  } catch (err) {
    // If timeout, try one self-healing prewarm retry
    if (prewarmFn && (err.message?.includes('ETIMEDOUT') || String(err.stdout || '').includes('TIMEOUT') || String(err.stderr || '').includes('TIMEOUT'))) {
      console.warn('⚠️ [Sync Notice] First attempt timed out. Attempting self-healing session pre-warm and retry...');
      try {
        await prewarmFn({ execFn, waitMs: 4000 });
        rawOutput = runOpenCliLikes(execFn, limit);
      } catch (retryErr) {
        err = retryErr;
      }
    }

    if (!rawOutput) {
      const errorOutput = `${err.stdout || ''}\n${err.stderr || ''}\n${err.message}`;
      if (
        errorOutput.includes('AUTH_REQUIRED') ||
        errorOutput.includes('not logged in') ||
        errorOutput.includes('EMPTY_RESULT')
      ) {
        throw new Error(
          '무신사 로그인이 필요합니다. Chrome 브라우저에서 https://musinsa.com 에 로그인한 후 다시 실행해 주세요. (또는 터미널에서 opencli musinsa login 실행)'
        );
      }
      throw new Error(`Failed to execute opencli musinsa likes: ${err.message}`);
    }
  }

  const jsonStart = rawOutput.indexOf('[');
  if (jsonStart === -1) {
    throw new Error('No JSON array found in opencli output');
  }
  return JSON.parse(rawOutput.slice(jsonStart));
}

export async function syncLikedItemsFromMusinsa({
  limit = 300,
  dbInstance = db,
  execFn = execSync,
  prewarmFn = null,
  sessionProvider = null,
  httpsFetchFn = fetchLikedGoodsViaHttps,
  httpsDelayMs = 700,
  allowOpenCli = true,
} = {}) {
  let remoteLikes = null;
  let source = null;
  if (sessionProvider) {
    console.log('🔄 Syncing Musinsa liked items via HTTPS...');
    remoteLikes = await fetchRemoteLikesViaHttps({ sessionProvider, httpsFetchFn, httpsDelayMs });
    if (remoteLikes) source = 'https';
  }
  if (!remoteLikes) {
    if (!allowOpenCli) {
      throw new Error('Liked items unavailable via HTTPS and OpenCLI is not allowed (browser bridge unavailable)');
    }
    console.log('🔄 Syncing Musinsa liked items via OpenCLI...');
    remoteLikes = await fetchRemoteLikesViaOpenCli({ limit, execFn, prewarmFn });
    source = 'opencli';
  }
  console.log(`📦 Retrieved ${remoteLikes.length} liked items from Musinsa (${source}).`);

  const remoteGoodsNoSet = new Set();
  const summary = {
    source,
    totalRemote: remoteLikes.length,
    newItems: [],
    reactivatedItems: [],
    promotedItems: [],
    unlikedItems: [],
    unchangedCount: 0,
  };

  // (기존 src/sync.js:81-135 — "// 1. Process remote likes"부터 "return summary;"까지 그대로)
}
```

주의: 마지막 주석 줄은 자리 표시가 아니다. 기존 파일의 81–135행을 **그대로 붙여 넣으라는 지시**다. 옮긴 뒤 `git diff src/sync.js`로 그 구간에 바뀐 줄이 없는지 확인한다. 기존 `import { prewarmMusinsaSession } from './collector.js';`는 쓰이지 않으니 지운다.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/sync-https.test.js tests/sync-env.test.js`
Expected: PASS

Run: `npm test`
Expected: 전부 PASS

- [ ] **Step 5: Commit**

```bash
git add src/sync.js tests/sync-https.test.js
git commit -m "$(cat <<'EOF'
feat(sync): sync liked items over HTTPS first, fall back to OpenCLI on an incomplete list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: deferred 실행을 `'full'`로 기록할 수 있게 하기 (`likesSynced`)

**Files:**
- Modify: `src/collector.js` (`collectPricesForActiveItems` 인자 목록 약 239–257행, deferred 분기 `src/collector.js:301-309`)
- Test: `tests/collector-deferred.test.js`(describe 블록 끝에 테스트 추가)

**Interfaces:**
- Consumes: 없음
- Produces: `collectPricesForActiveItems({ ..., likesSynced = false })`. `skipOpenCli`이고 VIP가 있으면 `mode = likesSynced && 남은 VIP 0개 ? 'full' : 'deferred'`

- [ ] **Step 1: Write the failing test**

`tests/collector-deferred.test.js`의 `describe('Deferred (sleep-aware) collection mode', ...)` 안, 마지막 테스트 뒤에 추가한다:

```js
  test('deferred run is recorded as full only when likes synced and HTTPS priced every VIP item', async () => {
    const authInfo = (goodsNo) => ({
      goodsNo, goodsName: `Name ${goodsNo}`, brandName: 'Brand', normalPrice: 20000, salePrice: 15000,
      couponPrice: 14000, myPrice: 13000, estimatedMyPrice: 12500, couponName: 'c', couponDiscount: 1000,
      isSoldOut: false, discontinued: false, priceSource: 'https-auth',
    });
    const run = async ({ likesSynced, pricedByHttps }) => {
      const { db, recorded } = makeDb();
      const res = await collectPricesForActiveItems({
        dbInstance: db,
        execFn: () => { throw new Error('should not be called'); },
        fetchFn: directFetch,
        skipOpenCli: true,
        delayMs: 0,
        sessionProvider: async () => 'app_atk=a; app_rtk=r',
        authDelayMs: 0,
        authFetchFn: async (g) => {
          if (!pricedByHttps.includes(g)) throw new Error('boom');
          return authInfo(g);
        },
        likesSynced,
      });
      return [res.mode, recorded.runs[0].mode];
    };
    assert.deepEqual(await run({ likesSynced: true, pricedByHttps: [1, 2] }), ['full', 'full']);
    assert.deepEqual(await run({ likesSynced: false, pricedByHttps: [1, 2] }), ['deferred', 'deferred']);
    assert.deepEqual(await run({ likesSynced: true, pricedByHttps: [1] }), ['deferred', 'deferred']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/collector-deferred.test.js`
Expected: FAIL — 첫 assert가 `['deferred','deferred']` ≠ `['full','full']`

- [ ] **Step 3: Implement**

`src/collector.js`의 `collectPricesForActiveItems` 인자 목록에서 `authDelayMs = 700,` 다음 줄에 추가한다:

```js
  // Deferred runs only: the liked list was synced this run, so an all-HTTPS price run needs no awake upgrade.
  likesSynced = false,
```

deferred 분기를 교체한다. 기존 코드:

```js
  if (skipOpenCli && vipGoodsNos.length > 0) {
    // Stays 'deferred' even when HTTPS priced every item: the awake upgrade run is what syncs liked items.
    results.mode = 'deferred';
```

새 코드:

```js
  if (skipOpenCli && vipGoodsNos.length > 0) {
    // 'full' (no awake upgrade) only when this run also synced the liked list and HTTPS priced every VIP item.
    results.mode = likesSynced && remainingVipGoodsNos.length === 0 ? 'full' : 'deferred';
```

(그 아래 `if (remainingVipGoodsNos.length > 0) { console.warn(...) }`는 그대로 둔다.)

- [ ] **Step 4: Run tests**

Run: `node --test tests/collector-deferred.test.js tests/collector-auth.test.js tests/daily-decision.test.js`
Expected: PASS

Run: `npm test`
Expected: 전부 PASS

- [ ] **Step 5: Commit**

```bash
git add src/collector.js tests/collector-deferred.test.js
git commit -m "$(cat <<'EOF'
feat(collector): record a deferred run as full when likes synced and HTTPS priced every VIP item

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: daily와 `sync` 명령 연결

**Files:**
- Modify: `src/cli.js:379-406`(daily의 deferred 로그와 동기화 블록), `src/cli.js:420`(수집 provider), `src/cli.js:774-779`(`sync` 명령)

**Interfaces:**
- Consumes: `syncLikedItemsFromMusinsa({ sessionProvider, allowOpenCli, prewarmFn })` → `{ source, ... }` (Task 2), `collectPricesForActiveItems({ likesSynced })` (Task 3), `makeSessionProvider`, `sessionProbeOptions`(이미 import되어 있음)
- Produces: 없음(최상위 연결)

`handleDailyRun`은 export되지 않은 I/O 함수라 단위 테스트가 없다. 이 태스크는 문법 검사, 전체 테스트, 읽기 전용 명령, diff 확인으로 검증한다.

- [ ] **Step 1: daily — provider를 하나 만들고 deferred 로그를 바꾼다**

`src/cli.js` 기존 코드:

```js
  const deferred = decision.mode === 'deferred';
```

새 코드:

```js
  const deferred = decision.mode === 'deferred';
  // One provider for likes sync and prices: a dead cookie is probed/renewed once and absorbed rotations carry over.
  // Cached cookie works while asleep; only fetch a fresh one when the browser bridge is usable.
  const sessionProvider = makeSessionProvider({ allowBridge: !deferred, probe: sessionProbeOptions() });
```

기존 deferred 로그:

```js
      `⏸ [Deferred Mode] Browser bridge unavailable. Skipping OpenCLI (likes sync + my-prices) and collecting public prices via direct parser.\n   Will automatically upgrade to authenticated prices on the next check once the Mac is fully awake.`
```

새 로그:

```js
      `⏸ [Deferred Mode] Browser bridge unavailable. Skipping OpenCLI; likes sync and VIP prices use the cached HTTPS session only.\n   Upgrades on the next awake check unless HTTPS covered both.`
```

- [ ] **Step 2: daily — 동기화 블록 교체**

기존 코드(`// 1. Sync liked items from Musinsa (needs the browser bridge)`부터 그 `if/else`가 끝나는 `}`까지):

```js
  // 1. Sync liked items from Musinsa (needs the browser bridge)
  if (deferred) {
    console.log('🔄 Liked items sync skipped (deferred mode).');
  } else {
    try {
      const syncRes = await syncLikedItemsFromMusinsa({ prewarmFn: prewarmMusinsaSession });
      const promotedCount = syncRes.promotedItems?.length || 0;
      console.log(
        `📊 Sync Summary: +${syncRes.newItems.length} new, ${syncRes.reactivatedItems.length} reactivated, ${promotedCount} promoted, ${syncRes.unlikedItems.length} unliked, ${syncRes.unchangedCount} unchanged.`
      );
    } catch (err) {
      console.warn(`⚠️ Warning: Liked items sync failed, proceeding with existing items. (${err.message})`);
      if (err.message.includes('로그인이 필요합니다') || err.message.includes('AUTH_REQUIRED')) {
        await notifySessionWarning({ reason: '무신사 좋아요 목록 동기화 인증 실패 (로그인 만료)' });
      }
    }
  }
```

새 코드:

```js
  // 1. Sync liked items: HTTPS first; OpenCLI fallback only when the browser bridge is usable
  let likesSynced = false;
  try {
    const syncRes = await syncLikedItemsFromMusinsa({
      sessionProvider,
      allowOpenCli: !deferred,
      prewarmFn: deferred ? null : prewarmMusinsaSession,
    });
    likesSynced = true;
    const promotedCount = syncRes.promotedItems?.length || 0;
    console.log(
      `📊 Sync Summary (${syncRes.source}): +${syncRes.newItems.length} new, ${syncRes.reactivatedItems.length} reactivated, ${promotedCount} promoted, ${syncRes.unlikedItems.length} unliked, ${syncRes.unchangedCount} unchanged.`
    );
  } catch (err) {
    console.warn(`⚠️ Warning: Liked items sync failed, proceeding with existing items. (${err.message})`);
    if (err.message.includes('로그인이 필요합니다') || err.message.includes('AUTH_REQUIRED')) {
      await notifySessionWarning({ reason: '무신사 좋아요 목록 동기화 인증 실패 (로그인 만료)' });
    }
  }
```

- [ ] **Step 3: daily — 수집 호출에 공유 provider와 `likesSynced`를 넘긴다**

기존 코드(`collectPricesForActiveItems({` 안):

```js
    // Cached cookie works while asleep; only fetch a fresh one when the browser bridge is usable.
    sessionProvider: makeSessionProvider({ allowBridge: !deferred, probe: sessionProbeOptions() }),
```

새 코드:

```js
    sessionProvider,
    likesSynced,
```

- [ ] **Step 4: `sync` 명령에 provider를 넘긴다**

기존 코드:

```js
      const syncRes = await syncLikedItemsFromMusinsa({ ...flags, prewarmFn: prewarmMusinsaSession });
      const promotedCount = syncRes.promotedItems?.length || 0;
      console.log(
        `📊 Sync Summary: +${syncRes.newItems.length} new,
```

새 코드(세 번째 줄은 템플릿 앞부분만 바꾸고 나머지는 그대로 둔다):

```js
      const syncRes = await syncLikedItemsFromMusinsa({
        ...flags,
        prewarmFn: prewarmMusinsaSession,
        sessionProvider: makeSessionProvider({ allowBridge: true, probe: sessionProbeOptions() }),
      });
      const promotedCount = syncRes.promotedItems?.length || 0;
      console.log(
        `📊 Sync Summary (${syncRes.source}): +${syncRes.newItems.length} new,
```

- [ ] **Step 5: Verify**

Run: `node --check src/cli.js && node --check src/sync.js && node --check src/likes-https.js`
Expected: 출력 없이 종료 코드 0

Run: `grep -n "Liked items sync skipped\|makeSessionProvider(" src/cli.js`
Expected: `Liked items sync skipped`는 없고, `makeSessionProvider(`는 daily 1곳, `sync` 명령 1곳, 기존 `track`/`update` 1곳(`src/cli.js:819` 부근)만 나온다.

Run: `npm test`
Expected: 전부 PASS

Run: `node src/cli.js power-status`
Expected: 기존과 같은 전원 상태 출력(모듈 로드와 import가 깨지지 않았는지 확인하는 용도. 읽기 전용)

- [ ] **Step 6: (선택, 읽기 전용) 실제 API 확인** — DB를 쓰지 않고 개수만 출력한다:

```bash
node -e "import('./src/session.js').then(async (s) => { const { fetchLikedGoodsViaHttps } = await import('./src/likes-https.js'); const items = await fetchLikedGoodsViaHttps(s.readSessionCookie()); console.log('liked goods:', items.length); })"
```

Expected: `liked goods: <N>` (2026-09-26 기준 109). 쿠키가 만료됐으면 `SessionExpiredError`가 난다. 이것도 정상 결과로 보고, 쿠키 값은 어디에도 출력하지 않는다.

- [ ] **Step 7: Commit**

```bash
git add src/cli.js
git commit -m "$(cat <<'EOF'
feat(daily): sync liked items over HTTPS in deferred runs and share one session provider

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```
