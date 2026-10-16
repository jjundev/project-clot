// One Telegram message per daily 4910 run (parse_mode=HTML, Telegram's 4096-char cap).
const TELEGRAM_MAX = 4096;

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => Number(n).toLocaleString('en-US');

const MAX_INCOMPLETE_NAMES = 5;
const MAX_COUPON_NAMES = 5;
const EXPIRED_LINE = '⚠️ 4910 로그인 만료 — ABLY_JWT_TOKEN 갱신 필요';

// ~100 brands: one summary line, never a per-brand list. A dry run has no seller filter, so it counts scanned rows.
function scanLine(brandCounts, sellers) {
  const dryRun = sellers?.qualified == null;
  const rows = brandCounts.reduce((sum, b) => sum + ((dryRun ? b.scanned : b.qualifiedRows) || 0), 0);
  const incomplete = brandCounts.filter((b) => !b.complete);
  let line = `브랜드 ${fmt(brandCounts.length)}개 스캔 (불완전 ${fmt(incomplete.length)}) · 판매글 ${fmt(rows)}`;
  if (!dryRun) line += ` · 우수 셀러 ${fmt(sellers.qualified)}/${fmt(sellers.seen)}`;
  if (incomplete.length) line += ` ⚠️ ${incomplete.slice(0, MAX_INCOMPLETE_NAMES).map((b) => escapeHtml(b.name)).join(', ')}`;
  return line;
}

// At most MAX_COUPON_NAMES names, then " 외 N" for the rest (a first wallet read can add dozens).
const nameList = (names) =>
  names.slice(0, MAX_COUPON_NAMES).map(escapeHtml).join(', ') + (names.length > MAX_COUPON_NAMES ? ` 외 ${fmt(names.length - MAX_COUPON_NAMES)}` : '');

// 'ok' lists the wallet and its changes, 'error' a failure; 'none', 'expired' (reported separately) and null add nothing.
function couponLines(coupons) {
  if (coupons?.memberStatus === 'error') return ['⚠️ 4910 쿠폰 계산 실패 — Actions 로그 확인'];
  if (coupons?.memberStatus !== 'ok') return [];
  const out = [`🎟 쿠폰 ${fmt(coupons.wallet)}장 · 쿠폰 적용 셀러 ${fmt(coupons.eligible)}곳${coupons.emoney == null ? '' : ` · 포인트 ${fmt(coupons.emoney)}원`}`];
  const { added = [], removed = [] } = coupons.walletChanges ?? {};
  if (added.length) out.push(`🎟 새 쿠폰: ${nameList(added)}`);
  if (removed.length) out.push(`🎟 사라진 쿠폰: ${nameList(removed)}`);
  if (coupons.mismatched > 0) {
    // A result from before the reasons were split counts every hidden seller as a mismatch.
    const { scope, naver, mismatch } = coupons.hidden ?? { scope: 0, naver: 0, mismatch: coupons.mismatched };
    out.push(`⚠️ 쿠폰가 숨김 셀러 ${fmt(coupons.mismatched)}곳 (범위 한정 ${fmt(scope)} · 네이버 ${fmt(naver)} · 불일치 ${fmt(mismatch)})`);
  }
  if (coupons.validation?.unverified) out.push(`⚠️ 가격 재검증 필요 ${fmt(coupons.validation.unverified)}개`);
  return out;
}

// The coupon price rides along only when it actually beats the list price.
const couponSuffix = (d) => (typeof d.couponPrice === 'number' && d.couponPrice < d.currentPrice ? ` (쿠폰가 ${fmt(d.couponPrice)}원)` : '');

function dropLines(drops) {
  return drops.map(
    (d) =>
      `${d.isNewLowest ? '🔥' : '🔻'} [${escapeHtml(d.row.market_name ?? '-')}] ${escapeHtml(d.row.name)} — ` +
      `${fmt(d.prevPrice)}→${fmt(d.currentPrice)}원 (-${d.dropRate}%)${couponSuffix(d)}\n  • <a href="${escapeHtml(d.row.url)}">바로가기</a>`
  );
}

function likedDropLines(drops) {
  return drops.map(
    (d) =>
      `🔻 [${escapeHtml(d.market_name ?? '-')}] ${escapeHtml(d.name)} — ${fmt(d.prevPrice)}→${fmt(d.currentPrice)}원\n` +
      `  • <a href="${escapeHtml(d.url)}">바로가기</a>`
  );
}

// `liked` is the liked-items sync result; 'none' (no token) and null add nothing, 'expired' adds a renewal warning, 'error' a failure warning.
// A login expiry seen by either the coupon pass or the liked sync is warned about once.
export function format4910Digest(result, { limit = 10, liked = null } = {}) {
  const head = [`<b>🇯🇵 [Project-Clot] 4910 리포트 (${result.date})</b>\n`, scanLine(result.brandCounts, result.sellers)];
  const { diff } = result;
  if (!diff) return head.join('\n');

  head.push(
    diff.initial
      ? `초기 적재 ${fmt(diff.added.length)}개`
      : `신규 ${fmt(diff.added.length)} · 가격변동 ${fmt(diff.priceChanged)} · 종료 ${fmt(diff.dropped.length)} · 재등장 ${fmt(diff.revived.length)}`
  );

  head.push(...couponLines(result.coupons));
  if (result.coupons?.memberStatus === 'expired' || liked?.memberStatus === 'expired') head.push(EXPIRED_LINE);

  let likedDrops = [];
  if (liked?.memberStatus === 'error') {
    head.push('⚠️ 4910 찜 가격 기록 실패 — Actions 로그 확인');
  } else if (liked?.memberStatus === 'ok') {
    head.push(`찜 ${fmt(liked.liked)}개 · 가격 기록 ${fmt(liked.logged)}개`);
    if (liked.validation?.unverified) head.push(`⚠️ 찜 가격 재검증 필요 ${fmt(liked.validation.unverified)}개`);
    likedDrops = likedDropLines(liked.drops.slice(0, limit));
  }

  const lines = dropLines(diff.drops.slice(0, limit));
  const build = () => {
    const out = [...head];
    if (lines.length) out.push('', `<b>📉 10% 이상 하락 (상위 ${lines.length}):</b>`, ...lines);
    if (likedDrops.length) out.push('', `<b>💜 찜 상품 쿠폰가 하락 (상위 ${likedDrops.length}):</b>`, ...likedDrops);
    return out.join('\n');
  };
  let text = build();
  while (text.length > TELEGRAM_MAX && (lines.length || likedDrops.length)) {
    (lines.length ? lines : likedDrops).pop();
    text = build();
  }
  return text.length > TELEGRAM_MAX ? text.slice(0, TELEGRAM_MAX) : text;
}
