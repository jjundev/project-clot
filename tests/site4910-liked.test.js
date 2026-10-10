import './setup-env.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store4910 } from '../src/site4910/store.js';
import { LIKED_BUDGET_MS_4910, MAX_LIKED_PAGES_4910, readAblyToken, tokenExpiry, syncLiked4910 } from '../src/site4910/liked.js';

const SECRET = 'SECRET-TOKEN';
const DATE = '2026-10-10';

let dir;
let store;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clot-4910-liked-'));
  store = new Store4910(path.join(dir, '4910.db'));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const entry = (sno) => ({
  item: { sno, name: `liked ${sno}`, market_sno: 7 },
  logging: { analytics: { SALES_PRICE: 18360, MARKET_NAME: 'seller', STANDARD_CATEGORY_NAME: 'cat', BRAND_SNO: 2421, BRAND_NAME: '유니클로' } },
  render: { data: { original_price: 51300, image: { url: `https://img/${sno}.jpg` } } },
});
const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const authErr = () => Object.assign(new Error('member token rejected'), { code: 'MEMBER_AUTH', status: 401 });

// pages: array of { entries, lastSno } or an Error to reject with; anon/member: sno -> detail | Error.
function fakeClient({ pages = [], anon = {}, member = {} } = {}) {
  const calls = { list: 0, anon: [], member: [] };
  return {
    calls,
    async listLikedGoods({ memberToken, lastSno }) {
      assert.equal(memberToken, SECRET);
      const page = pages[calls.list++];
      if (page instanceof Error) throw page;
      return page ?? { entries: [], lastSno: null };
    },
    async getGoodsDetail(sno, { memberToken } = {}) {
      const bucket = memberToken ? member : anon;
      (memberToken ? calls.member : calls.anon).push(sno);
      const d = bucket[sno];
      if (d instanceof Error) throw d;
      if (!d) throw httpErr(404);
      return { sno, price: null, couponPrice: null, listPrice: null, originalPrice: null, isSoldout: false, isOpen: true, ...d };
    },
  };
}
const ANON = { price: 18360, couponPrice: 18360, listPrice: 21600, originalPrice: 51300 };
const onePage = (...snos) => [{ entries: snos.map(entry), lastSno: null }];
const run = (client, extra = {}, logs = []) =>
  syncLiked4910({ client, store, date: DATE, memberToken: SECRET, log: (m) => logs.push(m), ...extra });

test('constants match the spec', () => {
  assert.equal(LIKED_BUDGET_MS_4910, 4 * 60_000);
});

test('readAblyToken prefers env, then the .env file', () => {
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'OTHER=1\nABLY_JWT_TOKEN=b\n');
  assert.equal(readAblyToken({ env: { ABLY_JWT_TOKEN: 'a' }, envFile }), 'a');
  assert.equal(readAblyToken({ env: {}, envFile }), 'b');
  assert.equal(readAblyToken({ env: {}, envFile: path.join(dir, 'missing.env') }), null);
});

test('readAblyToken normalizes cookie strings, quotes and URL encoding', () => {
  const read = (v) => readAblyToken({ env: { ABLY_JWT_TOKEN: v }, envFile: path.join(dir, 'missing.env') });
  assert.equal(read('ably-jwt-token=x.y.z; other=1'), 'x.y.z');
  assert.equal(read('"x.y.z"'), 'x.y.z');
  assert.equal(read("'x.y.z'"), 'x.y.z');
  assert.equal(read('x%2Ey.z'), 'x.y.z');
  assert.equal(read('  '), null);
});

test('readAblyToken ignores the .env file under CLOT_NOTIFY_SANDBOX', () => {
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'ABLY_JWT_TOKEN=b\n');
  assert.equal(readAblyToken({ env: { CLOT_NOTIFY_SANDBOX: '1' }, envFile }), null);
  // the default env is the sandboxed process.env, so the repo's real .env is never read in tests
  assert.equal(readAblyToken(), null);
});

test('tokenExpiry reads exp and returns null without it', () => {
  const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
  assert.deepEqual(tokenExpiry(jwt({ exp: 1791700000 })), new Date(1791700000 * 1000));
  assert.equal(tokenExpiry(jwt({ iat: 1 })), null);
  assert.equal(tokenExpiry('garbage'), null);
});

test('no token makes no calls and returns none', async () => {
  const client = fakeClient({ pages: onePage(1) });
  const res = await syncLiked4910({ client, store, date: DATE, memberToken: null });
  assert.deepEqual(res, { memberStatus: 'none', liked: 0, logged: 0, drops: [] });
  assert.equal(client.calls.list + client.calls.anon.length + client.calls.member.length, 0);
});

