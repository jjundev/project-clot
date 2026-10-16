import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMusinsaWideDigest, formatBackfillDigest } from '../src/musinsaWide/digest.js';

const row = (goods_no, { name = `상품 ${goods_no}`, brand = '나이키' } = {}) => ({
  goods_no, brand_name: brand, name, url: `https://www.musinsa.com/products/${goods_no}`,
});
const drop = (goods_no, prevPrice, currentPrice, opts = {}) => ({
  row: row(goods_no, opts), prevPrice, currentPrice, dropRate: Math.round(((prevPrice - currentPrice) / prevPrice) * 100),
});
const couponDrop = (goods_no, prevPrice, currentPrice) => ({
  goods_no, prevPrice, currentPrice, dropRate: Math.round(((prevPrice - currentPrice) / prevPrice) * 100),
});
const categoryCounts = (incomplete = false) => [
  { cat: '001', scanned: 1000, pages: 10, complete: true, problems: [] },
  { cat: '002', scanned: 234, pages: 3, complete: !incomplete, problems: incomplete ? ['page 3: HTTP 503'] : [] },
];
const diff = (over = {}) => ({
  initial: false, added: [row(1), row(2), row(3)], priceChanged: 12, drops: [drop(10, 50000, 45000)], revived: [row(4)], outOfScope: 5, ...over,
});
const coupons = (over = {}) => ({
  memberStatus: 'ok', checked: 200, failed: 2, priced: 150, withCoupon: 140, drops: [], lateDrops: 0, dropsSuppressed: false, ready: true, ...over,
});
const registry = (over = {}) => ({
  enum: { probed: 1500, hits: 40, newCoupons: 7, highest: 345123, stop: null },
  recheck: { probed: 30, newPositive: 2, stop: null },
  classify: { calls: 1234, usable: 5, other: 3, outOfScope: 1, pending: 12 },
  neighbors: { probed: 0, hits: 0, stop: null },
  walk: { walked: 1500, failed: 3, suspectEmpty: 0, calls: 2600, stop: null },
  sample: { checked: 200, exact: 187, under: 8, over: 5 },
  counts: { usable: 2345, added: 6, expiredYesterday: 4, retired: 1 },
  ...over,
});
const result = (over = {}) => ({ date: '2026-10-14', categoryCounts: categoryCounts(), diff: diff(), coupons: coupons(), registry: null, durationMs: 1000, ...over });
const lookup = (goodsNo) => row(goodsNo, { name: `쿠폰상품 ${goodsNo}` });

test('digest shows scan, change, coupon lines and coupon drops', () => {
  const text = formatMusinsaWideDigest(
    result({ coupons: coupons({ drops: [couponDrop(20, 100000, 80000)] }) }),
    { lookup }
  );
  assert.ok(text.startsWith('<b>🛍 [Project-Clot] 무신사 와이드 리포트 (2026-10-14)</b>'));
  assert.match(text, /대분류 2개 스캔 \(불완전 0\) · 상품 1,234/);
  assert.match(text, /신규 3 · 가격변동 12 · 범위이탈 5 · 재등장 1/);
  assert.match(text, /🎟 회원 조회 200개 \(실패 2\) · 쿠폰가 150개 · 쿠폰 적용 140개/);
  assert.doesNotMatch(text, /⚠️/);
  assert.match(text, /<b>📉 쿠폰가 10% 이상 하락 \(상위 1\):<\/b>/);
  assert.match(text, /🔻 \[나이키\] 쿠폰상품 20 — 100,000→80,000원 \(-20%\)\n {2}• <a href="https:\/\/www\.musinsa\.com\/products\/20">바로가기<\/a>/);
  assert.doesNotMatch(text, /판매가 10%/);
});

test('initial load shows the added count and incomplete categories are named', () => {
  const text = formatMusinsaWideDigest(result({ categoryCounts: categoryCounts(true), diff: diff({ initial: true }) }), { lookup });
  assert.match(text, /대분류 2개 스캔 \(불완전 1\) · 상품 1,234 ⚠️ 002/);
  assert.match(text, /초기 적재 3개/);
  assert.doesNotMatch(text, /신규 /);
});

