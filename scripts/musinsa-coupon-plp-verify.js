#!/usr/bin/env node
// Checks the assumptions behind pricing Musinsa coupons from coupon → goods listings (the coupon page's
// api2/coupon/plp/v1/goods) instead of one member call per goods. Report: docs/verify/musinsa-coupon-plp.md.
// Raw data goes to logs/plp-verify/ (gitignored). Only `sample`, `enum-check`, `enum-retest` and the member half of
// `probe` send the cached member cookie; the cookie is never printed or stored.
// Usage: musinsa-coupon-plp-verify.js probe | scan | sample --db PATH [--n 500] | walk --db PATH | evaluate --db PATH
//   | enum-count [--windows A-B,C-D] [--file NAME] | enum-check --db PATH [--cap 120] | enum-retest [--from N] [--cap 60]
//   | enum-expiry --db PATH [--file NAME] | enum-evaluate --db PATH
// Every command also takes --dir DIR (data folder, default logs/plp-verify) and --date YYYY-MM-DD (default today, KST).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createMusinsaClient, CATEGORIES_MUSINSA, DEPTH_PAGES } from '../src/musinsaWide/client.js';
import { parseCoupon, couponDiscountMusinsa } from '../src/musinsaWide/coupons.js';
import { readSessionCookie, mergeAuthSetCookies } from '../src/session.js';
import { USER_AGENT } from '../src/myprice.js';
import { mapConcurrent } from '../src/pool.js';

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const OUT_DIR = opt('dir', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'plp-verify'));
const PLP = 'https://api.musinsa.com/api2/coupon/plp/v1/goods';
const ALL_CATS = CATEGORIES_MUSINSA.join(',');
const PAGE_SIZE = 300; // the API maximum: 301 and above come back empty (totalCount 0) without an error
const COMBINED_MAX = 3000; // at most this many goods in the 5 categories (10 pages): walk the whole list in one go
const MAX_PAGES_PER_CAT = 60;
const WALK_WORKERS = 2;
const WALK_GAP_MS = 500;
const HEADERS = { 'User-Agent': USER_AGENT, Referer: 'https://www.musinsa.com/', Accept: 'application/json' };

const kstDate = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const TODAY = opt('date', kstDate());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (name, data) => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(data));
};
const load = (name) => JSON.parse(fs.readFileSync(path.join(OUT_DIR, name), 'utf8'));
const exists = (name) => fs.existsSync(path.join(OUT_DIR, name));
const openDb = () => {
  const p = opt('db');
  if (!p) throw new Error('--db PATH required (a musinsa-wide.db, e.g. from `musinsa-db pull`)');
  return new DatabaseSync(p, { readOnly: true });
};
const live = (c) => !c.until || c.until >= TODAY;
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');

// Deterministic shuffle so a sample can be drawn again.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(list, rnd) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

