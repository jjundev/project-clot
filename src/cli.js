#!/usr/bin/env node

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { syncLikedItemsFromMusinsa } from './sync.js';
import { collectPricesForActiveItems, fetchProductPriceInfo } from './collector.js';
import { notifyPriceDropsAndRestocks, sendMacNotification, formatHotDealsSummary, sendTelegramMessage } from './notifier.js';
import { discoverCategoryGoods } from './discovery.js';
import { setupEnvironment, getExtendedPath } from './env.js';
import { generateDashboardHtml } from './visualizer.js';
import { classifyCategory } from './classifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PLIST_NAME = 'com.musinsa.price-tracker.plist';
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library/LaunchAgents');
const PLIST_TARGET = path.join(LAUNCH_AGENTS_DIR, PLIST_NAME);

export function parseArgs(rawArgs = process.argv.slice(2)) {
  const args = Array.isArray(rawArgs) ? rawArgs : [];
  const command = args[0] || 'help';
  const flags = {};
  const positional = [];
  const BOOLEAN_FLAGS = new Set(['force', 'with-discovery', 'no-open', 'help']);

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (a.includes('=')) {
        const parts = a.slice(2).split('=');
        flags[parts[0]] = parts.slice(1).join('=');
      } else {
        const key = a.slice(2);
        if (!BOOLEAN_FLAGS.has(key) && i + 1 < args.length && !args[i + 1].startsWith('--')) {
          flags[key] = args[++i];
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }

  return { command, flags, positional };
}


export function parseConcurrency(val, defaultVal = 3) {
  if (typeof val === 'boolean' || val === undefined || val === null || val === '') {
    return defaultVal;
  }
  const parsed = Number(val);
  if (!Number.isFinite(parsed) || isNaN(parsed)) {
    return defaultVal;
  }
  // Clamp strictly between 1 and 5 for rate limit safety
  return Math.max(1, Math.min(Math.floor(parsed), 5));
}

export function exportDataForGit({ dbInstance = db, dataDir = DATA_DIR } = {}) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const items = dbInstance.getAllItems();
  const summary = {
    updated_at: new Date().toISOString(),
    total_items: items.length,
    active_items: items.filter((it) => it.status === 'ACTIVE').length,
    soldout_items: items.filter((it) => it.status === 'SOLDOUT').length,
    unliked_items: items.filter((it) => it.status === 'UNLIKED').length,
    items: items.map((it) => {
      const latest = dbInstance.getLatestPrice(it.goods_no);
      const tag = it.source === 'discovery' ? '[탐색]' : '[VIP]';
      const cleanName = (it.goods_name || '').replace(/^\[(VIP|탐색)\]\s*/, '');
      return {
        goods_no: it.goods_no,
        goods_name: `${tag} ${cleanName}`,
        brand_name: it.brand_name,
        source: it.source,
        status: it.status,
        url: it.url,
        current_price: latest?.my_price || latest?.estimated_my_price || latest?.sale_price || null,
        lowest_price: it.lowest_my_price || it.lowest_estimated_price || it.lowest_sale_price || null,
        lowest_price_date: it.lowest_price_date || null,
        is_sold_out: Boolean(latest?.is_sold_out),
        last_checked: it.last_checked_at,
      };
    }),
  };

  const jsonPath = path.join(dataDir, 'latest_prices.json');
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), 'utf-8');
  return jsonPath;
}


function tryGitAutoCommit() {
  try {
    const isGit = fs.existsSync(path.join(ROOT_DIR, '.git'));
    if (!isGit) return;

    exportDataForGit();
    const today = new Date().toISOString().split('T')[0];
    execSync('git add data/', { cwd: ROOT_DIR, stdio: 'ignore' });
    
    // Check if there are staged changes
    const status = execSync('git status --porcelain data/', { cwd: ROOT_DIR, encoding: 'utf-8' });
    if (status.trim()) {
      execSync(`git commit -m "chore(tracker): update daily prices [${today}]"`, {
        cwd: ROOT_DIR,
        stdio: 'ignore',
      });
      // Push to GitHub remote origin main
      try {
        execSync('git push origin main', { cwd: ROOT_DIR, stdio: 'ignore' });
        console.log(`🚀 Git pushed changes to remote repository for ${today}`);
      } catch (pushErr) {
        // Non-fatal
      }
      console.log(`📌 Git auto-commit created for ${today}`);
    }
  } catch (err) {
    // Non-fatal
  }
}