test('expired session shows the renewal warning; no coupon drops falls back to sale-price drops', () => {
  for (const memberStatus of ['expired', 'none']) {
    const text = formatMusinsaWideDigest(result({ coupons: coupons({ memberStatus }) }), { lookup });
    assert.match(text, /⚠️ 무신사 로그인 만료 — MUSINSA_COOKIE 갱신 필요/);
    assert.match(text, /<b>📉 판매가 10% 이상 하락 \(상위 1\):<\/b>/);
    assert.match(text, /🔻 \[나이키\] 상품 10 — 50,000→45,000원 \(-10%\)/);
    assert.doesNotMatch(text, /쿠폰가 10% 이상/);
  }
  const err = formatMusinsaWideDigest(result({ coupons: coupons({ memberStatus: 'error' }) }), { lookup });
  assert.match(err, /⚠️ 무신사 쿠폰 조회 실패 — Actions 로그 확인/);
});

test('throttled shows the 429 line with the checked count', () => {
  const text = formatMusinsaWideDigest(result({ coupons: coupons({ memberStatus: 'throttled', checked: 123 }) }), { lookup });
  assert.match(text, /⚠️ 무신사 쿠폰 조회 제한\(429\) — 123개에서 중단/);
});

test('dry run (diff null) shows only the scan line', () => {
  const text = formatMusinsaWideDigest(result({ diff: null, coupons: null }), { lookup });
  assert.equal(text.split('\n').length, 3);
  assert.match(text, /대분류 2개 스캔/);
  assert.doesNotMatch(text, /신규|쿠폰|📉/);
});

test('a coupon drop whose goods row is missing is skipped; limit caps the list', () => {
  const drops = [couponDrop(1, 1000, 800), couponDrop(2, 1000, 800), couponDrop(3, 1000, 800)];
  const text = formatMusinsaWideDigest(result({ coupons: coupons({ drops }) }), { limit: 5, lookup: (n) => (n === 2 ? undefined : row(n)) });
  assert.match(text, /쿠폰가 10% 이상 하락 \(상위 2\)/);
  assert.doesNotMatch(text, /상품 2/);
  const capped = formatMusinsaWideDigest(result({ coupons: coupons({ drops }) }), { limit: 1, lookup });
  assert.match(capped, /상위 1\)/);
});

test('escapes HTML in names and stays within 4096 chars by dropping drop lines', () => {
  const nasty = formatMusinsaWideDigest(
    result({ diff: diff({ drops: [drop(1, 10000, 8000, { name: '<script>&"x"', brand: 'A&B' })] }), coupons: coupons({ memberStatus: 'expired' }) }),
    { lookup }
  );
  assert.match(nasty, /\[A&amp;B\] &lt;script&gt;&amp;"x"/);
  assert.doesNotMatch(nasty, /<script>/);
  const unsafeUrl = formatMusinsaWideDigest(
    result({ diff: diff({ drops: [{ ...drop(1, 10000, 8000), row: { ...row(1), url: 'https://x/?a=1&b=<2>' } }] }), coupons: null }),
    { lookup }
  );
  assert.match(unsafeUrl, /href="https:\/\/x\/\?a=1&amp;b=&lt;2&gt;"/);

  const many = Array.from({ length: 60 }, (_, i) => drop(i + 1, 100000, 50000, { name: 'x'.repeat(100) }));
  const text = formatMusinsaWideDigest(result({ diff: diff({ drops: many }), coupons: coupons({ memberStatus: 'expired' }) }), { limit: 60, lookup });
  assert.ok(text.length <= 4096, `length ${text.length}`);
  assert.match(text, /^<b>🛍/);
  assert.match(text, /대분류 2개 스캔/);
  assert.match(text, /⚠️ 무신사 로그인 만료/);
  const n = Number(text.match(/판매가 10% 이상 하락 \(상위 (\d+)\)/)[1]);
  assert.ok(n > 0 && n < 60);
  assert.equal((text.match(/🔻/g) ?? []).length, n);
});

