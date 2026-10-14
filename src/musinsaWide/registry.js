import { anonCall } from './client.js';
import { mapConcurrent } from '../pool.js';

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
        // The walk will not get to what the probes recorded before the stop, so count and lift `highest` with it.
        hits += pr.hits.length;
        if (pr.hits.length > 0) lastHit = Math.max(lastHit, ...pr.hits);
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
