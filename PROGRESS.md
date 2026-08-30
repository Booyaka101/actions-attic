# actions-attic build state

**Status: v1.2.0 built and verified, ready to ship.** Adds the `preflight` command (CLI and
Action) on top of v1.1.0. All previous behaviour untouched: archive format, ref, and the
eight existing commands are unchanged.

Built 2026-08-30 on branch `feat/preflight`.

## What 1.2.0 adds

- `preflight <owner/repo>`: resolves the retention window (`--retention-days` flag, else
  the repository's artifact-and-log retention setting via
  `GET /repos/{o}/{r}/actions/permissions/artifact-and-log-retention`, else GitHub's 90-day
  platform default), clamps to `maximum_allowed_days` and to 90 for public repos, computes
  the cutoff, counts remote runs/checks/statuses created before it, and reports what is not
  in the attic. `--json`, `--fail-on-unarchived` (exit 1 while unprotected), `--archive`
  (compare a local directory instead of the ref).
- Action `mode: preflight` with `retention-days` and `fail-on-unarchived` inputs, four new
  outputs, and a job summary table.
- `Api.getRetentionSettings()` returns null on 403/404 (the endpoint needs `repo` scope on
  classic PATs) so the default can fire.

Design fact it leans on (LESSONS 2026-08-28): the runs endpoint's `total_count` is exact
for a `created=` filter despite the 1,000-result serving cap, so counting runs before the
cutoff costs one request. Verified again live this build, including sub-day instants:
`created=<2026-08-28T03:00:00Z` returned exactly the 3 runs before 03:00. Checks/statuses
have no counting endpoint; they come from the archive plus per-commit fetches for only the
commits the archive has not covered (per-month count probes localize any run gap first).

## Verified working (real runs, not tests)

- Phase 0: changelog, retention-settings API doc, published README and PROGRESS all
  re-fetched and matching the brief. Cost still zero (existing `gh` auth).
- Tarball install in a clean dir (`D:\tmp\attic-e2e`, own package.json, relative tgz path),
  then against live GitHub on `Booyaka101/rimpatch` (14 runs, 112 checks, all younger than
  90 days so `--retention-days 5` makes them at-risk):
  - preflight before any archive: `Unarchived and at risk: 14 runs, 112 check runs,
    0 statuses. Run: actions-attic backfill Booyaka101/rimpatch`, exit 1 under
    `--fail-on-unarchived`.
  - `backfill --archive ./attic`: 14 runs + 112 checks in 28 requests.
  - preflight after: `Nothing at risk. 126 records already in the attic.`, exit 0.
  - `--json` parses, `retentionSource: "api"`, `retentionDays: 90` (public repo).
  - default 90-day run: `Nothing at risk. No records are older than the cutoff.`
- The compiled Action bundle (`dist/index.cjs`) run locally with `INPUT_MODE=preflight`
  against live GitHub: resolves retention, prints the report, writes the summary table,
  sets the four outputs, and fails the step only under `fail-on-unarchived`.
- Tests: 102 passing (85 pre-existing kept green + 17 new), `npm test`. New coverage: the
  brief's eight edge cases (400-day window, 403+flag, 403+default, public clamp, zero old
  records, all archived, partial archive, missing ref), the flag-above-maximum clamp,
  post-cutoff checks on old commits, the budget error, the worked-example output lines, CLI
  exit codes before/after a backfill via a real spawned process against a local mock API,
  and preflight reading a ref the Action wrote (fake git server).
- difflib pass over the new functions: highest similarity to any existing function is 0.47
  (`runPreflight` vs `asUsage`, the try/catch shape). Nothing extracted; the tiny `plural`
  formatter is intentionally duplicated in `preflight.ts` the same way `n` already is in
  three files.

## Shipping steps remaining

1. Push `feat/preflight`, open a PR, wait for the 6 checks green on the exact commit
   (check-runs API, not `gh run watch`).
2. Merge, then on main: `npm publish` (local authenticated session; still no provenance,
   same as 1.0.0/1.1.0), `gh release create v1.2.0`, move the `v1` tag to the release
   commit. The Marketplace listing updates itself on release (LESSONS 2026-08-20).
3. Verify `npm view actions-attic@1.2.0` resolves (registry propagation lags) and the
   Marketplace page shows v1.2.0.

## Earlier history

v1.1.0 (2026-08-28): archive moved to `refs/attic/archive`, `pull` command, `archive-url`
output. v1.0.0 (2026-08-28): first release, 6 defects found by senior review all fixed with
regression tests. Full details in this file's git history and CHANGELOG.md. The September
distribution plan stands: a second run at the story in late September when the deadline is
imminent, HN resubmission allowed, and community discussion #138249 as the first step.
`preflight --fail-on-unarchived` is the launch hook for that repost: "one command tells you
what you will lose on Monday".