async function plpPage(couponNo, params, { cookie = null, suffix = '' } = {}) {
  const qs = new URLSearchParams({ couponNo: String(couponNo), couponKind: 'PRODUCT', caller: 'COUPON', gf: 'A', ...params });
  const res = await fetch(`${PLP}${suffix}?${qs}`, {
    headers: cookie ? { ...HEADERS, Cookie: cookie } : HEADERS,
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, list: json?.data?.list ?? [], pagination: json?.data?.pagination ?? null, meta: json?.meta ?? null };
}

// ---- probe: page size, deep pages, couponKind, anonymous vs member ----
async function probe() {
  const lines = [];
  const log = (s) => {
    lines.push(s);
    console.log(s);
  };
  for (const size of [200, 201, 300, 500]) {
    const r = await plpPage(359200, { category: ALL_CATS, sortCode: 'REVIEW', page: '1', size: String(size) });
    log(`size ${size}: HTTP ${r.status}, items ${r.list.length}, totalCount ${r.pagination?.totalCount}`);
    await sleep(600);
  }
  for (const [params, pages] of [[{ category: '001', sortCode: 'REVIEW' }, [50, 51, 60, 100, 500]], [{ sortCode: 'REVIEW' }, [51, 1000, 4000]]]) {
    for (const p of pages) {
      const r = await plpPage(353190, { ...params, page: String(p), size: String(PAGE_SIZE) });
      log(`deep ${JSON.stringify(params)} page ${p}: HTTP ${r.status}, items ${r.list.length}, first ${r.list[0]?.goodsNo ?? '-'} (reviews ${r.list[0]?.reviewCount ?? '-'}), totalCount ${r.pagination?.totalCount}`);
      await sleep(600);
    }
  }
  for (const kind of ['CART', 'PRODUCT']) {
    const qs = new URLSearchParams({ couponNo: '359200', couponKind: kind, caller: 'COUPON', gf: 'A', page: '1', size: '1' });
    const res = await fetch(`${PLP}?${qs}`, { headers: HEADERS });
    const j = await res.json().catch(() => null);
    log(`couponKind ${kind}: HTTP ${res.status}, totalCount ${j?.data?.pagination?.totalCount}`);
    await sleep(600);
  }
  const cookie = readSessionCookie();
  for (const c of [359200, 353190, 359700, 326028]) {
    const a = await plpPage(c, { category: ALL_CATS, sortCode: 'REVIEW', page: '1', size: String(PAGE_SIZE) });
    await sleep(600);
    const m = cookie ? await plpPage(c, { category: ALL_CATS, sortCode: 'REVIEW', page: '1', size: String(PAGE_SIZE) }, { cookie }) : null;
    await sleep(600);
    const ids = (r) => r.list.map((x) => x.goodsNo).join();
    log(`anon vs member ${c}: totalCount ${a.pagination?.totalCount} vs ${m?.pagination?.totalCount}, first page same goods in same order: ${m ? ids(a) === ids(m) : 'no cookie'}`);
  }
  save('probe.json', { date: TODAY, lines });
}

// ---- scan: today's REVIEW listing of the 5 categories with rank, review count and ad flag ----
async function scan() {
  const started = Date.now();
  const categories = {};
  await mapConcurrent(CATEGORIES_MUSINSA, 5, async (cat) => {
    const client = createMusinsaClient();
    const items = [];
    const seen = new Set();
    const problems = [];
    let url = null;
    let pages = 0;
    while (pages < DEPTH_PAGES) {
      let page = null;
      for (let attempt = 0; attempt < 3 && !page; attempt++) {
        if (attempt) await sleep(2000 * attempt);
        try {
          const p = await client.getCategoryPage(cat, url);
          if (p.items.length || !p.nextPageUrl) page = p;
        } catch (err) {
          problems.push(err.message);
        }
      }
      if (!page) {
        problems.push(`page ${pages + 1} failed`);
        break;
      }
      pages++;
      for (const it of page.items) {
        const goodsNo = Number(it.goodsNo);
        if (!goodsNo || seen.has(goodsNo)) continue;
        seen.add(goodsNo);
        items.push({
          goodsNo, rank: items.length + 1, reviewCount: it.reviewCount ?? null, isAd: Boolean(it.isAd), price: it.price,
          extra: it.extraDiscountAmount ?? 0, brand: it.brand ?? null, soldOut: Boolean(it.isSoldOut), listingCouponPrice: it.couponPrice ?? null,
        });
      }
      if (!page.nextPageUrl) break;
      url = page.nextPageUrl;
    }
    categories[cat] = { pages, items, problems };
    console.log(`${cat}: ${pages} pages, ${items.length} goods, ads ${items.filter((i) => i.isAd).length}, problems ${problems.length}`);
  });
  save('scan.json', { date: TODAY, durationMs: Date.now() - started, categories });
}

// Lowest review count among today's non-ad in-scope goods of each category: a REVIEW-sorted coupon list can stop
// once it goes below it.
function boundaries(scanData) {
  const out = {};
  for (const [cat, c] of Object.entries(scanData.categories)) {
    const counts = c.items.filter((i) => !i.isAd && i.reviewCount != null).map((i) => i.reviewCount);
    out[cat] = counts.length ? Math.min(...counts) : 0;
  }
  return out;
}

function scopeMap(scanData) {
  const scope = new Map();
  for (const [cat, c] of Object.entries(scanData.categories)) {
    for (const it of c.items) if (!scope.has(it.goodsNo)) scope.set(it.goodsNo, { ...it, cat });
  }
  return scope;
}

// ---- sample: member coupon calls on random never-checked goods (fresh ground truth) ----
const RAW_KEEP = [
  'couponNo', 'couponName', 'couponApply', 'couponKind', 'couponValue', 'couponAmountKind', 'maxLimitAmount', 'lowPrice',
  'salePrice', 'useFromDate', 'useToDate', 'issuedYn', 'downloadYn', 'sameCouponCount', 'pubCnt', 'couponPubCnt',
  'bestSalePriceYn', 'couponChannel', 'couponUseType',
];

async function sample() {
  const db = openDb();
  const scope = scopeMap(load('scan.json'));
  const never = db.prepare(`SELECT goods_no, cat FROM goods WHERE status = 'ACTIVE' AND coupon_checked_date IS NULL`).all();
  const n = Number(opt('n', 500));
  const rnd = mulberry32(Number(opt('seed', 20261014)));
  const picks = [];
  for (const cat of CATEGORIES_MUSINSA) {
    const pool = never
      .filter((g) => g.cat === cat)
      .map((g) => scope.get(g.goods_no))
      .filter((it) => it && it.cat === cat && !it.soldOut && !it.isAd && it.price > 0 && it.brand);
    picks.push(...shuffle(pool, rnd).slice(0, Math.round(n / CATEGORIES_MUSINSA.length)));
  }
  let cookie = readSessionCookie();
  if (!cookie) throw new Error('no cached member session (~/.clot/musinsa-session.json)');
  const client = createMusinsaClient(); // 700 ms between coupon calls, like the daily run
  const absorb = (headers) => {
    const merged = mergeAuthSetCookies(cookie, headers);
    if (merged.cookie && !merged.revoked) cookie = merged.cookie;
  };
  const results = [];
  let stop = null;
  const started = Date.now();
  for (const it of picks) {
    try {
      const raw = await client.getUsableCoupons({ goodsNo: it.goodsNo, brand: it.brand, salePrice: it.price }, cookie, { onSetCookie: absorb });
      results.push({ ...it, coupons: raw.map((c) => Object.fromEntries(RAW_KEEP.map((k) => [k, c[k]]))) });
    } catch (err) {
      if (err.code === 'MEMBER_AUTH') stop = 'expired';
      else if (err.status === 429) stop = 'throttled';
      else results.push({ ...it, error: `HTTP ${err.status ?? '?'}` });
      if (stop) break;
    }
    if (results.length % 100 === 0) console.log(`${results.length}/${picks.length}`);
  }
  console.log(`sampled ${results.length}/${picks.length}, stop ${stop ?? 'none'}, ${Math.round((Date.now() - started) / 1000)} s`);
  save('sample.json', { date: TODAY, stop, durationMs: Date.now() - started, results });
}

// ---- walk: every live coupon known (checked DB lists + sample) through the coupon goods list ----
function knownCoupons(db, sampleData) {
  const coupons = new Map();
  const add = (c, source) => {
    if (!live(c)) return;
    const cur = coupons.get(c.id) ?? { id: c.id, name: c.name, until: c.until, sources: [] };
    if (!cur.sources.includes(source)) cur.sources.push(source);
    coupons.set(c.id, cur);
  };
  for (const row of db.prepare(`SELECT coupons_json FROM goods WHERE coupons_json IS NOT NULL`).all()) {
    for (const c of JSON.parse(row.coupons_json)) add(c, 'db');
  }
  for (const r of sampleData?.results ?? []) for (const raw of r.coupons ?? []) add(parseCoupon(raw), 'sample');
  return coupons;
}

async function walk() {
  const db = openDb();
  const scanData = load('scan.json');
  const coupons = knownCoupons(db, exists('sample.json') ? load('sample.json') : null);
  const boundary = boundaries(scanData);
  const stats = { calls: 0, statuses: {}, retries: 0, throttled: false };
  const call = async (id, params) => {
    for (let attempt = 0; ; attempt++) {
      await sleep(WALK_GAP_MS);
      stats.calls++;
      let r;
      try {
        r = await plpPage(id, params);
      } catch {
        r = { status: 'network' };
      }
      stats.statuses[r.status] = (stats.statuses[r.status] ?? 0) + 1;
      if (r.status === 200 && r.meta?.result === 'SUCCESS') return r;
      if (r.status === 429) {
        stats.throttled = true;
        throw Object.assign(new Error('HTTP 429'), { status: 429 });
      }
      if (attempt >= 2) throw new Error(`HTTP ${r.status}`);
      stats.retries++;
      await sleep(2000 * (attempt + 1));
    }
  };
  const walkOne = async (id) => {
    const seq = []; // [goodsNo, reviewCount, price] in list order
    const add = (list) => {
      for (const x of list) seq.push([Number(x.goodsNo), x.reviewCount ?? null, x.price ?? null]);
    };
    const res = { total5: null, mode: null, pages: 0, perCat: {}, orderViolations: 0 };
    const order = (list, state) => {
      for (const x of list) {
        if (x.reviewCount > state.prev) res.orderViolations++;
        state.prev = x.reviewCount;
      }
    };
    const first = await call(id, { category: ALL_CATS, sortCode: 'REVIEW', page: '1', size: String(PAGE_SIZE) });
    res.pages++;
    res.total5 = first.pagination?.totalCount ?? 0;
    if (res.total5 <= COMBINED_MAX) {
      res.mode = 'combined';
      const state = { prev: Infinity };
      let r = first;
      add(r.list);
      order(r.list, state);
      for (let p = 2; r.pagination?.hasNext; p++) {
        r = await call(id, { category: ALL_CATS, sortCode: 'REVIEW', page: String(p), size: String(PAGE_SIZE) });
        res.pages++;
        add(r.list);
        order(r.list, state);
      }
    } else {
      res.mode = 'per-category';
      for (const cat of CATEGORIES_MUSINSA) {
        const c = { pages: 0, total: null, lastReviewCount: null, stoppedBy: 'cap' };
        const state = { prev: Infinity };
        for (let p = 1; p <= MAX_PAGES_PER_CAT; p++) {
          const r = await call(id, { category: cat, sortCode: 'REVIEW', page: String(p), size: String(PAGE_SIZE) });
          res.pages++;
          c.pages++;
          c.total = r.pagination?.totalCount ?? null;
          add(r.list);
          order(r.list, state);
          const last = r.list.at(-1);
          c.lastReviewCount = last?.reviewCount ?? null;
          if (!r.pagination?.hasNext) {
            c.stoppedBy = 'end';
            break;
          }
          if (last && last.reviewCount < boundary[cat]) {
            c.stoppedBy = 'boundary';
            break;
          }
        }
        res.perCat[cat] = c;
      }
    }
    res.seq = seq;
    return res;
  };
  const started = Date.now();
  const out = {};
  let done = 0;
  await mapConcurrent([...coupons.keys()], WALK_WORKERS, async (id) => {
    if (stats.throttled) return;
    try {
      out[id] = await walkOne(id);
    } catch (err) {
      out[id] = { error: err.message };
    }
    if (++done % 25 === 0) console.log(`${done}/${coupons.size} coupons, ${stats.calls} calls`);
  });
  const durationMs = Date.now() - started;
  console.log(`walked ${done} coupons, ${stats.calls} calls, ${Math.round(durationMs / 1000)} s, statuses ${JSON.stringify(stats.statuses)}`);
  save('walk.json', {
    date: TODAY, durationMs, stats, boundary,
    coupons: Object.fromEntries([...coupons].map(([id, c]) => [id, { ...c, ...out[id] }])),
  });
}

// Ground truth: the init's checked goods (DB) and the fresh sample, each with its member-call coupons by id.
function populations(db, sampleData) {
  const checked = db
    .prepare(`SELECT goods_no, cat, brand, sale_price, extra_discount, coupons_json FROM goods WHERE coupon_checked_date IS NOT NULL`)
    .all()
    .map((g) => ({ goodsNo: g.goods_no, cat: g.cat, brand: g.brand, price: g.sale_price, coupons: new Map(JSON.parse(g.coupons_json || '[]').map((c) => [c.id, c])) }));
  const fresh = sampleData.results
    .filter((r) => !r.error)
    .map((r) => {
      const raws = new Map();
      for (const raw of r.coupons) raws.set(String(raw.couponNo), raw); // dedupe copies of one coupon
      return {
        goodsNo: r.goodsNo, cat: r.cat, brand: r.brand, price: r.price,
        coupons: new Map([...raws.values()].map((raw) => [String(raw.couponNo), parseCoupon(raw)])), raws,
      };
    });
  return { checked, fresh };
}

// The best discount the member API gave a sampled goods.
const truthBest = (g) => Math.max(0, ...[...g.raws.values()].map((raw) => Number(raw.salePrice) || 0));

// The best discount from known coupons whose list holds the goods.
const predictor = (terms, plp) => (g, known) => {
  let best = 0;
  for (const id of known) {
    const t = terms.get(id);
    const members = plp.get(id);
    if (!t || !live(t) || !members?.has(g.goodsNo)) continue;
    best = Math.max(best, couponDiscountMusinsa(g.price, t));
  }
  return best;
};

// ---- evaluate: offline report ----
function evaluate() {
  const db = openDb();
  const scanData = load('scan.json');
  const walkData = load('walk.json');
  const sampleData = load('sample.json');
  const scope = scopeMap(scanData);
  const boundary = walkData.boundary;
  const report = [];
  const log = (s = '') => {
    report.push(s);
    console.log(s);
  };

  // PLP membership per walked coupon
  const walkedOk = Object.values(walkData.coupons).filter((w) => w.seq);
  const plp = new Map(walkedOk.map((w) => [w.id, new Set(w.seq.map(([g]) => g))]));

  const { checked, fresh } = populations(db, sampleData);

  // H9: one set of terms per coupon
  const terms = new Map();
  const termKeys = new Map();
  const noteTerms = (c, source) => {
    const key = JSON.stringify([c.type, c.percent, c.type === 'PRICE' ? c.price : null, c.max, c.min, c.until]);
    if (!termKeys.has(c.id)) termKeys.set(c.id, new Map());
    termKeys.get(c.id).set(key, (termKeys.get(c.id).get(key) ?? 0) + 1);
    if (!terms.has(c.id)) terms.set(c.id, { ...c, source });
  };
  for (const g of checked) for (const c of g.coupons.values()) noteTerms(c, 'db');
  for (const g of fresh) for (const c of g.coupons.values()) noteTerms(c, 'sample');
  const varying = [...termKeys].filter(([, m]) => m.size > 1);
  log(`H9 쿠폰 조건 일관성: 쿠폰 ${termKeys.size}종 중 상품마다 조건(율·상한·최소금액·만료일)이 다른 쿠폰 ${varying.length}종`);
  for (const [id, m] of varying.slice(0, 5)) log(`   ${id} ${terms.get(id).name}: ${[...m].map(([k, n]) => `${k}×${n}`).join(' | ')}`);
  const fixed = [...terms.values()].filter((c) => c.type !== 'PERCENT');
  log(`   정률이 아닌 쿠폰 ${fixed.length}종${fixed.length ? `: ${fixed.slice(0, 5).map((c) => `${c.id} ${c.name}`).join(', ')}` : ''}`);
  const applyTypes = {};
  for (const g of fresh) for (const raw of g.raws.values()) applyTypes[raw.couponApply] = (applyTypes[raw.couponApply] ?? 0) + 1;
  log(`   표본 쿠폰 적용 범위(쌍 기준): ${JSON.stringify(applyTypes)}`);

  // H2: every coupon the member API returns has a working list
  const failed = Object.values(walkData.coupons).filter((w) => w.error);
  const empty = walkedOk.filter((w) => w.total5 === 0);
  const holders = (id) => checked.filter((g) => g.coupons.has(id)).length + fresh.filter((g) => g.coupons.has(id)).length;
  log(`H2 목록 존재: 순회한 쿠폰 ${walkedOk.length}종, 실패 ${failed.length}종, 5개 대분류 안에서 0건 ${empty.length}종`);
  for (const w of empty.slice(0, 8)) log(`   0건: ${w.id} ${w.name} (조회로 가진 상품 ${holders(w.id)}개)`);
  for (const w of failed.slice(0, 5)) log(`   실패: ${w.id} ${w.name} ${w.error}`);

  // H1/H4: list membership vs member coupon calls, both directions; a list-only goods below the coupon minimum is
  // consistent (the member API drops coupons under their minimum, the local formula gives them 0).
  const compare = (population, label) => {
    const m = { pairs: 0, both: 0, apiOnly: [], apiOnlyBeyondCap: 0, listOnly: [], listOnlyBelowMin: 0, outOfScope: 0 };
    for (const [id, members] of plp) {
      const t = terms.get(id);
      if (!t || !live(t)) continue;
      const w = walkData.coupons[id];
      for (const g of population) {
        if (!scope.has(g.goodsNo)) {
          if (g.coupons.has(id)) m.outOfScope++;
          continue;
        }
        const api = g.coupons.has(id);
        const list = members.has(g.goodsNo);
        if (api && list) m.both++;
        else if (api) {
          // a per-category walk cut at its page cap (not at the scope boundary) never reached this goods
          const c = w.perCat?.[scope.get(g.goodsNo).cat];
          if (c?.stoppedBy === 'cap' && scope.get(g.goodsNo).reviewCount < c.lastReviewCount) m.apiOnlyBeyondCap++;
          else m.apiOnly.push([g.goodsNo, id]);
        } else if (list) {
          if (g.price < (t.min ?? 0)) m.listOnlyBelowMin++;
          else m.listOnly.push([g.goodsNo, id]);
        }
        if (api) m.pairs++;
      }
    }
    log(`H1 ${label}: 쿠폰 보유 쌍 ${m.pairs}개 중 목록에도 있음 ${m.both} (${pct(m.both, m.pairs)}), 조회에만 있음 ${m.apiOnly.length} (+페이지 상한에 잘린 것 ${m.apiOnlyBeyondCap}), 목록에만 있음 ${m.listOnly.length} (최소금액 미달로 설명되는 것 ${m.listOnlyBelowMin} 별도), 오늘 범위 밖 ${m.outOfScope}`);
    const show = (pairs, what) => {
      const byCoupon = {};
      for (const [, id] of pairs) byCoupon[id] = (byCoupon[id] ?? 0) + 1;
      const top = Object.entries(byCoupon).sort((a, b) => b[1] - a[1]).slice(0, 6);
      if (top.length) log(`   ${what}: ${top.map(([id, n]) => `${id} ${terms.get(id)?.name ?? ''} ×${n}`).join('; ')}`);
      if (pairs.length) log(`   예: ${pairs.slice(0, 6).map(([g, id]) => `${g}/${id}`).join(' ')}`);
    };
    show(m.apiOnly, '조회에만 있는 쌍의 쿠폰');
    show(m.listOnly, '목록에만 있는 쌍의 쿠폰');
    return m;
  };
  const dbCmp = compare(checked, 'init에서 조회한 4,000개');
  const freshCmp = compare(fresh, `새 표본 ${fresh.length}개`);

  // H6: REVIEW order and the scope-boundary stop
  const scanViolations = Object.values(scanData.categories).reduce((n, c) => {
    let prev = Infinity;
    let v = 0;
    for (const it of c.items.filter((i) => !i.isAd)) {
      if (it.reviewCount > prev) v++;
      prev = it.reviewCount;
    }
    return n + v;
  }, 0);
  const listViolations = walkedOk.reduce((n, w) => n + (w.orderViolations ?? 0), 0);
  const ads = Object.values(scanData.categories).reduce((n, c) => n + c.items.filter((i) => i.isAd).length, 0);
  log(`H6 정렬: 카테고리 목록에서 리뷰 수가 앞보다 큰 경우 ${scanViolations}건, 쿠폰 목록에서 ${listViolations}건, 카테고리 목록의 광고 ${ads}개`);
  log(`   범위 경계(대분류별 최저 리뷰 수): ${JSON.stringify(boundary)}`);
  // Does a coupon list keep the category listing's order? Adjacent in-scope goods of one category, in list order,
  // should have rising listing ranks; a swap between equal review counts is a tie-break difference, not an inversion.
  let inv = 0;
  let tieSwaps = 0;
  let adjacent = 0;
  for (const w of walkedOk) {
    for (const cat of CATEGORIES_MUSINSA) {
      const sub = w.seq.map(([g]) => scope.get(g)).filter((s) => s?.cat === cat && !s.isAd);
      for (let i = 1; i < sub.length; i++) {
        adjacent++;
        if (sub[i].rank < sub[i - 1].rank) {
          if (sub[i].reviewCount === sub[i - 1].reviewCount) tieSwaps++;
          else inv++;
        }
      }
    }
  }
  log(`   쿠폰 목록 안에서 이웃한 범위 안 상품 ${adjacent}쌍: 목록 순위가 거꾸로인 쌍 ${inv}, 리뷰 수가 같아 순서만 바뀐 쌍 ${tieSwaps}`);
  const stops = {};
  for (const w of walkedOk.filter((x) => x.mode === 'per-category')) for (const c of Object.values(w.perCat)) stops[c.stoppedBy] = (stops[c.stoppedBy] ?? 0) + 1;
  log(`   대분류별 순회 종료 이유: ${JSON.stringify(stops)}`);

  // H8: volume
  const pages = walkedOk.reduce((n, w) => n + w.pages, 0);
  const wide = walkedOk.filter((w) => w.mode === 'per-category');
  log(`H8 호출량: 쿠폰 ${walkedOk.length}종에 ${walkData.stats.calls}회 (재시도 ${walkData.stats.retries}), ${Math.round(walkData.durationMs / 1000)}초, 상태 ${JSON.stringify(walkData.stats.statuses)}`);
  log(`   전체 순회 ${walkedOk.length - wide.length}종 ${pages - wide.reduce((n, w) => n + w.pages, 0)}페이지, 대분류별 순회 ${wide.length}종 ${wide.reduce((n, w) => n + w.pages, 0)}페이지`);
  for (const w of wide.sort((a, b) => b.pages - a.pages).slice(0, 8)) log(`   ${w.id} ${w.name}: ${w.pages}페이지 (5개 대분류 ${w.total5}개)`);

  // H10/H12/H11: price the fresh sample from coupons discovered on a subset of checked goods + the lists
  const localBest = (g) => Math.max(0, ...[...g.coupons.values()].map((c) => couponDiscountMusinsa(g.price, c)));
  const formulaMismatch = fresh.filter((g) => truthBest(g) !== localBest(g)).length;
  log(`H9b 표본에서 API 할인액 = 로컬 식: ${fresh.length - formulaMismatch}/${fresh.length}`);
  const predict = predictor(terms, plp);
  const couponsOf = (goods) => new Set(goods.flatMap((g) => [...g.coupons.keys()]));
  const score = (known, label) => {
    let exact = 0;
    let under = 0;
    let over = 0;
    for (const g of fresh) {
      const p = predict(g, known);
      const t = truthBest(g);
      if (p === t) exact++;
      else if (p < t) under++;
      else over++;
    }
    log(`   ${label}: 정확 ${exact}/${fresh.length} (${pct(exact, fresh.length)}), 낮게 예측(쿠폰 놓침) ${under}, 높게 예측 ${over}`);
    return { exact, under, over };
  };
  log(`H10/H12 쿠폰 발견: 아는 쿠폰 + 쿠폰별 목록으로 새 표본 ${fresh.length}개의 쿠폰 할인액을 맞히는 비율`);
  const allKnown = couponsOf(checked);
  const sAll = score(allKnown, `init 4,000개에서 찾은 쿠폰 ${allKnown.size}종`);
  const rnd = mulberry32(7);
  for (const k of [500, 1000, 2000]) {
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const known = couponsOf(shuffle([...checked], rnd).slice(0, k));
      let exact = 0;
      for (const g of fresh) if (predict(g, known) === truthBest(g)) exact++;
      runs.push(exact);
    }
    log(`   init 중 무작위 ${k}개에서 찾은 쿠폰: 정확 ${runs.map((e) => pct(e, fresh.length)).join(' / ')}`);
  }
  {
    // leave-one-out: discovery = the 4,000 plus every other sampled goods
    let exact = 0;
    const counts = new Map();
    for (const g of fresh) for (const id of g.coupons.keys()) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const g of fresh) {
      const known = new Set(allKnown);
      for (const [id, n] of counts) if (n - (g.coupons.has(id) ? 1 : 0) > 0) known.add(id);
      if (predict(g, known) === truthBest(g)) exact++;
    }
    log(`   init 4,000개 + 표본의 나머지 상품에서 찾은 쿠폰: 정확 ${exact}/${fresh.length} (${pct(exact, fresh.length)})`);
  }
  // Why the misses with all 4,000
  const reasons = { unknown: 0, unknownByApply: {}, listMiss: 0, termsDiffer: 0, overByLive: 0 };
  const unknownCoupons = new Map();
  for (const g of fresh) {
    const p = predict(g, allKnown);
    const t = truthBest(g);
    if (p === t) continue;
    if (p > t) {
      reasons.overByLive++;
      continue;
    }
    const bestRaw = [...g.raws.values()].sort((a, b) => b.salePrice - a.salePrice)[0];
    const id = String(bestRaw.couponNo);
    if (!allKnown.has(id)) {
      reasons.unknown++;
      reasons.unknownByApply[bestRaw.couponApply] = (reasons.unknownByApply[bestRaw.couponApply] ?? 0) + 1;
      unknownCoupons.set(id, `${id} ${bestRaw.couponName} [${bestRaw.couponApply}] ${String(bestRaw.useFromDate).slice(0, 10)}~${String(bestRaw.useToDate).slice(0, 10)}`);
    } else if (!plp.get(id)?.has(g.goodsNo)) reasons.listMiss++;
    else reasons.termsDiffer++;
  }
  log(`   놓친 이유(4,000개 기준): 모르는 쿠폰 ${reasons.unknown} ${JSON.stringify(reasons.unknownByApply)}, 목록 누락 ${reasons.listMiss}, 조건 차이 ${reasons.termsDiffer}, 과대 예측 ${reasons.overByLive}`);
  for (const s of [...unknownCoupons.values()].slice(0, 10)) log(`     모르는 쿠폰: ${s}`);

  // H11: liveness — a known, unexpired coupon whose list holds the goods but the member call no longer returns it
  let livePairs = 0;
  let deadPairs = 0;
  const deadByCoupon = {};
  for (const g of fresh) {
    for (const id of allKnown) {
      const t = terms.get(id);
      if (!t || !live(t) || !plp.get(id)?.has(g.goodsNo) || g.price < (t.min ?? 0)) continue;
      livePairs++;
      if (!g.coupons.has(id)) {
        deadPairs++;
        deadByCoupon[id] = (deadByCoupon[id] ?? 0) + 1;
      }
    }
  }
  log(`H11 생존: init에서 본 쿠폰이 목록상 적용되는 표본 쌍 ${livePairs}개 중 회원 조회에 안 나온 쌍 ${deadPairs}`);
  for (const [id, n] of Object.entries(deadByCoupon).slice(0, 6)) log(`   ${id} ${terms.get(id)?.name} ×${n}`);

  // H16: coupons that started today or yesterday
  const recent = new Map();
  const yesterday = kstDate(new Date(Date.parse(`${TODAY}T12:00:00+09:00`) - 86400e3));
  for (const g of fresh) for (const raw of g.raws.values()) if (String(raw.useFromDate).slice(0, 10) >= yesterday) recent.set(String(raw.couponNo), raw);
  log(`H16 최근 시작 쿠폰(어제·오늘 시작): ${recent.size}종, 그중 init 4,000개에서 이미 본 것 ${[...recent.keys()].filter((id) => allKnown.has(id)).length}종`);
  for (const raw of [...recent.values()].slice(0, 8)) log(`   ${raw.couponNo} ${raw.couponName} [${raw.couponApply}] ${String(raw.useFromDate).slice(0, 16)}~${String(raw.useToDate).slice(0, 10)}`);

  // Coupon universe estimate (Chao1 on how many goods show each coupon) for the call-volume projection
  const freq = new Map();
  for (const g of [...checked, ...fresh]) for (const id of g.coupons.keys()) if (live(terms.get(id) ?? {})) freq.set(id, (freq.get(id) ?? 0) + 1);
  const f1 = [...freq.values()].filter((v) => v === 1).length;
  const f2 = [...freq.values()].filter((v) => v === 2).length;
  const chao1 = Math.round(freq.size + (f2 ? (f1 * f1) / (2 * f2) : (f1 * (f1 - 1)) / 2));
  log(`쿠폰 종류 추정: 관찰 ${freq.size}종 (상품 1개에서만 본 쿠폰 ${f1}, 2개 ${f2}) → Chao1 추정 약 ${chao1}종`);

  // Production-like discovery: a check on one (or two) other goods of the same brand reveals that brand's coupons,
  // and coupons on 50+ checked goods (member/flash coupons for everything) are found by any check.
  const wideKnown = new Set([...freq].filter(([, n]) => n >= 50).map(([id]) => id));
  const byBrand = new Map();
  for (const g of [...checked, ...fresh]) {
    if (!byBrand.has(g.brand)) byBrand.set(g.brand, []);
    byBrand.get(g.brand).push(g);
  }
  log(`H12b 브랜드 단위 발견: 넓은 쿠폰 ${wideKnown.size}종 + 같은 브랜드 다른 상품의 쿠폰만 알 때 (같은 브랜드 조회 상품이 있는 표본만)`);
  for (const k of [1, 2, 3]) {
    const rndp = mulberry32(11 + k);
    let n = 0;
    let exact = 0;
    let under = 0;
    for (const g of fresh) {
      const peers = byBrand.get(g.brand).filter((x) => x.goodsNo !== g.goodsNo);
      if (peers.length < k) continue;
      n++;
      const known = new Set(wideKnown);
      for (const p of shuffle([...peers], rndp).slice(0, k)) for (const id of p.coupons.keys()) known.add(id);
      const p = predict(g, known);
      if (p === truthBest(g)) exact++;
      else if (p < truthBest(g)) under++;
    }
    log(`   같은 브랜드 ${k}개: 정확 ${exact}/${n} (${pct(exact, n)}), 낮게 예측 ${under}`);
  }
  const brands = new Set(fresh.map((g) => g.brand));
  const withPeer = fresh.filter((g) => byBrand.get(g.brand).length > 1).length;
  log(`   표본 브랜드 ${brands.size}개, 같은 브랜드 조회 상품이 있는 표본 ${withPeer}/${fresh.length}`);
  const sbPerBrand = new Map();
  for (const g of fresh) for (const raw of g.raws.values()) if (raw.couponApply === 'SB') {
    if (!sbPerBrand.has(g.brand)) sbPerBrand.set(g.brand, new Set());
    sbPerBrand.get(g.brand).add(String(raw.couponNo));
  }
  const sbCoupons = [...sbPerBrand.values()].reduce((n, s) => n + s.size, 0);
  log(`   표본 브랜드 중 브랜드 쿠폰(SB)이 있는 브랜드 ${sbPerBrand.size}/${brands.size}, 브랜드당 SB 쿠폰 ${(sbCoupons / Math.max(1, sbPerBrand.size)).toFixed(2)}종`);

  save('evaluate.json', { date: TODAY, report, dbCmp: { ...dbCmp, apiOnly: dbCmp.apiOnly.length, listOnly: dbCmp.listOnly.length }, freshCmp: { ...freshCmp, apiOnly: freshCmp.apiOnly.length, listOnly: freshCmp.listOnly.length }, sAll });
}