export async function handleDiscover(flags = {}, dbInstance = db) {
  const limit = (typeof flags.limit === 'string' || typeof flags.limit === 'number') ? Number(flags.limit) : 100;
  const minLikes = (typeof flags['min-likes'] === 'string' || typeof flags['min-likes'] === 'number') ? Number(flags['min-likes']) : 1000;
  const years = (typeof flags.years === 'string' || typeof flags.years === 'number') ? Number(flags.years) : 2;
  const categoryRaw = typeof flags.category === 'string' ? flags.category : '001,002,003,103,004';
  const categoryAliases = { '007': '103', '008': '004' };
  const categories = categoryRaw
    .split(',')
    .map((c) => c.trim())
    .map((c) => categoryAliases[c] || c)
    .filter(Boolean);

  console.log(`\n========================================`);
  console.log(`🔍 [Project-Clot] Discovering Category Goods`);
  console.log(`   Categories: ${categories.join(', ')}`);
  console.log(`   Limit per category: ${limit} (Min likes: ${minLikes.toLocaleString()})`);
  console.log(`========================================\n`);

  const allDiscovered = [];
  let newlyIngestedCount = 0;
  const today = new Date().toISOString().split('T')[0];

  for (const cat of categories) {
    try {
      console.log(`📂 Scanning category [${cat}]...`);
      const items = await discoverCategoryGoods({
        categoryCode: cat,
        limit,
        minLikes,
        years,
      });
      console.log(`   ✓ Found ${items.length} items matching criteria in category [${cat}].`);

      for (const item of items) {
        allDiscovered.push(item);
        const existing = dbInstance.getItem(item.goodsNo);
        const isNew = !existing;
        if (isNew) {
          newlyIngestedCount++;
        }

        if (existing && existing.source !== 'discovery') {
          // Do not overwrite price_logs for VIP items during discovery scan
          continue;
        }

        dbInstance.upsertItem({
          goods_no: item.goodsNo,
          goods_name: item.goodsName,
          brand_name: item.brandName,
          url: item.url,
          image_url: item.imageUrl,
          source: existing ? existing.source : 'discovery',
          status: item.isSoldOut ? 'SOLDOUT' : 'ACTIVE',
          category: classifyCategory(item.goodsName, item.brandName, cat),
        });

        dbInstance.recordPriceLog({
          goods_no: item.goodsNo,
          date: today,
          normal_price: item.normalPrice,
          sale_price: item.salePrice,
          coupon_price: item.couponPrice,
          sale_rate:
            item.normalPrice && item.salePrice && item.normalPrice > item.salePrice
              ? Math.round(((item.normalPrice - item.salePrice) / item.normalPrice) * 100)
              : 0,
          my_price: null,
          estimated_my_price: item.estimatedMyPrice,
          coupon_name:
            item.couponPrice && item.salePrice && item.couponPrice < item.salePrice
              ? '쿠폰 적용가'
              : null,
          coupon_discount:
            item.couponPrice && item.salePrice && item.couponPrice < item.salePrice
              ? item.salePrice - item.couponPrice
              : 0,
          is_sold_out: item.isSoldOut ? 1 : 0,
        });

        if (
          !existing ||
          !existing.lowest_estimated_price ||
          (item.estimatedMyPrice && item.estimatedMyPrice < existing.lowest_estimated_price)
        ) {
          dbInstance.updateLowestEstimatedPrice(item.goodsNo, item.estimatedMyPrice, today);
        }
      }
    } catch (err) {
      console.error(`❌ Failed scanning category ${cat}:`, err.message);
    }
  }

  // Summary statistics
  let totalDiscountRate = 0;
  let discountCount = 0;
  let minPrice = Infinity;
  let maxPrice = 0;

  for (const it of allDiscovered) {
    const effPrice = it.estimatedMyPrice || it.couponPrice || it.salePrice;
    if (effPrice) {
      if (effPrice < minPrice) minPrice = effPrice;
      if (effPrice > maxPrice) maxPrice = effPrice;
    }
    const norm = it.normalPrice;
    if (norm && effPrice && norm > effPrice) {
      const rate = Math.round(((norm - effPrice) / norm) * 100);
      totalDiscountRate += rate;
      discountCount++;
    }
  }

  const avgDiscount = discountCount > 0 ? Math.round(totalDiscountRate / discountCount) : 0;
  const priceRangeStr =
    minPrice !== Infinity ? `${minPrice.toLocaleString()}원 ~ ${maxPrice.toLocaleString()}원` : '-';

  console.log(`\n========================================`);
  console.log(`✨ [Project-Clot] Discovery Summary`);
  console.log(`========================================`);
  console.log(`  • Categories: ${categories.join(', ')}`);
  console.log(`  • Total Discovered: ${allDiscovered.length} items`);
  console.log(`  • Newly Ingested: ${newlyIngestedCount} items`);
  console.log(`  • Average Discount: ${avgDiscount}%`);
  console.log(`  • Estimated Price Range: ${priceRangeStr}`);
  console.log(`========================================\n`);

  exportDataForGit({ dbInstance });
  return allDiscovered;
}

