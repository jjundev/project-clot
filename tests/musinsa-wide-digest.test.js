import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMusinsaWideDigest } from '../src/musinsaWide/digest.js';

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
const coupons = (over = {}) => ({ memberStatus: 'ok', checked: 200, failed: 2, priced: 150, stale: 30, drops: [], ...over });
const result = (over = {}) => ({ date: '2026-10-14', categoryCounts: categoryCounts(), diff: diff(), coupons: coupons(), durationMs: 1000, ...over });
const lookup = (goodsNo) => row(goodsNo, { name: `쿠폰상품 ${goodsNo}` });

test('digest shows scan, change, coupon lines and coupon drops', () => {
  const text = formatMusinsaWideDigest(
    result({ coupons: coupons({ drops: [couponDrop(20, 100000, 80000)] }) }),
    { lookup }
  );
  assert.ok(text.startsWith('<b>🛍 [Project-Clot] 무신사 와이드 리포트 (2026-10-14)</b>'));
  assert.match(text, /대분류 2개 스캔 \(불완전 0\) · 상품 1,234/);
  assert.match(text, /신규 3 · 가격변동 12 · 범위이탈 5 · 재등장 1/);
  assert.match(text, /🎟 쿠폰 조회 200개 \(실패 2\) · 쿠폰가 150개 · 미확인·오래됨 30개/);
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
