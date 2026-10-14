#!/usr/bin/env node
// Stage-0 check for the Musinsa wide scan: does the coupon API give the same coupons when called with
// listing-page values only (goodsNo, brand, comId=brand, salePrice=price) as with product-page values
// (brand, comId, specialtyCodes, salePrice from the product page)?
// Writes raw coupon objects to logs/musinsa-coupon-verify.json (gitignored). Never prints or stores the cookie.
// Usage: musinsa-coupon-verify.js dump | evaluate   (evaluate is offline: it only reads the dump)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCategoryGoodsPage } from '../src/discovery.js';
import { extractProductDetail, USER_AGENT } from '../src/myprice.js';
import { readSessionCookie } from '../src/session.js';
import { parseCoupon, couponDiscountMusinsa } from '../src/musinsaWide/coupons.js';

const CATEGORIES = ['001', '002', '003', '103', '004'];
const PAGES_PER_CATEGORY = 3;
const KEYS_PER_CATEGORY = 6;
const MIN_GOODS_PER_KEY = 3;
const CALL_GAP_MS = 700;
const OUT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'musinsa-coupon-verify.json');
const COUPON_API = 'https://api.musinsa.com/api2/coupon/coupons/getUsableCouponsByGoodsNo';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collectListing(cat) {
  const items = [];
  let url = `https://www.musinsa.com/categories/item/${cat}?gf=A&sortCode=REVIEW`;
  for (let page = 1; page <= PAGES_PER_CATEGORY && url; page++) {
    const { items: got, pagination } = await fetchCategoryGoodsPage(cat, url);
    items.push(...got);
    // Never build page URLs ourselves (403): follow nextPageUrl as given.
    url = pagination?.hasNext && pagination?.nextPageUrl ? pagination.nextPageUrl : null;
    await sleep(300);
  }
  return items;
}

// brand|cat groups with >= 3 goods; up to 6 per category (largest groups first); high/mid/low price per group.
function pickSample(cat, items) {
  const groups = new Map();
  const seen = new Set();
  for (const it of items) {
    const goodsNo = Number(it.goodsNo);
    if (!goodsNo || !it.brand || !(it.price > 0) || it.isSoldOut || seen.has(goodsNo)) continue;
    seen.add(goodsNo);
    const key = `${it.brand}|${cat}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const keys = [...groups.entries()]
    .filter(([, g]) => g.length >= MIN_GOODS_PER_KEY)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, KEYS_PER_CATEGORY);
  const picked = [];
  for (const [key, g] of keys) {
    const sorted = [...g].sort((a, b) => a.price - b.price);
    const trio = [
      ['high', sorted[sorted.length - 1]],
      ['mid', sorted[Math.floor((sorted.length - 1) / 2)]],
      ['low', sorted[0]],
    ];
    for (const [rank, it] of trio) {
      picked.push({
        key,
        cat,
        brand: it.brand,
        goodsNo: Number(it.goodsNo),
        salePrice: it.price,
        extraDiscount: it.extraDiscountAmount ?? 0,
        rank,
      });
    }
  }
  return picked;
}

async function fetchCoupons(params, headers) {
  const res = await fetch(`${COUPON_API}?${params}`, { headers: { ...headers, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`coupon API HTTP ${res.status}`);
  const list = (await res.json())?.data?.list;
  if (!Array.isArray(list)) throw new Error('unexpected coupon API response');
  return list;
}

async function fetchDetail(goodsNo, headers) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`https://www.musinsa.com/products/${goodsNo}`, {
      headers: { ...headers, Accept: 'text/html,application/xhtml+xml' },
    });
    if (res.ok) {
      const parsed = extractProductDetail(await res.text(), goodsNo);
      if (parsed?.detail) return parsed.detail;
    } else if (res.status !== 429) {
      throw new Error(`product page HTTP ${res.status}`);
    }
    if (attempt < 3) await sleep(2000 * attempt);
  }
  throw new Error('product page unavailable (rate limited?)');
}