async function handleDailyRun(flags) {
  const today = new Date().toISOString().split('T')[0];
  const force = Boolean(flags.force);

  console.log(`\n========================================`);
  console.log(`🚀 [Project-Clot] Daily Run: ${today}`);
  console.log(`========================================`);

  if (!force && db.hasRunToday(today)) {
    console.log(`✨ [Daily Lock] Already collected prices today (${today}). Skipping.`);
    return;
  }

  // 1. Sync liked items from Musinsa
  try {
    const syncRes = await syncLikedItemsFromMusinsa();
    const promotedCount = syncRes.promotedItems?.length || 0;
    console.log(
      `📊 Sync Summary: +${syncRes.newItems.length} new, ${syncRes.reactivatedItems.length} reactivated, ${promotedCount} promoted, ${syncRes.unlikedItems.length} unliked, ${syncRes.unchangedCount} unchanged.`
    );
  } catch (err) {
    console.warn(`⚠️ Warning: Liked items sync failed, proceeding with existing items. (${err.message})`);
  }

  // 2. Collect prices for VIP active items
  const concurrency = parseConcurrency(flags.concurrency, 3);
  console.log(`\n🔍 Fetching latest prices & discounts (concurrency: ${concurrency})...`);
  const results = await collectPricesForActiveItems({
    source: 'like',
    concurrency,
    onProgress: ({ current, total, item, priceInfo }) => {
      const displayPrice = priceInfo.isSoldOut
        ? '품절'
        : `${(priceInfo.myPrice || priceInfo.salePrice || 0).toLocaleString()}원`;
      process.stdout.write(
        `\r  [${current}/${total}] ${(item.brand_name || '-').slice(0, 15)} - ${displayPrice}`.padEnd(65)
      );
    },
  });
  console.log('\n');

  console.log(`✅ Collection complete in ${(results.durationMs / 1000).toFixed(1)}s.`);
  console.log(`  • Success: ${results.success} / Failed: ${results.failed}`);
  console.log(`  • Price Drops: ${results.priceDropped.length}`);
  console.log(`  • Restocks: ${results.restocked.length}`);

  // 3. Dispatch notifications if price drop or restock detected
  await notifyPriceDropsAndRestocks(results);

  // Discovery mode if flagged
  if (flags['with-discovery']) {
    console.log(`\n🌐 [Discovery Mode] Running catalog discovery...`);
    try {
      const discovered = await handleDiscover(flags);
      if (discovered && discovered.length > 0) {
        const hotDealsSummary = formatHotDealsSummary(discovered);
        if (hotDealsSummary) {
          await sendTelegramMessage(hotDealsSummary);
          console.log(`📢 [Discovery] Sent Top 5 hot deals summary to Telegram.`);
        }
      }
    } catch (discErr) {
      console.warn(`⚠️ Warning: Discovery failed (${discErr.message})`);
    }
  }

  // 4. Export JSON and try Git auto-commit
  exportDataForGit();
  tryGitAutoCommit();

  // 5. Refresh static dashboard in background
  try {
    generateDashboardHtml({ db, openBrowser: false });
    console.log('📊 Static dashboard refreshed (data/dashboard.html).');
  } catch (dashErr) {
    console.warn('⚠️ Warning: Dashboard regeneration failed:', dashErr.message);
  }

  console.log(`🎉 Daily run finished successfully for ${today}!\n`);
}


