import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ClotDatabase } from './db.js';

/**
 * Parses ps command output to find running Project-Clot collection and OpenCLI processes.
 *
 * @param {string} psOutput
 * @param {number} selfPid
 * @returns {Array<{ pid: number, command: string }>}
 */
export function parseProcessList(psOutput, options = {}) {
  const selfPid = typeof options === 'number' ? options : (options.selfPid ?? process.pid);
  const parentPid = typeof options === 'object' && options.parentPid !== undefined ? options.parentPid : process.ppid;

  const lines = String(psOutput || '').split('\n');
  const matched = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;

    const pid = Number(match[1]);
    const cmd = match[2];

    if (pid === selfPid || pid === parentPid) continue;
    // Don't match the skip command itself, test runner, or grep
    if (/\b(cli\.js\s+skip|skip-daily\.js|grep\b|node\s+--test|\.test\.js)\b/.test(cmd)) continue;

    const isDailyCli = /node\s+.*cli\.js\s+daily\b/.test(cmd);
    const isCaffeinateDaily = /caffeinate\s+.*cli\.js\s+daily\b/.test(cmd);
    const isOpenCliMusinsa = /opencli\s+musinsa\s+/.test(cmd);

    if (isDailyCli || isCaffeinateDaily || isOpenCliMusinsa) {
      matched.push({ pid, command: cmd });
    }
  }

  return matched;
}

/**
 * Finds all currently running daily collection / OpenCLI processes.
 *
 * @param {{ execFn?: Function, selfPid?: number }} [options]
 * @returns {Array<{ pid: number, command: string }>}
 */
export function findRunningDailyProcesses({ execFn = execSync, selfPid = process.pid } = {}) {
  try {
    const stdout = execFn('ps -eo pid,command', { encoding: 'utf-8' });
    return parseProcessList(stdout, selfPid);
  } catch {
    return [];
  }
}

/**
 * Terminates the specified processes using SIGTERM.
 *
 * @param {Array<{ pid: number, command: string }>} processes
 * @param {{ killFn?: Function }} [options]
 * @returns {number[]} array of successfully signaled PIDs
 */
export function terminateProcesses(processes, { killFn = process.kill.bind(process) } = {}) {
  const terminatedPids = [];
  for (const proc of processes) {
    try {
      killFn(proc.pid, 'SIGTERM');
      terminatedPids.push(proc.pid);
    } catch {
      // Process already terminated or permission error
    }
  }
  return terminatedPids;
}

/**
 * Skips the daily collection for target date:
 * 1. Terminates any running daily collection and OpenCLI processes.
 * 2. Updates daily_runs mode in SQLite to 'skipped'.
 * 3. Appends a skip record to daily.log.
 *
 * @param {object} options
 * @param {string} [options.dateStr] YYYY-MM-DD
 * @param {ClotDatabase} [options.dbInstance]
 * @param {string} [options.dataDir]
 * @param {string} [options.logDir]
 * @param {Function} [options.execFn]
 * @param {Function} [options.killFn]
 * @param {boolean} [options.terminateRunning]
 * @returns {Promise<{ date: string, terminatedProcesses: Array<{ pid: number, command: string }>, dailyRun: object, logAppended: boolean }>}
 */
export async function skipDailyRun({
  dateStr = new Date().toISOString().split('T')[0],
  dbInstance = null,
  dataDir = path.resolve(process.cwd(), 'data'),
  logDir = path.resolve(process.cwd(), 'logs'),
  execFn = execSync,
  killFn = process.kill.bind(process),
  terminateRunning = true,
} = {}) {
  let ownDb = false;
  let db = dbInstance;
  if (!db) {
    db = new ClotDatabase(path.join(dataDir, 'prices.db'));
    ownDb = true;
  }

  let terminated = [];
  try {
    // 1. Terminate running processes if requested
    if (terminateRunning) {
      const running = findRunningDailyProcesses({ execFn });
      if (running.length > 0) {
        terminateProcesses(running, { killFn });
        terminated = running;
      }
    }

    // 2. Mark database record as skipped
    const dailyRun = db.skipDailyRun(dateStr);

    // 3. Append to logs/daily.log if directory exists
    let logAppended = false;
    const logFilePath = path.join(logDir, 'daily.log');
    if (fs.existsSync(logDir)) {
      const now = new Date().toISOString();
      const logLine = `\n🛑 [Daily Skip] ${dateStr} collection skipped by user request at ${now}. Mode set to 'skipped'.\n`;
      fs.appendFileSync(logFilePath, logLine);
      logAppended = true;
    }

    return {
      date: dateStr,
      terminatedProcesses: terminated,
      dailyRun,
      logAppended,
    };
  } finally {
    if (ownDb && db) {
      db.close();
    }
  }
}

/**
 * Formats skip results for terminal output.
 */
export function formatSkipTerminal(result) {
  const lines = [
    '============================================================',
    `🛑 [Project-Clot] Skip Daily Collection: ${result.date}`,
    '============================================================',
  ];

  if (result.terminatedProcesses && result.terminatedProcesses.length > 0) {
    lines.push(`  • Running Processes Stopped: ${result.terminatedProcesses.length} process(es)`);
    for (const p of result.terminatedProcesses) {
      lines.push(`      - PID ${p.pid}: ${p.command.slice(0, 60)}`);
    }
  } else {
    lines.push('  • Running Processes: None active (clean state)');
  }

  lines.push(`  • Daily Run Status: Mode set to 'skipped' (completed_at: ${result.dailyRun?.completed_at || 'now'})`);
  lines.push('  • Launchd Daemon: All remaining 30-min catch-up ticks today will skip automatically.');
  lines.push('  • Next Scheduled Run: Tomorrow 09:30 AM will resume as normal.');
  lines.push('============================================================');

  return lines.join('\n');
}
