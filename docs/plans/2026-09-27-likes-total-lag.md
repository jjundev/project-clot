# 좋아요 개수 API 지연 허용 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 좋아요 HTTPS 동기화가 "목록이 전체 개수보다 조금 많은" 경우(개수 API 지연)를 받아들이고, 모자란 경우와 크게 많은 경우는 계속 버리게 한다.

**Architecture:** `fetchLikedGoodsViaHttps`의 마지막 개수 비교(`src/likes-https.js:121-123`) 한 곳을 방향별 3분기로 바꾼다. 허용 폭은 export한 모듈 상수 `LIKES_TOTAL_LAG_TOLERANCE = 3`. 허용된 초과는 `console.warn` 한 줄(개수만)로 알린다. `src/sync.js`는 바꾸지 않는다.

**Tech Stack:** Node 24 ESM, 의존성 없음, `node:test` + `node:assert/strict`.

**Spec:** 이 문서의 "설계 요약" 절(2026-09-27 grill-yourself 세션 설계, `#2=3` 확정) + 기존 설계 `docs/plans/2026-09-26-https-likes-sync-design.md`.

## 설계 요약

| 받은 고유 GOODS 수(`received`) vs `tab.data.goods`(`expected`) | 결과 |
|---|---|
| `received < expected` | `LikesIncompleteError("received X of Y liked goods")` — 기존 그대로. 부분 목록을 반영하면 대량 UNLIKED |
| `received === expected` | 반환, 알림 없음 |
| `expected < received <= expected + 3` | 반환 + `console.warn('[Sync HTTPS Notice] like total lags the list (X listed, total Y); accepting')` |
| `received > expected + 3` | `LikesIncompleteError("received X liked goods, total Y (more than 3 over)")` |

- 페이징 전후 총수 재확인(`after !== expected`, `src/likes-https.js:118`)은 그대로이며 위 비교보다 먼저 실행된다.
- 근거(2026-09-27 관찰): 목록 113/총수 112(deferred 실행), 목록 114/총수 113(upgrade 실행), 11:3x 재조회 114/114. 전날 밤 좋아요 5개 추가 직후였고 차이는 두 번 모두 +1, 페이징 전후 총수는 같았다 → 개수 API가 목록보다 늦게 갱신된다.
- 남는 쪽의 최악: 실제로는 좋아요를 취소한 상품이 하루 더 ACTIVE로 추적된다.

## Global Constraints

- `node src/cli.js daily`(`--force` 포함)와 `node src/cli.js sync`로 검증하지 않는다. 검증은 `npm test`만 쓴다.
- 쿠키·토큰·커서 값을 로그, 에러 메시지, 테스트 출력에 남기지 않는다. 알림 한 줄에는 개수 두 개만 들어간다.
- `data/prices.db`는 커밋하지 않는다(daily가 계속 수정함).
- 작업은 main에서 딴 worktree에서 한다. 커밋은 Conventional Commits, 메시지 마지막 줄은 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- 모든 테스트 파일은 첫 import로 `./setup-env.js`를 둔다(`tests/test-isolation.test.js`가 강제).
- 병합하면 다음 daily 실행이 origin에 푸시한다.

## Review Focus

1. **전체 개수 0인데 목록 1~3개** — 남는 쪽이라 안전하므로 알림과 함께 받아들여야 한다. → Task 1 테스트 `total 0 with a small list -> accepted with a notice`.
2. **중복 goodsNo와 BANNERS/AD_GOODS가 초과로 세지는 경우** — 고유 GOODS만 세야 한다. 중복이 초과로 잡히면 멀쩡한 날에 알림이 뜨거나 허용 폭을 잘못 소모한다. → Task 1 테스트 `duplicates and banners never count as surplus`.
3. **페이징 중 총수가 따라잡는 경우(초과가 허용 폭 이내여도)** — 재확인 실패가 우선해 `changed during paging`으로 버려야 한다. → Task 1 테스트 `a total change during paging still wins over the surplus rule`.
4. **허용 폭을 넘어 버리는 경로에서 알림이 같이 찍히는 경우** — "accepting" 알림은 실제로 받아들일 때만 나와야 한다. → Task 1 테스트 `over total + tolerance -> LikesIncompleteError, no notice`.
5. **여러 페이지(커서 포함)에서 초과 알림에 커서나 쿠키가 섞이는 경우** — 알림은 개수만 담아야 한다. → Task 1 테스트 `list one over the total -> accepted with a notice`의 `doesNotMatch`.

