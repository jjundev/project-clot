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

export function format4910Digest(result, { limit = 10 } = {}) {
  const head = [`<b>🇯🇵 [Project-Clot] 4910 유니클로·GU 리포트 (${result.date})</b>\n`, scanLine(result.brandCounts)];
  const { diff } = result;
  if (!diff) return head.join('\n');

  head.push(
    diff.initial
      ? `초기 적재 ${fmt(diff.added.length)}개`
      : `신규 ${fmt(diff.added.length)} · 가격변동 ${fmt(diff.priceChanged)} · 종료 ${fmt(diff.dropped.length)} · 재등장 ${fmt(diff.revived.length)}`
  );

  const lines = dropLines(diff.drops.slice(0, limit));
  const build = () =>
    lines.length ? [...head, '', `<b>📉 10% 이상 하락 (상위 ${lines.length}):</b>`, ...lines].join('\n') : head.join('\n');
  let text = build();
  while (text.length > TELEGRAM_MAX && lines.length) {
    lines.pop();
    text = build();
  }
  return text.length > TELEGRAM_MAX ? text.slice(0, TELEGRAM_MAX) : text;
}
