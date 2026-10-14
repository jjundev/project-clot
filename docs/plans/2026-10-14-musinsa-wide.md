# 무신사 와이드 스캔 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 무신사 5개 대분류 × 누적 리뷰순 상위 6,000개(약 3만 개)를 매일 비로그인으로 스캔하고, 하루 최대 4,000개 상품의 내 쿠폰을 상품별로 돌아가며 조회해 저장한 뒤, 전 상품의 쿠폰가를 로컬 계산해 Release DB에 변경분만 기록한다.

> **재설계 (2026-10-14):** 관문 B 실패(키 예측 63%)로 브랜드×대분류 학습·자가검증을 버리고 상품별 순환 조회로 바꿨다(spec #0·#2·#8). Task 1–2는 원래 계획대로 완료됐고, Task 4·6·7·8이 새 설계로 바뀌었다.

**Architecture:**
- 새 모듈 `src/musinsaWide/`가 `src/site4910/`의 구조를 따른다: `client.js`(목록 체인 + 쿠폰 API) → `store.js`(변경분만, 상품별 쿠폰 목록) → `coupons.js`(계산·상품별 조회·쿠폰가 반영) → `track.js`(순서·예산) → `digest.js`.
- `src/site4910/release.js`를 `createRelease(config)`로 일반화하고, 무신사는 `src/musinsaWide/release.js`에서 자기 설정으로 쓴다.
- 0단계(Task 1–2)는 go/no-go 관문이다. 통과하지 못하면 Task 3 이후를 시작하지 않는다.

**Tech Stack:** Node 24 ESM, `node:sqlite`, `node:test`, `node:zlib`, `gh` CLI, GitHub Actions. 외부 npm 의존성 없음.

**Spec:** `docs/specs/2026-10-14-musinsa-wide.md`. 쿠폰 계산의 근거는 `.agents/verification/discount-rules-verification-report.md` §2(`ix = 10*floor(e/10)`, 쿠폰 할인액도 10원 절사).

## Global Constraints
- 대분류 `['001','002','003','103','004']`, `sortCode=REVIEW`, `gf=A`, 깊이 `100`페이지(페이지당 60).
- 첫 페이지 URL: `https://www.musinsa.com/categories/item/<cat>?gf=A&sortCode=REVIEW`. 이후 페이지는 응답의 `nextPageUrl`만 따른다(URL을 직접 만들지 않는다 — 403).
- 페이지 간격 `300`ms, 쿠폰 API 호출 간격 `700`ms(작업자 단위). 대분류 동시 스캔 `3`, 쿠폰 학습 동시 `3`.
- 예산: `BUDGET_MS_MUSINSA = 20 * 60_000`(스캔), `RUN_BUDGET_MS_MUSINSA = 35 * 60_000`(전체, 실행 시작부터). workflow 제한 45분.
- 쿠폰 할인: `P < min ? 0 : floor10(min(max ?? ∞, PERCENT ? P·percent/100 : price))`. 쿠폰가: `sale_price − extra_discount − max(0, 할인들)`.
- 쿠폰 조회: 상품별, 하루 최대 `4000`개(`COUPON_CHECKS_PER_DAY`), 목록 값(`goodsNo, brand, comId=brand, salePrice=price`)으로 호출. 조회 결과는 `10`일 유효(`COUPON_TTL_DAYS`), 그보다 오래됐거나 없으면 쿠폰가 NULL(`stale`). `until < date`인 쿠폰은 계산에서 뺀다.
- 조회 순서: 미조회 → 조회 후 `sale_price`·`extra_discount`가 바뀐 상품 → `coupon_checked_date` 오래된 순, 동률 `goods_no`. ACTIVE·품절 아님·`sale_price` 있음만. 같은 날 이미 조회한 상품은 다시 조회하지 않는다.
- `OUT_OF_SCOPE`: 완전한 대분류 스캔에서 `2`회 연속 미노출(`OUT_AFTER_MISSES`). 하락 알림 기준 `0.1`(`DROP_ALERT_RATE`), 상위 `10`개.
- Release 태그 `data-musinsa`(prerelease), 첨부 `musinsa-wide.db.gz` / `musinsa-wide.db.prev.gz` / `musinsa-wide.db.<YYYY-MM-DD>.gz`(최근 7개).
- DB 경로 `CLOT_MUSINSA_WIDE_DB_PATH` 또는 `data/musinsa-wide.db`. git에 넣지 않는다.
- 쿠키 값은 로그·에러·텔레그램 어디에도 찍지 않는다. 텔레그램 한 통 4096자 이하, `parse_mode=HTML` 이스케이프.
- 모든 테스트 파일 첫 줄은 `import './setup-env.js';`(`tests/test-isolation.test.js`).
- 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. **대분류 체인이 중간에 끊김**(403·429·빈 응답·마감 시간) → 그 대분류만 불완전, 그 대분류 상품은 miss를 세지 않는다. 다른 대분류에는 영향 없음. (Task 5, Task 4 테스트)
2. **6,000위 경계에서 하루 빠졌다 돌아오는 상품** → 1회 미노출로는 ACTIVE 유지, 완전 스캔 2회 연속이어야 `OUT_OF_SCOPE`, 돌아오면 REVIVED. (Task 4 테스트)
3. **쿠키 없음 / 조회 도중 만료 / 429** → 스캔·저장은 정상, 쿠폰가는 저장된 쿠폰 목록으로 계속 계산(10일 지나면 NULL), 요약에 경고, 출력 어디에도 쿠키 문자열 없음. (Task 6·7·8 테스트)
4. **같은 날 재실행** → `price_changes` 중복 없음, miss는 날짜당 1회, `coupon_price_changes`는 그날 행을 교체. (Task 4 테스트)
5. **조회가 오래된 상품 / 조회 뒤 만료된 쿠폰** → 10일 넘은 조회는 쿠폰가 NULL, 만료 쿠폰은 빼고 계산(틀린 값을 공개하지 않음). (Task 6 테스트)

---

### Task 1: 0단계 검증 ① — 원시 응답 수집과 파라미터 동등성

**Files:**
- Create: `scripts/musinsa-coupon-verify.js`
- Create: `docs/verify/musinsa-coupon-price.md`

**Interfaces:**
- Consumes: `fetchCategoryGoodsPage(cat, url, fetchFn)` (`src/discovery.js:79` — HTML URL을 넘기면 첫 페이지 파싱), `extractProductDetail(html, goodsNo)` (`src/myprice.js:59`), `readSessionCookie()` (`src/session.js:266`), `USER_AGENT` (`src/myprice.js:44`).
- Produces: `logs/musinsa-coupon-verify.json` (gitignored) — `{ fetchedAt, goods: [{ key, cat, brand, goodsNo, salePrice, extraDiscount, rank: 'high'|'mid'|'low', listingParamsCoupons: raw[], fullParamsCoupons: raw[], detailParams: { brand, comId, specialtyCodes } }] }`. `docs/verify/musinsa-coupon-price.md` §1(동등성 결과), §2(쿠폰 원시 필드 표: id·이름·율·정액·최대·최소·이 상품 할인액 각각의 필드명).

- [ ] **Step 1: `node scripts/musinsa-coupon-verify.js dump` 구현**
  - 대분류마다 REVIEW 1–3페이지를 받아 `brand|cat`으로 묶고, 상품 3개 이상인 키를 대분류당 최대 6개(총 30) 고른다. 키마다 가격 최고·중앙·최저 3개.
  - 상품마다: 목록 값(`goodsNo, brand, comId=brand, salePrice=price`)으로 쿠폰 API 1회 → 쿠키를 붙여 상품 페이지에서 `brand, comId, specialtyCodes`를 읽어 쿠폰 API 1회 더. 호출 사이 700ms.
  - 쿠키가 없으면 `~/.clot/musinsa-session.json 없음`을 출력하고 exit 1. 쿠키 값은 출력하지 않는다.
  - 끝에 출력: `동등: <n>/<total> (쿠폰 id 집합과 각 쿠폰 할인액이 같은 상품)`.

- [ ] **Step 2: 실행**

Run: `node scripts/musinsa-coupon-verify.js dump`
Expected: `logs/musinsa-coupon-verify.json` 생성, 마지막 줄 `동등: n/≈90`.

- [ ] **Step 3: `docs/verify/musinsa-coupon-price.md` §1·§2 작성**
  §1: 동등 비율과 다른 경우의 예(상품번호, 차이). §2: 덤프의 쿠폰 원시 객체 1개 예시와 필드 표. 쿠폰 이름은 공개해도 된다(spec #12). 쿠키·회원 정보는 쓰지 않는다.

- [ ] **Step 4: 관문 A**
  동등 비율이 95% 미만이면 여기서 멈추고 사용자에게 보고한다(표본마다 상품 페이지가 필요 → 키당 비용 약 5초, 재설계 필요).

- [ ] **Step 5: Commit**

```bash
git add scripts/musinsa-coupon-verify.js docs/verify/musinsa-coupon-price.md
git commit -m "chore(musinsa): coupon API verification dump and parameter check"
```

---

### Task 2: 0단계 검증 ② — 쿠폰 계산식과 키 단위 일치율

**Files:**
- Create: `src/musinsaWide/coupons.js` (이 Task에서는 순수 함수만)
- Modify: `scripts/musinsa-coupon-verify.js` (`evaluate` 모드 추가)
- Modify: `docs/verify/musinsa-coupon-price.md` (§3)
- Test: `tests/musinsa-wide-coupons.test.js`

**Interfaces:**
- Produces (`src/musinsaWide/coupons.js`):
  - `COUPON_FIELDS: { id, name, rate, amount, max, min, discount }` — Task 1 §2 표의 원시 필드명.
  - `parseCoupon(raw) -> { id: string, name: string|null, type: 'PERCENT'|'PRICE', percent: number|null, price: number|null, max: number|null, min: number, discount: number }`. 율 필드가 있으면 PERCENT, 없으면 이름의 `(\d+)%`로 PERCENT, 그것도 없으면 PRICE(`price = discount`). `max` 없으면 null, `min` 없으면 0.
  - `couponDiscountMusinsa(P: number, c) -> number`, `couponPriceMusinsa({ sale_price, extra_discount }, coupons) -> number|null` (`sale_price == null`이면 null).
  - `keyCouponSet(samples: Array<{ salePrice: number, coupons: Parsed[] }>) -> Parsed[] | null` — 아래 규칙.

`keyCouponSet` 규칙(시그니처로 정해지지 않는 부분):
```
합집합(id 기준). 쿠폰 c가 가격 p_absent 표본에 없고 p_present 표본에 있을 때:
  p_absent < p_present 이면 c.min = max(c.min, p_absent + 1)   // 최소금액 때문으로 본다
  p_absent >= p_present 이면 모순 → null 반환(키 숨김, 'scope')
```

- [ ] **Step 1: 실패하는 테스트 작성** (`tests/musinsa-wide-coupons.test.js`)

```js
test('couponDiscountMusinsa floors to 10 won, honours min and max', () => {
  assert.equal(couponDiscountMusinsa(47390, { type: 'PERCENT', percent: 5, price: null, max: null, min: 0 }), 2360);
  assert.equal(couponDiscountMusinsa(101400, { type: 'PERCENT', percent: 12, price: null, max: null, min: 0 }), 12160);
  assert.equal(couponDiscountMusinsa(300000, { type: 'PERCENT', percent: 20, price: null, max: 30000, min: 0 }), 30000);
  assert.equal(couponDiscountMusinsa(9000, { type: 'PRICE', percent: null, price: 3000, max: null, min: 10000 }), 0);
});
test('couponPriceMusinsa subtracts extra discount and the single best coupon', () => {
  const cs = [{ type: 'PERCENT', percent: 5, price: null, max: null, min: 0 }, { type: 'PRICE', percent: null, price: 3000, max: null, min: 0 }];
  assert.equal(couponPriceMusinsa({ sale_price: 98100, extra_discount: 1960 }, cs), 98100 - 1960 - 4900);
  assert.equal(couponPriceMusinsa({ sale_price: 50000, extra_discount: 0 }, []), 50000);
  assert.equal(couponPriceMusinsa({ sale_price: null, extra_discount: 0 }, cs), null);
});
// raw는 COUPON_FIELDS 키로 만든다(Task 1 §2의 실제 필드명).
test('parseCoupon reads an explicit rate as PERCENT', ...);              // rate 12 → { type: 'PERCENT', percent: 12 }
test('parseCoupon falls back to the name percent', ...);                 // 율 필드 없음, name '실버정기 5%' → percent 5
test('parseCoupon falls back to a fixed amount of the discount', ...);   // 율·이름% 없음, discount 3000 → { type: 'PRICE', price: 3000 }
test('parseCoupon defaults max to null and min to 0', ...);
test('keyCouponSet infers a minimum from a cheaper sample without the coupon', () => {
  const a = { id: 'A', type: 'PERCENT', percent: 10, price: null, max: null, min: 0, discount: 0 };
  const set = keyCouponSet([{ salePrice: 80000, coupons: [a] }, { salePrice: 20000, coupons: [] }]);
  assert.equal(set[0].min, 20001);
});
test('keyCouponSet hides a key whose cheaper sample has a coupon the pricier lacks', () => {
  const a = { id: 'A', type: 'PERCENT', percent: 10, price: null, max: null, min: 0, discount: 0 };
  assert.equal(keyCouponSet([{ salePrice: 80000, coupons: [] }, { salePrice: 20000, coupons: [a] }]), null);
});
```
(앞의 두 테스트 값은 검증보고서 §4의 2705799·2341126·2741233 행에서 왔다.)

- [ ] **Step 2: 실패 확인** — Run: `node --test tests/musinsa-wide-coupons.test.js` / Expected: FAIL (모듈 없음)

- [ ] **Step 3: 위 함수들을 `src/musinsaWide/coupons.js`에 구현.** `floor10`은 `src/discovery.js`에서 import한다.

- [ ] **Step 4: 통과 확인** — Run: `node --test tests/musinsa-wide-coupons.test.js` / Expected: PASS

- [ ] **Step 5: `evaluate` 모드 추가.** 덤프를 읽어 두 숫자를 출력한다.
  - `식 재현: n/N` — 모든 상품·쿠폰에서 `couponDiscountMusinsa(salePrice, parseCoupon(raw)) === parsed.discount`
  - `키 예측: n/M (숨김 h)` — 키마다 high·low로 `keyCouponSet`을 만들어 mid의 최대 할인을 예측하고 API 값과 비교. 숨김 키는 M에서 빼고 h로 센다.

Run: `node scripts/musinsa-coupon-verify.js evaluate`
Expected: 두 줄 출력.

- [ ] **Step 6: §3 작성과 관문 B.** 식 재현 95% 이상, 키 예측 90% 이상, 숨김 키 20% 이하가 모두 맞아야 Task 3으로 간다. 아니면 멈추고 숫자와 어긋난 예를 사용자에게 보고한다.

- [ ] **Step 7: Commit**

```bash
git add src/musinsaWide/coupons.js tests/musinsa-wide-coupons.test.js scripts/musinsa-coupon-verify.js docs/verify/musinsa-coupon-price.md
git commit -m "feat(musinsa): coupon price math and key coupon set, verified against the API"
```

---

### Task 3: Release 업로드를 설정 가능하게

**Files:**
- Modify: `src/site4910/release.js` (전체 — 상수를 config로)
- Create: `src/musinsaWide/release.js`
- Test: `tests/site4910-release.test.js`(변경 없이 통과해야 함), `tests/musinsa-wide-release.test.js`

**Interfaces:**
- Produces:
  - `createRelease({ tag, asset, prevAsset, datedAsset: (date) => string, datedRe: RegExp, keep, title, notes, label, cliName }) -> { pullDb, pushDb }` — 시그니처와 동작은 지금의 `pullDb`/`pushDb`와 같다. 로그 접두어는 `[${label}]`, 새 DB 거부 메시지의 명령은 `` `${cliName} pull` ``.
  - `src/site4910/release.js`는 기존 export(`RELEASE_TAG_4910`, `ASSET_4910`, `PREV_ASSET_4910`, `DATED_KEEP_4910`, `datedAsset4910`, `defaultRun`, `pullDb`, `pushDb`)를 그대로 유지하고, `pullDb`/`pushDb`는 4910 설정의 `createRelease` 결과.
  - `src/musinsaWide/release.js`: `RELEASE_TAG_MUSINSA = 'data-musinsa'`, `ASSET_MUSINSA = 'musinsa-wide.db.gz'`, `PREV_ASSET_MUSINSA = 'musinsa-wide.db.prev.gz'`, `datedAssetMusinsa(date)`, `pullDb`, `pushDb` (label `musinsa-db`, cliName `node src/cli.js musinsa-db`, notes `Daily Musinsa wide DB (managed by .github/workflows/musinsa-wide.yml)`).
  - `prepareForPush`의 `goods`/`scan_runs` 검사는 두 DB 모두에 그대로 적용된다(Task 4 스키마가 두 테이블을 갖는다).

- [ ] **Step 1: 실패하는 테스트** (`tests/musinsa-wide-release.test.js`, `tests/site4910-release.test.js`의 `fakeRun`·`scratch` 패턴 복사)

```js
test('musinsa pushDb uploads under data-musinsa with musinsa asset names', () => {
  // makeDb: MusinsaWideStore 대신 sqlite로 goods(goods_no) 2행 + scan_runs 2일
  const run = fakeRun();
  pushDb({ src, run, tmpDir, date: '2026-10-14' });
  const uploads = run.calls.filter((c) => c.args[1] === 'upload').map((c) => [c.args[2], path.basename(c.args[3])]);
  assert.deepEqual(uploads.map((u) => u[0]), ['data-musinsa', 'data-musinsa']);
  assert.deepEqual(uploads.map((u) => u[1]), ['musinsa-wide.db.2026-10-14.gz', 'musinsa-wide.db.gz']);
});
test('musinsa pushDb refuses a one-day DB and names musinsa-db pull', () => {
  assert.throws(() => pushDb({ src: oneDay, run: fakeRun(), tmpDir }), /musinsa-db pull/);
});
```

- [ ] **Step 2: 실패 확인** — Run: `node --test tests/musinsa-wide-release.test.js` / Expected: FAIL

- [ ] **Step 3: `createRelease` 추출, 두 설정 파일 작성**

- [ ] **Step 4: 통과 확인** — Run: `node --test tests/musinsa-wide-release.test.js tests/site4910-release.test.js tests/cli-4910.test.js` / Expected: 모두 PASS

- [ ] **Step 5: Commit**

```bash
git add src/site4910/release.js src/musinsaWide/release.js tests/musinsa-wide-release.test.js
git commit -m "refactor(release): configurable Release DB storage; add data-musinsa"
```

---

### Task 4: `MusinsaWideStore`

**Files:**
- Create: `src/musinsaWide/store.js`
- Modify: `tests/setup-env.js` (`CLOT_MUSINSA_WIDE_DB_PATH`를 임시 경로로), `.gitignore` (`data/musinsa-wide.db`, `data/musinsa-wide.db-*`)
- Test: `tests/musinsa-wide-store.test.js`

**Interfaces:**
- Consumes: 없음 (`src/site4910/store.js`를 구조 참고용으로만).
- Produces:
  - `defaultMusinsaWideDbPath()`, `OUT_AFTER_MISSES = 2`, `DROP_ALERT_RATE = 0.1`, `STATUS_OUT_OF_SCOPE = 'OUT_OF_SCOPE'`
  - 행 형태 `ListingRow = { goods_no, cat, brand, brand_name, name, url, image_url, sale_price, normal_price, extra_discount, is_sold_out }`
  - `class MusinsaWideStore(dbPath)`:
    - `isEmpty() -> boolean`
    - `applyScan(date, rows: ListingRow[], { cat, complete }) -> { added: ListingRow[], priceChanged: number, drops: Array<{ row, prevPrice, currentPrice, dropRate }>, revived: ListingRow[], outOfScope: number }`
    - `pickCouponChecks(n, date) -> Array<{ goods_no, brand, sale_price, extra_discount }>` — Global Constraints의 조회 순서. `coupon_checked_date = date`인 상품은 제외.
    - `putGoodsCoupons(goodsNo, date, coupons: Parsed[], { sale_price, extra_discount })` — `coupons_json`, `coupon_checked_date = date`, `coupon_checked_sale_price`, `coupon_checked_extra`를 쓴다.
    - `getActivePriceRows() -> Array<{ goods_no, sale_price, extra_discount, coupon_checked_date, coupons: Parsed[]|null }>`
    - `setCouponPrices(Map<goods_no, number|null>)`
    - `logCouponPriceChanges(date, rows: Array<{ goods_no, sale_price, coupon_price }>) -> { written: number, drops: Array<{ goods_no, prevPrice, currentPrice, dropRate }> }`
    - `recordScanRun({ date, categoryCounts, complete, changed, added, outOfScope, durationMs, couponsOk, couponChecks })`
    - `getGoods(goodsNo)`, `getChanges(goodsNo)`, `checkpoint()`, `close()`

스키마:
```sql
goods(goods_no INTEGER PRIMARY KEY, cat TEXT, brand TEXT, brand_name TEXT, name TEXT NOT NULL, url TEXT NOT NULL, image_url TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE', sale_price INTEGER, normal_price INTEGER, extra_discount INTEGER NOT NULL DEFAULT 0,
  is_sold_out INTEGER NOT NULL DEFAULT 0, coupon_price INTEGER, coupons_json TEXT, coupon_checked_date TEXT,
  coupon_checked_sale_price INTEGER, coupon_checked_extra INTEGER,
  lowest_price INTEGER, lowest_price_date TEXT, first_seen_date TEXT NOT NULL, misses INTEGER NOT NULL DEFAULT 0, last_miss_date TEXT)
price_changes(id INTEGER PRIMARY KEY AUTOINCREMENT, goods_no INTEGER NOT NULL, date TEXT NOT NULL, sale_price INTEGER, normal_price INTEGER, event TEXT NOT NULL)
coupon_price_changes(goods_no INTEGER NOT NULL, date TEXT NOT NULL, sale_price INTEGER NOT NULL, coupon_price INTEGER, PRIMARY KEY (goods_no, date))
scan_runs(date TEXT PRIMARY KEY, category_counts_json TEXT, complete INTEGER, changed INTEGER, added INTEGER, out_of_scope INTEGER,
  duration_ms INTEGER, completed_at TEXT NOT NULL, coupons_ok INTEGER, coupon_checks INTEGER)
-- 인덱스: price_changes(goods_no, date), goods(cat, status), goods(status, coupon_checked_date)
```
`applyScan`은 `Store4910.applyScan`(`src/site4910/store.js:110-216`)과 같은 방식이다. 바뀐 칸이 있을 때만 행을 다시 쓰고, 이벤트는 NEW·PRICE·REVIVED만 기록한다. 다른 점은 세 가지다:
1. 기존 행을 `cat = ? OR goods_no IN rows`로 읽는다. 다른 대분류에서 넘어온 상품도 이렇게 해야 PK 충돌이 없다.
2. miss는 `complete`일 때 그 `cat`의 ACTIVE 행에만 날짜당 1회 센다.
3. `misses >= OUT_AFTER_MISSES`이면 `OUT_OF_SCOPE`로 바꾸고 `price_changes`에는 기록하지 않는다. 반환값의 `outOfScope`는 이렇게 바뀐 수다.

- [ ] **Step 1: 실패하는 테스트** (`tests/musinsa-wide-store.test.js`)

```js
test('applyScan logs NEW once and skips unchanged rows', ...);           // 두 번째 같은 스캔 → getChanges 길이 1
test('a price change logs PRICE and a >=10% drop', ...);                 // 50000→44000 → drops[0].dropRate === 12
test('one complete miss keeps ACTIVE; two consecutive go OUT_OF_SCOPE without a price_changes row', ...);
test('a same-day rerun counts the miss once', ...);                      // 같은 date로 두 번 → misses === 1
test('an incomplete category scan counts no misses', ...);               // complete:false → misses === 0
test('a miss in 001 never touches 002 rows', ...);
test('an OUT_OF_SCOPE listing that reappears is REVIVED', ...);
test('a listing seen under another cat updates in place', ...);          // 001에서 본 goods_no를 002 스캔에 → 충돌 없음, cat === '002'
test('logCouponPriceChanges writes only changes and reports coupon-to-coupon drops', ...);
  // 전날 (50000, 45000), 오늘 (50000, 40000) → written 1, drops[0].dropRate === 11
  // 전날 coupon_price null → drop 없음; 같은 쌍이면 written 0; 같은 날 재실행이면 행 교체
test('pickCouponChecks orders never-checked, then price-changed since check, then oldest; skips sold-out and today-checked', ...);
test('putGoodsCoupons round-trips the coupon list through getActivePriceRows', ...);
```

- [ ] **Step 2: 실패 확인** — Run: `node --test tests/musinsa-wide-store.test.js` / Expected: FAIL

- [ ] **Step 3: `src/musinsaWide/store.js` 구현, `setup-env.js`·`.gitignore` 수정**

- [ ] **Step 4: 통과 확인** — Run: `node --test tests/musinsa-wide-store.test.js tests/test-isolation.test.js` / Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/musinsaWide/store.js tests/musinsa-wide-store.test.js tests/setup-env.js .gitignore
git commit -m "feat(musinsa): change-only wide store with OUT_OF_SCOPE after two complete misses"
```

---

### Task 5: 클라이언트 — 목록 체인과 쿠폰 API

**Files:**
- Create: `src/musinsaWide/client.js`
- Test: `tests/musinsa-wide-client.test.js`

**Interfaces:**
- Consumes: `fetchCategoryGoodsPage` (`src/discovery.js:79`), `USER_AGENT` (`src/myprice.js:44`).
- Produces:
  - 상수 `CATEGORIES_MUSINSA`, `SORT_MUSINSA = 'REVIEW'`, `GENDER_MUSINSA = 'A'`, `DEPTH_PAGES = 100`
  - `createMusinsaClient({ fetchFn = fetch, pageDelayMs = 300, couponDelayMs = 700, sleep } = {}) -> { getCategoryPage(cat, pageUrl|null) -> { items, nextPageUrl }, getUsableCoupons({ goodsNo, brand, salePrice }, cookie, { onSetCookie } = {}) -> raw[] }`
    - 쿠폰 API 401/403 → `err.code = 'MEMBER_AUTH'`로 throw(메시지에 쿠키 없음). 응답의 `Set-Cookie`는 `onSetCookie(headers.getSetCookie())`로 넘긴다. 그 밖의 non-ok는 `err.status`(예: 429)를 단 Error로 throw. 쿠폰 호출은 재시도하지 않는다(429 처리는 Task 6).
  - `toListingRow(item, cat) -> ListingRow | null` (`goodsNo` 없으면 null. `sale_price = item.price`, `extra_discount = item.extraDiscountAmount ?? 0`, `is_sold_out = item.isSoldOut ? 1 : 0`)
  - `scanCategory(client, cat, { maxPages = DEPTH_PAGES, deadline = Infinity }) -> { cat, rows: Map<goods_no, ListingRow>, pages, complete, problems: string[] }`
    - 페이지 실패(throw/non-ok/빈 목록인데 `nextPageUrl` 있음)는 2초·4초 백오프로 최대 3회 시도. 그래도 실패하면 멈추고 `complete=false`.
    - `maxPages`에 닿거나 `nextPageUrl`이 없으면 `complete=true`. 마감 시간을 넘기면 `complete=false`, problems에 `deadline`.

- [ ] **Step 1: 실패하는 테스트** (가짜 `fetchFn`이 첫 HTML과 JSON 페이지를 돌려준다. 픽스처는 spec의 목록 항목 형태)

```js
test('scanCategory follows nextPageUrl and stops at maxPages as complete', ...);   // 3페이지 체인, maxPages 2 → pages 2, complete true
test('scanCategory requests the REVIEW first page and never builds page URLs', ...); // 요청 URL 1번째 sortCode=REVIEW&gf=A, 나머지는 응답 nextPageUrl 그대로
test('scanCategory skips items without goodsNo', ...);
test('a page that keeps failing ends the category incomplete with a problem', ...); // 403 ×3 → complete false, rows는 앞 페이지까지
test('scanCategory past the deadline is incomplete', ...);
test('getUsableCoupons sends the cookie, passes Set-Cookie on, and maps 401 to MEMBER_AUTH without the cookie in the message', ...);
test('getUsableCoupons throws a 429 with err.status 429 and no retry', ...);
```

- [ ] **Step 2: 실패 확인** — Run: `node --test tests/musinsa-wide-client.test.js` / Expected: FAIL

- [ ] **Step 3: 구현.** 첫 페이지는 `fetchCategoryGoodsPage(cat, 'https://www.musinsa.com/categories/item/<cat>?gf=A&sortCode=REVIEW', fetchFn)`, 이후는 `fetchCategoryGoodsPage(cat, nextPageUrl, fetchFn)`.

- [ ] **Step 4: 통과 확인** — Run: `node --test tests/musinsa-wide-client.test.js tests/discovery.test.js` / Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/musinsaWide/client.js tests/musinsa-wide-client.test.js
git commit -m "feat(musinsa): REVIEW category chain scanner and usable-coupon client"
```

---

### Task 6: 상품별 쿠폰 조회와 쿠폰가 반영

**Files:**
- Modify: `src/musinsaWide/coupons.js`
- Modify: `scripts/musinsa-coupon-verify.js` (`keyCouponSet`을 이 스크립트 안으로 옮긴다 — `evaluate`만 쓴다)
- Test: `tests/musinsa-wide-coupons.test.js` (`keyCouponSet` 테스트 2개는 삭제)

**Interfaces:**
- Consumes: Task 2 `parseCoupon`·`couponPriceMusinsa`, Task 4 store 메서드(`pickCouponChecks`, `putGoodsCoupons`, `getActivePriceRows`, `setCouponPrices`, `logCouponPriceChanges`), Task 5 `getUsableCoupons`, `mapConcurrent`/`clientPool` (`src/pool.js`), `sessionProvider` (`makeSessionProvider` 결과, `src/session.js:616` — `provider()`, `provider({ refresh: true, failedCookie })`, `provider.absorb(setCookieHeaders)`).
- Produces:
  - 상수 `COUPON_CHECKS_PER_DAY = 4000`, `COUPON_TTL_DAYS = 10`
  - `checkGoodsCoupons({ withClient, store, date, sessionProvider, limit = COUPON_CHECKS_PER_DAY, concurrency = 3, deadline, log }) -> { memberStatus: 'ok'|'none'|'expired'|'throttled'|'error', checked: number, failed: number }`
    - `sessionProvider`가 null이거나 쿠키를 못 주면 `'none'`, 쿠폰 호출 없음.
    - `store.pickCouponChecks(limit, date)`의 상품마다 `getUsableCoupons` → raw를 `parseCoupon`, `id`로 중복 제거 → `putGoodsCoupons`. 마감 시간이 지나면 새 상품을 시작하지 않는다.
    - `MEMBER_AUTH`: run 전체에서 1회만 `sessionProvider({ refresh: true, failedCookie })`로 갱신하고 그 상품을 다시 시도. 그래도 실패하면 조회를 멈추고 `'expired'`.
    - HTTP 429: 조회를 멈추고 `'throttled'`(그때까지 조회한 결과는 저장된 채로 둔다).
    - 그 밖의 예외는 그 상품만 건너뛰고 `failed`를 센다(로그는 상품번호와 상태만, 연속 실패도 한 줄씩).
    - `Set-Cookie`는 `onSetCookie`로 `sessionProvider.absorb`에 넘긴다.
  - `applyCouponPrices({ store, date }) -> { priced: number, stale: number, drops: Array<{ goods_no, prevPrice, currentPrice, dropRate }> }` (drops는 하락률 내림차순)
    - ACTIVE 상품마다: `coupon_checked_date`가 있고 `date`로부터 `COUPON_TTL_DAYS`일 이내면 `couponPriceMusinsa(row, coupons.filter(c => !c.until || c.until >= date))`, 아니면 null(`stale`로 센다).
    - `setCouponPrices` → `logCouponPriceChanges` → drops 반환. 세션이 없어도 실행된다(로컬 계산).

- [ ] **Step 1: 실패하는 테스트** (가짜 client와 가짜 `sessionProvider`. 테스트 끝에 모든 로그 문자열에 가짜 쿠키 값이 없는지 `assert.ok(!logs.join().includes(COOKIE))`)

```js
test('checkGoodsCoupons stores each picked goods coupons and applyCouponPrices prices it', ...);
test('no session → memberStatus none, no coupon calls', ...);
test('MEMBER_AUTH refreshes once and retries; a second failure is expired and never logs the cookie', ...);
test('429 stops checking as throttled and keeps what was checked', ...);
test('a failing goods is skipped and counted as failed', ...);
test('checking past the deadline starts no new goods', ...);
test('a check 11 days old is stale and priced null; 9 days old is priced', ...);
test('an expired coupon (until before date) is left out of the price', ...);
```

- [ ] **Step 2: 실패 확인** — Run: `node --test tests/musinsa-wide-coupons.test.js` / Expected: 새 테스트 FAIL

- [ ] **Step 3: 구현.** `keyCouponSet`은 `src/musinsaWide/coupons.js`에서 빼서 `scripts/musinsa-coupon-verify.js`로 옮기고 그 테스트 2개를 지운다. `node scripts/musinsa-coupon-verify.js evaluate`는 같은 두 줄을 그대로 출력해야 한다.

- [ ] **Step 4: 통과 확인** — Run: `node --test tests/musinsa-wide-coupons.test.js && node scripts/musinsa-coupon-verify.js evaluate` / Expected: PASS, `식 재현: 435/435`, `키 예측: 17/27`

- [ ] **Step 5: Commit**

```bash
git add src/musinsaWide/coupons.js tests/musinsa-wide-coupons.test.js scripts/musinsa-coupon-verify.js
git commit -m "feat(musinsa): rotating per-goods coupon checks and local coupon prices"
```

---

### Task 7: `trackMusinsa` 오케스트레이션

**Files:**
- Create: `src/musinsaWide/track.js`
- Test: `tests/musinsa-wide-track.test.js`

**Interfaces:**
- Consumes: Task 4–6 전부, `mapConcurrent`, `clientPool`.
- Produces:
  - `BUDGET_MS_MUSINSA`, `RUN_BUDGET_MS_MUSINSA`
  - `trackMusinsa({ makeClient, store, date, categories = CATEGORIES_MUSINSA, depthPages = DEPTH_PAGES, partial = false, concurrency = 3, dryRun = false, sessionProvider = null, budgetMs, runBudgetMs, log }) -> MusinsaResult`
  - `MusinsaResult = { date, categoryCounts: Array<{ cat, scanned, pages, complete, problems }>, diff: { initial, added, priceChanged, drops, revived, outOfScope } | null, coupons: { memberStatus, checked, failed, priced, stale, drops } | null, durationMs }`

순서:
1. 대분류를 `concurrency`로 동시 스캔한다. 대분류마다 로그 한 줄: `[무신사] ${cat}: ${scanned}개 ${pages}페이지` + 불완전이면 ` (불완전: ${problems 앞 3개 '; '로})`.
2. 모든 대분류의 `scanned`가 0이면 첫 problem으로 throw한다.
3. `dryRun`이면 `diff`·`coupons`를 null로 두고 반환한다.
4. 대분류마다 `applyScan(date, rows, { cat, complete: complete && !partial })`.
5. `checkGoodsCoupons`를 실행한다(마감은 `runDeadline`). 예외가 나면 `{ memberStatus: 'error', checked: 0, failed: 0 }`. `ok`가 아니면 로그 `⚠️ [무신사] 쿠폰 조회 ${memberStatus} — 저장된 쿠폰 목록으로 계산`.
6. `applyCouponPrices`는 상태와 상관없이 실행한다.
7. `recordScanRun`을 호출한다(`couponsOk = memberStatus === 'ok'`, `couponChecks = checked`).

`diff`는 대분류별 결과를 합친 것이고, drops는 하락률 내림차순이다. 4910 `mergeDiffs`처럼 spread 없이 하나씩 push한다.

- [ ] **Step 1: 실패하는 테스트** (가짜 `makeClient`가 대분류별 페이지를 돌려준다. store는 임시 파일)

```js
test('dry run scans and writes nothing', ...);
test('a full run records listings, checks coupons and prices them', ...);   // coupons.memberStatus 'ok', getGoods(x).coupon_price 계산값
test('one failing category is incomplete and its listings take no misses', ...);
test('every category failing throws', ...);
test('partial (--category/--depth) counts no misses anywhere', ...);
test('without a session the scan is stored and coupon prices come from the stored coupons', ...); // 전날 조회한 쿠폰으로 오늘 판매가 기준 쿠폰가, couponsOk 0, coupon_checks 0
```

- [ ] **Step 2: 실패 확인** — Run: `node --test tests/musinsa-wide-track.test.js` / Expected: FAIL

- [ ] **Step 3: 구현**

- [ ] **Step 4: 통과 확인** — Run: `node --test tests/musinsa-wide-track.test.js` / Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/musinsaWide/track.js tests/musinsa-wide-track.test.js
git commit -m "feat(musinsa): daily wide scan orchestration with scan and run budgets"
```

---

### Task 8: 텔레그램 요약

**Files:**
- Create: `src/musinsaWide/digest.js`
- Test: `tests/musinsa-wide-digest.test.js`

**Interfaces:**
- Consumes: `MusinsaResult` (Task 7), `store.getGoods` (drops의 이름·URL·브랜드).
- Produces: `formatMusinsaWideDigest(result, { limit = 10, lookup = (goodsNo) => row }) -> string`

정해진 문구(4910 `digest.js`와 같은 HTML 이스케이프와 4096자 자르기):
- 제목: `<b>🛍 [Project-Clot] 무신사 와이드 리포트 (${date})</b>`
- 스캔: `대분류 ${n}개 스캔 (불완전 ${k}) · 상품 ${합계}`, 불완전이면 ` ⚠️ ${cat 목록}`
- 변화: 첫 적재면 `초기 적재 ${added}개`, 아니면 `신규 ${a} · 가격변동 ${p} · 범위이탈 ${o} · 재등장 ${r}`
- 쿠폰: 항상 `🎟 쿠폰 조회 ${checked}개 (실패 ${failed}) · 쿠폰가 ${priced}개 · 미확인·오래됨 ${stale}개`. 그 아래 상태별 경고 한 줄: `expired`/`none`이면 `⚠️ 무신사 로그인 만료 — MUSINSA_COOKIE 갱신 필요`, `throttled`이면 `⚠️ 무신사 쿠폰 조회 제한(429) — ${checked}개에서 중단`, `error`이면 `⚠️ 무신사 쿠폰 조회 실패 — Actions 로그 확인`.
- 하락: `coupons.drops`가 있으면 `<b>📉 쿠폰가 10% 이상 하락 (상위 ${n}):</b>`와 그 목록(행은 `lookup(goods_no)`), 없으면 `<b>📉 판매가 10% 이상 하락 (상위 ${n}):</b>`와 `diff.drops`(행은 `d.row`). 줄 형식: `🔻 [${brand_name}] ${name} — ${prev}→${cur}원 (-${rate}%)\n  • <a href="${url}">바로가기</a>`

- [ ] **Step 1: 실패하는 테스트**

```js
test('digest shows scan, change, coupon lines and coupon drops', ...);
test('expired session shows the renewal warning; no coupon drops falls back to sale-price drops', ...);
test('throttled shows the 429 line with the checked count', ...);
test('dry run (diff null) shows only the scan line', ...);
test('escapes HTML in names and stays within 4096 chars by dropping drop lines', ...);
```

- [ ] **Step 2: 실패 확인** — Run: `node --test tests/musinsa-wide-digest.test.js` / Expected: FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — 같은 명령 / Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src/musinsaWide/digest.js tests/musinsa-wide-digest.test.js
git commit -m "feat(musinsa): one daily Telegram digest for the wide scan"
```

---

### Task 9: CLI `track-musinsa`, `musinsa-db`

**Files:**
- Modify: `src/cli.js` (import, `BOOLEAN_FLAGS`에 `'init'`, 함수 2개, `switch`의 case 2개, 도움말 `:1209` 부근)
- Test: `tests/cli-musinsa-wide.test.js`

**Interfaces:**
- Consumes: Task 3 `pullDb`/`pushDb`(musinsa), Task 4 store, Task 5 client, Task 7 `trackMusinsa`, Task 8 digest, `makeSessionProvider` (`src/session.js:616`), `sendTelegramMessage`.
- Produces:
  - `runMusinsaWideStep({ flags, today, openStore, dbExists, makeClient, makeProvider = () => makeSessionProvider({ allowBridge: false }), trackFn = trackMusinsa, notify = sendTelegramMessage, log }) -> { ran, ok, result?, error? }` — `run4910Step`(`src/cli.js:498`)과 같은 모양.
    - 쓰기 실행인데 DB가 없으면, `--init`이 없는 한 `musinsa-wide.db 없음 — 먼저 \`node src/cli.js musinsa-db pull\``을 출력하고 실패한다.
    - `--category a,b`는 `categories`로, `--depth n`(1–100 정수)은 `depthPages`로 넘긴다. 둘 중 하나라도 있으면 `partial: true`.
    - `--concurrency`는 `Math.min(parseConcurrency(flags.concurrency, 3), 4)`.
    - dry run은 요약을 로그로만 출력하고 텔레그램은 보내지 않는다. 끝나면 `checkpoint()` 후 `close()`.
  - `runMusinsaDb({ sub, allowFresh, dbPath, pullFn, pushFn, log }) -> { ok, bytes?, error? }` — `run4910Db`(`src/cli.js:599`)와 같은 모양이고 접두어는 `[musinsa-db]`.
  - 도움말:
    - `track-musinsa [--category <codes>] [--depth <pages>] [--concurrency=1-4] [--dry-run] [--init]`
    - `musinsa-db pull|push [--allow-fresh]`

- [ ] **Step 1: 실패하는 테스트** (`tests/cli-4910.test.js` 패턴)

```js
test('track-musinsa refuses to write without a DB unless --init', ...);
test('--category and --depth pass through and mark the run partial', ...);
test('a dry run never notifies; a write run notifies once', ...);
test('a failing track returns ok:false and still closes the store', ...);
test('musinsa-db rejects an unknown subcommand and reports pull/push', ...);
```

- [ ] **Step 2: 실패 확인** — Run: `node --test tests/cli-musinsa-wide.test.js` / Expected: FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — Run: `npm test` / Expected: 전체 PASS
- [ ] **Step 5: 실제 dry run(쓰기 없음, 비로그인)**

Run: `node src/cli.js track-musinsa --dry-run --category 001 --depth 3`
Expected: `[무신사] 001: 180개 3페이지` 줄과 요약 출력, `data/musinsa-wide.db` 생성 안 됨.

- [ ] **Step 6: Commit**

```bash
git add src/cli.js tests/cli-musinsa-wide.test.js
git commit -m "feat(cli): track-musinsa and musinsa-db commands"
```

---

### Task 10: workflow, README, 첫 실행

**Files:**
- Create: `.github/workflows/musinsa-wide.yml`
- Modify: `README.md` (핵심 기능에 "10. 무신사 와이드 스캔" 절, 디렉토리 구조에 `src/musinsaWide/`, `data/musinsa-wide.db`)

**Interfaces:**
- Consumes: Task 9 CLI, `scripts/actions-session.js restore|check` (`daily.yml`과 같은 단계).

workflow 요점:
- `name: Musinsa wide scan`
- `schedule: cron '30 2 * * *'` (11:30 KST)
- `workflow_dispatch.inputs.mode`: `scan` | `dry-run` | `init`, 기본값 `dry-run`
- `permissions: contents: write`
- **`concurrency: { group: clot-daily, cancel-in-progress: false }`**
- `timeout-minutes: 45`
- Node 24
- env: `GH_TOKEN: github.token`, `TELEGRAM_*` secrets

단계(앞 단계가 실패하면 뒤는 실행하지 않는다):
1. Restore Musinsa session
2. `scan`: `musinsa-db pull`
3. `scan`: `track-musinsa`, `init`: `track-musinsa --init`, `dry-run`: `track-musinsa --dry-run`
4. `scan`: `musinsa-db push`, `init`: `musinsa-db push --allow-fresh`
5. Check for token rotation
6. Store rotated tokens in the secret
7. Fail when the session is gone

5–7은 `daily.yml:96-126`을 그대로 복사하고 `if: always() && …` 조건을 유지한다.

- [ ] **Step 1: workflow와 README 작성.** README에는 다음을 적는다.
  - 범위: 5 대분류 × REVIEW 상위 6,000
  - 쿠폰가 정의와 제외 항목, 상품별 순환 조회(하루 4,000개, 10일 유효)
  - OUT_OF_SCOPE 규칙
  - Release 저장소
  - 로컬에서는 `--dry-run`만 쓸 것
  - 공개 경고: 쿠폰가와 상품별 쿠폰 목록(쿠폰 이름 포함)이 Release에 공개됨

- [ ] **Step 2: 검증** — Run: `npm test` / Expected: 전체 PASS. `actionlint`가 설치돼 있으면 `actionlint .github/workflows/musinsa-wide.yml` / Expected: 출력 없음. 없으면 `daily.yml`의 rotation 단계와 diff해 조건식(`if:`)과 env 이름이 같은지 확인한다.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/musinsa-wide.yml README.md
git commit -m "ci(musinsa): daily wide scan workflow sharing the clot-daily concurrency group"
```

- [ ] **Step 4: 첫 실행(사용자 확인 후).** main에 merge한 다음 아래를 순서대로 실행한다. 사람이 결과를 확인하고 진행한다.
  1. Actions에서 `mode=dry-run`을 수동 실행한다. 대분류 5개가 모두 `100페이지 complete`인지, 걸린 시간이 얼마인지 본다.
  2. `mode=init`을 실행한다. Release `data-musinsa`가 생기고, 텔레그램에 `초기 적재` 메시지가 1통 온다.
  3. 다음 날 스케줄 실행에서 `신규·가격변동` 줄과 쿠폰 조회 수·실패 수를 확인한다. 429(`throttled`)가 보이면 `COUPON_CHECKS_PER_DAY`를 낮춘다.
