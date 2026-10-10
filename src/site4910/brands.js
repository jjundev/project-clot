// Which 4910 brands the daily run scans: the top-N of the brand ranking (refreshed weekly) plus pinned ones.
export const TOP_BRANDS_4910 = 100;
export const PINNED_BRANDS_4910 = [
  { sno: 2421, name: '유니클로' },
  { sno: 13647, name: 'GU' },
];

const RANKING_PAGE = 100;

// Ranked brands in rank order, then any pinned brand the ranking does not already contain (sno-deduplicated).
function withPinned(brands) {
  const out = [];
  const seen = new Set();
  for (const b of [...brands, ...PINNED_BRANDS_4910]) {
    const sno = Number(b.sno);
    if (seen.has(sno)) continue;
    seen.add(sno);
    out.push({ sno, name: b.name });
  }
  return out;
}

// Pages the ranking until n brands are collected. Anything short of n is an error: 4910 ranks far more than n
// brands, so a short, empty or stuck ranking is a glitch and must never replace the stored list.
async function fetchRanking(client, n) {
  const ranked = [];
  const seen = new Set();
  let lastSno = null;
  while (ranked.length < n) {
    const page = await client.listTopBrands({ limit: RANKING_PAGE, lastSno });
    const before = ranked.length;
    for (const b of page.brands) {
      if (!seen.has(b.sno)) {
        seen.add(b.sno);
        ranked.push({ sno: b.sno, name: b.name });
      }
    }
    if (ranked.length >= n) break;
    if (page.lastSno == null || !page.brands.length) throw new Error(`brand ranking ended at ${ranked.length} of ${n} brands`);
    if (ranked.length === before || page.lastSno === lastSno) throw new Error('brand ranking cursor is not advancing');
    lastSno = page.lastSno;
  }
  return ranked.slice(0, n);
}

/**
 * Resolves the brand list to scan. The ranking is fetched on Mondays (UTC) and whenever there is no stored list
 * (or no store at all, as in a dry run); otherwise the stored list is reused. A failing (or short) ranking falls back to the
 * stored list, then to the pinned brands only. Pinned brands are always included.
 */
export async function resolveBrands({ client, store, date, now = new Date(), n = TOP_BRANDS_4910, log = console.log }) {
  const stored = store ? store.getActiveBrands() : [];
  const dueForRefresh = now.getUTCDay() === 1 || stored.length === 0;

  if (dueForRefresh) {
    try {
      const ranked = await fetchRanking(client, n);
      store?.upsertBrands(date, ranked, PINNED_BRANDS_4910);
      return { brands: withPinned(ranked), refreshed: true };
    } catch (err) {
      log(`[4910] brand ranking failed, using ${stored.length ? 'stored list' : 'pinned brands only'}: ${err.message}`);
    }
  }
  return { brands: withPinned(stored), refreshed: false };
}
