import { execSync } from 'node:child_process';
import { db } from './db.js';
import { getExecOptions } from './env.js';

export async function syncLikedItemsFromMusinsa({ limit = 300 } = {}) {
  console.log('🔄 Syncing Musinsa liked items via OpenCLI...');
  
  let rawOutput = '';
  try {
    rawOutput = execSync(
      `opencli musinsa likes --limit ${limit} -f json`,
      getExecOptions({
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    );
  } catch (err) {
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
    unlikedItems: [],
    unchangedCount: 0,
  };

  // 1. Process remote likes
  for (const r of remoteLikes) {
    const goodsNo = Number(r.goodsNo);
    if (!goodsNo) continue;
    remoteGoodsNoSet.add(goodsNo);

    const existing = db.getItem(goodsNo);
    if (!existing) {
      db.upsertItem({
        goods_no: goodsNo,
        goods_name: r.goodsName,
        brand_name: r.brandName,
        url: r.url || `https://www.musinsa.com/products/${goodsNo}`,
        source: 'like',
        status: 'ACTIVE',
      });
      summary.newItems.push({ goodsNo, name: r.goodsName, brand: r.brandName });
    } else {
      if (existing.status === 'UNLIKED') {
        db.updateItemStatus(goodsNo, 'ACTIVE');
        summary.reactivatedItems.push(existing);
      } else {
        summary.unchangedCount++;
      }
    }
  }

  // 2. Detect unliked items (items in DB with source='like' and status='ACTIVE' but missing from current remote likes)
  const allDbItems = db.getAllItems();
  for (const item of allDbItems) {
    if (item.source === 'like' && item.status === 'ACTIVE') {
      if (!remoteGoodsNoSet.has(item.goods_no)) {
        db.updateItemStatus(item.goods_no, 'UNLIKED');
        summary.unlikedItems.push(item);
      }
    }
  }

  return summary;
}
