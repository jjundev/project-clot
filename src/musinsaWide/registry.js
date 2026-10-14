import { anonCall } from './client.js';
import { mapConcurrent } from '../pool.js';
import { COUPON_STATE } from './store.js';
import { CLASSIFY_CAP } from './coupons.js';

export const ENUM_BATCH = 50;
export const ENUM_EMPTY_STOP = 200; // empties in a row past the last hit that end the walk
export const ENUM_PROBES = [500, 1000, 2000]; // looked at past the last hit before the walk gives up
export const NEIGHBOR_RADIUS = 50;
export const NEIGHBOR_CAP = 300; // count calls per day
export const BACKFILL_FROM = 345000;
export const ANON_CONCURRENCY = 2;

/**
 * Asks count for each number (ANON_CONCURRENCY at a time). A number with goods is recorded: a new one by its first page
 * (its ACTIVE goods become scopeGoods), a known one only by its count. Empty numbers are not recorded, they come back
 * in `empties`. The first 429 ('throttled'), a number that still fails after the retries ('error') or the deadline stops
 * the phase; numbers not reached are in neither list, and what was recorded stays.
 */
export async function probeNumbers({ withClient, store, date, numbers, deadline = Infinity, now = Date.now }) {
  const hits = [];
  const empties = [];
  const newCoupons = [];
  let stop = null;

  await mapConcurrent(numbers, ANON_CONCURRENCY, async (n) => {
    if (stop) return;
    if (now() >= deadline) {
      stop = 'deadline';
      return;
    }
    try {
      await withClient(async (client) => {
        const count = await anonCall(() => client.getCouponGoodsCount(n), { sleep: client.sleep });
        if (!(count > 0)) {
          empties.push(n);
          return;
        }
        let scopeGoods = null;
        if (!store.getCoupon(n)) {
          const page = await anonCall(() => client.getCouponGoodsPage(n, { page: 1 }), { sleep: client.sleep });
          scopeGoods = store.filterActive(page.items.map((it) => it.goodsNo));
        }
        if (store.recordHit(n, date, count, { scopeGoods }) === 'new') newCoupons.push(n);
        hits.push(n);
      });
    } catch (err) {
      stop ??= err?.status === 429 ? 'throttled' : 'error';
    }
  });

  const asc = (a, b) => a - b;
  return { probed: hits.length + empties.length, hits: hits.sort(asc), empties: empties.sort(asc), newCoupons: newCoupons.sort(asc), stop };
}

/**
 * Walks coupon numbers upward from `from` in batches of ENUM_BATCH. The walk ends after ENUM_EMPTY_STOP empties in a
 * row, once it is past `mustReach`, unless one of the ENUM_PROBES past the last hit has goods; then it walks on up to
 * that number. `highest` (the last number with goods, null if none) lifts meta.frontier. With recordEmpties, the empty
 * numbers below `highest` are remembered for a later re-check; a backfill leaves that off.
 * `next` is where the walk would go on (the cursor): the first number of a batch that a stop cut short, else past the last batch; `stop` is null when the walk finished by itself.
 */
