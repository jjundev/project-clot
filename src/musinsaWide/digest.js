// One Telegram message per daily Musinsa wide run (parse_mode=HTML, Telegram's 4096-char cap).
const TELEGRAM_MAX = 4096;

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => Number(n).toLocaleString('en-US');

const MAX_INCOMPLETE_NAMES = 5;
const EXPIRED_LINE = '⚠️ 무신사 로그인 만료 — MUSINSA_COOKIE 갱신 필요';

// 5 top-level categories: one summary line, never a per-category list.
function scanLine(categoryCounts) {
  const incomplete = categoryCounts.filter((c) => !c.complete);
  const rows = categoryCounts.reduce((sum, c) => sum + (c.scanned || 0), 0);
  let line = `대분류 ${fmt(categoryCounts.length)}개 스캔 (불완전 ${fmt(incomplete.length)}) · 상품 ${fmt(rows)}`;
  if (incomplete.length) line += ` ⚠️ ${incomplete.slice(0, MAX_INCOMPLETE_NAMES).map((c) => escapeHtml(c.cat)).join(', ')}`;
  return line;
}

// Warnings by member-checker status: 'ok' adds nothing; 'none' (no cookie) reads like an expiry; 'skipped' (a registry
// not yet ready never reads the session) adds nothing, the not-ready line covers it.
function couponWarning(memberStatus, checked) {
  switch (memberStatus) {
    case 'expired':
    case 'none':
      return EXPIRED_LINE;
    case 'throttled':
      return `⚠️ 무신사 쿠폰 조회 제한(429) — ${fmt(checked)}개에서 중단`;
    case 'error':
      return '⚠️ 무신사 쿠폰 조회 실패 — Actions 로그 확인';
    default:
      return null;
  }
}

// Report anonymous phase stops including exhausted time budgets.
function phaseWarning(name, stop) {
  if (stop === 'throttled') return `⚠️ 무신사 비로그인 쿠폰 API 제한(429) — ${name} 중단`;
  if (stop === 'deadline') return `⚠️ 무신사 시간 예산 소진 — ${name} 중단`;
  if (stop === 'error') return `⚠️ 무신사 ${name} 실패 — Actions 로그 확인`;
  return null;
}

const classifyLine = (c) => (
  `🧮 판별 ${fmt(c.calls)}회 · 쓸 수 있음 ${fmt(c.usable)} · 대상 아님 ${fmt(c.other)} · 범위 밖 ${fmt(c.outOfScope)} · 대기 ${fmt(c.pending)}`
);

function registryLines(reg) {
  const { enum: en, recheck, classify, neighbors, walk, sample, counts } = reg;
  const pct = sample.checked > 0 ? `${((sample.exact / sample.checked) * 100).toFixed(1)}%` : '-';
  return [
    `🔢 번호 순회 ${fmt(en.probed)}개 · 최대 ${en.highest == null ? '-' : fmt(en.highest)} · 새 쿠폰 ${fmt(en.newCoupons)} · 0→양수 ${fmt(recheck.newPositive)}`,
    classifyLine(classify),
    `📒 쓸 수 있는 쿠폰 ${fmt(counts.usable)}종 (새로 ${fmt(counts.added)} · 만료 ${fmt(counts.expiredYesterday)} · 퇴출 ${fmt(counts.retired)})`,
    `🚶 목록 순회 ${fmt(walk.walked)}종 · 호출 ${fmt(walk.calls)} · 실패 ${fmt(walk.failed)}${walk.complete === false ? ` · 미완료 ${fmt(walk.remaining ?? walk.failed)}` : ''}`,
    `🎯 표본 ${fmt(sample.checked)}개 · 정확 ${fmt(sample.exact)} (${pct}) · 낮게 ${fmt(sample.under)} · 높게 ${fmt(sample.over)}`,
    phaseWarning('번호 순회', en.stop ?? recheck.stop),
    phaseWarning('목록 순회', walk.stop),
    phaseWarning('이웃 조회', neighbors?.stop),
  ].filter(Boolean);
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
  const { diff, coupons, registry } = result;
  if (!diff) return head.join('\n');

  head.push(
    diff.initial
      ? `초기 적재 ${fmt(diff.added.length)}개`
      : `신규 ${fmt(diff.added.length)} · 가격변동 ${fmt(diff.priceChanged)} · 범위이탈 ${fmt(diff.outOfScope)} · 재등장 ${fmt(diff.revived.length)}`
  );

  if (coupons) {
    head.push(`🎟 회원 조회 ${fmt(coupons.checked)}개 (실패 ${fmt(coupons.failed)}) · 쿠폰가 ${fmt(coupons.priced)}개 · 쿠폰 적용 ${fmt(coupons.withCoupon)}개`);
    const warning = couponWarning(coupons.memberStatus, coupons.checked);
    if (warning) head.push(warning);
    if (!coupons.ready) head.push('⚠️ 쿠폰 등록부 미완성 — backfill 필요');
    if (coupons.refreshDeferred) head.push('⚠️ 목록 불완전 — 쿠폰가 갱신 보류, 기존 값 유지');
  }
  if (registry) head.push(...registryLines(registry));
  // A suppressed first day shows no drops at all: the sale-price list would stand in for coupon prices that moved at once.
  if (coupons?.dropsSuppressed) head.push('등록부 전환 첫날 — 쿠폰가 하락 알림 생략');

  const couponMode = coupons?.drops?.length > 0;
  const title = couponMode ? '쿠폰가' : '판매가';
  let lines = [];
  if (coupons?.dropsSuppressed) lines = [];
  else if (couponMode) lines = couponDropLines(coupons.drops, lookup, limit);
  else lines = saleDropLines(diff.drops, limit);
  const lateLine = coupons?.lateDrops > 0 ? `늦게 찾은 쿠폰 하락 ${fmt(coupons.lateDrops)}건 제외` : null;
  const build = () => {
    const out = [...head];
    const tail = [];
    if (lateLine) tail.push(lateLine);
    if (lines.length) tail.push(`<b>📉 ${title} 10% 이상 하락 (상위 ${lines.length}):</b>`, ...lines);
    if (tail.length) out.push('', ...tail);
    return out.join('\n');
  };
  let text = build();
  while (text.length > TELEGRAM_MAX && lines.length) {
    lines.pop();
    text = build();
  }
  return text.length > TELEGRAM_MAX ? text.slice(0, TELEGRAM_MAX) : text;
}

// One message per backfill run. A run that is not done keeps the resume line whatever the cause; the warnings say which
// phase failed. Phases are read from `enumStop` and `classifyStop`, never from the merged `stop`, and the member-session
// line comes from `memberStatus`.
export function formatBackfillDigest(result) {
  const { date, from, next, probed, hits, seeded, classify, done, memberStatus, enumStop, classifyStop } = result;
  const out = [
    `<b>🗂 [Project-Clot] 무신사 쿠폰 등록부 전환 (${date})</b>`,
    '',
    `번호 ${fmt(from)}–${fmt(next - 1)} (${fmt(probed)}개) · 상품 있음 ${fmt(hits)} · 기존 쿠폰 등록 ${fmt(seeded)}`,
    classifyLine(classify),
    couponWarning(memberStatus, classify.calls),
    phaseWarning('번호 순회', enumStop),
    phaseWarning('판별', classifyStop),
    done ? '✅ 전환 완료 — 내일 실행부터 등록부로 계산' : `⏸ ${fmt(next)}에서 멈춤 — backfill을 다시 실행해 이어서`,
  ];
  return out.filter((line) => line != null).join('\n');
}
