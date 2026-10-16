import { CATEGORIES_MUSINSA } from './client.js';
import { DAILY_GOODS_TARGET } from './partitions.js';

// Run after the Release push so an incomplete attempt remains recoverable but cannot appear green.
export function verifyDailyCoverage(run) {
  if (!run || run.complete !== 1) throw new Error('Daily product scan incomplete');
  const categories = JSON.parse(run.category_counts_json ?? 'null');
  if (!Array.isArray(categories) || categories.length !== CATEGORIES_MUSINSA.length ||
      new Set(categories.map(c => c.cat)).size !== CATEGORIES_MUSINSA.length ||
      categories.some(c => !CATEGORIES_MUSINSA.includes(c.cat) || !c.complete || !Number.isSafeInteger(c.scanned) || c.scanned < 0)) {
    throw new Error('Daily category coverage incomplete');
  }
  const selected = categories.reduce((n,c) => n+c.scanned,0);
  if (selected !== DAILY_GOODS_TARGET) throw new Error(`Daily target incomplete: ${selected}/${DAILY_GOODS_TARGET}`);
  const walk = JSON.parse(run.coupon_metrics_json ?? 'null')?.walk;
  if (!walk?.complete || walk.stop || walk.failed !== 0 || walk.remaining !== 0 || walk.walked !== walk.requested) {
    throw new Error('Daily coupon list coverage incomplete');
  }
  return { selected, couponLists: walk.walked, calls: walk.calls };
}
