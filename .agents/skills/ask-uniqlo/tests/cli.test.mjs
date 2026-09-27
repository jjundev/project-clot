import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, stubFetch, restoreFetch } from './helpers.mjs';
import { main, run } from '../lib/cli.js';

afterEach(restoreFetch);

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sink() {
    const stream = { text: '', write(chunk) { stream.text += chunk; } };
    return stream;
}

function runScript(scriptPath, args) {
    return new Promise(resolve => {
        execFile(process.execPath, [scriptPath, ...args], (error, stdout, stderr) => {
            resolve({ code: error ? error.code : 0, stdout, stderr });
        });
    });
}

const searchPage = () => ok({
    items: [{ productId: 'E1', priceGroup: '00', name: '울트라라이트다운', prices: { base: { value: 79900 }, promo: null } }],
    pagination: { total: 1, offset: 0, count: 1 },
});

test('search joins unquoted words into one query', async () => {
    const calls = stubFetch(searchPage);
    await run(['search', '울트라', '라이트', '다운', '--limit', '5']);
    assert.equal(calls[0].url.searchParams.get('q'), '울트라 라이트 다운');
    assert.equal(calls[0].url.searchParams.get('limit'), '5');
});

test('search passes boolean flags through', async () => {
    stubFetch(searchPage);
    await assert.rejects(run(['search', '다운', '--sale']), { code: 'EMPTY' });
});

test('argument errors are ARG', async () => {
    await assert.rejects(run([]), { code: 'ARG' });
    await assert.rejects(run(['buy', 'x']), { code: 'ARG' });
    await assert.rejects(run(['search']), { code: 'ARG' });
    await assert.rejects(run(['detail', 'E450195-000', 'E450196-000']), { code: 'ARG' });
    await assert.rejects(run(['detail', 'E450195-000', '--color', '09']), { code: 'ARG' });
    await assert.rejects(run(['reviews']), { code: 'ARG' });
});

test('main prints JSON on success and returns 0', async () => {
    stubFetch(searchPage);
    const stdout = sink();
    const stderr = sink();
    assert.equal(await main(['search', '다운'], { stdout, stderr }), 0);
    assert.equal(JSON.parse(stdout.text).items[0].productId, 'E1');
    assert.equal(stderr.text, '');
});

test('main prints an error object and maps the exit code', async () => {
    stubFetch(() => ok({ items: [], pagination: { total: 0, offset: 0, count: 0 } }));
    const stdout = sink();
    const stderr = sink();
    assert.equal(await main(['search', 'zzqx'], { stdout, stderr }), 3);
    assert.equal(stdout.text, '');
    assert.equal(JSON.parse(stderr.text).error.code, 'EMPTY');
});

test('main reports unexpected errors as INTERNAL with exit 1', async () => {
    stubFetch(() => ok(null));
    const stderr = sink();
    assert.equal(await main(['search', '다운'], { stdout: sink(), stderr }), 1);
    assert.equal(JSON.parse(stderr.text).error.code, 'INTERNAL');
});

test('the script exits 2 with a JSON error for bad arguments', async () => {
    const { code, stdout, stderr } = await runScript(path.join(SKILL_DIR, 'scripts/uq.mjs'), ['detail']);
    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.equal(JSON.parse(stderr).error.code, 'ARG');
});

test('the script works when the skill folder is reached through a symlink', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ask-uniqlo-'));
    try {
        const link = path.join(dir, 'ask-uniqlo');
        symlinkSync(SKILL_DIR, link, 'dir');
        const { code, stderr } = await runScript(path.join(link, 'scripts/uq.mjs'), ['bogus']);
        assert.equal(code, 2);
        assert.equal(JSON.parse(stderr).error.code, 'ARG');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