// A coupon is identified by couponNo; "same" means the same id set and the same discount on this product.
// `strict` also compares how many issued copies (same couponNo, different idx) the list carries.
const signature = (list, strict) => {
  const sig = list.map((c) => `${c.couponNo}:${c.salePrice}`);
  return JSON.stringify(strict ? sig.sort() : [...new Set(sig)].sort());
};
const sameCoupons = (a, b, strict = false) => signature(a, strict) === signature(b, strict);

async function dump() {
  const cookie = readSessionCookie();
  if (!cookie) {
    console.log('~/.clot/musinsa-session.json 없음');
    process.exit(1);
  }
  const headers = { 'User-Agent': USER_AGENT, Referer: 'https://www.musinsa.com/', Cookie: cookie };

  const sample = [];
  for (const cat of CATEGORIES) {
    const picked = pickSample(cat, await collectListing(cat));
    console.log(`${cat}: 키 ${new Set(picked.map((p) => p.key)).size}개, 상품 ${picked.length}개`);
    sample.push(...picked);
  }

  const goods = [];
  let equal = 0;
  let strictEqual = 0;
  let failed = 0;
  for (const [i, g] of sample.entries()) {
    try {
      const listingParams = new URLSearchParams({
        goodsNo: String(g.goodsNo),
        brand: g.brand,
        comId: g.brand,
        salePrice: String(g.salePrice),
      });
      const listingParamsCoupons = await fetchCoupons(listingParams, headers);
      await sleep(CALL_GAP_MS);

      const det = await fetchDetail(g.goodsNo, headers);
      const gp = det.goodsPrice || {};
      const detailParams = {
        brand: det.brand || '',
        comId: det.comId || det.brand || '',
        specialtyCodes: det.specialtyCodes?.length ? det.specialtyCodes.join(',') : '',
      };
      const fullParams = new URLSearchParams({
        goodsNo: String(g.goodsNo),
        brand: detailParams.brand,
        comId: detailParams.comId,
        salePrice: String(gp.salePrice ?? gp.normalPrice ?? g.salePrice),
      });
      if (detailParams.specialtyCodes) fullParams.set('specialtyCodes', detailParams.specialtyCodes);
      const fullParamsCoupons = await fetchCoupons(fullParams, headers);

      const isEqual = sameCoupons(listingParamsCoupons, fullParamsCoupons);
      const isStrictEqual = sameCoupons(listingParamsCoupons, fullParamsCoupons, true);
      if (isEqual) equal++;
      if (isStrictEqual) strictEqual++;
      goods.push({
        ...g,
        listingParamsCoupons,
        fullParamsCoupons,
        detailParams,
        detailSalePrice: gp.salePrice ?? gp.normalPrice ?? null,
        equal: isEqual,
        equalStrict: isStrictEqual,
      });
    } catch (err) {
      failed++;
      goods.push({ ...g, error: err.message });
    }
    console.log(`[${i + 1}/${sample.length}] ${g.goodsNo} ${goods[goods.length - 1].equal ? '=' : goods[goods.length - 1].error ? '!' : '≠'}`);
    await sleep(CALL_GAP_MS);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ fetchedAt: new Date().toISOString(), goods }, null, 2));
  const total = goods.length - failed;
  if (failed) console.log(`실패 ${failed}건 제외`);
  console.log(`동등: ${equal}/${total} (쿠폰 id 집합과 각 쿠폰 할인액이 같은 상품)`);
  console.log(`발급 사본 수까지 같음: ${strictEqual}/${total}`);
}

/**
 * The coupons of a key from samples ({ salePrice, coupons }), united by id. A coupon missing from a sample that is
 * cheaper than every sample having it is read as a minimum purchase (min = that price + 1); one missing from a
 * sample that is not cheaper contradicts that, so the key's coupons are unknown: null (hide the key, 'scope').
 */