test('syncs likes and logs one row per liked item', async () => {
  const client = fakeClient({ pages: onePage(1, 2), anon: { 1: ANON, 2: ANON }, member: { 1: { price: 19440 }, 2: { price: 19440 } } });
  const res = await run(client);
  assert.equal(res.memberStatus, 'ok');
  assert.equal(res.liked, 2);
  assert.equal(res.logged, 2);
  assert.deepEqual(res.drops, []);
  assert.equal(store.getActiveLiked().length, 2);
  assert.equal(store.getActiveLiked()[0].brand, '유니클로');
  const logs = store.db.prepare('SELECT * FROM liked_price_logs WHERE sno = 1').all();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].list_price, 21600);
  assert.equal(logs[0].original_price, 51300);
  assert.equal(logs[0].coupon_price, 18360);
  assert.equal(logs[0].member_price, 19440);
  assert.equal(logs[0].is_soldout, 0);
});

test('pages the liked list until the cursor ends', async () => {
  const client = fakeClient({
    pages: [{ entries: [entry(1)], lastSno: 1 }, { entries: [entry(2)], lastSno: null }],
    anon: { 1: ANON, 2: ANON }, member: { 1: { price: 19440 }, 2: { price: 19440 } },
  });
  const res = await run(client);
  assert.equal(client.calls.list, 2);
  assert.equal(res.liked, 2);
});

test('MEMBER_AUTH on the liked list returns expired and touches nothing', async () => {
  const client = fakeClient({ pages: [authErr()] });
  const res = await run(client);
  assert.deepEqual(res, { memberStatus: 'expired', liked: 0, logged: 0, drops: [] });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM liked_goods').get().n, 0);
  assert.equal(client.calls.anon.length + client.calls.member.length, 0);
});

test('a liked-list failure after page 1 leaves likes untouched', async () => {
  store.syncLiked([{ ...entryRow(5) }], '2026-10-09');
  const before = store.db.prepare('SELECT sno, status FROM liked_goods ORDER BY sno').all();
  const client = fakeClient({ pages: [{ entries: [entry(9)], lastSno: 5 }, httpErr(500)] });
  await assert.rejects(run(client), (err) => err.status === 500);
  assert.deepEqual(store.db.prepare('SELECT sno, status FROM liked_goods ORDER BY sno').all(), before);
});

test('a repeating liked cursor rejects and leaves likes untouched', async () => {
  store.syncLiked([{ ...entryRow(5) }], '2026-10-09');
  const before = store.db.prepare('SELECT sno, status FROM liked_goods ORDER BY sno').all();
  const client = fakeClient({
    pages: [{ entries: [entry(9)], lastSno: 9 }, { entries: [entry(10)], lastSno: 9 }, { entries: [entry(11)], lastSno: 9 }],
  });
  await assert.rejects(run(client), (err) => /cursor repeated/.test(err.message) && !err.message.includes(SECRET));
  assert.equal(client.calls.list, 2);
  assert.deepEqual(store.db.prepare('SELECT sno, status FROM liked_goods ORDER BY sno').all(), before);
});

test('hitting the liked page cap rejects and leaves likes untouched', async () => {
  assert.equal(MAX_LIKED_PAGES_4910, 50);
  store.syncLiked([{ ...entryRow(5) }], '2026-10-09');
  const before = store.db.prepare('SELECT sno, status FROM liked_goods ORDER BY sno').all();
  const client = fakeClient({
    pages: [{ entries: [entry(9)], lastSno: 9 }, { entries: [entry(10)], lastSno: 10 }, { entries: [entry(11)], lastSno: 11 }],
  });
  await assert.rejects(run(client, { maxPages: 2 }), (err) => /page cap/.test(err.message) && !err.message.includes(SECRET));
  assert.equal(client.calls.list, 2);
  assert.deepEqual(store.db.prepare('SELECT sno, status FROM liked_goods ORDER BY sno').all(), before);
});

function entryRow(sno) {
  return { sno, name: `liked ${sno}`, brand: null, market_name: null, category: null, url: `https://4910.kr/goods/${sno}`, image_url: null };
}

