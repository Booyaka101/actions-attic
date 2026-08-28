# actions-attic build state

**Status: v1.1.0 shipped.** Published to npm and released on GitHub, 2026-08-28. v1.1.0 moved the archive off an orphan branch onto `refs/attic/archive`. The Marketplace listing form is filled and submitted; it needs one 6-digit code from the owner's authenticator app to land.

Built and reviewed 2026-08-28.

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
- **Tests.** 81 tests, all passing: `npm test`. A fresh `git clone` + `npm ci` + `npm test` was verified in an isolated directory.

## Bugs found by real data and fixed

1. An interrupted first month left `backfillFrontier: null`, which `auto` mode read as "backfill complete". Added `backfillComplete` and `backfillOldestMonth`.
2. A month bigger than one request budget restarted from scratch every invocation and never advanced, a livelock, reproduced live on `cli/cli`. Added sub-month window checkpointing (`backfillPartial`).
3. Pages already fetched were discarded when the budget aborted a window mid-pagination. Now kept via `try/finally`.
4. A leaf window needing more pages than the whole budget could never complete. Added page-level resume (`startPage` / `onPage`).

All four have regression tests.


## Senior review pass (2026-08-28, after the first build)

A full read-through plus an isolated test environment and adversarial edge-case probing found six
more defects. All are fixed and all have regression tests; the suite went from 60 to 81 tests.

1. **The Action committed nothing whenever it spent its budget. Critical.** The commit itself needs
   API requests, and the walk stopped exactly at the `max-requests` ceiling, so `finalize()` threw
   before writing. Every night's work was discarded and the backfill could never converge on any
   repository big enough to hit the ceiling, which is precisely what the tool is for. Invisible to
   the CLI, whose file backend spends no requests. Fixed with `Api.withCheckpointBudget()`:
   persisting data already fetched outranks the self-imposed ceiling, while the live rate limit
   still applies. Proven live: `cli/cli`'s August, 4 nights at a 20-request budget, 4,015 runs,
   matching `total_count` exactly. Before the fix that scenario committed zero.
2. **Window checkpoints could run ahead of the data.** A window was recorded as captured when its
   pages were *fetched*, not when they were *stored*. An interruption in between marked the window
   done and lost those runs for good, measured at 150 runs silently missing while the month was
   reported complete. Runs are now written window by window, and every checkpoint strictly follows a
   successful write.
3. **Queued check runs were silently dropped.** A check run that has not started has neither
   `started_at` nor `completed_at`, so it had no month to be filed under and was discarded, and its
   commit was then marked fetched, so it was never revisited. `add()` now takes the month of the run
   that referenced it.
4. **A commit re-read the whole archive.** Recounting on every `finalize()` cost one API request per
   month per record type on the branch backend: 43 wasted requests a night on a 14-month archive,
   growing without bound. The manifest now keeps a running total, `recount()` exists to repair or
   verify, and `stats` always reports what is really on disk.
5. **`repository` was advertised but broken.** It redirected the branch write as well as the read, so
   archiving another repository 404'd on a repo the token cannot write to. The branch now always
   lives in the repository running the workflow; `repository` only chooses whose history to read.
6. **`backfill-complete` output was wrong** when the backfill had not started, because a null
   frontier means both "finished" and "nothing done yet".

House rules: a difflib pass over all 67 functions found `daysInMonth`/`monthToIndex` at 67%
similarity (shared `parseMonth` extracted) and two CLI validators at 53% (shared `asUsage`
extracted). No pair is now above 45%. Output wording was tightened for humans: correct plurals,
thousands separators everywhere, paths shown relative to the working directory with forward slashes,
and a `stats` table that flags any disagreement between the manifest and the files.

Docs assets in `docs/` are rendered by `scripts/screenshots.mjs` from the verbatim captures in
`docs/sessions/`; every line in them is real output from a live run.

## 1.1.0: the archive is a ref, not a branch

An orphan branch is a thing the repository owner has to look after. It shows in the branch list, it
comes down on every clone, it can be picked as a PR base, and worst of all a nightly commit to it
fires `on: push: branches: ['**']` workflows, so we would impose a CI run a night on every repo that
has one. Measured on `Booyaka101/rimpatch`, which has an active push workflow: writing
`refs/attic/archive` triggered zero runs, and `git branch -a` after a fresh clone still showed only
`main`.