---

### Task 1: 개수 비교를 방향별로 나누기 (코드 + 테스트 + 설계 문서)

**Files:**
- Modify: `src/likes-https.js:62-66` (JSDoc), `src/likes-https.js:121-123` (비교), 상단 상수 추가
- Test: `tests/likes-https.test.js` (import 추가, 헬퍼 2개, 기존 테스트 이름 변경, 새 테스트 7개)
- Modify: `docs/plans/2026-09-26-https-likes-sync-design.md:25` + 새 소절
- Add: `docs/plans/2026-09-27-likes-total-lag.md` (이 계획 문서. main 작업 트리에 미커밋 상태로 있음 → worktree로 복사해 함께 커밋)

**Interfaces:**
- Consumes: 기존 `fetchLikedGoodsViaHttps(cookie, { fetchFn, delayMs, retryDelayMs, pageSize, maxPages, onSetCookie })`, `LikesIncompleteError`, 테스트 헬퍼 `fakeFetch`, `routes`, `page`, `tab`, `goods`, `opts`, 상수 `COOKIE`, `FIRST`, `PAGE2` (모두 `tests/likes-https.test.js`에 이미 있음).
- Produces: `export const LIKES_TOTAL_LAG_TOLERANCE = 3;` (`src/likes-https.js`). 함수 시그니처와 반환 형태는 바뀌지 않는다.

- [ ] **Step 0: worktree 준비**

```bash
cd /Users/hyunjun_macbook_pro/Documents/Private/project-clot
git worktree add ../project-clot-likes-lag -b fix/likes-total-lag main
cp docs/plans/2026-09-27-likes-total-lag.md ../project-clot-likes-lag/docs/plans/
cd ../project-clot-likes-lag
npm test
```

