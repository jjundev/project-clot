import { execSync } from 'node:child_process';

/**
 * macOS power/wake state probing.
 *
 * Why this exists: launchd fires the 09:30 daily job at the *next wake* when the Mac was
 * asleep. On a MacBook with the lid closed that wake is usually a DarkWake (a few seconds
 * of maintenance wake with no display / WindowServer). Chrome and its OpenCLI extension are
 * effectively frozen in that state, so every browser-bridge call times out (60s each) and
 * the whole run drags across several sleep cycles.
 *
 * The probes below let the daily run detect that situation up-front and go straight to the
 * direct HTTP parser (deferred mode) instead of burning minutes on doomed OpenCLI calls.
 */

const CLAMSHELL_CMD = 'ioreg -r -k AppleClamshellState -d 4';
// Only keep sleep/wake/display lines; the full pmset log is several MB.
const PMSET_LOG_CMD =
  "pmset -g log | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8} [+-][0-9]{4} (Sleep|Wake|DarkWake|Notification) ' | tail -n 200";

/**
 * @param {string} output raw `ioreg -r -k AppleClamshellState -d 4` output
 * @returns {boolean|null} true = lid closed, false = open, null = unknown
 */
export function parseClamshellState(output) {
  const m = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(String(output || ''));
  if (!m) return null;
  return m[1] === 'Yes';
}

/**
 * Parses `pmset -g log` lines and returns the most recent sleep/wake transition and the
 * most recent display notification.
 *
 * pmset log line format: `<date> <time> <tz> <Type padded>\t<details>`
 * The type column can contain spaces ("Wake Requests"), so we split on the first tab.
 *
 * @param {string} log
 * @returns {{ lastWake: 'full'|'dark'|'sleep'|null, lastWakeAt: string|null, displayOn: boolean|null }}
 */
export function parsePmsetWakeLog(log) {
  const result = { lastWake: null, lastWakeAt: null, displayOn: null };
  const lines = String(log || '').split('\n');
  const lineRe = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}) ([^\t]*?)\s*\t(.*)$/;

  for (const line of lines) {
    const m = lineRe.exec(line);
    if (!m) continue;
    const [, timestamp, type, details] = m;

    if (type === 'Sleep') {
      result.lastWake = 'sleep';
      result.lastWakeAt = timestamp;
    } else if (type === 'DarkWake') {
      result.lastWake = 'dark';
      result.lastWakeAt = timestamp;
    } else if (type === 'Wake') {
      result.lastWake = 'full';
      result.lastWakeAt = timestamp;
    } else if (type === 'Notification') {
      if (/Display is turned on/i.test(details)) result.displayOn = true;
      else if (/Display is turned off/i.test(details)) result.displayOn = false;
    }
  }
  return result;
}

/**
 * Decides whether the Chrome/OpenCLI browser bridge can realistically respond right now.
 *
 * @param {{ lidClosed: boolean|null, lastWake: string|null, displayOn: boolean|null }} state
 * @returns {{ usable: boolean, reason: string }}
 */
export function evaluateBridgeUsability({ lidClosed = null, lastWake = null, displayOn = null } = {}) {
  if (lidClosed === true) {
    return { usable: false, reason: '맥북 덮개가 닫혀 있음 (clamshell) — Chrome/OpenCLI 확장 응답 불가' };
  }
  if (lastWake === 'dark') {
    return { usable: false, reason: '시스템이 DarkWake(백그라운드 유지보수 기상) 상태 — GUI 앱 스로틀링 중' };
  }
  if (lastWake === 'sleep') {
    return { usable: false, reason: '마지막 전원 이벤트가 Sleep — 정상 기상 기록 없음' };
  }
  if (displayOn === false && lastWake === null) {
    // No sleep/wake evidence at all but the display is reported off: be conservative.
    return { usable: false, reason: '디스플레이 꺼짐 상태 (기상 기록 없음)' };
  }
  return {
    usable: true,
    reason: lastWake === 'full' ? '정상 기상(Full Wake) 상태' : '수면/기상 기록 없음 — 정상 상태로 간주',
  };
}

/**
 * Probes the current macOS power state. Fails open (bridgeUsable = true) on non-macOS or
 * when the probes themselves fail, so a probe bug can never disable the OpenCLI path.
 *
 * @param {object} options
 * @param {Function} options.execFn injectable execSync for tests
 * @param {string} options.platform injectable process.platform
 * @returns {{ platform: string, lidClosed: boolean|null, lastWake: string|null, lastWakeAt: string|null,
 *            displayOn: boolean|null, bridgeUsable: boolean, reason: string }}
 */
export function getMacPowerState({ execFn = execSync, platform = process.platform } = {}) {
  const base = {
    platform,
    lidClosed: null,
    lastWake: null,
    lastWakeAt: null,
    displayOn: null,
    bridgeUsable: true,
    reason: '',
  };

  if (platform !== 'darwin') {
    return { ...base, reason: 'macOS가 아니므로 전원 상태 감지 생략' };
  }

  const run = (cmd) => {
    try {
      return String(execFn(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024, timeout: 15000 }) || '');
    } catch {
      return '';
    }
  };

  const clamshellOut = run(CLAMSHELL_CMD);
  const pmsetOut = run(PMSET_LOG_CMD);

  if (!clamshellOut && !pmsetOut) {
    return { ...base, reason: '전원 상태 프로브 실패 — 정상 상태로 간주 (fail-open)' };
  }

  const lidClosed = parseClamshellState(clamshellOut);
  const wake = parsePmsetWakeLog(pmsetOut);
  const verdict = evaluateBridgeUsability({ lidClosed, lastWake: wake.lastWake, displayOn: wake.displayOn });

  return {
    ...base,
    lidClosed,
    lastWake: wake.lastWake,
    lastWakeAt: wake.lastWakeAt,
    displayOn: wake.displayOn,
    bridgeUsable: verdict.usable,
    reason: verdict.reason,
  };
}

/**
 * Probes once, and if the bridge looks unusable waits briefly and probes again.
 * The daemon is wrapped in `caffeinate -u`, which can promote a DarkWake to a full wake when
 * the lid is open; the second probe gives that promotion a chance to land.
 */
export async function probeBrowserBridge({ execFn = execSync, platform = process.platform, retryDelayMs = 5000 } = {}) {
  let state = getMacPowerState({ execFn, platform });
  if (!state.bridgeUsable && platform === 'darwin' && retryDelayMs > 0) {
    await new Promise((r) => setTimeout(r, retryDelayMs));
    state = getMacPowerState({ execFn, platform });
  }
  return state;
}