export async function enumerateNumbers({ withClient, store, date, from, mustReach = null, deadline = Infinity, recordEmpties = true, onCursor = null, now = Date.now }) {
  let n = from;
  let lastHit = from - 1;
  let run = 0;
  let reach = mustReach ?? -Infinity;
  let probed = 0;
  let hits = 0;
  let newCoupons = 0;
  let stop = null;
  const empties = [];

  while (true) {
    if (now() >= deadline) {
      stop = 'deadline';
      break;
    }
    const batch = Array.from({ length: ENUM_BATCH }, (_, i) => n + i);
    const r = await probeNumbers({ withClient, store, date, numbers: batch, deadline, now });
    probed += r.probed;
    hits += r.hits.length;
    newCoupons += r.newCoupons.length;
    const hitSet = new Set(r.hits);
    const emptySet = new Set(r.empties);
    for (const no of batch) {
      if (hitSet.has(no)) {
        lastHit = no;
        run = 0;
      } else if (emptySet.has(no)) {
        run++;
        empties.push(no);
      }
    }
    // A batch cut short stays the cursor, so a resumed walk probes it again (idempotent) instead of skipping its rest.
    if (r.stop) {
      stop = r.stop;
      break;
    }
    n += ENUM_BATCH;
    onCursor?.(n);
    if (run >= ENUM_EMPTY_STOP && n > reach) {
      const probes = ENUM_PROBES.map((d) => lastHit + d).filter((p) => p >= n);
      const pr = await probeNumbers({ withClient, store, date, numbers: probes, deadline, now });
      probed += pr.probed;
      // A probe hit is registered here, so the walk reaching it later sees a known number: count it as new now.
      newCoupons += pr.newCoupons.length;
      if (pr.stop) {
        // Counted here since the walk will not get to them; `highest` and the frontier stay where the walk itself reached.
        hits += pr.hits.length;
        stop = pr.stop;
        break;
      }
      if (pr.hits.length === 0) break;
      reach = pr.hits[0];
      run = 0;
    }
  }

  const highest = lastHit >= from ? lastHit : null;
  if (highest !== null && highest > Number(store.getMeta('frontier') ?? -Infinity)) store.setMeta('frontier', highest);
  if (recordEmpties && highest !== null) for (const no of empties) if (no < highest) store.recordEmpty(no, date);
  return { from, next: n, probed, hits, newCoupons, highest, stop };
}

// Asks again for the empty numbers of the last few days; `newPositive` of them have goods by now.
export async function recheckEmpties({ withClient, store, date, deadline = Infinity, now = Date.now }) {
  const r = await probeNumbers({ withClient, store, date, numbers: store.emptyNumbersToRecheck(date), deadline, now });
  return { probed: r.probed, newPositive: r.hits.length, stop: r.stop };
}

// Counts the numbers within NEIGHBOR_RADIUS of each center that the registry does not know, up to `cap` of them.
export async function probeNeighbors({ withClient, store, date, centers, cap = NEIGHBOR_CAP, deadline = Infinity, now = Date.now }) {
  const picked = new Set();
  outer: for (const center of centers) {
    for (let no = center - NEIGHBOR_RADIUS; no <= center + NEIGHBOR_RADIUS; no++) {
      if (picked.size >= cap) break outer;
      if (no < 1 || picked.has(no) || store.getCoupon(no)) continue;
      picked.add(no);
    }
  }
  const r = await probeNumbers({ withClient, store, date, numbers: [...picked], deadline, now });
  return { probed: r.probed, hits: r.hits.length, stop: r.stop };
}

/**
 * Greedy plan for the member calls that classify PENDING coupons: the ACTIVE, not sold out goods that sits in the scope of
 * the most still-untested pending coupons goes first (ties: more reviews, then the smaller goods_no); a call settles every
 * coupon covering that goods. A pending coupon no candidate goods covers is `unclassifiable`. Pure.
 * `goodsInfo` is goods_no -> { review_count, is_sold_out, status }; a goods missing from it is not a candidate.
 */
