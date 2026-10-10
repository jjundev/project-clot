// Which 4910 sellers (markets) are good enough to track: purchase satisfaction >= 95% and >= 100 reviews.
// Verdicts are cached in the store and re-checked weekly, so a daily run only asks about new or stale sellers.
export const MIN_SATISFACTION = 95;
export const MIN_REVIEWS = 100;
export const MARKET_RECHECK_DAYS = 7;
export const MAX_MARKET_CHECKS = 300;

const MAX_FAILURE_LOGS = 3;
const DAY_MS = 86_400_000;

export function isQualified({ satisfaction, reviewsCount }) {
  return satisfaction != null && reviewsCount != null && satisfaction >= MIN_SATISFACTION && reviewsCount >= MIN_REVIEWS;
}

// Whole days from `from` to `to` (both 'YYYY-MM-DD').
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * Brings the stored seller verdicts up to date for today's sellers and returns those that qualify.
 * Checks new sellers first, then stale ones (checked more than MARKET_RECHECK_DAYS ago, oldest first), at most
 * `maxChecks` in all. A failed check keeps the stored verdict; a new seller whose check fails is not stored (so
 * it is retried first next time) and does not qualify today.
 */
export async function refreshMarkets({ client, store, date, marketSnos, maxChecks = MAX_MARKET_CHECKS, log = console.log }) {
  const snos = [...new Set(marketSnos.filter((s) => s != null).map(Number))];
  const stored = store.getMarkets();

  const fresh = snos.filter((sno) => !stored.has(sno));
  const stale = snos
    .filter((sno) => stored.has(sno) && (stored.get(sno).checked_date == null || daysBetween(stored.get(sno).checked_date, date) > MARKET_RECHECK_DAYS))
    .sort((a, b) => (stored.get(a).checked_date ?? '').localeCompare(stored.get(b).checked_date ?? ''));
  const toCheck = [...fresh, ...stale].slice(0, maxChecks);

  let failed = 0;
  for (const sno of toCheck) {
    try {
      const m = await client.getMarket(sno);
      const qualified = isQualified(m);
      store.upsertMarket(date, { ...m, sno, qualified });
      stored.set(sno, { sno, qualified: qualified ? 1 : 0 });
    } catch (err) {
      failed += 1;
      if (failed <= MAX_FAILURE_LOGS) log(`4910 seller ${sno} check failed: ${err.message}`);
    }
  }

  const qualified = new Set(snos.filter((sno) => stored.get(sno)?.qualified));
  const pending = fresh.length + stale.length - toCheck.length;
  log(`4910 sellers: ${snos.length} today, ${toCheck.length} checked (${failed} failed), ${qualified.size} qualified${pending > 0 ? `, ${pending} left for later` : ''}`);
  return { qualified, checked: toCheck.length, failed };
}
