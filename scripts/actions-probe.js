#!/usr/bin/env node
// GitHub Actions reachability check: can a runner (datacenter IP) reach Musinsa and stay logged in, and reach 4910.kr?
// Read-only — no DB writes, no commit. Prints statuses and prices only, never a cookie value.
// Usage: actions-probe.js [goodsNo]   (default: first active VIP item in data/prices.db)
import { ClotDatabase } from '../src/db.js';
import { readSessionCookie, verifySession } from '../src/session.js';
import { USER_AGENT, fetchAuthenticatedPriceInfo } from '../src/myprice.js';
import { LIKES_TAB_URL } from '../src/likes-https.js';
import { createClient } from '../src/site4910/client.js';
import { probe4910 } from '../src/site4910/track.js';
import { readAblyToken } from '../src/site4910/liked.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickGoodsNo() {
  const arg = Number(process.argv[2]);
  if (Number.isInteger(arg) && arg > 0) return arg;
  const db = new ClotDatabase();
  try {
    return db.getActiveVipItems()[0]?.goods_no ?? null;
  } finally {
    db.close();
  }
}

// Cloudflare challenges answer 403/503 with cf-mitigated or an HTML challenge page.
async function plainGet(url, headers) {
  try {
    const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const cf = res.headers.get('cf-mitigated') ? ` cf-mitigated=${res.headers.get('cf-mitigated')}` : '';
    return { ok: res.ok, line: `${res.status}${cf}`, res };
  } catch (err) {
    return { ok: false, line: `error ${err.name}`, res: null };
  }
}

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}: ${detail}`);
};

const cookie = readSessionCookie();
if (!cookie) {
  console.error('::error::No usable Musinsa session in ~/.clot (run actions-session.js restore first).');
  process.exit(1);
}
const goodsNo = pickGoodsNo();

const pub = await plainGet(`https://www.musinsa.com/products/${goodsNo}`, { 'User-Agent': USER_AGENT, Accept: 'text/html' });
record('public product page', pub.ok, `goods ${goodsNo} → ${pub.line}`);
await sleep(700);

const login = await verifySession(cookie, { diagnostics: true });
record('login-status', login.loggedIn === true, `status ${login.status ?? 'error'}, loggedIn=${login.loggedIn}`);
await sleep(700);

try {
  const info = await fetchAuthenticatedPriceInfo(goodsNo, { cookie, retries: 1 });
  const price = info.discontinued ? 'discontinued' : `myPrice=${info.myPrice ?? '?'} salePrice=${info.salePrice ?? '?'}`;
  record('authenticated price', !info.discontinued && Number.isFinite(info.myPrice), price);
} catch (err) {
  record('authenticated price', false, `${err.name}: ${err.message}`);
}
await sleep(700);

const likes = await plainGet(LIKES_TAB_URL, {
  'User-Agent': USER_AGENT,
  Referer: 'https://www.musinsa.com/',
  Origin: 'https://www.musinsa.com',
  Accept: 'application/json',
  Cookie: cookie,
});
let total = '?';
if (likes.ok) {
  try {
    total = (await likes.res.json())?.data?.goods ?? '?';
  } catch {
    total = 'unparseable';
  }
}
record('liked goods total', likes.ok && Number.isInteger(total), `${likes.line}, goods=${total}`);
await sleep(700);

// 4910.kr (Ably) sits behind Cloudflare too; a 403 here means the runner IP is blocked for the 4910 step.
for (const c of await probe4910({ client: createClient(), memberToken: readAblyToken() })) record(c.name, c.ok, c.detail);

const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `\n${failed}/${checks.length} checks failed from this runner.` : `\nAll ${checks.length} checks passed from this runner.`);
process.exit(failed ? 1 : 0);
