import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(ROOT_DIR, 'data');
const DEFAULT_LOG_DIR = path.join(ROOT_DIR, 'logs');

export function scanLogsForAudit(dateStr, logDir = DEFAULT_LOG_DIR) {
  const logFile = path.join(logDir, 'daily.log');
  const errFile = path.join(logDir, 'daily.err');

  let circuitBreakerTriggered = false;
  let fatalErrorCount = 0;
  let fatalErrorSnippets = [];
  let detectedModes = [];

  if (fs.existsSync(logFile)) {
    try {
      const logContent = fs.readFileSync(logFile, 'utf-8');
      const lines = logContent.split('\n');
      
      const dateHeaderRegex = new RegExp(`Daily Run:\\s*${dateStr}\\s*\\(([^)]+)\\)`, 'i');
      let isTargetDateSection = false;

      for (const line of lines) {
        const headerMatch = line.match(dateHeaderRegex);
        if (headerMatch) {
          isTargetDateSection = true;
          detectedModes.push(headerMatch[1].trim());
        }

        if (isTargetDateSection) {
          if (line.includes('[OpenCLI CircuitBreaker]')) {
            circuitBreakerTriggered = true;
          }
        }
      }
    } catch {
      // ignore read error
    }
  }

  if (fs.existsSync(errFile)) {
    try {
      const errContent = fs.readFileSync(errFile, 'utf-8');
      const errLines = errContent.split('\n');
      for (const line of errLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Ignore benign npm update notices
        if (trimmed.includes('Update available') || trimmed.includes('npm install -g')) {
          continue;
        }
        if (
          trimmed.startsWith('Error:') ||
          trimmed.startsWith('FATAL') ||
          trimmed.includes('UnhandledPromiseRejection') ||
          trimmed.includes('SyntaxError') ||
          trimmed.includes('ReferenceError')
        ) {
          fatalErrorCount++;
          if (fatalErrorSnippets.length < 3) {
            fatalErrorSnippets.push(trimmed);
          }
        }
      }
    } catch {
      // ignore read error
    }
  }

  return {
    circuitBreakerTriggered,
    fatalErrorCount,
    fatalErrorSnippets,
    detectedModes,
  };
}

export function checkArtifacts(dateStr, dataDir = DEFAULT_DATA_DIR) {
  const dashboardPath = path.join(dataDir, 'dashboard.html');
  const latestJsonPath = path.join(dataDir, 'latest_prices.json');

  let dashboardExists = false;
  let latestJsonFresh = false;

  if (fs.existsSync(dashboardPath)) {
    try {
      const stat = fs.statSync(dashboardPath);
      dashboardExists = stat.size > 1000;
    } catch {}
  }

  if (fs.existsSync(latestJsonPath)) {
    try {
      const raw = fs.readFileSync(latestJsonPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.updated_at && parsed.updated_at.startsWith(dateStr)) {
        latestJsonFresh = true;
      }
    } catch {}
  }

  return {
    dashboardExists,
    latestJsonFresh,
  };
}