// ---- coupon-number enumeration ----
// Coupon numbers are sequential, and the count call answers for any number without a cookie, so probing a range of
// numbers finds every coupon with goods in the 5 categories. Most of them are for other members (other tiers,
// targeted coupons). Whether this member can use one, and its terms, still takes a member call, but one call on a
// goods returns every coupon of that goods and so settles several numbers at once.
const ENUM_WINDOWS = '359500-360600,353170-353210,349400-349700,334200-334500'; // newest; the member-tier block; mid-Sep; early Aug
const ENUM_WORKERS = 2;
const ENUM_GAP_MS = 500;
const parseWindows = (s) => s.split(',').map((w) => w.split('-').map(Number));

async function plpCount(couponNo) {
  const qs = new URLSearchParams({ couponNo: String(couponNo), couponKind: 'PRODUCT', caller: 'COUPON', gf: 'A', category: ALL_CATS });
  const res = await fetch(`${PLP}/count?${qs}`, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  const json = await res.json().catch(() => null);
  return { status: res.status, count: typeof json?.data === 'number' ? json.data : null };
}

// Every coupon number a member call has returned (checked DB lists + sample), expired or not.
function knownNumbers(db, sampleData) {
  const ids = new Set();
  for (const row of db.prepare(`SELECT coupons_json FROM goods WHERE coupons_json IS NOT NULL`).all()) {
    for (const c of JSON.parse(row.coupons_json)) ids.add(Number(c.id));
  }
  for (const r of sampleData?.results ?? []) for (const raw of r.coupons ?? []) ids.add(Number(raw.couponNo));
  return ids;
}

// Today's non-ad scan goods: the 30k whose prices matter.
function scopeGoods(scanData) {
  const set = new Set();
  for (const c of Object.values(scanData.categories)) for (const it of c.items) if (!it.isAd) set.add(it.goodsNo);
  return set;
}

// Member calls in greedy order: the in-scope, not sold out goods that sits in the most untested first pages goes
// first (ties: more reviews). A call settles every number whose first page holds that goods, whatever it returns.
function greedyPlan(numbers, lists, scope) {
  const untested = new Set(numbers);
  const byGoods = new Map();
  for (const n of numbers) {
    for (const g of lists[n] ?? []) {
      if (g.isSoldOut || !scope.has(g.goodsNo)) continue;
      if (!byGoods.has(g.goodsNo)) byGoods.set(g.goodsNo, { goods: g, numbers: [] });
      byGoods.get(g.goodsNo).numbers.push(n);
    }
  }
  const plan = [];
  for (;;) {
    let best = null;
    let bestK = 0;
    for (const e of byGoods.values()) {
      const k = e.numbers.filter((n) => untested.has(n)).length;
      if (k > bestK || (k > 0 && k === bestK && e.goods.reviewCount > best.goods.reviewCount)) {
        best = e;
        bestK = k;
      }
    }
    if (!best) break;
    const tested = best.numbers.filter((n) => untested.has(n));
    for (const n of tested) untested.delete(n);
    plan.push({ goods: best.goods, tested });
  }
  return plan;
}

async function runMemberPlan(plan) {
  let cookie = readSessionCookie();
  if (!cookie) throw new Error('no cached member session (~/.clot/musinsa-session.json)');
  const client = createMusinsaClient(); // 700 ms between coupon calls, like the daily run
  const absorb = (headers) => {
    const merged = mergeAuthSetCookies(cookie, headers);
    if (merged.cookie && !merged.revoked) cookie = merged.cookie;
  };
  const checks = [];
  let stop = null;
  for (const { goods, tested } of plan) {
    try {
      const raw = await client.getUsableCoupons({ goodsNo: goods.goodsNo, brand: goods.brand, salePrice: goods.price }, cookie, { onSetCookie: absorb });
      checks.push({ goodsNo: goods.goodsNo, brand: goods.brand, price: goods.price, tested, usable: raw.map((c) => Object.fromEntries(RAW_KEEP.map((k) => [k, c[k]]))) });
    } catch (err) {
      if (err.code === 'MEMBER_AUTH') stop = 'expired';
      else if (err.status === 429) stop = 'throttled';
      else checks.push({ goodsNo: goods.goodsNo, tested: [], error: `HTTP ${err.status ?? '?'}` });
      if (stop) break;
    }
  }
  return { checks, stop };
}

// Tested numbers that came back in their member call, and those that did not.
function classify(checks) {
  const usable = new Map();
  const notReturned = [];
  for (const c of checks) {
    const got = new Map((c.usable ?? []).map((u) => [Number(u.couponNo), u]));
    for (const n of c.tested) {
      if (got.has(n)) usable.set(n, got.get(n));
      else notReturned.push(n);
    }
  }
  return { usable, notReturned };
}

// ---- enum-count: the anonymous goods count of every number in the windows ----
async function enumCount() {
  const windows = parseWindows(opt('windows', ENUM_WINDOWS));
  const numbers = windows.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));
  const counts = {};
  const statuses = {};
  let throttled = false;
  let done = 0;
  const started = Date.now();
  await mapConcurrent(numbers, ENUM_WORKERS, async (n) => {
    if (throttled) return;
    let r = { status: 'network', count: null };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        r = await plpCount(n);
        break;
      } catch {
        await sleep(2000 * (attempt + 1));
      }
    }
    statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    if (r.status === 429) throttled = true;
    else counts[n] = r.status === 200 ? r.count : `HTTP ${r.status}`;
    if (++done % 250 === 0) console.log(`${done}/${numbers.length}`);
    await sleep(ENUM_GAP_MS);
  });
  const durationMs = Date.now() - started;
  console.log(`probed ${Object.keys(counts).length}/${numbers.length} numbers, ${Math.round(durationMs / 1000)} s, statuses ${JSON.stringify(statuses)}`);
  save(opt('file', 'enum-count.json'), { date: TODAY, at: new Date().toISOString(), windows, counts, statuses, throttled, durationMs });
}

