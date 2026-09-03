#!/usr/bin/env node

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { syncLikedItemsFromMusinsa } from './sync.js';
import { collectPricesForActiveItems, fetchProductPriceInfo } from './collector.js';
import { notifyPriceDropsAndRestocks, sendMacNotification } from './notifier.js';
import { setupEnvironment, getExtendedPath } from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PLIST_NAME = 'com.musinsa.price-tracker.plist';
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library/LaunchAgents');
const PLIST_TARGET = path.join(LAUNCH_AGENTS_DIR, PLIST_NAME);

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  const flags = {};
  const positional = [];

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const parts = a.slice(2).split('=');
      flags[parts[0]] = parts[1] !== undefined ? parts[1] : true;
    } else {
      positional.push(a);
    }
  }

  return { command, flags, positional };
}

export function exportDataForGit() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const items = db.getAllItems();
  const summary = {
    updated_at: new Date().toISOString(),
    total_items: items.length,
    active_items: items.filter((it) => it.status === 'ACTIVE').length,
    soldout_items: items.filter((it) => it.status === 'SOLDOUT').length,
    unliked_items: items.filter((it) => it.status === 'UNLIKED').length,
    items: items.map((it) => {
      const latest = db.getLatestPrice(it.goods_no);
      return {
        goods_no: it.goods_no,
        goods_name: it.goods_name,
        brand_name: it.brand_name,
        status: it.status,
        url: it.url,
        current_price: latest?.my_price || latest?.sale_price || null,
        lowest_price: it.lowest_my_price || null,
        lowest_price_date: it.lowest_price_date || null,
        is_sold_out: Boolean(latest?.is_sold_out),
        last_checked: it.last_checked_at,
      };
    }),
  };

  const jsonPath = path.join(DATA_DIR, 'latest_prices.json');
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
    console.log(
      `📊 Sync Summary: +${syncRes.newItems.length} new, ${syncRes.unlikedItems.length} unliked, ${syncRes.unchangedCount} unchanged.`
    );
  } catch (err) {
    console.warn(`⚠️ Warning: Liked items sync failed, proceeding with existing items. (${err.message})`);
  }

  // 2. Collect prices for all active items
  console.log(`\n🔍 Fetching latest prices & discounts...`);
  const results = await collectPricesForActiveItems({
    onProgress: ({ current, total, item, priceInfo }) => {
      process.stdout.write(
        `\r  [${current}/${total}] ${item.brand_name} - ${priceInfo.myPrice ? priceInfo.myPrice.toLocaleString() + '원' : '품절'}`.padEnd(60)
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

  // 4. Export JSON and try Git auto-commit
  exportDataForGit();
  tryGitAutoCommit();

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
  console.log(`   Current price: ${info.myPrice?.toLocaleString() || '-'}원 (Normal: ${info.normalPrice?.toLocaleString()}원)`);
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
    const currStr = latest?.my_price ? latest.my_price.toLocaleString() + '원' : it.status === 'SOLDOUT' ? '품절' : '-';
    const lowStr = it.lowest_my_price ? it.lowest_my_price.toLocaleString() + '원' : '-';
    const brand = (it.brand_name || '-').slice(0, 14);
    const name = it.goods_name.slice(0, 35);
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

async function main() {
  const { command, flags, positional } = parseArgs();

  switch (command) {
    case 'daily':
    case 'run-daily':
      await handleDailyRun(flags);
      break;
    case 'sync':
      await syncLikedItemsFromMusinsa(flags);
      exportDataForGit();
      break;
    case 'track':
    case 'update':
      await collectPricesForActiveItems();
      exportDataForGit();
      break;
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
    case 'list':
      handleList(flags);
      break;
    case 'history':
      handleHistory(positional);
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
  daily [--force]         Run the daily sync & price tracking with daily lock
  sync                   Sync liked items from Musinsa account
  track                  Fetch latest prices for all active tracked items
  watch <url/goodsNo>    Manually add a product to track
  unwatch <goodsNo>      Untrack a product
  list                   List all tracked items with current & lowest prices
  history <goodsNo>      View price history table for a specific product
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