async function handleWatch(positional) {
  const target = positional[0];
  if (!target) {
    console.error('Usage: clot watch <url_or_goodsNo>');
    process.exit(1);
  }

  const match = target.match(/(?:products\/|^)(\d+)/);
  const goodsNo = match ? Number(match[1]) : Number(target);

  if (!goodsNo || isNaN(goodsNo)) {
    console.error('Invalid product URL or goodsNo:', target);
    process.exit(1);
  }

  console.log(`🔍 Inspecting product ${goodsNo}...`);
  const info = await fetchProductPriceInfo(goodsNo);
  if (info.discontinued) {
    console.error(`❌ Product ${goodsNo} does not exist or has been discontinued.`);
    process.exit(1);
  }

  db.upsertItem({
    goods_no: goodsNo,
    goods_name: info.goodsName,
    brand_name: info.brandName,
    url: info.url,
    image_url: info.imageUrl,
    source: 'manual',
    status: info.isSoldOut ? 'SOLDOUT' : 'ACTIVE',
  });

  const today = new Date().toISOString().split('T')[0];
  db.recordPriceLog({
    goods_no: goodsNo,
    date: today,
    normal_price: info.normalPrice,
    sale_price: info.salePrice,
    sale_rate: info.saleRate,
    my_price: info.myPrice,
    coupon_name: info.couponName,
    coupon_discount: info.couponDiscount,
    is_sold_out: info.isSoldOut,
  });

  exportDataForGit();
  console.log(`✅ Successfully added [${info.brandName}] ${info.goodsName} to watchlist!`);
  const displayPrice = (info.myPrice || info.salePrice)?.toLocaleString() || '-';
  console.log(`   Current price: ${displayPrice}원 (Normal: ${info.normalPrice?.toLocaleString()}원)`);
}

function handleList(flags) {
  const items = db.getAllItems();
  console.log(`\n📋 Tracked Items List (${items.length} total)\n`);
  console.log(
    'No'.padEnd(4) +
      'Status'.padEnd(10) +
      'Brand'.padEnd(16) +
      'Current Price'.padEnd(16) +
      'Lowest Price'.padEnd(16) +
      'Product Name'
  );
  console.log('-'.repeat(90));

  items.forEach((it, i) => {
    const latest = db.getLatestPrice(it.goods_no);
    const activePrice = latest?.my_price || latest?.estimated_my_price || latest?.sale_price;
    const lowestPrice = it.lowest_my_price || it.lowest_estimated_price || it.lowest_sale_price;
    const currStr = activePrice ? activePrice.toLocaleString() + '원' : it.status === 'SOLDOUT' ? '품절' : '-';
    const lowStr = lowestPrice ? lowestPrice.toLocaleString() + '원' : '-';
    const tag = it.source === 'discovery' ? '[탐색]' : '[VIP]';
    const cleanName = (it.goods_name || '').replace(/^\[(VIP|탐색)\]\s*/, '');
    const brand = (it.brand_name || '-').slice(0, 14);
    const name = `${tag} ${cleanName}`.slice(0, 40);
    console.log(
      String(i + 1).padEnd(4) +
        it.status.padEnd(10) +
        brand.padEnd(16) +
        currStr.padEnd(16) +
        lowStr.padEnd(16) +
        name
    );
  });
  console.log('');
}


function handleHistory(positional) {
  const target = positional[0];
  if (!target) {
    console.error('Usage: clot history <goodsNo>');
    process.exit(1);
  }
  const goodsNo = Number(target.replace(/[^0-9]/g, ''));
  const item = db.getItem(goodsNo);
  if (!item) {
    console.error(`Product ${goodsNo} not found in database.`);
    process.exit(1);
  }

  const logs = db.getPriceHistory(goodsNo, 60);
  console.log(`\n📈 Price History for [${item.brand_name}] ${item.goods_name} (goodsNo: ${goodsNo})\n`);
  console.log('Date'.padEnd(14) + 'Normal Price'.padEnd(16) + 'Sale Price'.padEnd(16) + 'My Price (Coupon)'.padEnd(20) + 'Status');
  console.log('-'.repeat(80));

  for (const l of logs) {
    const normStr = l.normal_price ? l.normal_price.toLocaleString() + '원' : '-';
    const saleStr = l.sale_price ? l.sale_price.toLocaleString() + '원' : '-';
    const myStr = l.my_price ? l.my_price.toLocaleString() + '원' : '-';
    const status = l.is_sold_out ? '품절' : '판매중';
    console.log(
      l.date.padEnd(14) +
        normStr.padEnd(16) +
        saleStr.padEnd(16) +
        myStr.padEnd(20) +
        status
    );
  }
  console.log('');
}

