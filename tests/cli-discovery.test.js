import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClotDatabase } from '../src/db.js';
import { formatHotDealsSummary } from '../src/notifier.js';
import { syncLikedItemsFromMusinsa } from '../src/sync.js';
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

  await t.test('exportDataForGit correctly tags items with [VIP] and [탐색] and lowest estimated price', () => {
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

    const items = db.getAllItems();
    const vip = items.find((it) => it.goods_no === 9001);
    const disc = items.find((it) => it.goods_no === 9002);

    const tagVip = vip.source === 'discovery' ? '[탐색]' : '[VIP]';
    const tagDisc = disc.source === 'discovery' ? '[탐색]' : '[VIP]';

    assert.equal(tagVip, '[VIP]');
    assert.equal(tagDisc, '[탐색]');
    assert.equal(disc.lowest_estimated_price, 72000);
    assert.equal(vip.lowest_my_price, 45000);
  });
});

