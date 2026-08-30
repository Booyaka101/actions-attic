# Changelog

## 1.2.0 - 2026-08-30

### Added

- `preflight` command. Answers one question: how much of this repository's Actions history
  will the 2026-10-01 retention change delete, and how much of it is already in the attic.
  It resolves the retention window from `--retention-days`, then the repository's
  artifact-and-log retention setting, then GitHub's 90-day platform default, clamping to the
  repository's maximum and to 90 days for public repositories. It counts remote workflow
  runs, check runs and commit statuses created before the cutoff and compares them with the
  archive ref, or with a local directory when `--archive` is given. `--json` prints the
  structured result and nothing else; `--fail-on-unarchived` exits 1 while anything at risk
  is not archived, so it works as a gate.
- The Action understands `mode: preflight`, with `retention-days` and `fail-on-unarchived`
  inputs and `retention-days`, `retention-source`, `unarchived-total` and `preflight-json`
  outputs, so a scheduled workflow can go red while records sit unprotected.
- `Api.getRetentionSettings()`, `runPreflight()` and `formatPreflight()` on the library
  surface.

Counting runs costs one request: the runs endpoint's `total_count` reports the true match
count for a `created=` filter even though the endpoint serves at most 1,000 results. Checks
and statuses are read from the archive, plus a per-commit fetch for only the commits the
archive has not covered, so preflight is nearly free once the attic is populated.

## 1.1.0 - 2026-08-28

### Changed

- The archive moved from an orphan branch to `refs/attic/archive`. A ref outside
  `refs/heads/` stays out of the branch list, out of a default clone, out of the pull
  request base picker, and out of `on: push` triggers, so a nightly archive commit no
  longer fires other workflows. The `branch` input is deprecated but still honoured, so
  upgrading never moves an existing archive.

### Added

- `pull <owner/repo>` copies an archive ref down into a local directory over the API, with
  no refspec to remember.
- `archive-url` output and a job-summary link. GitHub's file browser cannot resolve a
  custom ref, but it browses any commit by SHA.

## 1.0.0 - 2026-08-28

First release: `sync`, `backfill`, `incremental`, `build`, `flake`, `stats` and `runs`,
the GitHub Action, month-windowed backfill under the 1,000-result search cap, and
three-level checkpointing (month, window, page) so budget-limited runs converge.