test('registry lines appear in order with formatted numbers and sample percent', () => {
  const text = formatMusinsaWideDigest(result({ registry: registry() }), { lookup });
  const lines = [
    '🎟 회원 조회 200개 (실패 2) · 쿠폰가 150개 · 쿠폰 적용 140개',
    '🔢 번호 순회 1,500개 · 최대 345,123 · 새 쿠폰 7 · 0→양수 2',
    '🧮 판별 1,234회 · 쓸 수 있음 5 · 대상 아님 3 · 범위 밖 1 · 대기 12',
    '📒 쓸 수 있는 쿠폰 2,345종 (새로 6 · 만료 4 · 퇴출 1)',
    '🚶 목록 순회 1,500종 · 호출 2,600 · 실패 3',
    '🎯 표본 200개 · 정확 187 (93.5%) · 낮게 8 · 높게 5',
  ];
  let at = -1;
  for (const line of lines) {
    const i = text.indexOf(line);
    assert.ok(i > at, `missing or out of order: ${line}`);
    at = i;
  }
  assert.doesNotMatch(text, /⚠️/);
  assert.doesNotMatch(text, /미확인/);
  const empty = formatMusinsaWideDigest(result({ registry: registry({ enum: { probed: 0, hits: 0, newCoupons: 0, highest: null, stop: null }, sample: { checked: 0, exact: 0, under: 0, over: 0 } }) }), { lookup });
  assert.match(empty, /최대 - · 새 쿠폰 0/);
  assert.match(empty, /🎯 표본 0개 · 정확 0 \(-\) · 낮게 0 · 높게 0/);
});

test('not ready shows the backfill warning and no registry lines', () => {
  const text = formatMusinsaWideDigest(result({ coupons: coupons({ ready: false, memberStatus: 'skipped', checked: 0, failed: 0, priced: 0, withCoupon: 0 }) }), { lookup });
  assert.match(text, /⚠️ 쿠폰 등록부 미완성 — backfill 필요/);
  assert.doesNotMatch(text, /🔢|🧮|📒|🚶|🎯/);
  assert.doesNotMatch(text, /로그인 만료|조회 제한|조회 실패/);
  assert.match(text, /<b>📉 판매가 10% 이상 하락/);
  const ready = formatMusinsaWideDigest(result({ registry: registry() }), { lookup });
  assert.doesNotMatch(ready, /등록부 미완성/);
});

test('a throttled walk and a failed enumeration each add their warning', () => {
  const text = formatMusinsaWideDigest(result({
    registry: registry({ walk: { walked: 10, failed: 0, suspectEmpty: 0, calls: 20, stop: 'throttled' }, enum: { probed: 5, hits: 0, newCoupons: 0, highest: 1, stop: 'error' } }),
  }), { lookup });
  assert.match(text, /⚠️ 무신사 비로그인 쿠폰 API 제한\(429\) — 목록 순회 중단/);
  assert.match(text, /⚠️ 무신사 번호 순회 실패 — Actions 로그 확인/);
  const neighbors = formatMusinsaWideDigest(result({ registry: registry({ neighbors: { probed: 3, hits: 0, stop: 'throttled' } }) }), { lookup });
  assert.match(neighbors, /⚠️ 무신사 비로그인 쿠폰 API 제한\(429\) — 이웃 조회 중단/);
  const deadline = formatMusinsaWideDigest(result({ registry: registry({ walk: { walked: 1, failed: 0, suspectEmpty: 0, calls: 1, stop: 'deadline' } }) }), { lookup });
  assert.match(deadline, /⚠️ 무신사 시간 예산 소진 — 목록 순회 중단/);
});