export function planClassification(pending, goodsInfo) {
  const byGoods = new Map(); // goods_no -> coupon numbers whose scope holds it
  const covered = new Set();
  for (const c of pending) {
    for (const g of new Set(c.scope_goods ?? [])) {
      const gi = goodsInfo.get(g);
      if (!gi || gi.status !== 'ACTIVE' || gi.is_sold_out) continue;
      if (!byGoods.has(g)) byGoods.set(g, []);
      byGoods.get(g).push(c.coupon_no);
      covered.add(c.coupon_no);
    }
  }
  const unclassifiable = pending.map((c) => c.coupon_no).filter((n) => !covered.has(n));

  // Lazy greedy: a goods' untested count only ever falls, so a stale queue entry is an upper bound; re-count the best
  // one and, if it fell, put it back.
  const better = (a, b) =>
    a.k !== b.k ? a.k > b.k : a.reviews !== b.reviews ? a.reviews > b.reviews : a.goods_no < b.goods_no;
  const heap = [];
  const push = (e) => {
    heap.push(e);
    for (let i = heap.length - 1; i > 0;) {
      const up = (i - 1) >> 1;
      if (!better(heap[i], heap[up])) break;
      [heap[i], heap[up]] = [heap[up], heap[i]];
      i = up;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ;) {
        let m = i;
        for (const ch of [2 * i + 1, 2 * i + 2]) if (ch < heap.length && better(heap[ch], heap[m])) m = ch;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  for (const [goods_no, nos] of byGoods) push({ goods_no, k: nos.length, reviews: goodsInfo.get(goods_no).review_count ?? 0 });

  const untested = new Set(covered);
  const plan = [];
  while (heap.length > 0) {
    const top = pop();
    const couponNos = byGoods.get(top.goods_no).filter((n) => untested.has(n));
    if (couponNos.length === 0) continue;
    if (couponNos.length < top.k) {
      push({ ...top, k: couponNos.length });
      continue;
    }
    for (const n of couponNos) untested.delete(n);
    plan.push({ goods_no: top.goods_no, couponNos: couponNos.sort((a, b) => a - b) });
  }
  return { plan, unclassifiable };
}

/**
 * Classifies the PENDING coupons with member calls, at most `cap` of them. Coupons no usable goods covers are
 * OUT_OF_SCOPE. Each checked goods stores its result, registers what it returned as USABLE (a number below enum_floor that
 * the registry did not know is a neighbour centre) and turns the pending coupons it covered but did not return into
 * OTHER. Goods the checker never got to (cap, deadline, throttle) leave their coupons PENDING. `checks` is the record of
 * what each goods returned, for recordObservations; `added` the numbers newly registered by the results.
 * A checker that is not 'ok' does nothing.
 */
export async function classifyPending({ store, checker, date, cap = CLASSIFY_CAP, deadline = Infinity }) {
  const result = { calls: 0, usable: 0, other: 0, outOfScope: 0, pending: 0, neighborCenters: [], checks: [], added: [] };
  if (checker.status !== 'ok') {
    result.pending = store.pendingCoupons().length;
    return result;
  }

  const pending = store.pendingCoupons();
  const goodsInfo = store.goodsInfo([...new Set(pending.flatMap((c) => c.scope_goods ?? []))]);
  const { plan, unclassifiable } = planClassification(pending, goodsInfo);
  if (unclassifiable.length > 0) {
    store.markClassified(unclassifiable, date, COUPON_STATE.OUT_OF_SCOPE);
    result.outOfScope = unclassifiable.length;
  }

  const covers = new Map();
  const goodsList = [];
  for (const { goods_no, couponNos } of plan.slice(0, cap)) {
    const goods = store.getGoods(goods_no);
    if (!goods) continue;
    covers.set(goods_no, couponNos);
    goodsList.push(goods);
  }

  const enumFloor = store.getMeta('enum_floor');
  const floor = enumFloor == null ? null : Number(enumFloor);
  const callsBefore = checker.calls;
  await checker.check(goodsList, {
    deadline,
    onResult: async (goods, coupons) => {
      const couponNos = coupons.map((c) => Number(c.id));
      const returned = new Set(couponNos);
      // Counted from what is still PENDING: an earlier result may already have settled some of these.
      const stillPending = covers.get(goods.goods_no).filter((n) => store.getCoupon(n)?.state === COUPON_STATE.PENDING);
      store.putGoodsCoupons(goods.goods_no, date, coupons, goods);
      const { added } = store.upsertMemberCoupons(date, coupons);
      result.added.push(...added);
      if (floor != null) result.neighborCenters.push(...added.filter((n) => n < floor));
      const rest = stillPending.filter((n) => !returned.has(n));
      store.markClassified(rest, date, COUPON_STATE.OTHER);
      result.usable += stillPending.length - rest.length;
      result.other += rest.length;
      result.checks.push({ goods_no: goods.goods_no, couponNos });
    },
  });
  result.calls = checker.calls - callsBefore;
  result.pending = store.pendingCoupons().length;
  return result;
}