Expected: 368 tests pass, 0 fail. 이후 모든 경로는 worktree 기준.

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/likes-https.test.js` 상단 import에 상수를 추가한다.

```js
import {
  fetchLikedGoodsViaHttps,
  LikesIncompleteError,
  LIKES_TAB_URL,
  LIKED_GOODS_URL,
  LIKES_TOTAL_LAG_TOLERANCE,
} from '../src/likes-https.js';
```

`const opts = ...` 줄 바로 아래에 헬퍼 두 개를 추가한다.

```js
const likes = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => goods(from + i));
function captureWarn(t) {
  const warns = [];
  t.mock.method(console, 'warn', (...a) => warns.push(a.join(' ')));
  return warns;
}
```

기존 테스트 이름만 바꾼다(본문 그대로).

```js
  test('fewer than the total -> LikesIncompleteError (would mass-unlike)', async () => {
```

기존 `describe('fetchLikedGoodsViaHttps', ...)` 블록이 끝난 뒤, 파일 끝에 새 describe를 추가한다.

```js
describe('fetchLikedGoodsViaHttps: listed count vs like total', () => {
  const NOTICE = /^\[Sync HTTPS Notice\] like total lags the list \((\d+) listed, total (\d+)\); accepting$/;

  test('tolerance is 3', () => {
    assert.equal(LIKES_TOTAL_LAG_TOLERANCE, 3);
  });

  test('equal counts -> no notice', async (t) => {
    const warns = captureWarn(t);
    const fetchFn = fakeFetch(routes(3, { [FIRST]: page(likes(1, 3)) }));
    assert.equal((await fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn))).length, 3);
    assert.deepEqual(warns, []);
  });

  test('list one over the total (total API lags) -> accepted with a notice', async (t) => {
    const warns = captureWarn(t);
    const fetchFn = fakeFetch(routes(2, { [FIRST]: page(likes(1, 2), PAGE2), [PAGE2]: page([goods(3)]) }));
    const items = await fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn));
    assert.deepEqual(items.map((i) => i.goodsNo), [1, 2, 3]);
    assert.equal(warns.length, 1);
    assert.equal(warns[0], '[Sync HTTPS Notice] like total lags the list (3 listed, total 2); accepting');
    assert.doesNotMatch(warns[0], /cursor|c2|lastIndex|secret|app_atk|app_rtk/);
  });

  test('exactly total + tolerance -> accepted with a notice', async (t) => {
    const warns = captureWarn(t);
    const n = 1 + LIKES_TOTAL_LAG_TOLERANCE;
    const fetchFn = fakeFetch(routes(1, { [FIRST]: page(likes(1, n)) }));
    assert.equal((await fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn))).length, n);
    assert.equal(warns.length, 1);
    assert.deepEqual(warns[0].match(NOTICE).slice(1), [String(n), '1']);
  });

  test('over total + tolerance -> LikesIncompleteError, no notice', async (t) => {
    const warns = captureWarn(t);
    const n = 1 + LIKES_TOTAL_LAG_TOLERANCE + 1;
    const fetchFn = fakeFetch(routes(1, { [FIRST]: page(likes(1, n)) }));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn)), (err) => {
      assert.ok(err instanceof LikesIncompleteError);
      assert.equal(err.message, `received ${n} liked goods, total 1 (more than ${LIKES_TOTAL_LAG_TOLERANCE} over)`);
      return true;
    });
    assert.deepEqual(warns, []);
  });

  test('total 0 with a small list -> accepted with a notice', async (t) => {
    const warns = captureWarn(t);
    const fetchFn = fakeFetch(routes(0, { [FIRST]: page(likes(1, 2)) }));
    assert.equal((await fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn))).length, 2);
    assert.deepEqual(warns[0].match(NOTICE).slice(1), ['2', '0']);
  });

  test('duplicates and banners never count as surplus', async (t) => {
    const warns = captureWarn(t);
    const fetchFn = fakeFetch(routes(2, {
      [FIRST]: page([goods(1), { itemType: 'BANNERS' }, goods(2)], PAGE2),
      [PAGE2]: page([goods(2), { itemType: 'AD_GOODS', content: [goods(99)] }, goods(1)]),
    }));
    assert.deepEqual((await fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn))).map((i) => i.goodsNo), [1, 2]);
    assert.deepEqual(warns, []);
  });

  test('a total change during paging still wins over the surplus rule', async (t) => {
    const warns = captureWarn(t);
    let tabHits = 0;
    const fetchFn = fakeFetch((url) => (url === LIKES_TAB_URL ? tab(++tabHits === 1 ? 2 : 3) : page(likes(1, 3))));
    await assert.rejects(fetchLikedGoodsViaHttps(COOKIE, opts(fetchFn)), /changed during paging \(2 -> 3\)/);
    assert.deepEqual(warns, []);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test tests/likes-https.test.js`
Expected: FAIL. 파일 로드 단계에서 `SyntaxError: The requested module '../src/likes-https.js' does not provide an export named 'LIKES_TOTAL_LAG_TOLERANCE'`가 난다. 상수만 임시로 추가해 다시 돌리면 `list one over`, `exactly total + tolerance`, `total 0 with a small list`가 `received 3 of 2` 같은 메시지로 실패하고 `over total + tolerance`는 메시지 불일치로 실패하는 것도 확인할 수 있다(선택).

- [ ] **Step 3: 최소 구현**

`src/likes-https.js`의 `LOGGED_OUT_CODE` 줄 아래에 추가한다.

```js
// The tab total lags the list right after new likes (observed +1 twice, 2026-09-27).
// A surplus only keeps an unliked item tracked a day longer; a shortfall would mass-unlike.
export const LIKES_TOTAL_LAG_TOLERANCE = 3;
```

JSDoc(`:62-66`)을 다음으로 바꾼다.

```js
/**
 * Every liked goods item over authenticated HTTPS (like.musinsa.com), sequentially.
 * Throws instead of returning a partial list: the caller would otherwise mark the
 * missing items UNLIKED. A small surplus over the total is accepted (the total lags).
 */
```

`:121-123`을 다음으로 바꾼다.

```js
  const received = byGoodsNo.size;
  if (received < expected) {
    throw new LikesIncompleteError(`received ${received} of ${expected} liked goods`);
  }
  if (received > expected + LIKES_TOTAL_LAG_TOLERANCE) {
    throw new LikesIncompleteError(
      `received ${received} liked goods, total ${expected} (more than ${LIKES_TOTAL_LAG_TOLERANCE} over)`
    );
  }
  if (received > expected) {
    console.warn(`[Sync HTTPS Notice] like total lags the list (${received} listed, total ${expected}); accepting`);
  }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test tests/likes-https.test.js`
Expected: PASS. 기존 테스트(`fewer than the total` 포함 `/2 of 3/`)도 통과한다.

Run: `npm test`
Expected: 376 tests pass (368 + 새 테스트 8개), 0 fail.

- [ ] **Step 5: 설계 문서 갱신**

`docs/plans/2026-09-26-https-likes-sync-design.md:25`를 다음으로 바꾼다.

```markdown
- 고유 상품 수 < 전체 개수, 고유 상품 수 > 전체 개수 + 3, 401 두 번, 스키마 불일치, 페이지 끊김 → 결과 전체를 버린다. 부분 반영 없음. 전체 개수보다 1~3개 많은 목록은 받아들이고 알림 한 줄을 남긴다(아래 "개수 API 지연").
```

같은 문서의 `## Not in this round` 바로 위에 소절을 추가한다.

```markdown
### 개수 API 지연 (2026-09-27 추가)

좋아요를 추가한 직후 `tab.data.goods`가 목록보다 늦게 갱신된다. 페이징 전후 총수는 같았으므로 페이징 중 변동이 아니다.

| 시점 | 목록의 고유 GOODS | `tab.data.goods` | 당시 결과 |
|---|---|---|---|
| 아침 deferred 실행 | 113 | 112 | 목록을 버림, 동기화 건너뜀 |
| 11시대 upgrade 실행 | 114 | 113 | 목록을 버리고 OpenCLI 폴백 |
| 11:3x 직접 조회 | 114 | 114 | 일치 |

규칙(`LIKES_TOTAL_LAG_TOLERANCE = 3`): 모자라면 버린다(대량 UNLIKED 위험). 1~3개 많으면 받아들이고 `[Sync HTTPS Notice] like total lags the list (X listed, total Y); accepting`을 남긴다. 3개를 넘게 많으면 다른 목록이 섞였거나 API가 바뀐 것으로 보고 버린다. 남는 쪽의 최악은 취소한 좋아요가 하루 더 ACTIVE로 추적되는 것이다. 총수를 기다렸다 다시 읽는 방식은 지연 폭을 몰라 택하지 않았다.
```

- [ ] **Step 6: 최종 확인과 커밋**

```bash
npm test
git status --short
```

Expected: 테스트 전부 통과. `git status`에 `src/likes-https.js`, `tests/likes-https.test.js`, `docs/plans/2026-09-26-https-likes-sync-design.md`, `docs/plans/2026-09-27-likes-total-lag.md`만 있고 `data/prices.db`는 없다.

```bash
git add src/likes-https.js tests/likes-https.test.js docs/plans/2026-09-26-https-likes-sync-design.md docs/plans/2026-09-27-likes-total-lag.md
git commit -m "$(cat <<'EOF'
fix(likes): accept a small surplus when the like total lags the list

The like tab total trails the liked list right after new likes (113/112 and
114/113 on 2026-09-27), so strict equality discarded good lists. Keep
rejecting a shortfall (would mass-unlike) and a surplus over 3; accept up to
3 extra with a count-only notice.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: 병합**

```bash
cd /Users/hyunjun_macbook_pro/Documents/Private/project-clot
diff docs/plans/2026-09-27-likes-total-lag.md ../project-clot-likes-lag/docs/plans/2026-09-27-likes-total-lag.md
rm docs/plans/2026-09-27-likes-total-lag.md
git merge --ff-only fix/likes-total-lag
npm test
git worktree remove ../project-clot-likes-lag
git branch -d fix/likes-total-lag
```

Expected: `diff`는 출력 없음(다르면 worktree 쪽이 최신이니 그대로 진행). main의 미추적 계획 파일은 병합을 막으므로 먼저 지운다. 병합은 fast-forward, `npm test` 전부 통과. 그사이 daily가 main에 커밋해 fast-forward가 안 되면 worktree에서 `git rebase main` 후 다시 병합한다. push는 하지 않는다(다음 daily가 푸시).
