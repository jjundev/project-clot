import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const CLI_PATH = path.join(ROOT_DIR, 'src/cli.js');

describe('CLI Visualize Integration', () => {
  test('clot visualize --no-open successfully builds dashboard without error', () => {
    const output = execSync(`"${process.execPath}" "${CLI_PATH}" visualize --no-open`, {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
    });

    assert.ok(output.includes('대시보드가 생성되었습니다'));
    assert.ok(output.includes('--no-open'));
  });

  test('clot visualize <goodsNo> --no-open passes target goodsNo successfully', () => {
    const output = execSync(`"${process.execPath}" "${CLI_PATH}" visualize 6084885 --no-open`, {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
    });

    assert.ok(output.includes('대시보드가 생성되었습니다'));
    assert.ok(output.includes('6084885'));
  });
});
