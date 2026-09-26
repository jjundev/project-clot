import { execSync } from 'node:child_process';
import { db } from './db.js';
import { getExecOptions } from './env.js';
import { fetchLikedGoodsViaHttps } from './likes-https.js';

/**
 * Liked list over authenticated HTTPS. Returns null (caller falls back) on any failure;
 * a SessionExpiredError refreshes the cookie once and restarts from the first page.
 */
async function fetchRemoteLikesViaHttps({ sessionProvider, httpsFetchFn, httpsDelayMs }) {
  const getCookie = async (opts) => {
    try {
      return await sessionProvider(opts);
    } catch (err) {
      console.warn(`[Sync HTTPS Notice] Session provider failed: ${err.message}`);
      return null;
    }
  };
  const onSetCookie = sessionProvider.absorb ? (headers) => sessionProvider.absorb(headers) : null;

  let cookie = await getCookie({ refresh: false });
  if (!cookie) {
    console.warn('[Sync HTTPS Notice] No Musinsa session; skipping HTTPS likes.');
    return null;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await httpsFetchFn(cookie, { delayMs: httpsDelayMs, onSetCookie });
    } catch (err) {
      if (err?.name === 'SessionExpiredError' && attempt === 1) {
        cookie = await getCookie({ refresh: true, failedCookie: cookie });
        if (!cookie) {
          console.warn('[Sync HTTPS Notice] Session expired and could not be refreshed.');
          return null;
        }
        continue;
      }
      console.warn(`[Sync HTTPS Notice] Liked list discarded: ${err.message}`);
      return null;
    }
  }
  return null;
}

function runOpenCliLikes(execFn, limit) {
  return execFn(
    `opencli musinsa likes --limit ${limit} -f json`,
    getExecOptions({
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  );
}

async function fetchRemoteLikesViaOpenCli({ limit, execFn, prewarmFn }) {
  if (prewarmFn) {
    try {
      await prewarmFn({ waitMs: process.env.NODE_ENV === 'test' ? 0 : 3000 });
    } catch {}
  }

  let rawOutput = '';
  try {
    rawOutput = runOpenCliLikes(execFn, limit);
  } catch (err) {
    // If timeout, try one self-healing prewarm retry
    if (prewarmFn && (err.message?.includes('ETIMEDOUT') || String(err.stdout || '').includes('TIMEOUT') || String(err.stderr || '').includes('TIMEOUT'))) {
      console.warn('⚠️ [Sync Notice] First attempt timed out. Attempting self-healing session pre-warm and retry...');
      try {
        await prewarmFn({ execFn, waitMs: 4000 });
        rawOutput = runOpenCliLikes(execFn, limit);
      } catch (retryErr) {
        err = retryErr;
      }
    }

    if (!rawOutput) {
      const errorOutput = `${err.stdout || ''}\n${err.stderr || ''}\n${err.message}`;
      if (
        errorOutput.includes('AUTH_REQUIRED') ||
        errorOutput.includes('not logged in') ||
        errorOutput.includes('EMPTY_RESULT')
      ) {
        throw new Error(
          '무신사 로그인이 필요합니다. Chrome 브라우저에서 https://musinsa.com 에 로그인한 후 다시 실행해 주세요. (또는 터미널에서 opencli musinsa login 실행)'
        );
      }
      throw new Error(`Failed to execute opencli musinsa likes: ${err.message}`);
    }
  }

  const jsonStart = rawOutput.indexOf('[');
  if (jsonStart === -1) {
    throw new Error('No JSON array found in opencli output');
  }
  return JSON.parse(rawOutput.slice(jsonStart));
}

export async function syncLikedItemsFromMusinsa({
  limit = 300,
  dbInstance = db,
  execFn = execSync,
  prewarmFn = null,
  sessionProvider = null,
  httpsFetchFn = fetchLikedGoodsViaHttps,
  httpsDelayMs = 700,
  allowOpenCli = true,
} = {}) {
  let remoteLikes = null;
  let source = null;
  if (sessionProvider) {
    console.log('🔄 Syncing Musinsa liked items via HTTPS...');
    remoteLikes = await fetchRemoteLikesViaHttps({ sessionProvider, httpsFetchFn, httpsDelayMs });
    if (remoteLikes) source = 'https';
  }
  if (!remoteLikes) {
    if (!allowOpenCli) {
      throw new Error('Liked items unavailable via HTTPS and OpenCLI is not allowed (browser bridge unavailable)');
    }
    console.log('🔄 Syncing Musinsa liked items via OpenCLI...');
    remoteLikes = await fetchRemoteLikesViaOpenCli({ limit, execFn, prewarmFn });
    source = 'opencli';
  }
  console.log(`📦 Retrieved ${remoteLikes.length} liked items from Musinsa (${source}).`);

  const remoteGoodsNoSet = new Set();
  const summary = {
    source,
    totalRemote: remoteLikes.length,
    newItems: [],
    reactivatedItems: [],
    promotedItems: [],
    unlikedItems: [],
    unchangedCount: 0,
  };

  // 1. Process remote likes
  for (const r of remoteLikes) {
    const goodsNo = Number(r.goodsNo);
    if (!goodsNo) continue;
    remoteGoodsNoSet.add(goodsNo);

    const existing = dbInstance.getItem(goodsNo);
    if (!existing) {
      dbInstance.upsertItem({
        goods_no: goodsNo,
        goods_name: r.goodsName,
        brand_name: r.brandName,
        url: r.url || `https://www.musinsa.com/products/${goodsNo}`,
        source: 'like',
        status: 'ACTIVE',
      });
      summary.newItems.push({ goodsNo, name: r.goodsName, brand: r.brandName });
    } else {
      if (existing.source === 'discovery') {
        dbInstance.promoteItemToLike(goodsNo);
        summary.promotedItems.push(existing);
      }
      if (existing.status === 'UNLIKED') {
        dbInstance.updateItemStatus(goodsNo, 'ACTIVE');
        summary.reactivatedItems.push(existing);
      } else if (existing.source !== 'discovery') {
        summary.unchangedCount++;
      }
    }
  }

  // 2. Detect unliked items (with safety guardrail against partial scroll/crawl cutoff)
  const allDbItems = dbInstance.getAllItems();
  const currentActiveVipCount = allDbItems.filter((i) => i.source === 'like' && i.status === 'ACTIVE').length;

  // Safety guardrail: If DB had substantial active items (>= 10) but remote returned suspiciously few (< 40% of DB count),
  // skip bulk unliking to protect data integrity against incomplete page loads or scroll interruptions.
  const isSuspiciouslyLow = currentActiveVipCount >= 10 && remoteGoodsNoSet.size < currentActiveVipCount * 0.4;

  if (isSuspiciouslyLow) {
    console.warn(
      `🛡️ [Safety Guardrail] Remote returned only ${remoteGoodsNoSet.size} items while DB has ${currentActiveVipCount} active VIP items. Skipping bulk unliking to prevent accidental deactivation.`
    );
  } else {
    for (const item of allDbItems) {
      if (item.source === 'like' && item.status === 'ACTIVE') {
        if (!remoteGoodsNoSet.has(item.goods_no)) {
          dbInstance.updateItemStatus(item.goods_no, 'UNLIKED');
          summary.unlikedItems.push(item);
        }
      }
    }
  }

  return summary;
}
