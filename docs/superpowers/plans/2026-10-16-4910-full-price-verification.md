# 4910 full price verification

Approved scope: extend the investigated pricing direction, test, recollect, update the Release DB, deploy and verify the live dashboard. Execute Native as previously selected. The user has explicitly authorized execution and publication; no repeated handoff approval.

## Contract
All active tracked goods and active liked goods are eligible for direct option-level verification, rather than seller extrema only. Positive membership in a partial coupon list is usable evidence; absence is unknown until completeness is proved. Partial coupon membership prioritizes direct checks; never claim an optimum from an incomplete set of competing coupons. Quantity, minimum spend, ownership, platform, option and is_applied remain enforced. No automatic coupon acquisition. Raw history is preserved.

Full verification uses a fixed Release snapshot and partitioned Actions workers. Each worker checkpoints results, bounded concurrency and a deadline. Merge validates snapshot hash, wallet fingerprint, date, identities and partition completeness before applying results. Completed current-day observations with matching wallet and base may be reused on retry; errors remain pending. Upload only after all partitions are present; report pending separately. Serialize publication with the regular collector. Re-pull and compare the source hash before replacing the Release DB. Existing Pages workflow follows successful collection publication.

## Review focus
- Partial membership cannot exclude unseen goods or waive quantity/minimum terms.
- Wallet/date/base changes invalidate reuse; first-purchase state is determined by the live API.
- Failed requests do not become no-coupon prices; mismatched options are rejected.
- Missing/duplicate/foreign shard results cannot overwrite a newer Release DB.
- Deadline checkpoints retain completed results and preserve historical rows.

### Task 1: positive membership
Files: src/site4910/coupon-eligibility.js, tests/site4910-coupon-eligibility.test.js.
- [ ] RED: partial included => eligible; partial absent => unknown; quantity restrictions still win.
- [ ] GREEN: implement distinction; run eligibility tests.

### Task 2: resumable whole-catalog verifier
Files: src/site4910/full-verification.js, scripts/4910-full-verify.js, tests/site4910-full-verification.test.js.
Interfaces: prepare snapshot metadata and priority IDs; verify partition using per-product detail + best coupon; merge validated shard results via Store4910 price validations.
- [ ] RED: prove disjoint exhaustive partition, option price proof, retry reuse/invalidation, deadline/error checkpoints and guarded merge/raw preservation.
- [ ] GREEN: implement module and prepare/worker/merge CLI. Run whole suite.

### Task 3: delivery
Files: .github/workflows/4910-full.yml, .github/workflows/pages.yml, README.md, verification report.
- [ ] Add snapshot job, 32 workers (max 8 simultaneous, 2 client workers each), guarded merge/Release publish; Pages follow success. Permit reruns to resume pending work.
- [ ] Run unit and browser suites; independent final review and fixes.
- [ ] Commit/merge/push only scoped files; run full verification until pending=0 or actionable external blocker; confirm Release/live prices and record limitations.

Operational ruling: first production shard returned 510 HTTP 429 failures; halve per-shard clients from four to two for subsequent resumed runs. Keep completed proofs and bounded retry handling.

Operational ruling: restore matching same-day proofs from the last three successful main workflow artifact sets before preparing the next queue; a regular collector had reset same-day validation rows. Do not modify source DB bytes during recovery. Independent follow-up review: no publication blocker; 17 focused tests pass. Deferred minor: an incompatible newer DB proof can cause extra recollection rather than accepting an older matching artifact proof; worker/merge validation still prevents publication of mismatched prices.
