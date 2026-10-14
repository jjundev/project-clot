// One Telegram message per daily Musinsa wide run (parse_mode=HTML, Telegram's 4096-char cap).
const TELEGRAM_MAX = 4096;

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => Number(n).toLocaleString('en-US');

const MAX_INCOMPLETE_NAMES = 5;
const EXPIRED_LINE = '⚠️ 무신사 로그인 만료 — MUSINSA_COOKIE 갱신 필요';

// 29 top-level categories: one summary line, never a per-category list.
function scanLine(categoryCounts) {
  const incomplete = categoryCounts.filter((c) => !c.complete);
  const rows = categoryCounts.reduce((sum, c) => sum + (c.scanned || 0), 0);
  let line = `대분류 ${fmt(categoryCounts.length)}개 스캔 (불완전 ${fmt(incomplete.length)}) · 상품 ${fmt(rows)}`;
  if (incomplete.length) line += ` ⚠️ ${incomplete.slice(0, MAX_INCOMPLETE_NAMES).map((c) => escapeHtml(c.cat)).join(', ')}`;
  return line;
}

// Warnings by coupon-check status: 'ok' adds nothing; 'none' (no cookie) reads like an expiry.
function couponWarning(coupons) {
  switch (coupons.memberStatus) {
    case 'expired':
    case 'none':
      return EXPIRED_LINE;
    case 'throttled':
      return `⚠️ 무신사 쿠폰 조회 제한(429) — ${fmt(coupons.checked)}개에서 중단`;
    case 'error':
      return '⚠️ 무신사 쿠폰 조회 실패 — Actions 로그 확인';
    default:
      return null;
  }
}

function dropLine(row, prevPrice, currentPrice, dropRate) {
  return (
    `🔻 [${escapeHtml(row.brand_name ?? '-')}] ${escapeHtml(row.name)} — ${fmt(prevPrice)}→${fmt(currentPrice)}원 (-${dropRate}%)\n` +
    `  • <a href="${escapeHtml(row.url)}">바로가기</a>`
  );
}

// A coupon drop whose goods row is gone from the store has no name or link to show: skipped.
function couponDropLines(drops, lookup, limit) {
  const out = [];
  for (const d of drops) {
    if (out.length >= limit) break;
    const row = lookup(d.goods_no);
    if (row) out.push(dropLine(row, d.prevPrice, d.currentPrice, d.dropRate));
  }
  return out;
}

const saleDropLines = (drops, limit) => drops.slice(0, limit).map((d) => dropLine(d.row, d.prevPrice, d.currentPrice, d.dropRate));

export function formatMusinsaWideDigest(result, { limit = 10, lookup = () => undefined } = {}) {
  const head = [`<b>🛍 [Project-Clot] 무신사 와이드 리포트 (${result.date})</b>\n`, scanLine(result.categoryCounts)];
  const { diff, coupons } = result;
  if (!diff) return head.join('\n');

  head.push(
    diff.initial
      ? `초기 적재 ${fmt(diff.added.length)}개`
      : `신규 ${fmt(diff.added.length)} · 가격변동 ${fmt(diff.priceChanged)} · 범위이탈 ${fmt(diff.outOfScope)} · 재등장 ${fmt(diff.revived.length)}`
  );

  if (coupons) {
    head.push(`🎟 쿠폰 조회 ${fmt(coupons.checked)}개 (실패 ${fmt(coupons.failed)}) · 쿠폰가 ${fmt(coupons.priced)}개 · 미확인·오래됨 ${fmt(coupons.stale)}개`);
    const warning = couponWarning(coupons);
    if (warning) head.push(warning);
  }

  const couponMode = coupons?.drops?.length > 0;
  const title = couponMode ? '쿠폰가' : '판매가';
  const lines = couponMode ? couponDropLines(coupons.drops, lookup, limit) : saleDropLines(diff.drops, limit);
  const build = () => {
    const out = [...head];
    if (lines.length) out.push('', `<b>📉 ${title} 10% 이상 하락 (상위 ${lines.length}):</b>`, ...lines);
    return out.join('\n');
  };
  let text = build();
  while (text.length > TELEGRAM_MAX && lines.length) {
    lines.pop();
    text = build();
  }
  return text.length > TELEGRAM_MAX ? text.slice(0, TELEGRAM_MAX) : text;
}
