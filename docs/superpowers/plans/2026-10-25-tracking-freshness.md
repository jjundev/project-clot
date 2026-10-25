# Tracking freshness implementation plan

> **For agentic workers:** Use executing-plans inline. Steps use checkbox syntax for tracking.

**Goal:** Only currently tracked, recently observed prices may produce lowest/drop signals; historical products remain explicitly accessible.

**Architecture:** Persist per-product observation evidence separately from change-only history. Export tracking evidence into the shared browser/Node model; recompute eligibility at query/display time. Prefer explicit user tracking over wide scans and never revive obsolete discovery data through fallback.

**Tech Stack:** Node 24, SQLite, shared JS factories, static dashboard/Worker, node:test, Playwright.

**Spec:** Approved design in this chat (2026-10-25). Decisions #6–8 confirmed: historical items opt-in; freshness 48 hours; drop age and observation gap at most 48 hours.

## Global constraints
- Preserve selection target, two distinct-date miss handling, raw histories, price basis verification and point pricing behavior.
- Missing evidence fails closed; recalculation and carried-forward history do not refresh observations.
- UTC timestamps internally, Asia/Seoul presentation; existing run/coupon date conventions stay unchanged.
- No original DB mutation, collection, notifications, push or deployment during implementation verification.

## Review focus
- Same-day retries replace daily samples without creating a drop against an intermediate same-day price.
- Null listing prices and failed coupon refreshes cannot renew cached effective-price evidence.
- Explicit likes/manual tracking must survive wide-scope exit and take precedence over scan prices.
- Legacy/read-only snapshots need no migration to build; unknown evidence yields historical records.
- Expired bootstrap, product lookup, modal and Worker/file facets must agree after time advances.

## Tasks

### Task 1: Persist real observation evidence
Files: new `src/price-observation.js`; both wide stores/trackers, coupon price calls; tests `tests/tracking-freshness.test.js`.
Interface: JSON observation `{seenAt,saleAt,checkedAt,computedAt,samples}`; samples `{at,date,price,basis}` (last two distinct run dates), common `recordPriceObservation`, `priceSignalEligibility` exposed by browser-safe factory.
- [x] Write/run failing persistence tests for unchanged price, missing price, re-entry, same-day replacement and old schemas.
- [x] Add nullable observation JSON columns, update real observations independently of price-change logging; pass actual run timestamps.
- [x] Record effective price evidence only when required base and verification evidence exist; apply same drop eligibility to notifications.
- [x] Run store/collector regression tests.

### Task 2: Correct export ownership and shared signal policy
Files: dashboard model/base/Musinsa/catalog/index/builder, visualizer, existing source stores; freshness and model/export tests.
Interfaces: summary `tracking` contains evidence plus state; `includeHistory` state flag; shared `refresh(item,asOfMs)` derives freshness/signals.
- [x] Write/run failing tests for obsolete discovery fallback, explicit preference, retained/unknown exclusion and 48-hour windows.
- [x] Export authoritative tracking metadata, keep historical items routable, derive observations from actual daily logs where proven.
- [x] Round-trip metadata in index and re-evaluate queries/cards consistently at one clock per operation.
- [x] Run dashboard model/index/export tests.

### Task 3: Historical UI and expiration
Files: dashboard template/runtime/Worker, browser tests and fixtures.
- [x] Write/run failing tests for history opt-in and time advancing after page load.
- [x] Add history checkbox, explicit status/date copy, safe preview, refreshed lookup/modal and periodic/visibility re-query.
- [x] Run browser tests and full npm suite; fix regressions, review diff and verify actual snapshot regression using temporary files only.

## Progress / rulings
- Working in existing checkout on `codex/tracking-freshness`; preserve unrelated `data/4910-all.js`.
- Execute authorized design without another plan approval round. Leave source changes reviewable, do not publish.

- Task 1: complete — observation persistence, field-specific base timestamps, missing-price and same-day regressions passed.
- Task 2: complete — authoritative ownership, archival routes, appended index metadata, common 48-hour policy passed.
- Task 3: complete — history opt-in, HTTP/file/Worker expiry and UI passed; full suite 1109/1109, browser 51/51.
- Ruling: browser-safe signal policy lives in the existing serialized dashboard-model factory and is imported by server observation helpers, avoiding duplicate policy implementations.
- Ruling: source-specific observation timestamps are additive base-DB columns; wide stores use nullable observation_json. Old read-only snapshots build without schema writes and fail closed when evidence is unavailable.
- Independent reviewer findings fixed: full-verification observation path; inactive likes shadowing active scans; same-day field timestamps; previous-day scan alert baselines.
- Actual snapshot verification: 505570 records, 43 obsolete discovery products archived, 0 visible/lowest/drop. Separate 4096MiB verifier exit 0. See docs/verify/2026-10-25-tracking-freshness.md.
- Changes remain uncommitted on codex/tracking-freshness; no push, live collection or deployment.