export function runAudit({
  dateStr = new Date().toISOString().split('T')[0],
  dbInstance = db,
  dataDir = DEFAULT_DATA_DIR,
  logDir = DEFAULT_LOG_DIR,
} = {}) {
  const dbReport = dbInstance.getDailyAuditReport(dateStr);
  const logAudit = scanLogsForAudit(dateStr, logDir);
  const artifacts = checkArtifacts(dateStr, dataDir);

  const remediations = [];

  // Dimension 1: Run Status
  let runStatus = { verdict: 'PASS', details: '' };
  if (!dbReport.dailyRun) {
    runStatus = {
      verdict: 'FAIL',
      details: `No daily_runs record found for ${dateStr}. Collection may have not been scheduled or terminated abnormally.`,
    };
    remediations.push(`Run manual collection: node src/cli.js daily --force`);
  } else if (dbReport.dailyRun.mode === 'skipped') {
    runStatus = {
      verdict: 'INFO',
      details: `Daily collection was intentionally skipped by user request.`,
    };
  } else if (dbReport.dailyRun.mode === 'deferred') {
    runStatus = {
      verdict: 'WARN',
      details: `Run completed in deferred mode (public/estimated prices only; clamshell sleep detected).`,
    };
    remediations.push(`Upgrade to authenticated prices now: node src/cli.js daily --force --assume-awake`);
  } else if (dbReport.dailyRun.mode === 'degraded') {
    runStatus = {
      verdict: 'WARN',
      details: `Run completed in degraded mode due to browser bridge warnings.`,
    };
    remediations.push(`Check Chrome login session and re-run: node src/cli.js daily --force`);
  } else {
    runStatus = {
      verdict: 'PASS',
      details: `Mode: ${dbReport.dailyRun.mode}, Duration: ${(dbReport.dailyRun.duration_ms / 1000).toFixed(1)}s, Completed: ${dbReport.dailyRun.completed_at}`,
    };
  }

  // Dimension 2: Catalog Coverage
  let coverage = { verdict: 'PASS', details: '' };
  const catalogCount = dbReport.catalogCount;
  const distinctLogged = dbReport.distinctItems;
  const missingCount = Math.max(0, catalogCount - distinctLogged);

  if (dbReport.dailyRun && dbReport.dailyRun.mode === 'skipped') {
    coverage = {
      verdict: 'INFO',
      details: `${distinctLogged} / ${catalogCount} items logged (Collection skipped by user request).`,
    };
  } else if (catalogCount > 0 && distinctLogged === 0) {
    coverage = {
      verdict: 'FAIL',
      details: `0 / ${catalogCount} items logged. Zero items collected.`,
    };
    remediations.push(`Verify Musinsa connection and re-run: node src/cli.js sync && node src/cli.js track`);
  } else if (missingCount > 0) {
    coverage = {
      verdict: 'FAIL',
      details: `${distinctLogged} / ${catalogCount} items logged (${missingCount} items missing).`,
    };
    remediations.push(`Re-run missing items: node src/cli.js track`);
  } else {
    coverage = {
      verdict: 'PASS',
      details: `${distinctLogged} / ${catalogCount} items logged (100% coverage, 0 missing).`,
    };
  }

  // Dimension 3: Auth Rate (OpenCLI my-prices)
  let authRate = { verdict: 'PASS', details: '' };
  const authCount = dbReport.myPriceCount;
  const authRatio = distinctLogged > 0 ? (authCount / distinctLogged) : 0;
  const authPercent = (authRatio * 100).toFixed(1);

  if (dbReport.dailyRun && dbReport.dailyRun.mode === 'skipped') {
    authRate = {
      verdict: 'INFO',
      details: `${authCount} / ${distinctLogged} authenticated prices (Collection skipped by user request).`,
    };
  } else if (dbReport.dailyRun && dbReport.dailyRun.mode === 'deferred') {
    authRate = {
      verdict: 'WARN',
      details: `0 / ${distinctLogged} authenticated prices (Expected for deferred mode).`,
    };
  } else if (distinctLogged > 0 && authCount === 0) {
    authRate = {
      verdict: 'FAIL',
      details: `0 / ${distinctLogged} (0%) items have authenticated my_price. OpenCLI session was completely unutilized or expired.`,
    };
    remediations.push(`Check Musinsa login in Chrome: opencli musinsa my-prices 595040`);
  } else if (authCount < distinctLogged) {
    authRate = {
      verdict: 'WARN',
      details: `${authCount} / ${distinctLogged} (${authPercent}%) items have my_price (${distinctLogged - authCount} unauthenticated).`,
    };
    remediations.push(`Re-collect authenticated prices: node src/cli.js daily --force`);
  } else {
    authRate = {
      verdict: 'PASS',
      details: `${authCount} / ${distinctLogged} (${authPercent}%) items have authenticated my_price.`,
    };
  }

  // Dimension 4: Log Cleanliness
  let logCleanliness = { verdict: 'PASS', details: '' };
  if (logAudit.circuitBreakerTriggered) {
    logCleanliness = {
      verdict: 'FAIL',
      details: `OpenCLI circuit breaker was triggered (2 consecutive batch timeouts/failures). Direct parser fallback occurred.`,
    };
    remediations.push(`Restart Chrome browser bridge extension and test: opencli musinsa likes`);
  } else if (logAudit.fatalErrorCount > 0) {
    logCleanliness = {
      verdict: 'FAIL',
      details: `${logAudit.fatalErrorCount} fatal error(s) logged in daily.err.`,
    };
    remediations.push(`Inspect errors: tail -n 50 logs/daily.err`);
  } else {
    logCleanliness = {
      verdict: 'PASS',
      details: `0 fatal errors in daily.err, 0 circuit breaker trips in daily.log.`,
    };
  }

  // Dimension 5: Artifact Sync
  let artifactSync = { verdict: 'PASS', details: '' };
  if (!artifacts.dashboardExists && !artifacts.latestJsonFresh) {
    artifactSync = {
      verdict: 'WARN',
      details: `Neither dashboard.html nor latest_prices.json refreshed for ${dateStr}.`,
    };
    remediations.push(`Regenerate artifacts: node src/cli.js export && node src/cli.js visualize --no-open`);
  } else if (!artifacts.dashboardExists) {
    artifactSync = {
      verdict: 'WARN',
      details: `dashboard.html missing or corrupt.`,
    };
    remediations.push(`Regenerate dashboard: node src/cli.js visualize --no-open`);
  } else {
    artifactSync = {
      verdict: 'PASS',
      details: `dashboard.html and latest_prices.json up-to-date.`,
    };
  }

  // Overall verdict computation
  const verdicts = [
    runStatus.verdict,
    coverage.verdict,
    authRate.verdict,
    logCleanliness.verdict,
    artifactSync.verdict,
  ];

  let overallVerdict = 'PASS';
  if (verdicts.includes('FAIL')) {
    overallVerdict = 'FAIL';
  } else if (verdicts.includes('WARN')) {
    overallVerdict = 'WARN';
  }

  return {
    date: dateStr,
    overallVerdict,
    dimensions: {
      runStatus,
      coverage,
      authRate,
      logCleanliness,
      artifactSync,
    },
    metrics: {
      catalogCount,
      distinctLogged,
      missingCount,
      authCount,
      authPercent: Number(authPercent),
      soldOutCount: dbReport.soldOutCount,
      priceDropCount: dbReport.priceDrops.length,
      durationMs: dbReport.dailyRun?.duration_ms || 0,
      mode: dbReport.dailyRun?.mode || 'none',
      completedAt: dbReport.dailyRun?.completed_at || null,
    },
    priceDrops: dbReport.priceDrops,
    remediations: Array.from(new Set(remediations)),
  };
}