export function keyCouponSet(samples) {
  const byId = new Map();
  for (const s of samples) {
    for (const c of s.coupons) if (!byId.has(c.id)) byId.set(c.id, { ...c });
  }
  const out = [];
  for (const [id, coupon] of byId) {
    const has = samples.filter((s) => s.coupons.some((c) => c.id === id)).map((s) => s.salePrice);
    const lacks = samples.filter((s) => !s.coupons.some((c) => c.id === id)).map((s) => s.salePrice);
    if (lacks.length) {
      const absent = Math.max(...lacks);
      if (absent >= Math.min(...has)) return null;
      coupon.min = Math.max(coupon.min, absent + 1);
    }
    out.push(coupon);
  }
  return out;
}

const dedupeById = (parsed) => [...new Map(parsed.map((c) => [c.id, c])).values()];

// Offline: reads the dump and prints (1) how often the discount formula reproduces the API's per-product discount,
// (2) how often the key coupon set learned from a key's high and low goods predicts the best discount of its mid good.
// Mismatching examples follow the two lines.
function evaluate() {
  const { goods } = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  const ok = goods.filter((g) => !g.error && Array.isArray(g.listingParamsCoupons));

  let formulaOk = 0;
  let formulaTotal = 0;
  const formulaMiss = [];
  for (const g of ok) {
    for (const raw of g.listingParamsCoupons) {
      const c = parseCoupon(raw);
      const got = couponDiscountMusinsa(g.salePrice, c);
      formulaTotal++;
      if (got === c.discount) formulaOk++;
      else formulaMiss.push(`${g.goodsNo} ${c.id} ${c.name}: 식 ${got} / API ${c.discount} (가격 ${g.salePrice}, ${c.percent ?? c.price}${c.type === 'PERCENT' ? '%' : '원'}, max ${c.max}, min ${c.min})`);
    }
  }

  const byKey = new Map();
  for (const g of ok) {
    if (!byKey.has(g.key)) byKey.set(g.key, {});
    byKey.get(g.key)[g.rank] = g;
  }
  let keyOk = 0;
  let keyTotal = 0;
  let hidden = 0;
  const keyMiss = [];
  for (const [key, { high, mid, low }] of byKey) {
    if (!high || !mid || !low) continue;
    const set = keyCouponSet(
      [high, low].map((g) => ({ salePrice: g.salePrice, coupons: dedupeById(g.listingParamsCoupons.map(parseCoupon)) })),
    );
    if (!set) {
      hidden++;
      continue;
    }
    keyTotal++;
    const predicted = Math.max(0, ...set.map((c) => couponDiscountMusinsa(mid.salePrice, c)));
    const actual = Math.max(0, ...mid.listingParamsCoupons.map((c) => Number(c.salePrice) || 0));
    if (predicted === actual) keyOk++;
    else keyMiss.push(`${key} mid ${mid.goodsNo} (가격 ${mid.salePrice}): 예측 ${predicted} / 실제 ${actual} (high ${high.salePrice}, low ${low.salePrice})`);
  }

  const pct = (n, d) => (d ? ` (${((100 * n) / d).toFixed(1)}%)` : '');
  console.log(`식 재현: ${formulaOk}/${formulaTotal}${pct(formulaOk, formulaTotal)}`);
  console.log(`키 예측: ${keyOk}/${keyTotal} (숨김 ${hidden})${pct(keyOk, keyTotal)}, 숨김 ${hidden}/${hidden + keyTotal}${pct(hidden, hidden + keyTotal)}`);
  for (const m of formulaMiss) console.log(`  식 불일치: ${m}`);
  for (const m of keyMiss) console.log(`  키 불일치: ${m}`);
}

const cmd = process.argv[2];
if (cmd === 'dump') {
  dump().catch((err) => {
    console.error(`실패: ${err.message}`);
    process.exit(1);
  });
} else if (cmd === 'evaluate') {
  evaluate();
} else {
  console.log('사용법: musinsa-coupon-verify.js dump | evaluate');
  process.exit(cmd ? 1 : 0);
}
