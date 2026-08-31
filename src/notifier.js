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

export async function sendTelegramMessage(text) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = getEnvConfig();
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return false;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
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
      lines.push(
        `✨ <b>[${r.item.brand_name}] ${r.item.goods_name}</b>\n` +
          `  • 현재가: ${r.priceInfo.myPrice?.toLocaleString() || '-'}원\n` +
          `  • <a href="${r.item.url}">상품 바로가기</a>`
      );
    }
  }

  const message = lines.join('\n');
  await sendTelegramMessage(message);
}