export function generatePlistContent({
  nodePath = process.execPath,
  scriptPath = path.join(__dirname, 'cli.js'),
  rootDir = ROOT_DIR,
  logDir = path.join(ROOT_DIR, 'logs'),
  extendedPath = getExtendedPath(),
  homeDir = os.homedir(),
} = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.musinsa.price-tracker</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${scriptPath}</string>
        <string>daily</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${extendedPath}</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>9</integer>
        <key>Minute</key>
        <integer>30</integer>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${path.join(logDir, 'daily.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(logDir, 'daily.err')}</string>
    <key>WorkingDirectory</key>
    <string>${rootDir}</string>
</dict>
</plist>`;
}

function handleInstallDaemon() {
  if (!fs.existsSync(LAUNCH_AGENTS_DIR)) {
    fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  }

  const logDir = path.join(ROOT_DIR, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const plistContent = generatePlistContent({
    nodePath: process.execPath,
    scriptPath: path.join(__dirname, 'cli.js'),
    rootDir: ROOT_DIR,
    logDir,
    extendedPath: getExtendedPath(),
    homeDir: os.homedir(),
  });

  fs.writeFileSync(PLIST_TARGET, plistContent, 'utf-8');

  try {
    execSync(`launchctl unload "${PLIST_TARGET}"`, { stdio: 'ignore' });
  } catch {}

  try {
    execSync(`launchctl load "${PLIST_TARGET}"`);
    console.log(`✅ Successfully installed & loaded macOS background daemon!`);
    console.log(`   Service: ${PLIST_NAME}`);
    console.log(`   Schedule: Daily at 09:30 AM (Catch-up on boot enabled)`);
    console.log(`   Logs: ${path.join(logDir, 'daily.log')}`);
  } catch (err) {
    console.error('Failed to load launchctl:', err.message);
  }
}

function handleUninstallDaemon() {
  if (fs.existsSync(PLIST_TARGET)) {
    try {
      execSync(`launchctl unload "${PLIST_TARGET}"`, { stdio: 'ignore' });
      fs.unlinkSync(PLIST_TARGET);
      console.log('✅ Successfully uninstalled and removed background daemon.');
    } catch (err) {
      console.error('Error during uninstall:', err.message);
    }
  } else {
    console.log('No background daemon found to uninstall.');
  }
}

function handleVisualize(flags, positional) {
  const digits = positional[0] ? String(positional[0]).replace(/\D/g, '') : '';
  const targetGoodsNo = digits.length > 0 ? Number(digits) : undefined;
  const noOpen = Boolean(flags['no-open'] || flags.noOpen);

  console.log('🎨 Generating price trend dashboard...');
  const res = generateDashboardHtml({
    db,
    openBrowser: !noOpen,
    targetGoodsNo,
  });

  console.log(`✅ 대시보드가 생성되었습니다: ${res.outputPath}`);
  console.log(`   총 ${res.totalItems}개 상품 시계열 반영 완료.`);
  if (res.targetGoodsNo) {
    console.log(`   🎯 타겟 상품 번호: ${res.targetGoodsNo}`);
  }
  if (noOpen) {
    console.log('   (브라우저 열기 생략: --no-open)');
  } else {
    console.log('   🚀 기본 브라우저로 대시보드를 열었습니다.');
    console.log(`   💡 브라우저가 자동으로 뜨지 않으면 직접 열기: open ${res.outputPath}`);
  }
}

async function main() {
  const { command, flags, positional } = parseArgs();

  switch (command) {
    case 'daily':
    case 'run-daily':
      await handleDailyRun(flags);
      break;
    case 'discover':
      await handleDiscover(flags);
      break;
    case 'sync': {
      const syncRes = await syncLikedItemsFromMusinsa(flags);
      const promotedCount = syncRes.promotedItems?.length || 0;
      console.log(
        `📊 Sync Summary: +${syncRes.newItems.length} new, ${syncRes.reactivatedItems.length} reactivated, ${promotedCount} promoted from discovery, ${syncRes.unlikedItems.length} unliked, ${syncRes.unchangedCount} unchanged.`
      );
      if (syncRes.newItems.length > 0) {
        console.log('🆕 Newly Added Items:');
        for (const it of syncRes.newItems) {
          console.log(`   • [${it.goodsNo}] ${it.name} (${it.brand})`);
        }
      }
      if (promotedCount > 0) {
        console.log('✨ Promoted from Discovery to VIP:');
        for (const it of syncRes.promotedItems) {
          console.log(`   • [${it.goods_no}] ${it.goods_name} (${it.brand_name})`);
        }
      }
      exportDataForGit();
      break;
    }
    case 'track':
    case 'update': {
      const singleTarget = positional[0] ? Number(positional[0].replace(/\D/g, '')) : null;
      if (singleTarget) {
        const existing = db.getItem(singleTarget);
        if (existing && existing.source === 'discovery') {
          db.promoteItemToLike(singleTarget);
          console.log(`✨ [VIP 승격] 탐색 카탈로그 상품 ${singleTarget}이(가) VIP 관심 상품으로 승격되었습니다.`);
          exportDataForGit();
          break;
        } else if (!existing) {
          console.log(`상품 ${singleTarget}을(를) 추적 목록에 추가합니다.`);
          await handleWatch([String(singleTarget)]);
          break;
        } else if (existing && existing.source !== 'discovery') {
          console.log(`ℹ️ 상품 ${singleTarget}은(는) 이미 VIP 관심 상품 목록에 등록되어 있습니다.`);
          break;
        }
      }
      // If no single target, proceed to batch price collection across active items
      const concurrency = parseConcurrency(flags.concurrency, 3);
      console.log(`🔍 Fetching latest prices (concurrency: ${concurrency})...`);
      const results = await collectPricesForActiveItems({
        concurrency,
        onProgress: ({ current, total, item, priceInfo }) => {
          const displayPrice = priceInfo.isSoldOut
            ? '품절'
            : `${(priceInfo.myPrice || priceInfo.salePrice || 0).toLocaleString()}원`;
          process.stdout.write(
            `\r  [${current}/${total}] ${(item.brand_name || '-').slice(0, 15)} - ${displayPrice}`.padEnd(65)
          );
        },
      });
      console.log('\n');
      console.log(`✅ Collection complete in ${(results.durationMs / 1000).toFixed(1)}s.`);
      console.log(`  • Success: ${results.success} / Failed: ${results.failed}`);
      console.log(`  • Price Drops: ${results.priceDropped.length}`);
      console.log(`  • Restocks: ${results.restocked.length}`);
      exportDataForGit();
      break;
    }
    case 'watch':
      await handleWatch(positional);
      break;
    case 'unwatch': {
      const gNo = Number(positional[0]);
      if (gNo) {
        db.updateItemStatus(gNo, 'UNLIKED');
        console.log(`✅ Untracked item ${gNo}`);
        exportDataForGit();
      }
      break;
    }
    case 'status':
    case 'list':
      handleList(flags);
      break;
    case 'history':
      handleHistory(positional);
      break;
    case 'visualize':
    case 'dashboard':
      handleVisualize(flags, positional);
      break;
    case 'export':
      exportDataForGit();
      console.log('✅ Exported data to data/latest_prices.json');
      break;
    case 'daemon-install':
      handleInstallDaemon();
      break;
    case 'daemon-uninstall':
      handleUninstallDaemon();
      break;
    default:
      console.log(`
Project-Clot: Musinsa Automated Price Tracker & Wishlist Manager

Usage:
  node src/cli.js <command> [options]

Commands:
  daily [--force] [--concurrency=1-5] [--with-discovery]  Run daily sync & price tracking (default concurrency: 3)
  discover [--category <codes>] [--limit <n>] [--min-likes <n>]  Discover popular products matching criteria
  sync                   Sync liked items from Musinsa account
  track [goodsNo] [--concurrency=1-5]  Track active items or promote discovery item to VIP
  watch <url/goodsNo>    Manually add a product to track
  unwatch <goodsNo>      Untrack a product
  list / status          List tracked items with current & lowest prices ([VIP] / [탐색])
  history <goodsNo>      View price history table for a specific product
  visualize [goodsNo]    Generate and launch interactive price trend dashboard
  export                 Export JSON snapshot for Git commit
  daemon-install         Install macOS launchd background scheduler (09:30 AM)
  daemon-uninstall       Uninstall macOS background scheduler
`);
      break;
  }

}

const currentScript = fileURLToPath(import.meta.url);
const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : '';
let isMainModule = invokedScript === currentScript;
if (!isMainModule && invokedScript) {
  try {
    isMainModule = fs.realpathSync(invokedScript) === currentScript;
  } catch {}
}

if (isMainModule) {
  setupEnvironment();
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