test('MEMBER_AUTH mid-way stops logging and returns expired', async () => {
  const client = fakeClient({
    pages: onePage(1, 2, 3),
    anon: { 1: ANON, 2: ANON, 3: ANON },
    member: { 1: { price: 19440 }, 2: authErr(), 3: { price: 19440 } },
  });
  const res = await run(client);
  assert.equal(res.memberStatus, 'expired');
  assert.equal(res.logged, 1);
  assert.equal(res.liked, 3);
  assert.deepEqual(client.calls.anon, [1, 2]);
  assert.deepEqual(client.calls.member, [1, 2]);
});

test('an anonymous detail failure skips only that item', async () => {
  const logs = [];
  const client = fakeClient({ pages: onePage(1, 2), anon: { 1: httpErr(404), 2: ANON }, member: { 1: { price: 19440 }, 2: { price: 19440 } } });
  const res = await run(client, {}, logs);
  assert.equal(res.logged, 1);
  assert.equal(res.memberStatus, 'ok');
  assert.ok(logs.some((l) => l.includes('1') && l.includes('404')));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM liked_price_logs').get().n, 1);
});

test('a member detail failure logs the item with a null member price', async () => {
  const client = fakeClient({ pages: onePage(1), anon: { 1: ANON }, member: { 1: httpErr(500) } });
  const res = await run(client);
  assert.equal(res.logged, 1);
  assert.equal(store.db.prepare('SELECT member_price FROM liked_price_logs WHERE sno = 1').get().member_price, null);
});

const prevRow = (sno, member_price, coupon_price, list_price = 21600) =>
  store.logLikedPrice({ sno, date: '2026-10-09', list_price, original_price: 51300, coupon_price, member_price, is_soldout: 0 });

test('a member price below the last day is a drop; member null falls back to coupon price', async () => {
  prevRow(1, 20000, 18000);
  prevRow(2, null, 18000);
  const client = fakeClient({
    pages: onePage(1, 2),
    anon: { 1: ANON, 2: { ...ANON, couponPrice: 17000 } },
    member: { 1: { price: 19440 }, 2: httpErr(500) },
  });
  const res = await run(client);
  assert.equal(res.drops.length, 2);
  const byPrev = Object.fromEntries(res.drops.map((d) => [d.sno, d]));
  assert.deepEqual(byPrev[1], { sno: 1, name: 'liked 1', market_name: 'seller', url: 'https://4910.kr/goods/1', prevPrice: 20000, currentPrice: 19440 });
  assert.equal(byPrev[2].prevPrice, 18000);
  assert.equal(byPrev[2].currentPrice, 17000);
});

test('a member-price day followed by a coupon-only day is not a drop', async () => {
  prevRow(1, 20000, 18000);
  const client = fakeClient({ pages: onePage(1), anon: { 1: { ...ANON, couponPrice: 18000 } }, member: { 1: httpErr(500) } });
  const res = await run(client);
  assert.equal(res.logged, 1);
  assert.deepEqual(res.drops, []);
});

test('drops are sorted by drop rate, largest first', async () => {
  prevRow(1, 20000, null);
  prevRow(2, 20000, null);
  const client = fakeClient({
    pages: onePage(1, 2), anon: { 1: ANON, 2: ANON }, member: { 1: { price: 19000 }, 2: { price: 15000 } },
  });
  const res = await run(client);
  assert.deepEqual(res.drops.map((d) => d.sno), [2, 1]);
});

test('a same-day rerun reports no drop against itself', async () => {
  const mk = () => fakeClient({ pages: onePage(1), anon: { 1: ANON }, member: { 1: { price: 19440 } } });
  await run(mk());
  const second = await run(mk());
  assert.equal(second.logged, 1);
  assert.deepEqual(second.drops, []);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM liked_price_logs').get().n, 1);
});

test('a spent budget logs nothing and says 시간 초과', async () => {
  const logs = [];
  const client = fakeClient({ pages: onePage(1, 2), anon: { 1: ANON, 2: ANON }, member: { 1: { price: 1 }, 2: { price: 1 } } });
  const res = await run(client, { budgetMs: -1 }, logs);
  assert.equal(res.logged, 0);
  assert.ok(logs.some((l) => /찜 가격 기록 시간 초과/.test(l)));
  assert.equal(client.calls.anon.length, 0);
});

test('the token never appears in logs', async () => {
  const logs = [];
  await run(fakeClient({ pages: onePage(1, 2), anon: { 1: httpErr(404), 2: ANON }, member: { 2: authErr() } }), {}, logs);
  await run(fakeClient({ pages: onePage(1) }), { budgetMs: -1 }, logs);
  await run(fakeClient({ pages: [authErr()] }), {}, logs);
  assert.ok(logs.length > 0);
  assert.ok(logs.every((l) => !String(l).includes(SECRET)));
});
