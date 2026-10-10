// Daily sync of the member's liked 4910 items: refresh the like list, then record each item's display (list),
// coupon and member price. The member token is only ever passed to the client and never logged or stored.
import fs from 'node:fs';
import path from 'node:path';
import { toRow } from './client.js';

export const LIKED_BUDGET_MS_4910 = 4 * 60_000;
export const MAX_LIKED_PAGES_4910 = 50;
const COOKIE_NAME = 'ably-jwt-token';

// The token may be pasted as a bare JWT, a quoted value, a URL-encoded value or a whole cookie string.
function normalizeToken(raw) {
  if (raw == null) return null;
  let v = String(raw).trim();
  const cookie = v.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`, 'i'));
  if (cookie) v = cookie[1].trim();
  v = v.replace(/^(["'])(.*)\1$/, '$2').trim();
  try {
    v = decodeURIComponent(v);
  } catch {
    // not URL-encoded after all; keep as is
  }
  return v || null;
}

/**
 * The member token: env ABLY_JWT_TOKEN, else the ABLY_JWT_TOKEN= line of <cwd>/.env. The .env file is never read
 * when CLOT_NOTIFY_SANDBOX is set (tests), mirroring src/notifier.js.
 */
export function readAblyToken({ env = process.env, envFile = path.join(process.cwd(), '.env') } = {}) {
  const fromEnv = normalizeToken(env.ABLY_JWT_TOKEN);
  if (fromEnv) return fromEnv;
  if (env.CLOT_NOTIFY_SANDBOX || !fs.existsSync(envFile)) return null;
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && match[1] === 'ABLY_JWT_TOKEN') {
      const v = normalizeToken(match[2]);
      if (v) return v;
    }
  }
  return null;
}

/** The JWT's `exp` as a Date, or null when the token has no exp or is not a JWT. */
export function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf-8'));
    return Number.isFinite(payload?.exp) ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

// Pages the whole liked list; MEMBER_AUTH or any other failure rejects before anything is written. A list that
// cannot be read to its end (page cap hit, or the cursor stops advancing) rejects too: a partial list would make
// syncLiked mark every unread like as UNLIKED.
async function listAllLiked(client, memberToken, maxPages) {
  const rows = [];
  let lastSno = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await client.listLikedGoods({ memberToken, lastSno });
    if (!res.entries.length) return rows;
    for (const entry of res.entries) {
      const a = entry.logging?.analytics ?? {};
      rows.push(toRow(entry, { sno: a.BRAND_SNO ?? null, name: a.BRAND_NAME ?? null }));
    }
    const next = res.lastSno ?? null;
    if (next === null) return rows;
    if (next === lastSno) throw new Error('4910 liked list did not finish (cursor repeated)');
    lastSno = next;
  }
  throw new Error('4910 liked list did not finish (page cap)');
}

// A drop is only meaningful between days priced the same way: member vs member, or coupon/list vs coupon/list.
// A day whose member detail failed must not be compared with a member-priced day.
function comparablePrices(prev, row) {
  if ((prev.member_price == null) !== (row.member_price == null)) return null;
  if (row.member_price != null) return { prevPrice: prev.member_price, currentPrice: row.member_price };
  return { prevPrice: prev.coupon_price ?? prev.list_price, currentPrice: row.coupon_price ?? row.list_price };
}

export async function syncLiked4910({
  client, store, date, memberToken, budgetMs = LIKED_BUDGET_MS_4910, maxPages = MAX_LIKED_PAGES_4910, log = console.log,
}) {
  const result = { memberStatus: 'none', liked: 0, logged: 0, drops: [] };
  if (!memberToken) return result;
  const deadline = Date.now() + budgetMs;

  let rows;
  try {
    rows = await listAllLiked(client, memberToken, maxPages);
  } catch (err) {
    if (err.code === 'MEMBER_AUTH') return { ...result, memberStatus: 'expired' };
    throw err;
  }
  store.syncLiked(rows, date);
  result.memberStatus = 'ok';
  result.liked = rows.length;

  const items = store.getActiveLiked();
  for (const item of items) {
    if (Date.now() > deadline) {
      log(`⚠️ [4910] 찜 가격 기록 시간 초과 (${result.logged}/${items.length})`);
      break;
    }

    let anon;
    try {
      anon = await client.getGoodsDetail(item.sno);
    } catch (err) {
      log(`⚠️ [4910] 찜 ${item.sno} 가격 조회 실패 (HTTP ${err.status ?? '?'})`);
      continue;
    }

    let memberPrice = null;
    try {
      memberPrice = (await client.getGoodsDetail(item.sno, { memberToken })).price ?? null;
    } catch (err) {
      if (err.code === 'MEMBER_AUTH') {
        result.memberStatus = 'expired';
        break;
      }
      log(`⚠️ [4910] 찜 ${item.sno} 회원가 조회 실패 (HTTP ${err.status ?? '?'})`);
    }

    const logRow = {
      sno: item.sno,
      date,
      list_price: anon.listPrice,
      original_price: anon.originalPrice,
      coupon_price: anon.couponPrice,
      member_price: memberPrice,
      is_soldout: anon.isSoldout,
    };
    const prev = store.getPrevLikedPrice(item.sno, date);
    store.logLikedPrice(logRow);
    result.logged++;

    const cmp = prev && comparablePrices(prev, logRow);
    if (cmp && cmp.prevPrice != null && cmp.currentPrice != null && cmp.currentPrice < cmp.prevPrice) {
      result.drops.push({ sno: item.sno, name: item.name, market_name: item.market_name, url: item.url, ...cmp });
    }
  }

  const rate = (d) => (d.prevPrice - d.currentPrice) / d.prevPrice;
  result.drops.sort((a, b) => rate(b) - rate(a));
  return result;
}
