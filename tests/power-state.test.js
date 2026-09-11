import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClamshellState,
  parsePmsetWakeLog,
  evaluateBridgeUsability,
  getMacPowerState,
  probeBrowserBridge,
} from '../src/power.js';

const TAB = '\t';
const line = (ts, type, details) => `${ts} ${type.padEnd(20)}${TAB}${details}`;

describe('macOS power state probing', () => {
  test('parseClamshellState reads lid state from ioreg output', () => {
    assert.equal(parseClamshellState('  |   "AppleClamshellCausesSleep" = Yes\n  |   "AppleClamshellState" = Yes\n'), true);
    assert.equal(parseClamshellState('"AppleClamshellState" = No'), false);
    assert.equal(parseClamshellState(''), null);
    assert.equal(parseClamshellState('"AppleClamshellCausesSleep" = Yes'), null);
  });

  test('parsePmsetWakeLog picks the last real Sleep/Wake/DarkWake transition, ignoring "Wake Requests"', () => {
    const log = [
      line('2026-09-11 09:24:24 +0900', 'DarkWake', 'DarkWake from Deep Idle [CDNP] : due to rtc/SleepService'),
      line('2026-09-11 09:24:26 +0900', 'Sleep', "Entering Sleep state due to 'Sleep Service Back to Sleep'"),
      line('2026-09-11 10:18:42 +0900', 'DarkWake', 'DarkWake from Deep Idle [CDNP] : due to rtc/SleepService'),
      line('2026-09-11 10:18:47 +0900', 'Wake Requests', '[process=mDNSResponder request=Maintenance deltaSecs=7200]'),
    ].join('\n');
    const parsed = parsePmsetWakeLog(log);
    assert.equal(parsed.lastWake, 'dark');
    assert.equal(parsed.lastWakeAt, '2026-09-11 10:18:42 +0900');
    assert.equal(parsed.displayOn, null);
  });

  test('parsePmsetWakeLog detects a full user wake and display notifications', () => {
    const log = [
      line('2026-09-11 10:49:00 +0900', 'DarkWake', 'DarkWake from Deep Idle'),
      line('2026-09-11 10:49:02 +0900', 'Sleep', 'Entering Sleep state'),
      line('2026-09-11 10:51:02 +0900', 'Wake', 'Wake from Deep Idle [CDNVA] : due to lid RTP.multi-touch/HID Activity'),
      line('2026-09-11 10:51:02 +0900', 'Notification', 'Display is turned on'),
      line('2026-09-11 10:51:05 +0900', 'Wake Requests', '[process=powerd request=UserWake]'),
    ].join('\n');
    const parsed = parsePmsetWakeLog(log);
    assert.equal(parsed.lastWake, 'full');
    assert.equal(parsed.lastWakeAt, '2026-09-11 10:51:02 +0900');
    assert.equal(parsed.displayOn, true);

    const off = parsePmsetWakeLog(line('2026-09-11 11:00:00 +0900', 'Notification', 'Display is turned off'));
    assert.equal(off.displayOn, false);
    assert.equal(off.lastWake, null);
  });

  test('evaluateBridgeUsability: lid closed or DarkWake => unusable; full wake => usable', () => {
    assert.equal(evaluateBridgeUsability({ lidClosed: true, lastWake: 'full' }).usable, false);
    assert.equal(evaluateBridgeUsability({ lidClosed: false, lastWake: 'dark' }).usable, false);
    assert.equal(evaluateBridgeUsability({ lidClosed: false, lastWake: 'sleep' }).usable, false);
    assert.equal(evaluateBridgeUsability({ lidClosed: false, lastWake: 'full', displayOn: false }).usable, true);
    assert.equal(evaluateBridgeUsability({ lidClosed: false, lastWake: 'full' }).usable, true);
    assert.equal(evaluateBridgeUsability({}).usable, true, 'no evidence at all fails open');
    assert.equal(evaluateBridgeUsability({ displayOn: false }).usable, false, 'display off with no wake record is conservative');
  });

  test('getMacPowerState reproduces the 2026-09-11 DarkWake incident as bridgeUsable=false', () => {
    const execFn = (cmd) => {
      if (cmd.startsWith('ioreg')) return '"AppleClamshellState" = Yes';
      if (cmd.startsWith('pmset')) {
        return [
          line('2026-09-11 09:24:26 +0900', 'Sleep', 'Entering Sleep state'),
          line('2026-09-11 10:18:42 +0900', 'DarkWake', 'DarkWake from Deep Idle [CDNP]'),
        ].join('\n');
      }
      throw new Error(`unexpected command ${cmd}`);
    };
    const state = getMacPowerState({ execFn, platform: 'darwin' });
    assert.equal(state.lidClosed, true);
    assert.equal(state.lastWake, 'dark');
    assert.equal(state.bridgeUsable, false);
    assert.ok(state.reason.length > 0);
  });

  test('getMacPowerState reports usable after a full wake with lid open', () => {
    const execFn = (cmd) => {
      if (cmd.startsWith('ioreg')) return '"AppleClamshellState" = No';
      return [
        line('2026-09-11 10:18:42 +0900', 'DarkWake', 'DarkWake from Deep Idle'),
        line('2026-09-11 10:51:02 +0900', 'Wake', 'Wake from Deep Idle [CDNVA] : due to lid'),
        line('2026-09-11 10:51:02 +0900', 'Notification', 'Display is turned on'),
      ].join('\n');
    };
    const state = getMacPowerState({ execFn, platform: 'darwin' });
    assert.equal(state.bridgeUsable, true);
    assert.equal(state.displayOn, true);
    assert.equal(state.lastWakeAt, '2026-09-11 10:51:02 +0900');
  });

  test('getMacPowerState fails open on non-darwin and when probes throw', () => {
    let called = false;
    const linux = getMacPowerState({ execFn: () => { called = true; return ''; }, platform: 'linux' });
    assert.equal(linux.bridgeUsable, true);
    assert.equal(called, false);

    const broken = getMacPowerState({ execFn: () => { throw new Error('boom'); }, platform: 'darwin' });
    assert.equal(broken.bridgeUsable, true);
    assert.match(broken.reason, /fail-open/);
  });

  test('probeBrowserBridge re-probes once when the first probe says unusable', async () => {
    let calls = 0;
    const execFn = (cmd) => {
      if (cmd.startsWith('ioreg')) {
        calls++;
        return calls === 1 ? '"AppleClamshellState" = Yes' : '"AppleClamshellState" = No';
      }
      return line('2026-09-11 10:51:02 +0900', 'Wake', 'Wake from Deep Idle');
    };
    const state = await probeBrowserBridge({ execFn, platform: 'darwin', retryDelayMs: 1 });
    assert.equal(calls, 2);
    assert.equal(state.bridgeUsable, true);
  });
});
