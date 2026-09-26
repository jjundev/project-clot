import { exec } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// Check for .env or environment variables
function getEnvConfig() {
  const envPath = path.join(process.cwd(), '.env');
  const config = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || '',
  };

  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const l of lines) {
      const match = l.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match) {
        config[match[1]] = match[2].trim();
      }
    }
  }

  return config;
}

export function sendMacNotification(title, message) {
  const sanitizedTitle = title.replace(/"/g, '\\"');
  const sanitizedMsg = message.replace(/"/g, '\\"');
  exec(
    `osascript -e 'display notification "${sanitizedMsg}" with title "${sanitizedTitle}" sound name "Glass"'`,
    (err) => {
      if (err) console.error('Failed to send Mac notification:', err.message);
    }
  );
}

const TELEGRAM_TIMEOUT_MS = 10_000;

// Awaited by daily ticks and collection runs: a stalled API must not hold them for fetch's ~300 s default.
export async function sendTelegramMessage(text, { fetchFn = fetch, timeoutMs = TELEGRAM_TIMEOUT_MS } = {}) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = getEnvConfig();
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return false;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error('Telegram notification error:', err.message);
    return false;
  }
}

export async function notifyPriceDropsAndRestocks({ priceDropped = [], restocked = [] } = {}) {
  if (priceDropped.length === 0 && restocked.length === 0) {
    return;
  }

  // 1. Send macOS desktop notification
  if (priceDropped.length > 0) {
    const topDrop = priceDropped[0];
    sendMacNotification(
      '📉 무신사 가격 하락 알림!',
      `${topDrop.item.goods_name.slice(0, 25)}... 외 ${priceDropped.length}건 가격 하락`
    );
  } else if (restocked.length > 0) {
    const topRestock = restocked[0];
    sendMacNotification(
      '📦 무신사 재입고 알림!',
      `${topRestock.item.goods_name.slice(0, 25)}... 외 ${restocked.length}건 재입고`
    );
  }

  // 2. Format Telegram message if configured
  const lines = ['<b>🔔 [Project-Clot] 무신사 실시간 가격 변동 리포트</b>\n'];

  if (priceDropped.length > 0) {
    lines.push('<b>📉 가격 하락 & 최저가 갱신:</b>');
    for (const d of priceDropped.slice(0, 10)) {
      const badge = d.isNewLowest ? '🔥 [역대 최저가!]' : '🔻';
      lines.push(
        `${badge} <b>[${d.item.brand_name}] ${d.item.goods_name}</b>\n` +
          `  • 기존가: ${d.prevPrice.toLocaleString()}원 → <b>현재가: ${d.currentPrice.toLocaleString()}원</b> (-${d.dropAmount.toLocaleString()}원, -${d.dropRate}%)\n` +
          `  • <a href="${d.item.url}">상품 바로가기</a>`
      );
    }
    lines.push('');
  }

  if (restocked.length > 0) {
    lines.push('<b>📦 품절 상품 재입고:</b>');
    for (const r of restocked.slice(0, 10)) {
      const priceStr = (r.priceInfo.myPrice || r.priceInfo.salePrice)?.toLocaleString() || '-';
      lines.push(
        `✨ <b>[${r.item.brand_name}] ${r.item.goods_name}</b>\n` +
          `  • 현재가: ${priceStr}원\n` +
          `  • <a href="${r.item.url}">상품 바로가기</a>`
      );
    }
  }

  const message = lines.join('\n');
  await sendTelegramMessage(message);
}

