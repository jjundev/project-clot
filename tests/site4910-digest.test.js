import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { format4910Digest } from '../src/site4910/digest.js';

const row = (sno, { name = `listing ${sno}`, market = '모에모에' } = {}) => ({
  sno, brand_sno: 2421, brand: '유니클로', name, market_sno: 1, market_name: market, category: null,
  sale_price: 0, original_price: 0, discount_rate: null, image_url: null, url: `https://4910.kr/goods/${sno}`, closed: false,
});
const drop = (sno, prevPrice, currentPrice, opts = {}) => ({
  row: row(sno, opts), prevPrice, currentPrice, dropRate: Math.round(((prevPrice - currentPrice) / prevPrice) * 100), isNewLowest: opts.isNewLowest ?? true,
});
const brandCounts = (guComplete = true) => [
  { sno: 2421, name: '유니클로', total: 10529, scanned: 10520, complete: true, problems: [] },
  { sno: 13647, name: 'GU', total: 5359, scanned: 5359, complete: guComplete, problems: guComplete ? [] : ['slice 0-∞: HTTP 503'] },
];
const diff = (over = {}) => ({
  initial: false, added: [row(101), row(102), row(103)], priceChanged: 12, drops: [drop(1, 50000, 45000)], revived: [],
  dropped: [{ sno: 9, name: 'gone', market_name: 'x', url: 'https://4910.kr/goods/9' }], ...over,
});
const result = { date: '2026-10-11', brandCounts: brandCounts(), diff: diff(), durationMs: 1000 };

test('digest header, counts, and top drops', () => {
  const text = format4910Digest(result);
  assert.match(text, /<b>🇯🇵 \[Project-Clot\] 4910 유니클로·GU 리포트 \(2026-10-11\)<\/b>/);
  assert.match(text, /유니클로 10,529 · GU 5,359 스캔/);
  assert.match(text, /신규 3 · 가격변동 12 · 종료 1 · 재등장 0/);
  assert.match(text, /<b>📉 10% 이상 하락 \(상위 1\):<\/b>/);
  assert.match(text, /🔥 \[모에모에\] .* — 50,000→45,000원 \(-10%\)/);
  assert.match(text, /<a href="https:\/\/4910\.kr\/goods\/1">바로가기<\/a>/);
});

test('a drop that is not a new lowest uses 🔻 and no drops means no drop section', () => {
  assert.match(format4910Digest({ ...result, diff: diff({ drops: [drop(1, 50000, 40000, { isNewLowest: false })] }) }), /🔻 \[모에모에\]/);
  assert.doesNotMatch(format4910Digest({ ...result, diff: diff({ drops: [] }) }), /하락/);
});

test('initial load says 초기 적재 instead of listing every new item', () => {
  const initialResult = { ...result, diff: diff({ initial: true, added: Array.from({ length: 15888 }, (_, i) => row(i)), drops: [] }) };
  const text = format4910Digest(initialResult);
  assert.match(text, /초기 적재 15,888개/);
  assert.doesNotMatch(text, /신규/);
});

test('incomplete brand is flagged', () => {
  const text = format4910Digest({ ...result, brandCounts: brandCounts(false) });
  assert.match(text, /GU 5,359 ⚠️ 불완전/);
});

test('an unknown brand total shows ?', () => {
  const counts = brandCounts(false);
  counts[1].total = null;
  assert.match(format4910Digest({ ...result, brandCounts: counts }), /GU \? ⚠️ 불완전/);
});

test('dry-run result shows only the scan line', () => {
  const text = format4910Digest({ ...result, diff: null });
  assert.match(text, /유니클로 10,529 · GU 5,359 스캔/);
  assert.doesNotMatch(text, /신규|초기 적재|하락/);
});

test('escapes HTML in names', () => {
  const text = format4910Digest({ ...result, diff: diff({ drops: [drop(1, 50000, 40000, { name: 'M&M <한정>', market: 'A&B' })] }) });
  assert.match(text, /M&amp;M &lt;한정&gt;/);
  assert.match(text, /\[A&amp;B\]/);
});

test('keeps at most 10 drops and stays under 4096 chars', () => {
  const many = Array.from({ length: 15 }, (_, i) => drop(i + 1, 50000, 40000 - i * 100));
  const text = format4910Digest({ ...result, diff: diff({ drops: many }) });
  assert.equal((text.match(/바로가기/g) || []).length, 10);
  assert.match(text, /상위 10/);

  const hugeNames = { ...result, diff: diff({ drops: many.map((d) => ({ ...d, row: { ...d.row, name: '가'.repeat(900) } })) }) };
  const huge = format4910Digest(hugeNames);
  assert.ok(huge.length <= 4096, `length ${huge.length}`);
  const shown = (huge.match(/바로가기/g) || []).length;
  assert.ok(shown > 0 && shown < 10);
  assert.match(huge, new RegExp(`상위 ${shown}\\)`));
});