- `RefBackend` replaces `BranchBackend`, which stays as a deprecated alias so 1.0 imports keep working.
- `normalizeRef` treats a bare name as a branch, so `ref: my-archive` still means `refs/heads/my-archive`.
- The `branch` input is deprecated but honoured, so upgrading never moves an existing archive.
- New `archive-url` output and job-summary link, since GitHub's file browser cannot resolve a custom
  ref but browses any commit by SHA. Verified 200 on a real commit.
- New `actions-attic pull <owner/repo>` reads the ref over the API into a directory, so nobody has to
  remember `git fetch origin 'refs/attic/*:refs/attic/*'`. Verified from a clean directory: 4 files,
  7 API requests, then `stats`, `build` and `flake` all read it.

## Shipped

| Where | State |
| --- | --- |
| GitHub | https://github.com/Booyaka101/actions-attic, public, 8 topics |
| Release | v1.0.0 at `82da50f`, plus a moving `v1` tag |
| CI on the release commit | 6/6 green: 4 test legs (ubuntu + windows, node 22 + 24), `dist-is-current`, `pack` |
| npm | `actions-attic@1.0.0`, MIT, 32 files, 983 kB unpacked. Verified by installing from the registry into an empty directory and archiving a live repository. |
| Marketplace | Form submitted with Continuous integration + Backup Utilities. Blocked on sudo. |

**No provenance attestation on 1.0.0.** It was published from an authenticated local npm session,
and provenance needs an OIDC publish from a GitHub runner, which needs a token minted behind 2FA.
npm forbids republishing a version, so 1.0.0 cannot gain one later. To get provenance from 1.0.1
onward, set up npm Trusted Publishing for the package and publish from CI.

## Finishing the Marketplace listing

The release edit form has already been submitted with the Marketplace box ticked and both categories
set. GitHub is holding that POST behind sudo and replays it automatically once sudo clears, so
nothing needs re-ticking.

1. In the open Chrome tab on `github.com/Booyaka101/actions-attic/releases/tag/v1.0.0`, the
   "Confirm access" page is showing the authenticator field (`#app_totp`, placeholder XXXXXX).
2. Type the 6-digit code from the authenticator app and click Verify. Ignore "Send a code via
   email"; measured delivery here has run 45 to 90 minutes, past the code's own validity.
3. `https://github.com/marketplace/actions/actions-attic` goes from 404 to 200 within a few minutes.

Sudo then lasts about three hours. Later releases need no UI step at all: once an Action is listed,
`gh release create` alone publishes the new version.

## Distribution, 2026-08-28

| Channel | State |
| --- | --- |
| GitHub Marketplace | Live, `actions-attic@v1`, Continuous integration + Backup Utilities |
| npm | `actions-attic@1.1.0` |
| r/booyakatools, Discord `#tool-releases` | Both releases posted by the owner's automation |
| Hacker News | https://news.ycombinator.com/item?id=49477735, the changelog as the story, tool disclosed in the first comment |
| dev.to | https://dev.to/booyaka101/github-starts-deleting-your-actions-run-history-on-october-1-there-is-no-export-button-3ck1 |
| community discussion 138249 | Drafted, owner decided not to post |

The dev.to piece is a search asset rather than an audience play. Measured first: 20 prior articles
on that account total 16 reactions and 9 comments, and three of them are the same deadline-plus-tool
shape as this one, so the expected engagement there is about one reaction. It was published for the
Google surface on queries people will type in October, and it is indexable with no robots
restriction.

**The launch is five weeks early.** The changelog does not bite until 1 October, so nobody is
searching for this yet. The high-value move is a second run at the story in late September, when
"GitHub starts deleting Actions history on Monday" is imminent rather than hypothetical. HN permits
resubmitting a URL that got no traction, and r/devops becomes worth the rules-reading then too.

## Not done, deliberately

- Out of scope for v1 per the brief: org-wide rollup, log text download, artifacts, web dashboard, Prometheus, hosted service.

## First distribution step

A comment in [community discussion #138249](https://github.com/orgs/community/discussions/138249),
the thread where people have asked GitHub for exactly this since 2024, still labelled "In Backlog".
