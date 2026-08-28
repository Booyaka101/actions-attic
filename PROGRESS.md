# actions-attic — build state

**Status: v1.0.0 complete.** Feature-complete, tested, packaged, verified end to end against live GitHub. Not published (owner ships that step).

Built 2026-08-28.

## Phase 0 verification (all resources re-fetched live, none missing)

| Resource | Result |
| --- | --- |
| `github.blog/changelog/2026-08-27-actions-retention-...` | All four quoted sentences present verbatim |
| REST `GET /repos/{o}/{r}/actions/runs` | Endpoint, `created`/`per_page` (max 100)/`page`/`status`/`branch`/`event`, and the "up to 1,000 results for each search" sentence all confirmed |
| REST check runs | `commits/{ref}/check-runs` and `check-suites/{id}/check-runs`, fields and `total_count` confirmed |
| REST commit statuses | `commits/{ref}/statuses` and `/status`, pull access + `repo:status`, fields confirmed |
| REST rate limits | "1,000 requests per hour per repository" for `GITHUB_TOKEN`, 5,000 for PATs, `x-ratelimit-*`, `retry-after` all confirmed |
| community discussions 138249 / 123969 / 190621 | Confirmed as briefed, including the "In Backlog" label and the Actions Data Stream wording |
| `githubocto/github-archive-action` | `archived: true`, 8 stars, 3 open issues |
| `arddluma/GHAlyzer` | 3 stars, read-only analytics, no persistence |
| Cost | Zero. `GITHUB_TOKEN` inside Actions, existing local `gh` auth for the CLI. No paid API, account or hosting. |
| Toolchain | Node v22.18.0, `node:sqlite` works (experimental warning suppressed in the bin shim), npm name `actions-attic` free (registry 404) |

## Verified working (real runs, not tests)

- **Backfill across invocations, `cli/cli` (>1,000 runs/month).** Three invocations at a 30-request ceiling, 85 requests total, 7,148 runs. Archived counts match the API's `total_count` exactly: 3,133 for 2026-07 and 4,015 for 2026-08. Zero duplicates, zero 403s.
- **1,000-result cap handling.** `2026-08-01..2026-08-31` reported 4,015, split recursively to `..-07`, `..-15`, `..-23` and so on until every leaf window was under the cap.
- **Three-level checkpointing.** Month frontier, sub-month window set, and page number within a window. Proven by a run that stopped mid-page and resumed at the next page.
- **flake vs live API.** `Unit and Integration Tests` for 2026-07 on `cli/cli`: archive says 266 success / 6 failure; the API's `status=success` and `status=failure` counts say 266 and 6.
- **All three record types on real data.** `numpy/numpy` 2026-08: 10,829 runs, 6,981 check runs, 969 real CircleCI commit statuses. SQLite index row counts match JSONL line counts exactly.
- **Per-commit resume.** A second numpy invocation made zero run requests (month already walked) and went straight to the 549 commits still needing checks.
- **The Action itself, live.** Compiled `dist/index.cjs` run against `Booyaka101/rimpatch` with real inputs: created a real orphan branch (parent count 0), committed `attic: backfill 2025-07..2026-08 (14 runs)`, wrote `runs/`, `checks/`, `shas/` and `manifest.json`, emitted all nine outputs and a job summary. A second run made no commit. Test branch deleted afterwards; `rimpatch` is back to `main` only.
- **Consecutive runs make no commit.** Both CLI and Action.
- **Clean install.** `npm pack` → install the tarball into an empty directory → `actions-attic --help`, `--version`, `flake` and `build` all work. 32 files in the tarball, `lib/` + `dist/` + `bin/` + `action.yml`.
- **Tests.** 59 tests, all passing: `npm test`.

## Bugs found by real data and fixed

1. An interrupted first month left `backfillFrontier: null`, which `auto` mode read as "backfill complete". Added `backfillComplete` and `backfillOldestMonth`.
2. A month bigger than one request budget restarted from scratch every invocation and never advanced — a livelock, reproduced live on `cli/cli`. Added sub-month window checkpointing (`backfillPartial`).
3. Pages already fetched were discarded when the budget aborted a window mid-pagination. Now kept via `try/finally`.
4. A leaf window needing more pages than the whole budget could never complete. Added page-level resume (`startPage` / `onPage`).

All four have regression tests.

## Not done, deliberately

- **Publishing.** Not pushed to GitHub, not on the Marketplace, not on npm. That is the owner's step.
- Out of scope for v1 per the brief: org-wide rollup, log text download, artifacts, web dashboard, Prometheus, hosted service.

## Owner's next steps to ship

1. `gh repo create Booyaka101/actions-attic --public --source=. --push` (the local repo is committed on `main`).
2. Wait for CI green on that commit, then `gh release create v1.0.0` and a moving `v1` tag.
3. Marketplace listing (first listing needs sudo/TOTP in the browser — `action.yml` description is 101 chars, under the 125 limit; primary category "Continuous integration" = id 2).
4. `npm publish` (needs the owner's npm session; decide on provenance before the first publish, since a version cannot be republished).
5. First distribution step: a comment in [community discussion #138249](https://github.com/orgs/community/discussions/138249), the thread where people have asked GitHub for exactly this since 2024.
