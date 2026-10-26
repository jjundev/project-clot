# Freshness coverage gate — real snapshot check (2026-10-26)

Build commands match Pages (`CLOT_REQUIRE_MUSINSA_WIDE=1`, `--max-old-space-size=4096`), run against temporary copies: the watched DB copied from `data/prices.db`, 4910 from `4910-db pull` into a temporary path, and wide from Release `data-musinsa`. No original DB was modified, and nothing was pushed or deployed.

## 1. Incident snapshot (`musinsa-wide.db.gz` = 2026-10-25 run) → blocked

Build time `asOfMs` 2026-10-26T04:25:30Z. The wide scan finished 2026-10-25T09:51:44Z, 18.6h earlier, which is inside the 48h window.

| group | active | live | live % | lastRunAt |
|---|---:|---:|---:|---|
| musinsa-wide | 299,899 | 0 | 0% | 2026-10-25T09:51:44.611Z |
| musinsa-watched | 129 | 129 | 100% | 2026-10-25T05:12:12.630Z |
| 4910 | 128,543 | 119,142 | 92.7% | 2026-10-25T06:41:45.700Z |

- `visualize`: exit 0. The local build is unaffected.
- `scripts/verify-dashboard-build.js`: exit 1, stderr `freshness coverage collapse: musinsa-wide live 0/299899 (last run 2026-10-25T09:51:44.611Z)`.
- The Pages "Verify generated dashboard" step would fail, so the previous site stays deployed.
- Build: 60.9s, max RSS 1.75GB.

The two healthy groups (watched 100%, 4910 92.7%) are far above the 25% threshold, so the gate does not fire on normal data.

## 2. Snapshot after today's wide scan → pending

As of this writing (2026-10-26 04:25Z), today's wide scan has not run yet (it usually finishes around 09:50Z), so this check is pending. To confirm afterwards, re-download `musinsa-wide.db.gz`, run the same two commands, and expect verify exit 0 with musinsa-wide live ≥ 25%. The wide DB holds ESTIMATED 300,475 and DIRECT 202 rows, so most ACTIVE goods should become live once the scan writes `observation_json`.

## Follow-up

Once the wide catalog is live again, the default screen loads about 300k Musinsa live rows instead of 129. The loading measurement in `docs/verify/2026-10-26-dashboard-loading-speed.md` assumed 129, so it needs to be re-measured.