export function formatHotDealsSummary(discoveryItems = []) {
  if (!discoveryItems || discoveryItems.length === 0) {
    return '';
  }

  const seen = new Set();
  const dedupedItems = [];
  for (const it of discoveryItems) {
    const key = it.goodsNo || it.goods_no;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    dedupedItems.push(it);
  }

  const itemsWithDiscount = dedupedItems.map((item) => {
    const normalPrice = item.normalPrice ?? item.normal_price ?? null;
    const targetPrice =
      item.estimatedMyPrice ??
      item.estimated_my_price ??
      item.couponPrice ??
      item.coupon_price ??
      item.salePrice ??
      item.sale_price ??
      null;

    let discountRate = 0;
    if (normalPrice && targetPrice && normalPrice > targetPrice) {
      discountRate = Math.round(((normalPrice - targetPrice) / normalPrice) * 100);
    } else if (item.saleRate || item.sale_rate) {
      discountRate = Number(item.saleRate || item.sale_rate);
    }

    return {
      ...item,
      discountRate,
      targetPrice,
    };
  });

  itemsWithDiscount.sort((a, b) => b.discountRate - a.discountRate);
  const top5 = itemsWithDiscount.slice(0, 5);

  const lines = ['<b>🔥 오늘의 탐색 핫딜 Top 5 (발매 2년 이내 & 좋아요 1,000+)</b>\n'];
  top5.forEach((item, index) => {
    const rank = index + 1;
    const brand = item.brandName || item.brand_name || '-';
    const name = item.goodsName || item.goods_name || '상품';
    const goodsNo = item.goodsNo || item.goods_no;
    const url = item.url || `https://www.musinsa.com/products/${goodsNo}`;
    const priceStr = item.targetPrice ? `${item.targetPrice.toLocaleString()}원` : '-';

    lines.push(
      `${rank}. <b>[${brand}]</b> ${name} - 정가 대비 <b>${item.discountRate}%</b> 할인 (추정회원가: <b>${priceStr}</b>)\n` +
        `   • <a href="${url}">상품 바로가기</a>`
    );
  });

  return lines.join('\n');
}

export async function notifySessionWarning({ reason = '브라우저 세션 지연 또는 인증 만료', isFallback = true } = {}) {
  sendMacNotification(
    '⚠️ 무신사 로그인 확인 필요',
    '세션 지연으로 비로그인 추정가 모드로 수집되었습니다. Chrome 무신사 로그인을 확인해주세요.'
  );

  const lines = [
    '<b>⚠️ [Project-Clot] 무신사 로그인 세션 확인 필요</b>\n',
    `• 사유: ${reason}`,
    '• 상태: 개인 쿠폰/등급 할인이 미적용된 <b>비로그인 추정가</b>로 수집되었습니다.',
    '• 조치: Chrome 브라우저에서 <a href="https://www.musinsa.com">musinsa.com</a> 에 접속하여 자동 로그인을 연장해주세요.',
  ];
  return await sendTelegramMessage(lines.join('\n'));
}

export async function notifySessionLost() {
  sendMacNotification('⚠️ 무신사 로그인 필요', 'Chrome에서 무신사 로그인 쿠키를 받지 못했습니다. 다시 로그인해주세요.');
  const lines = [
    '<b>⚠️ [Project-Clot] 무신사 세션 만료</b>\n',
    '• 상태: 저장된 로그인 쿠키가 만료됐고, Chrome에서도 새 쿠키를 받지 못했습니다.',
    '• 영향: 다시 로그인할 때까지 VIP 실제가 대신 OpenCLI/공개가 폴백으로 수집됩니다.',
    '• 조치: Chrome에서 <a href="https://www.musinsa.com">musinsa.com</a> 에 로그인해주세요.',
  ];
  return await sendTelegramMessage(lines.join('\n'));
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function formatExpiryProbeMessage(summaryLine) {
  return [
    '<b>🧪 [Project-Clot] 무신사 토큰 만료 계측</b>\n',
    escapeHtml(summaryLine),
    '\n• 전체 기록: ~/.clot/musinsa-session.json 의 expiryProbes[] (값 없음)',
  ].join('\n');
}

/** One message per expiry probe — the summary line is already value-free. */
export async function notifyExpiryProbe(summaryLine) {
  return await sendTelegramMessage(formatExpiryProbeMessage(summaryLine));
}