export function formatAuditTerminal(audit) {
  const icon = (v) => {
    if (v === 'PASS') return '✅ PASS';
    if (v === 'WARN') return '⚠️  WARN';
    if (v === 'INFO') return 'ℹ️  INFO';
    return '❌ FAIL';
  };

  const lines = [
    '============================================================',
    `📋 Project-Clot Daily Collection Audit: ${audit.date}`,
    '============================================================',
    `Overall Verdict: ${icon(audit.overallVerdict)}`,
    '',
    '[5-POINT VERDICT DIMENSIONS]',
    `  • 1. Run Status:       ${icon(audit.dimensions.runStatus.verdict)} — ${audit.dimensions.runStatus.details}`,
    `  • 2. Catalog Coverage: ${icon(audit.dimensions.coverage.verdict)} — ${audit.dimensions.coverage.details}`,
    `  • 3. OpenCLI Auth:     ${icon(audit.dimensions.authRate.verdict)} — ${audit.dimensions.authRate.details}`,
    `  • 4. Log Cleanliness:  ${icon(audit.dimensions.logCleanliness.verdict)} — ${audit.dimensions.logCleanliness.details}`,
    `  • 5. Artifact Sync:    ${icon(audit.dimensions.artifactSync.verdict)} — ${audit.dimensions.artifactSync.details}`,
    '',
    '[PRICE MOVEMENTS & INVENTORY]',
    `  • Price Drops: ${audit.metrics.priceDropCount} item(s)`,
  ];

  if (audit.priceDrops && audit.priceDrops.length > 0) {
    audit.priceDrops.slice(0, 5).forEach((item, idx) => {
      const dropFormatted = Number(item.drop_amount || 0).toLocaleString();
      const curFormatted = Number(item.current_price || 0).toLocaleString();
      const prevFormatted = Number(item.prev_price || 0).toLocaleString();
      lines.push(
        `    ${idx + 1}. [${item.brand_name || '-'}] ${(item.goods_name || '').slice(0, 32)}: ${prevFormatted}원 → ${curFormatted}원 (▼ ${dropFormatted}원 / -${item.drop_rate}%)`
      );
    });
  } else {
    lines.push('    (No price drops detected on this date)');
  }

  lines.push(`  • Sold Out Items: ${audit.metrics.soldOutCount} item(s)`);

  if (audit.remediations && audit.remediations.length > 0) {
    lines.push('');
    lines.push('[ACTIONABLE REMEDIATION]');
    audit.remediations.forEach((rem, idx) => {
      lines.push(`  ${idx + 1}. ${rem}`);
    });
  }

  lines.push('============================================================');
  return lines.join('\n');
}