test('late drops are excluded with a count line; suppressed drops show the first-day line and no sale-price fallback', () => {
  const late = formatMusinsaWideDigest(
    result({ registry: registry(), coupons: coupons({ lateDrops: 3, drops: [couponDrop(20, 100000, 80000)] }) }),
    { lookup }
  );
  assert.match(late, /늦게 찾은 쿠폰 하락 3건 제외\n<b>📉 쿠폰가 10% 이상 하락/);
  const none = formatMusinsaWideDigest(result({ registry: registry() }), { lookup });
  assert.doesNotMatch(none, /늦게 찾은/);

  const suppressed = formatMusinsaWideDigest(result({ registry: registry(), coupons: coupons({ dropsSuppressed: true }) }), { lookup });
  assert.match(suppressed, /등록부 전환 첫날 — 쿠폰가 하락 알림 생략/);
  assert.doesNotMatch(suppressed, /📉|🔻/);
});

const backfill = (over = {}) => ({
  date: '2026-10-15', from: 345000, next: 351000, probed: 6000, hits: 80, seeded: 2300,
  classify: { calls: 1500, usable: 900, other: 400, outOfScope: 100, pending: 20 },
  done: true, memberStatus: 'ok', stop: null, neighbors: { probed: 0, hits: 0 }, ...over,
});

test('formatBackfillDigest shows done and resume variants', () => {
  const done = formatBackfillDigest(backfill());
  assert.equal(done.split('\n')[0], '<b>🗂 [Project-Clot] 무신사 쿠폰 등록부 전환 (2026-10-15)</b>');
  assert.match(done, /번호 345,000–350,999 \(6,000개\) · 상품 있음 80 · 기존 쿠폰 등록 2,300/);
  assert.match(done, /🧮 판별 1,500회 · 쓸 수 있음 900 · 대상 아님 400 · 범위 밖 100 · 대기 20/);
  assert.match(done, /✅ 전환 완료 — 내일 실행부터 등록부로 계산/);
  assert.doesNotMatch(done, /⏸|⚠️/);

  const resume = formatBackfillDigest(backfill({ done: false, stop: 'deadline', next: 351000 }));
  assert.match(resume, /⏸ 351,000에서 멈춤 — backfill을 다시 실행해 이어서/);
  assert.doesNotMatch(resume, /✅/);

  const expired = formatBackfillDigest(backfill({ done: false, memberStatus: 'expired', stop: 'expired' }));
  assert.match(expired, /⚠️ 무신사 로그인 만료 — MUSINSA_COOKIE 갱신 필요/);
  assert.match(expired, /⏸/);
  assert.doesNotMatch(expired, /번호 순회|판별 실패/);
  const throttled = formatBackfillDigest(backfill({ done: false, stop: 'throttled', enumStop: 'throttled' }));
  assert.match(throttled, /⚠️ 무신사 비로그인 쿠폰 API 제한\(429\) — 번호 순회 중단/);
  const enumError = formatBackfillDigest(backfill({ done: false, stop: 'error', enumStop: 'error' }));
  assert.match(enumError, /⚠️ 무신사 번호 순회 실패 — Actions 로그 확인/);
  assert.doesNotMatch(enumError, /판별 실패/);
  const none = formatBackfillDigest(backfill({ done: false, memberStatus: 'none', stop: 'none' }));
  assert.match(none, /로그인 만료/);
});

test('a classification error names the 판별 phase, never the enumeration', () => {
  const text = formatBackfillDigest(backfill({ done: false, stop: 'error', classifyStop: 'error' }));
  assert.match(text, /⚠️ 무신사 판별 실패 — Actions 로그 확인/);
  assert.doesNotMatch(text, /번호 순회 (실패|중단)/);
  assert.match(text, /⏸/);
});

test('an enumeration throttle and an expired member session show both warnings', () => {
  const text = formatBackfillDigest(backfill({ done: false, memberStatus: 'expired', stop: 'throttled', enumStop: 'throttled' }));
  assert.match(text, /⚠️ 무신사 비로그인 쿠폰 API 제한\(429\) — 번호 순회 중단/);
  assert.match(text, /⚠️ 무신사 로그인 만료 — MUSINSA_COOKIE 갱신 필요/);
});

