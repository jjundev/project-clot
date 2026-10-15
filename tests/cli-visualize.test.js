import './setup-env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {writeFixture} from './helpers/dashboard-page.js';
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

test('CLI reports the full deduplicated catalog count',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clot-cli-count-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 writeFixture(dir);
 const result=spawnSync(process.execPath,[CLI_PATH,'visualize','--no-open'],{cwd:ROOT_DIR,encoding:'utf8',env:{...process.env,CLOT_DB_PATH:path.join(dir,'musinsa.db'),CLOT_4910_DB_PATH:path.join(dir,'fixture.db'),CLOT_DASHBOARD_PATH:path.join(dir,'index.html')}});
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/총 5개 상품 반영 완료/);
});
