# Changelog

## 1.4.0 - 2026-09-13

### Added

- `provenance <package>` command. A package published with npm provenance carries a signed
  SLSA v1 statement whose `runDetails.metadata.invocationId` is the Actions run URL, built
  as `server_url` + repository + `/actions/runs/` + `run_id` + `/attempts/` + `run_attempt`.
  From 2026-10-01 that URL resolves to a 404 for every version whose run is older than the
  retention window.

  **Signature verification is unaffected.** Verifying a package never fetches the run, so
  `npm audit signatures` and every sigstore check keep working exactly as before. What
  breaks is the audit trail the pointer names: the one link from a published artifact back
  to the job that built it, which is the part a supply-chain review actually follows.

  The command reads the packument for the version list, the attestations endpoint for each
  version that has one, decodes the DSSE payload, and cross-references the run id and
  attempt against the archive using the same identity the archive keys on. Both provenance
  shapes npm has published are read: SLSA v1, which names the run URL outright, and the
  v0.2 form used until early 2024, which names the Actions environment and the
  `<run id>-<attempt>` build invocation id instead. Those older versions are the ones the
  retention change reaches first. A real session against our own package:

  ```
  $ actions-attic provenance runner-drift --archive ./attic
  runner-drift: 6 published versions, 2 with provenance
  retention window: 90 days (repository setting)
  from 2026-10-01, runs created before 2026-06-15T14:14:46Z are deleted

  version  run                                     created     archived  at risk
  1.2.1    Booyaka101/runner-drift #34307443469/1  2026-09-09  yes       no
  1.2.0    Booyaka101/runner-drift #34305025325/1  2026-09-09  yes       no

  Every provenance-referenced run for Booyaka101/runner-drift is in the attic.
  ```

  `--json` prints the structured result and nothing else, `--fail-on-unarchived` exits 1
  while a referenced run is unarchived and due for deletion, `--all` lists the versions
  published without provenance, `--version` checks one, and `--registry` points at a mirror.
  A run in another repository is reported as out of scope, never as unarchived. A version
  published before the backfill's oldest month says so instead of claiming the run is
  missing. No GitHub token is needed for the registry half; without one it falls back to
  GitHub's 90-day platform default and says so.
- `show-run <id>` prints the archived record for a run id, with `--attempt` and `--json`,
  and exits 1 when the id is not in the archive. Once the run's own page is gone, that is
  the local answer a dead `html_url` no longer gives. It also takes the run URL itself,
  since that is what a dangling provenance pointer gives you; an `/attempts/N` suffix picks
  that attempt.
- `path` and `display_title` on run records, both already in the payload the archiver
  reads, so capturing them costs nothing. An archived run carried only `workflow_id`, which
  stops resolving the moment the workflow file is deleted or renamed, and never told you
  the path as it was at the time. `display_title` is the run's own title, which for a
  release run is usually the only human-readable label it had.
- The Action understands `mode: provenance`, with `package`, `registry` and `probe-all`
  inputs, an `unarchived-total` output and a job summary table, working the same way
  `mode: preflight` already does.
- `resolveRetention()`, `retentionLines()`, `collectProvenance()`, `resolveProvenance()`,
  `formatProvenance()` and the rest of the provenance surface on the library exports.
  Preflight's retention resolution is now shared rather than duplicated.

### Changed

- `--version` after a command now belongs to that command, so `provenance pkg --version`
  with no value is a usage error instead of quietly printing the tool version and exiting.
  `actions-attic --version` and `actions-attic version` are unchanged.
- The Action's preflight job summary names the retention source the way the report does,
  `repository setting` rather than the raw `api`.
- `schemaVersion` is 2. Records written by 1.x simply lack the two new fields, so they are
  filled with `null` on read: a 1.3.0 archive keeps working untouched, and a caller can
  tell "this build never captured it" from "captured as empty" without knowing which
  version wrote the line. No rewalk, no migration.

## 1.3.0 - 2026-09-07

### Fixed

- A day with more than 1,000 workflow runs kept only the first 1,000 and reported the
  backfill as complete. The `created` filter accepts full instants, not only dates, so the
  window halving now carries on below a day instead of stopping there. Measured against
  `pytorch/pytorch`, which does around 10,000 runs a day: the first seven days of 2026-09
  hold 53,990 runs, of which the old walk archived 6,999 and said `backfillComplete: true`.
  Anyone archiving a busy repository before 2026-10-01 would have kept 13% of it and been
  told the attic was complete.

  Only more than 1,000 runs inside a single second is now beyond reach, which is where the
  cap really is irreducible.

  Existing archives do not refill a day they already recorded as captured. `preflight` finds
  the gap: it counts runs at risk against distinct run ids in the archive, so a truncated day
  shows up as `unarchived.runs` above zero and `--fail-on-unarchived` exits 1. Delete the
  affected month files under `runs/` and rerun the backfill to rewalk them.

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
