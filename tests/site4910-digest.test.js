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
  { sno: 2421, name: '유니클로', total: 10529, scanned: 10520, complete: true, problems: [], qualifiedRows: 3000 },
  { sno: 13647, name: 'GU', total: 5359, scanned: 5359, complete: guComplete, problems: guComplete ? [] : ['slice 0-∞: HTTP 503'], qualifiedRows: 1234 },
];
const diff = (over = {}) => ({
  initial: false, added: [row(101), row(102), row(103)], priceChanged: 12, drops: [drop(1, 50000, 45000)], revived: [],
  dropped: [{ sno: 9, name: 'gone', market_name: 'x', url: 'https://4910.kr/goods/9' }], ...over,
});
const sellers = { seen: 40, qualified: 12, checked: 40 };
const coupons = (over = {}) => ({
  memberStatus: 'ok', wallet: 7, walletChanges: { added: [], removed: [] }, emoney: null, eligible: 5, mismatched: 0, priced: 30, ...over,
});
const result = { date: '2026-10-11', brandCounts: brandCounts(), diff: diff(), sellers, coupons: null, outOfScope: 0, durationMs: 1000 };
const dryResult = {
  ...result, diff: null, sellers: { seen: 40, qualified: null, checked: 0 },
  brandCounts: brandCounts().map(({ qualifiedRows, ...b }) => b),
};

