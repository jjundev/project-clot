import { execSync } from 'node:child_process';
import { db } from './db.js';
import { getExecOptions } from './env.js';

export async function syncLikedItemsFromMusinsa({ limit = 300, dbInstance = db, execFn = execSync } = {}) {
  console.log('🔄 Syncing Musinsa liked items via OpenCLI...');
  
  let rawOutput = '';
  try {
    rawOutput = execFn(
      `opencli musinsa likes --limit ${limit} -f json`,
      getExecOptions({
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    );
  } catch (err) {
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

  const jsonStart = rawOutput.indexOf('[');
  if (jsonStart === -1) {
    throw new Error('No JSON array found in opencli output');
  }

  const remoteLikes = JSON.parse(rawOutput.slice(jsonStart));
  console.log(`📦 Retrieved ${remoteLikes.length} liked items from Musinsa.`);

  const remoteGoodsNoSet = new Set();
  const summary = {
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

  // 2. Detect unliked items (items in DB with source='like' and status='ACTIVE' but missing from current remote likes)
  const allDbItems = dbInstance.getAllItems();
  for (const item of allDbItems) {
    if (item.source === 'like' && item.status === 'ACTIVE') {
      if (!remoteGoodsNoSet.has(item.goods_no)) {
        dbInstance.updateItemStatus(item.goods_no, 'UNLIKED');
        summary.unlikedItems.push(item);
      }
    }
  }

  return summary;
}