// ---- enum-check: first page of every unknown number with goods, then member calls on today's scope goods ----
async function enumCheck() {
  const db = openDb();
  const scope = scopeGoods(load('scan.json'));
  const known = knownNumbers(db, exists('sample.json') ? load('sample.json') : null);
  const { counts } = load('enum-count.json');
  const unknown = Object.keys(counts).map(Number).filter((n) => counts[n] > 0 && !known.has(n));
  const lists = exists('enum-lists.json') ? load('enum-lists.json') : {};
  for (const n of unknown) {
    if (lists[n]) continue;
    const r = await plpPage(n, { category: ALL_CATS, sortCode: 'REVIEW', page: '1', size: String(PAGE_SIZE) });
    if (r.status === 429) {
      console.log('HTTP 429 on first pages; numbers without a page stay unchecked');
      break;
    }
    if (r.status === 200) {
      lists[n] = r.list.map((x) => ({
        goodsNo: Number(x.goodsNo), brand: x.brand, brandName: x.brandName, price: x.price, reviewCount: x.reviewCount, isSoldOut: Boolean(x.isSoldOut),
      }));
    }
    await sleep(600);
  }
  save('enum-lists.json', lists);
  const candidates = unknown.filter((n) => (lists[n] ?? []).some((g) => !g.isSoldOut && scope.has(g.goodsNo)));
  const plan = greedyPlan(candidates, lists, scope);
  const cap = Number(opt('cap', 120));
  console.log(`unknown numbers with goods ${unknown.length}, touching today's scope ${candidates.length}, member calls to settle all ${plan.length} (cap ${cap})`);
  const started = Date.now();
  const { checks, stop } = await runMemberPlan(plan.slice(0, cap));
  const settled = new Set(checks.flatMap((c) => c.tested));
  const { usable, notReturned } = classify(checks);
  console.log(`member calls ${checks.length}: usable ${usable.size}, not returned ${notReturned.length}, untested ${candidates.length - settled.size}, stop ${stop ?? 'none'}`);
  save('enum-check.json', {
    date: TODAY, at: new Date().toISOString(), durationMs: Date.now() - started, stop, checks,
    untested: candidates.filter((n) => !settled.has(n)),
  });
}