test('digest header, counts, and top drops', () => {
  const text = format4910Digest(result);
  assert.match(text, /<b>🇯🇵 \[Project-Clot\] 4910 리포트 \(2026-10-11\)<\/b>/);
  assert.match(text, /브랜드 2개 스캔 \(불완전 0\) · 판매글 4,234 · 우수 셀러 12\/40/);
  assert.doesNotMatch(text, /유니클로 10,529/);
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

test('incomplete brands are counted and named', () => {
  const text = format4910Digest({ ...result, brandCounts: brandCounts(false) });
  assert.match(text, /브랜드 2개 스캔 \(불완전 1\)/);
  assert.match(text, /불완전 1\).*⚠️ GU/);
  assert.doesNotMatch(text, /⚠️ .*유니클로/);
});

test('at most 5 incomplete brand names are listed', () => {
  const counts = Array.from({ length: 8 }, (_, i) => ({ sno: i, name: `B${i}`, total: 10, scanned: 5, complete: false, problems: ['x'], qualifiedRows: 1 }));
  const text = format4910Digest({ ...result, brandCounts: counts });
  assert.match(text, /\(불완전 8\)/);
  assert.match(text, /⚠️ B0, B1, B2, B3, B4(?!, B5)/);
  assert.doesNotMatch(text, /B5/);
});

test('rows are the sum of qualifiedRows, missing counts as 0', () => {
  const counts = brandCounts();
  delete counts[1].qualifiedRows;
  assert.match(format4910Digest({ ...result, brandCounts: counts }), /판매글 3,000 · 우수 셀러 12\/40/);
});

test('dry-run result shows only the scan line, with scanned rows and no seller part', () => {
  const text = format4910Digest(dryResult);
  assert.match(text, /브랜드 2개 스캔 \(불완전 0\) · 판매글 15,879$/m);
  assert.doesNotMatch(text, /우수 셀러|신규|초기 적재|하락|쿠폰/);
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

const likedDrop = (sno, prevPrice, currentPrice, name = `liked ${sno}`) => ({
  sno, name, market_name: '모에모에', url: `https://4910.kr/goods/${sno}`, prevPrice, currentPrice,
});
const likedOk = (drops = [likedDrop(7, 20000, 19440, '모에모에 상품')]) => ({ memberStatus: 'ok', liked: 12, logged: 11, drops });

test('liked ok adds the count line and a 💜 drop section', () => {
  const text = format4910Digest(result, { liked: likedOk() });
  assert.match(text, /찜 12개 · 가격 기록 11개/);
  assert.match(text, /<b>💜 찜 상품 쿠폰가 하락 \(상위 1\):<\/b>/);
  assert.match(text, /🔻 \[모에모에\] 모에모에 상품 — 20,000→19,440원\n  • <a href="https:\/\/4910\.kr\/goods\/7">바로가기<\/a>/);
  assert.ok(text.indexOf('찜 12개') > text.indexOf('신규 3'));
  assert.ok(text.indexOf('📉') < text.indexOf('💜'));
});

test('liked ok with no drops adds only the count line', () => {
  const text = format4910Digest(result, { liked: likedOk([]) });
  assert.match(text, /찜 12개 · 가격 기록 11개/);
  assert.doesNotMatch(text, /💜/);
});

test('liked drops respect the limit', () => {
  const drops = Array.from({ length: 5 }, (_, i) => likedDrop(i + 1, 20000, 19000));
  const text = format4910Digest({ ...result, diff: diff({ drops: [] }) }, { limit: 3, liked: likedOk(drops) });
  assert.match(text, /💜 찜 상품 쿠폰가 하락 \(상위 3\)/);
  assert.equal((text.match(/바로가기/g) || []).length, 3);
});

test('liked expired adds the expiry warning', () => {
  const text = format4910Digest(result, { liked: { memberStatus: 'expired', liked: 0, logged: 0, drops: [] } });
  assert.match(text, /⚠️ 4910 로그인 만료 — ABLY_JWT_TOKEN 갱신 필요/);
  assert.doesNotMatch(text, /찜 \d+개/);
});

test('liked error adds the failure line', () => {
  const text = format4910Digest(result, { liked: { memberStatus: 'error', liked: 0, logged: 0, drops: [] } });
  assert.match(text, /⚠️ 4910 찜 가격 기록 실패 — Actions 로그 확인/);
  assert.doesNotMatch(text, /로그인 만료|찜 \d+개/);
});

test('liked none or null adds nothing', () => {
  const base = format4910Digest(result);
  assert.equal(format4910Digest(result, { liked: null }), base);
  assert.equal(format4910Digest(result, { liked: { memberStatus: 'none', liked: 0, logged: 0, drops: [] } }), base);
});

test('liked lines are not added to a dry-run digest', () => {
  const text = format4910Digest(dryResult, { liked: likedOk() });
  assert.doesNotMatch(text, /찜|💜/);
});

test('over 4096 chars drops scan lines before liked lines', () => {
  const many = Array.from({ length: 10 }, (_, i) => drop(i + 1, 50000, 40000, { name: '가'.repeat(300) }));
  const likedMany = Array.from({ length: 10 }, (_, i) => likedDrop(i + 1, 20000, 19000, '나'.repeat(100)));
  const text = format4910Digest({ ...result, diff: diff({ drops: many }) }, { liked: likedOk(likedMany) });
  assert.ok(text.length <= 4096, `length ${text.length}`);
  assert.equal((text.match(/💜 찜 상품 쿠폰가 하락 \(상위 10\)/g) || []).length, 1);
  const scanShown = Number(text.match(/📉 10% 이상 하락 \(상위 (\d+)\)/)[1]);
  assert.ok(scanShown > 0 && scanShown < 10, `scan lines shown ${scanShown}`);
});

test('coupon ok line shows wallet, eligible sellers and points', () => {
  const text = format4910Digest({ ...result, coupons: coupons({ emoney: 3000 }) });
  assert.match(text, /🎟 쿠폰 7장 · 쿠폰 적용 셀러 5곳 · 포인트 3,000원/);
  assert.ok(text.indexOf('🎟') > text.indexOf('신규 3'));
  const noPoints = format4910Digest({ ...result, coupons: coupons() });
  assert.match(noPoints, /🎟 쿠폰 7장 · 쿠폰 적용 셀러 5곳$/m);
  assert.doesNotMatch(noPoints, /포인트/);
  assert.match(format4910Digest({ ...result, coupons: coupons({ emoney: 0 }) }), /포인트 0원/);
});

test('wallet changes list added and removed coupons, HTML-escaped', () => {
  const text = format4910Digest({ ...result, coupons: coupons({ walletChanges: { added: ['A&B 10%', '신규 <5천원>'], removed: ['만료쿠폰'] } }) });
  assert.match(text, /🎟 새 쿠폰: A&amp;B 10%, 신규 &lt;5천원&gt;/);
  assert.match(text, /🎟 사라진 쿠폰: 만료쿠폰/);
  const onlyAdded = format4910Digest({ ...result, coupons: coupons({ walletChanges: { added: ['X'], removed: [] } }) });
  assert.match(onlyAdded, /새 쿠폰: X/);
  assert.doesNotMatch(onlyAdded, /사라진 쿠폰/);
  assert.doesNotMatch(format4910Digest({ ...result, coupons: coupons() }), /새 쿠폰|사라진 쿠폰/);
});

test('wallet change lines list at most 5 names, then the count of the rest', () => {
  const names = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
  const text = format4910Digest({ ...result, coupons: coupons({ walletChanges: { added: names('새', 12), removed: names('옛', 5) } }) });
  assert.match(text, /^🎟 새 쿠폰: 새1, 새2, 새3, 새4, 새5 외 7$/m);
  assert.match(text, /^🎟 사라진 쿠폰: 옛1, 옛2, 옛3, 옛4, 옛5$/m);
});

test('mismatch adds a warning line', () => {
  const text = format4910Digest({ ...result, coupons: coupons({ mismatched: 3 }) });
  assert.match(text, /⚠️ 쿠폰 계산 불일치 셀러 3곳 — 해당 쿠폰가 숨김/);
  assert.doesNotMatch(format4910Digest({ ...result, coupons: coupons() }), /불일치/);
});

test('coupon status none or null adds no coupon lines', () => {
  const base = format4910Digest(result);
  assert.doesNotMatch(base, /🎟|쿠폰/);
  assert.equal(format4910Digest({ ...result, coupons: coupons({ memberStatus: 'none' }) }), base);
});

test('coupon status error adds the failure line and no wallet lines', () => {
  const text = format4910Digest({ ...result, coupons: coupons({ memberStatus: 'error', mismatched: 2, walletChanges: { added: ['X'], removed: [] } }) });
  assert.match(text, /⚠️ 4910 쿠폰 계산 실패 — Actions 로그 확인/);
  assert.doesNotMatch(text, /🎟|불일치|로그인 만료/);
});

test('coupon status expired shows the expiry warning only, and only once when liked is expired too', () => {
  const expiredLiked = { memberStatus: 'expired', liked: 0, logged: 0, drops: [] };
  const text = format4910Digest({ ...result, coupons: coupons({ memberStatus: 'expired', mismatched: 2 }) });
  assert.equal((text.match(/로그인 만료/g) || []).length, 1);
  assert.doesNotMatch(text, /🎟|불일치/);
  const both = format4910Digest({ ...result, coupons: coupons({ memberStatus: 'expired' }) }, { liked: expiredLiked });
  assert.equal((both.match(/로그인 만료/g) || []).length, 1);
  const likedOnly = format4910Digest({ ...result, coupons: coupons() }, { liked: expiredLiked });
  assert.equal((likedOnly.match(/로그인 만료/g) || []).length, 1);
  assert.match(likedOnly, /🎟 쿠폰 7장/);
});

test('a drop with a coupon price shows it', () => {
  const withCoupon = { ...drop(1, 50000, 45000), couponPrice: 41000 };
  const text = format4910Digest({ ...result, diff: diff({ drops: [withCoupon] }) });
  assert.match(text, /50,000→45,000원 \(-10%\) \(쿠폰가 41,000원\)\n  • <a href/);
});

test('a coupon price that is missing, null or not lower is not shown', () => {
  for (const couponPrice of [undefined, null, 45000, 46000]) {
    const text = format4910Digest({ ...result, diff: diff({ drops: [{ ...drop(1, 50000, 45000), couponPrice }] }) });
    assert.doesNotMatch(text, /쿠폰가/, String(couponPrice));
  }
  const fromRow = drop(1, 50000, 45000);
  fromRow.row.coupon_price = 40000;
  assert.doesNotMatch(format4910Digest({ ...result, diff: diff({ drops: [fromRow] }) }), /쿠폰가/);
});

test('100 brands still fit under 4096 chars', () => {
  const counts = Array.from({ length: 100 }, (_, i) => ({
    sno: i, name: `아주 긴 브랜드 이름 번호 ${i} `.repeat(2), total: 500, scanned: 400, complete: i >= 5, problems: i < 5 ? ['HTTP 503'] : [], qualifiedRows: 300,
  }));
  const drops = Array.from({ length: 10 }, (_, i) => ({ ...drop(i + 1, 50000, 40000, { name: '가'.repeat(60) }), couponPrice: 35000 }));
  const likedMany = Array.from({ length: 10 }, (_, i) => likedDrop(i + 1, 20000, 19000, '나'.repeat(60)));
  const text = format4910Digest(
    { ...result, brandCounts: counts, diff: diff({ drops }), coupons: coupons({ emoney: 3000, mismatched: 1, walletChanges: { added: ['새쿠폰'], removed: ['옛쿠폰'] } }) },
    { liked: likedOk(likedMany) }
  );
  assert.ok(text.length <= 4096, `length ${text.length}`);
  assert.match(text, /4910 리포트 \(2026-10-11\)/);
  assert.match(text, /브랜드 100개 스캔 \(불완전 5\) · 판매글 30,000 · 우수 셀러 12\/40/);
  for (const re of [/🎟 쿠폰 7장/, /🎟 새 쿠폰: 새쿠폰/, /🎟 사라진 쿠폰: 옛쿠폰/, /쿠폰 계산 불일치/]) assert.match(text, re);
});

test('trimming drops scan lines before liked lines and never cuts the coupon lines', () => {
  const many = Array.from({ length: 10 }, (_, i) => drop(i + 1, 50000, 40000, { name: '가'.repeat(300) }));
  const likedMany = Array.from({ length: 10 }, (_, i) => likedDrop(i + 1, 20000, 19000, '나'.repeat(100)));
  const text = format4910Digest({ ...result, diff: diff({ drops: many }), coupons: coupons({ emoney: 3000 }) }, { liked: likedOk(likedMany) });
  assert.ok(text.length <= 4096, `length ${text.length}`);
  assert.match(text, /🎟 쿠폰 7장/);
});
