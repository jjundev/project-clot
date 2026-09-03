import path from 'node:path';
import os from 'node:os';

/**
 * Computes an extended PATH string ensuring Node/NVM bin, Homebrew,
 * and user local bins are included even in minimal daemon environments.
 * @returns {string}
 */
export function getExtendedPath() {
  const homeDir = os.homedir();
  const nodeBinDir = path.dirname(process.execPath);

  const defaultBins = [
    nodeBinDir,
    path.join(homeDir, '.local/bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];

  const currentParts = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
  const combined = Array.from(new Set([...defaultBins, ...currentParts])).filter(Boolean);
  return combined.join(path.delimiter);
}

/**
 * Injects the extended PATH into process.env.PATH so all child processes
 * spawned by execSync or spawn automatically inherit it.
 */
export function setupEnvironment() {
  process.env.PATH = getExtendedPath();
}

/**
 * Merges process execution options with an environment containing the extended PATH.
 * @param {object} customOptions
 * @returns {object}
 */
export function getExecOptions(customOptions = {}) {
  return {
    ...customOptions,
    env: {
      ...process.env,
      PATH: getExtendedPath(),
      ...(customOptions.env || {}),
    },
  };
}