test('a suppressed day prints no coupon drops even when some exist', () => {
  const text = formatMusinsaWideDigest(
    result({ registry: registry(), coupons: coupons({ dropsSuppressed: true, drops: [couponDrop(20, 100000, 80000)] }) }),
    { lookup }
  );
  assert.match(text, /등록부 전환 첫날/);
  assert.doesNotMatch(text, /📉|🔻/);
});

test('trimming drop lines keeps every head line, registry and warning lines included', () => {
  const many = Array.from({ length: 60 }, (_, i) => couponDrop(i + 1, 100000, 50000));
  const long = (n) => ({ ...row(n), name: 'x'.repeat(100) });
  const text = formatMusinsaWideDigest(
    result({
      registry: registry({ walk: { walked: 1, failed: 0, suspectEmpty: 0, calls: 1, stop: 'throttled' } }),
      coupons: coupons({ drops: many, lateDrops: 2 }),
    }),
    { limit: 60, lookup: long }
  );
  assert.ok(text.length <= 4096, `length ${text.length}`);
  for (const mark of ['🎟', '🔢', '🧮', '📒', '🚶', '🎯', '목록 순회 중단', '늦게 찾은 쿠폰 하락 2건 제외']) assert.ok(text.includes(mark), mark);
  const n = Number(text.match(/쿠폰가 10% 이상 하락 \(상위 (\d+)\)/)[1]);
  assert.ok(n > 0 && n < 60);
});

test('incomplete coupon walks and deadlines are visible in the daily report', () => {
  const reg = registry();
  reg.walk = { ...reg.walk, complete: false, remaining: 2, stop: 'deadline' };
  const text = formatMusinsaWideDigest(result({ registry: reg, coupons: coupons() }));
  assert.match(text, /목록.*미완료 2/);
  assert.match(text, /시간 예산.*목록 순회/);
});

test('estimate policy separates estimates from direct confirmations and warns about API exceptions', () => {
  const text = formatMusinsaWideDigest(result({
    coupons: coupons({ pricingPolicy: 'confirmed-benefits-estimate-v1', direct: 12, estimated: 138, exceptionCoupons: [111, 222] }),
    registry: registry({ walk: { walked: 1206, requested: 1208, failed: 0, calls: 2400, exceptions: [111, 222], complete: false, remaining: 2 } }),
  }));
  assert.match(text, /확인된 혜택 기준 추정 쿠폰가 138개/);
  assert.match(text, /직접 확인 쿠폰가 12개/);
  assert.match(text, /API 예외 쿠폰 2종: 111, 222/);
  assert.match(text, /추가 쿠폰.*실제.*더 낮/);
  assert.match(text, /목록 순회 1,206종.*실패 0.*예외 2/);
  assert.match(text, /판매가 10% 이상 하락/);
  assert.doesNotMatch(text, /쿠폰가 10% 이상 하락/);
});

test('estimate policy labels supplied confirmed coupon drops and bounds exception IDs without losing warnings', () => {
  const text = formatMusinsaWideDigest(result({
    coupons: coupons({ pricingPolicy: 'confirmed-benefits-estimate-v1', direct: 12, estimated: 138,
      exceptionCoupons: Array.from({ length: 1000 }, (_, i) => 100000 + i), drops: [couponDrop(20, 100000, 80000)] }),
  }), { lookup });
  assert.ok(text.length <= 4096);
  assert.match(text, /API 예외 쿠폰 1,000종: 100000/);
  assert.match(text, /외 980종/);
  assert.match(text, /추가 쿠폰.*실제.*더 낮/);
  assert.match(text, /직접 확인 쿠폰가 10% 이상 하락/);
  assert.doesNotMatch(text, /판매가 10% 이상 하락/);
});