// ---- enum-retest: numbers a member call did not return, asked again later (e.g. after the date changed) ----
// One that comes back was a coupon that had not started, not a coupon for other members.
async function enumRetest() {
  const scope = scopeGoods(load('scan.json'));
  const lists = load('enum-lists.json');
  const from = Number(opt('from', 0));
  const { notReturned } = classify(load('enum-check.json').checks);
  const pool = notReturned.filter((n) => n >= from);
  const plan = greedyPlan(pool, lists, scope).slice(0, Number(opt('cap', 60)));
  console.log(`not returned before, number >= ${from}: ${pool.length}; member calls ${plan.length}`);
  const { checks, stop } = await runMemberPlan(plan);
  const { usable, notReturned: still } = classify(checks);
  const results = [...[...usable].map(([n, u]) => ({ n, usable: true, name: u.couponName, useFromDate: u.useFromDate })), ...still.map((n) => ({ n, usable: false }))];
  console.log(`re-tested ${results.length}: usable now ${usable.size}, stop ${stop ?? 'none'}`);
  save('enum-retest.json', { date: TODAY, at: new Date().toISOString(), from, calls: checks.length, stop, results });
}

// ---- enum-expiry: do coupons past their end date still have goods? ----
// The member call gives the end date; if the count stays up after it, expiry has to come from those terms.
async function enumExpiry() {
  const db = openDb();
  const sampleData = exists('sample.json') ? load('sample.json') : null;
  const ended = new Map();
  const add = (c) => {
    if (c.until && c.until < TODAY && !ended.has(c.id)) ended.set(c.id, c);
  };
  for (const row of db.prepare(`SELECT coupons_json FROM goods WHERE coupons_json IS NOT NULL`).all()) for (const c of JSON.parse(row.coupons_json)) add(c);
  for (const r of sampleData?.results ?? []) for (const raw of r.coupons ?? []) add(parseCoupon(raw));
  const coupons = [];
  for (const c of [...ended.values()].slice(0, 30)) {
    const r = await plpCount(c.id);
    coupons.push({ id: Number(c.id), name: c.name, until: c.until, count: r.count, status: r.status });
    console.log(`${c.id} ${c.name} (until ${c.until}): count ${r.count ?? `HTTP ${r.status}`}`);
    await sleep(600);
  }
  save(opt('file', 'enum-expiry.json'), { date: TODAY, at: new Date().toISOString(), coupons });
}

