// One Telegram message per daily 4910 run (parse_mode=HTML, Telegram's 4096-char cap).
const TELEGRAM_MAX = 4096;

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => Number(n).toLocaleString('en-US');

function scanLine(brandCounts) {
  const parts = brandCounts.map((b) => `${escapeHtml(b.name)} ${b.total == null ? '?' : fmt(b.total)}${b.complete ? '' : ' ⚠️ 불완전'}`);
  return `${parts.join(' · ')} 스캔`;
}

function dropLines(drops) {
  return drops.map(
    (d) =>
      `${d.isNewLowest ? '🔥' : '🔻'} [${escapeHtml(d.row.market_name ?? '-')}] ${escapeHtml(d.row.name)} — ` +
      `${fmt(d.prevPrice)}→${fmt(d.currentPrice)}원 (-${d.dropRate}%)\n  • <a href="${escapeHtml(d.row.url)}">바로가기</a>`
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
export function format4910Digest(result, { limit = 10, liked = null } = {}) {
  const head = [`<b>🇯🇵 [Project-Clot] 4910 유니클로·GU 리포트 (${result.date})</b>\n`, scanLine(result.brandCounts)];
  const { diff } = result;
  if (!diff) return head.join('\n');

  head.push(
    diff.initial
      ? `초기 적재 ${fmt(diff.added.length)}개`
      : `신규 ${fmt(diff.added.length)} · 가격변동 ${fmt(diff.priceChanged)} · 종료 ${fmt(diff.dropped.length)} · 재등장 ${fmt(diff.revived.length)}`
  );

  let likedDrops = [];
  if (liked?.memberStatus === 'expired') {
    head.push('⚠️ 4910 로그인 만료 — ABLY_JWT_TOKEN 갱신 필요');
  } else if (liked?.memberStatus === 'error') {
    head.push('⚠️ 4910 찜 가격 기록 실패 — Actions 로그 확인');
  } else if (liked?.memberStatus === 'ok') {
    head.push(`찜 ${fmt(liked.liked)}개 · 가격 기록 ${fmt(liked.logged)}개`);
    likedDrops = likedDropLines(liked.drops.slice(0, limit));
  }

  const lines = dropLines(diff.drops.slice(0, limit));
  const build = () => {
    const out = [...head];
    if (lines.length) out.push('', `<b>📉 10% 이상 하락 (상위 ${lines.length}):</b>`, ...lines);
    if (likedDrops.length) out.push('', `<b>💜 찜 상품 회원가 하락 (상위 ${likedDrops.length}):</b>`, ...likedDrops);
    return out.join('\n');
  };
  let text = build();
  while (text.length > TELEGRAM_MAX && (lines.length || likedDrops.length)) {
    (lines.length ? lines : likedDrops).pop();
    text = build();
  }
  return text.length > TELEGRAM_MAX ? text.slice(0, TELEGRAM_MAX) : text;
}
