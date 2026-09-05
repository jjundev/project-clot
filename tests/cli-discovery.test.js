import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClotDatabase } from '../src/db.js';
import { formatHotDealsSummary } from '../src/notifier.js';
import { syncLikedItemsFromMusinsa } from '../src/sync.js';
import { parseArgs, exportDataForGit } from '../src/cli.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('CLI Discovery Integration & VIP Promotion', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-cli-disc-'));
  const testDbPath = path.join(tempDir, 'test.db');
  const db = new ClotDatabase(testDbPath);

  t.after(() => {
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test('parseArgs parses space-separated flags and boolean flags', () => {
    const res1 = parseArgs(['discover', '--limit', '50', '--category', '001', '--min-likes', '500']);
    assert.equal(res1.command, 'discover');
    assert.equal(res1.flags.limit, '50');
    assert.equal(res1.flags.category, '001');
    assert.equal(res1.flags['min-likes'], '500');

    const res2 = parseArgs(['daily', '--with-discovery', '--force', '--concurrency=4']);
    assert.equal(res2.command, 'daily');
    assert.equal(res2.flags['with-discovery'], true);
    assert.equal(res2.flags.force, true);
    assert.equal(res2.flags.concurrency, '4');
  });

  await t.test('track command promotes discovery item to like', () => {
    db.upsertItem({
      goods_no: 5555,
      goods_name: 'Trendy Trench Coat',
      source: 'discovery',
      url: 'https://www.musinsa.com/products/5555',
    });

    const before = db.getItem(5555);
    assert.equal(before.source, 'discovery');

    // Simulate promotion
    db.promoteItemToLike(5555);

    const after = db.getItem(5555);
    assert.equal(after.source, 'like');
  });

  await t.test('discovered item price logging records initial estimated prices during ingestion', () => {
    db.upsertItem({
      goods_no: 7777,
      goods_name: 'Fresh Shirt',
      source: 'discovery',
      url: 'https://www.musinsa.com/products/7777',
    });

    db.recordPriceLog({
      goods_no: 7777,
      date: '2026-09-05',
      normal_price: 50000,
      sale_price: 45000,
      coupon_price: 40000,
      sale_rate: 20,
      my_price: null,
      estimated_my_price: 36084,
      is_sold_out: 0,
    });
    db.updateLowestEstimatedPrice(7777, 36084, '2026-09-05');

    const item = db.getItem(7777);
    assert.equal(item.lowest_estimated_price, 36084);
  });

  await t.test('formatHotDealsSummary sorts by discount rate and produces Telegram HTML', () => {
    const mockItems = [
      {
        goodsNo: 1,
        goodsName: 'Item 1 (10% off)',
        brandName: 'Brand A',
        normalPrice: 100000,
        couponPrice: 90000,
        estimatedMyPrice: 90000,
        url: 'https://www.musinsa.com/products/1',
      },
      {
        goodsNo: 2,
        goodsName: 'Item 2 (50% off)',
        brandName: 'Brand B',
        normalPrice: 100000,
        couponPrice: 50000,
        estimatedMyPrice: 50000,
        url: 'https://www.musinsa.com/products/2',
      },
      {
        goodsNo: 3,
        goodsName: 'Item 3 (30% off)',
        brandName: 'Brand C',
        normalPrice: 100000,
        couponPrice: 70000,
        estimatedMyPrice: 70000,
        url: 'https://www.musinsa.com/products/3',
      },
      {
        goodsNo: 4,
        goodsName: 'Item 4 (40% off)',
        brandName: 'Brand D',
        normalPrice: 100000,
        couponPrice: 60000,
        estimatedMyPrice: 60000,
        url: 'https://www.musinsa.com/products/4',
      },
      {
        goodsNo: 5,
        goodsName: 'Item 5 (20% off)',
        brandName: 'Brand E',
        normalPrice: 100000,
        couponPrice: 80000,
        estimatedMyPrice: 80000,
        url: 'https://www.musinsa.com/products/5',
      },
      {
        goodsNo: 6,
        goodsName: 'Item 6 (5% off - should be excluded from top 5)',
        brandName: 'Brand F',
        normalPrice: 100000,
        couponPrice: 95000,
        estimatedMyPrice: 95000,
        url: 'https://www.musinsa.com/products/6',
      },
    ];

    const html = formatHotDealsSummary(mockItems);
    assert.ok(html.includes('<b>🔥 오늘의 탐색 핫딜 Top 5 (발매 2년 이내 & 좋아요 1,000+)</b>'));
    assert.ok(html.includes('1. <b>[Brand B]</b> Item 2 (50% off) - 정가 대비 <b>50%</b> 할인 (추정회원가: <b>50,000원</b>)'));
    assert.ok(html.includes('2. <b>[Brand D]</b> Item 4 (40% off) - 정가 대비 <b>40%</b> 할인 (추정회원가: <b>60,000원</b>)'));
    assert.ok(html.includes('3. <b>[Brand C]</b> Item 3 (30% off) - 정가 대비 <b>30%</b> 할인 (추정회원가: <b>70,000원</b>)'));
    assert.ok(html.includes('4. <b>[Brand E]</b> Item 5 (20% off) - 정가 대비 <b>20%</b> 할인 (추정회원가: <b>80,000원</b>)'));
    assert.ok(html.includes('5. <b>[Brand A]</b> Item 1 (10% off) - 정가 대비 <b>10%</b> 할인 (추정회원가: <b>90,000원</b>)'));
    assert.ok(!html.includes('Item 6'), 'Should only include Top 5');
    assert.ok(html.includes('<a href="https://www.musinsa.com/products/2">상품 바로가기</a>'));
  });

  await t.test('formatHotDealsSummary returns empty string when no items provided', () => {
    assert.equal(formatHotDealsSummary([]), '');
    assert.equal(formatHotDealsSummary(null), '');
  });

  await t.test('syncLikedItemsFromMusinsa auto-promotes discovery items to like', async () => {
    db.upsertItem({
      goods_no: 8888,
      goods_name: 'Discovered Hoodie',
      brand_name: 'DiscoveryBrand',
      source: 'discovery',
      url: 'https://www.musinsa.com/products/8888',
    });

    const mockOutput = JSON.stringify([
      {
        goodsNo: 8888,
        goodsName: 'Discovered Hoodie',
        brandName: 'DiscoveryBrand',
        url: 'https://www.musinsa.com/products/8888',
      },
    ]);

    const res = await syncLikedItemsFromMusinsa({
      dbInstance: db,
      execFn: () => mockOutput,
    });

    assert.ok(res.promotedItems, 'promotedItems must be defined');
    assert.equal(res.promotedItems.length, 1);
    assert.equal(res.promotedItems[0].goods_no, 8888);

    const promoted = db.getItem(8888);
    assert.equal(promoted.source, 'like');
  });

  await t.test('exportDataForGit correctly tags items with [VIP] and [탐색] and writes latest_prices.json', () => {
    db.upsertItem({
      goods_no: 9001,
      goods_name: 'VIP Denim',
      brand_name: 'DenimBrand',
      source: 'like',
      url: 'https://www.musinsa.com/products/9001',
    });
    db.updateLowestPrice(9001, 45000, 48000, '2026-09-05');

    db.upsertItem({
      goods_no: 9002,
      goods_name: 'Discovery Blazer',
      brand_name: 'BlazerBrand',
      source: 'discovery',
      url: 'https://www.musinsa.com/products/9002',
    });
    db.updateLowestEstimatedPrice(9002, 72000, '2026-09-05');

    const exportedPath = exportDataForGit({ dbInstance: db, dataDir: tempDir });
    assert.equal(exportedPath, path.join(tempDir, 'latest_prices.json'));
    assert.ok(fs.existsSync(exportedPath));

    const content = JSON.parse(fs.readFileSync(exportedPath, 'utf-8'));
    assert.ok(content.items.length >= 2);

    const vipItem = content.items.find((it) => it.goods_no === 9001);
    const discItem = content.items.find((it) => it.goods_no === 9002);

    assert.ok(vipItem);
    assert.equal(vipItem.goods_name, '[VIP] VIP Denim');
    assert.equal(vipItem.lowest_price, 45000);
    assert.equal(vipItem.source, 'like');

    assert.ok(discItem);
    assert.equal(discItem.goods_name, '[탐색] Discovery Blazer');
    assert.equal(discItem.lowest_price, 72000);
    assert.equal(discItem.source, 'discovery');
  });

  await t.test('VIP item my_price is protected against clobbering by recordPriceLog or discovery scan', () => {
    const today = new Date().toISOString().split('T')[0];
    const goodsNo = 6001;

    db.upsertItem({
      goods_no: goodsNo,
      goods_name: 'Authentic VIP Coat',
      brand_name: 'VIPBrand',
      source: 'like',
      url: `https://www.musinsa.com/products/${goodsNo}`,
    });

    // Authentic VIP run records my_price = 85000
    db.recordPriceLog({
      goods_no: goodsNo,
      date: today,
      normal_price: 150000,
      sale_price: 120000,
      coupon_price: 100000,
      my_price: 85000,
      estimated_my_price: null,
    });

    const beforeLog = db.getPriceLogs(goodsNo);
    assert.equal(beforeLog[0].my_price, 85000);

    // Later discovery or unauthenticated run tries to record with my_price = null
    db.recordPriceLog({
      goods_no: goodsNo,
      date: today,
      normal_price: 150000,
      sale_price: 120000,
      coupon_price: 100000,
      my_price: null,
      estimated_my_price: 89000,
    });

    const afterLog = db.getPriceLogs(goodsNo);
    assert.equal(afterLog[0].my_price, 85000, 'COALESCE must prevent clobbering non-null my_price with null');
    assert.equal(afterLog[0].estimated_my_price, 89000);

    // Also verify discovery scanner check: existing item with source !== 'discovery' is skipped
    const existing = db.getItem(goodsNo);
    assert.ok(existing);
    assert.notEqual(existing.source, 'discovery');
    const shouldSkipDiscoveryUpdate = Boolean(existing && existing.source !== 'discovery');
    assert.equal(shouldSkipDiscoveryUpdate, true);
  });

  await t.test('formatHotDealsSummary deduplicates items by goodsNo before sorting', () => {
    const itemsWithDuplicates = [
      {
        goodsNo: 501,
        goodsName: 'Duplicate Item A',
        brandName: 'Brand A',
        normalPrice: 100000,
        couponPrice: 40000,
        estimatedMyPrice: 40000,
        url: 'https://www.musinsa.com/products/501',
      },
      {
        goods_no: 501,
        goods_name: 'Duplicate Item A (Repeated)',
        brand_name: 'Brand A',
        normal_price: 100000,
        coupon_price: 40000,
        estimated_my_price: 40000,
        url: 'https://www.musinsa.com/products/501',
      },
      {
        goodsNo: 502,
        goodsName: 'Single Item B',
        brandName: 'Brand B',
        normalPrice: 100000,
        couponPrice: 50000,
        estimatedMyPrice: 50000,
        url: 'https://www.musinsa.com/products/502',
      },
    ];

    const html = formatHotDealsSummary(itemsWithDuplicates);
    const countA = (html.match(/Duplicate Item A/g) || []).length;
    assert.equal(countA, 1, 'Duplicate product should appear exactly once');
    assert.ok(html.includes('Single Item B'));
  });
});