// ---- enum-evaluate: offline report of the enumeration ----
function enumEvaluate() {
  const db = openDb();
  const sampleData = load('sample.json');
  const scope = scopeGoods(load('scan.json'));
  const known = knownNumbers(db, sampleData);
  const report = [];
  const log = (s = '') => {
    report.push(s);
    console.log(s);
  };

  // E1: which numbers have goods in the 5 categories
  const probe = load('enum-count.json');
  const { windows, counts } = probe;
  const probed = Object.keys(counts).map(Number);
  const isHit = (n) => typeof counts[n] === 'number' && counts[n] > 0;
  log(`E1 번호 조회: ${probed.length}개, ${Math.round(probe.durationMs / 1000)}초, 상태 ${JSON.stringify(probe.statuses)}`);
  const top = Math.max(...probed.filter(isHit));
  for (const [a, b] of windows) {
    const nums = probed.filter((n) => n >= a && n <= b);
    const upTo = nums.filter((n) => n <= top); // numbers above the highest hit were not issued yet
    const hits = nums.filter(isHit);
    const knownIn = nums.filter((n) => known.has(n));
    log(`   ${a}~${b}: 조회 ${nums.length}, 상품 있음 ${hits.length} (가장 큰 번호 ${top}까지의 ${upTo.length}개 중 ${pct(hits.length, upTo.length)}), 아는 쿠폰 ${knownIn.length}개 중 상품 있음 ${knownIn.filter(isHit).length}, 처음 보는 번호 ${hits.filter((n) => !known.has(n)).length}`);
  }

  // E2: unknown hits that touch today's scope, and the member calls that would settle them all
  const lists = load('enum-lists.json');
  const unknown = probed.filter((n) => isHit(n) && !known.has(n));
  const touching = unknown.filter((n) => (lists[n] ?? []).some((g) => !g.isSoldOut && scope.has(g.goodsNo)));
  const bySize = {};
  for (const n of touching) {
    const c = counts[n];
    const k = c <= 10 ? '1-10' : c <= 100 ? '11-100' : c <= 300 ? '101-300' : '>300';
    bySize[k] = (bySize[k] ?? 0) + 1;
  }
  log(`E2 처음 보는 번호 ${unknown.length}개 중 첫 페이지에 3만 개 범위 상품이 있는 번호 ${touching.length}개. 5개 대분류 상품 수별 ${JSON.stringify(bySize)}`);
  const families = new Map();
  for (const n of unknown) {
    const key = (lists[n] ?? []).map((g) => g.goodsNo).join();
    families.set(key, (families.get(key) ?? 0) + 1);
  }
  log(`   첫 페이지가 서로 같은 번호 묶음: 서로 다른 첫 페이지 ${families.size}개, 가장 큰 묶음 ${Math.max(...families.values())}개`);
  for (const [a, b] of windows) {
    const inWin = touching.filter((n) => n >= a && n <= b);
    log(`   ${a}~${b}: 범위에 걸리는 번호 ${inWin.length}개, 모두 판별하는 회원 조회(탐욕 선택, 계산) ${greedyPlan(inWin, lists, scope).length}회`);
  }
  log(`   전체: ${greedyPlan(touching, lists, scope).length}회`);

  // E3: member calls on those numbers
  const check = load('enum-check.json');
  const { usable, notReturned } = classify(check.checks);
  log(`E3 회원 판별: 회원 조회 ${check.checks.length}회로 ${usable.size + notReturned.length}개를 판별했다. 쓸 수 있음 ${usable.size}, 안 나옴 ${notReturned.length}, 미판별 ${check.untested.length}`);
  for (const [a, b] of windows) {
    const u = [...usable.keys()].filter((n) => n >= a && n <= b).length;
    const nr = notReturned.filter((n) => n >= a && n <= b);
    log(`   ${a}~${b}: 쓸 수 있음 ${u}, 안 나옴 ${nr.length} (그중 5개 대분류 상품 50만 개 이상 ${nr.filter((n) => counts[n] >= 500000).length})`);
  }
  for (const [n, u] of [...usable].sort((x, y) => x[0] - y[0])) {
    log(`   쓸 수 있음: ${n} ${u.couponName} [${u.couponApply}] ${u.couponValue}% 상한 ${u.maxLimitAmount} 최소 ${u.lowPrice} ${String(u.useFromDate).slice(0, 10)}~${String(u.useToDate).slice(0, 10)}, 5개 대분류 ${counts[n]}개`);
  }
  // Every coupon those calls returned: does the count see the usable ones inside the windows, and how many were new?
  const returned = new Map();
  for (const c of check.checks) for (const u of c.usable ?? []) returned.set(Number(u.couponNo), u);
  const inWindows = (n) => windows.some(([a, b]) => n >= a && n <= b);
  const returnedIn = [...returned.keys()].filter(inWindows);
  log(`   이 조회들이 돌려준 쿠폰 ${returned.size}종: 순회 구간 안 ${returnedIn.length}종 중 count가 0이던 쿠폰 ${returnedIn.filter((n) => !isHit(n)).length}종`);
  const other = [...returned].filter(([n]) => !known.has(n) && !inWindows(n)).sort((x, y) => x[0] - y[0]);
  log(`   아는 쿠폰도 아니고 순회 구간 밖인 쿠폰 ${other.length}종 (번호 ${other[0]?.[0]}~${other.at(-1)?.[0]})`);
  for (const [n, u] of other.slice(0, 12)) log(`     ${n} ${u.couponName} [${u.couponApply}] ${String(u.useFromDate).slice(0, 10)}~${String(u.useToDate).slice(0, 10)}`);

  // E4/E5: later re-test and expired coupons
  if (exists('enum-retest.json')) {
    const rt = load('enum-retest.json');
    log(`E4 다시 판별 (${rt.at}): 안 나왔던 번호 중 ${rt.from} 이상 ${rt.results.length}개, 회원 조회 ${rt.calls}회 → 쓸 수 있게 바뀐 번호 ${rt.results.filter((r) => r.usable).length}`);
  }
  const expiries = fs.readdirSync(OUT_DIR).filter((f) => /^enum-expiry.*\.json$/.test(f)).map(load);
  for (const ex of expiries.sort((x, y) => x.at.localeCompare(y.at))) {
    log(`E5 만료 뒤 count (${ex.at}): ${ex.coupons.map((c) => `${c.id} ${c.name} (~${c.until}) ${c.count}`).join('; ')}`);
    if (ex.frontier) log(`   ${ex.frontier.from}~${ex.frontier.to} 다시 조회: 상품 있는 번호 ${ex.frontier.hits}, 가장 큰 번호 ${ex.frontier.highest}, 저녁 조회와 달라진 번호 ${ex.frontier.changed}`);
  }

  // E6: the fresh sample priced from every coupon in an enumerated range (+ coupons member calls found before)
  const walkData = load('walk.json');
  const plp = new Map(Object.values(walkData.coupons).filter((w) => w.seq).map((w) => [w.id, new Set(w.seq.map(([g]) => g))]));
  const { checked, fresh } = populations(db, sampleData);
  const terms = new Map();
  for (const g of [...checked, ...fresh]) for (const c of g.coupons.values()) if (!terms.has(c.id)) terms.set(c.id, c);
  const predict = predictor(terms, plp);
  const registry = new Set(checked.flatMap((g) => [...g.coupons.keys()]));
  const score = (known2, label) => {
    let exact = 0;
    let over = 0;
    const misses = new Map();
    for (const g of fresh) {
      const p = predict(g, known2);
      const t = truthBest(g);
      if (p === t) exact++;
      else if (p > t) over++;
      else {
        const best = [...g.raws.values()].sort((x, y) => y.salePrice - x.salePrice)[0];
        const id = String(best.couponNo);
        const why = !known2.has(id) ? '모르는 쿠폰' : '목록 누락';
        const key = `${id} ${best.couponName} (${why})`;
        misses.set(key, (misses.get(key) ?? 0) + 1);
      }
    }
    const shown = [...misses].sort((x, y) => y[1] - x[1]).slice(0, 5);
    const rest = misses.size - shown.length;
    log(`   ${label}: 정확 ${exact}/${fresh.length} (${pct(exact, fresh.length)}), 높게 예측 ${over}${shown.length ? `, 놓침: ${shown.map(([k, v]) => `${k}×${v}`).join('; ')}${rest ? ` 외 ${rest}종` : ''}` : ''}`);
  };
  const hi = Math.max(top, ...[...terms.keys()].map(Number));
  log(`E6 범위 안 번호를 모두 판별했다고 볼 때 새 표본 ${fresh.length}개의 최대 쿠폰 할인액을 맞히는 비율 (번호 상한 ${hi})`);
  score(registry, 'init 4,000개에서 찾은 쿠폰만 (비교)');
  for (const lo of [350000, 345000, 325000, 0]) {
    const inRange = new Set([...terms.keys()].filter((id) => Number(id) >= lo && Number(id) <= hi));
    score(inRange, `${lo}~${hi} (${hi - lo + 1}개 번호)`);
    score(new Set([...inRange, ...registry]), `${lo}~${hi} + init에서 찾은 쿠폰`);
  }

  // E7: how fast numbers are issued: the largest number among sampled coupons that start on each day
  const byStart = new Map();
  for (const g of fresh) for (const raw of g.raws.values()) {
    const d = String(raw.useFromDate).slice(0, 10);
    byStart.set(d, Math.max(byStart.get(d) ?? 0, Number(raw.couponNo)));
  }
  const days = [...byStart].filter(([d]) => d >= '2026-09-01').sort();
  if (days.length > 1) {
    const [d0, n0] = days[0];
    const [d1, n1] = days.at(-1);
    const span = (Date.parse(d1) - Date.parse(d0)) / 86400e3;
    log(`E7 번호 증가: ${d0}에 시작한 쿠폰 중 가장 큰 번호 ${n0}, ${d1} ${n1} → 하루 약 ${Math.round((n1 - n0) / span)}개 (시작일은 만든 날 이후이므로 대략값)`);
  }
  save('enum-evaluate.json', { date: TODAY, report });
}

const commands = {
  probe, scan, sample, walk, evaluate,
  'enum-count': enumCount, 'enum-check': enumCheck, 'enum-retest': enumRetest, 'enum-expiry': enumExpiry, 'enum-evaluate': enumEvaluate,
};
const cmd = commands[args[0]];
if (!cmd) {
  console.log('usage: musinsa-coupon-plp-verify.js probe | scan | sample --db PATH [--n 500] | walk --db PATH | evaluate --db PATH');
  console.log('  | enum-count [--windows A-B,C-D] [--file NAME] | enum-check --db PATH [--cap 120] | enum-retest [--from N] [--cap 60]');
  console.log('  | enum-expiry --db PATH [--file NAME] | enum-evaluate --db PATH');
  process.exit(1);
}
await cmd();
