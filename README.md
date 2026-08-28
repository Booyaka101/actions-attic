# actions-attic

> "Starting October 1, 2026, checks, workflow runs, and statuses will be governed by the same Actions retention setting."
> Until now they "were retained for 400+ days regardless of your retention configuration". "For public repositories, the maximum retention for checks, workflow runs, and statuses is 90 days."
> "Export or archive anything you need to keep beyond your configured retention period, since older checks, workflow runs, and statuses will be automatically removed."
>
> — [GitHub Changelog, 27 August 2026](https://github.blog/changelog/2026-08-27-actions-retention-will-cover-checks-workflow-runs-and-statuses/)

GitHub tells you to export. It does not ship an exporter. This is one.

actions-attic keeps a permanent, plain-text archive of a repository's workflow runs, check runs and commit statuses **inside the repository itself**, on an orphan branch. No hosted service, no database to run, no credentials beyond the token the workflow already has.

Add this to `.github/workflows/attic.yml`:

```yaml
name: attic
on:
  schedule: [{ cron: '17 3 * * *' }]
  workflow_dispatch:
permissions: { actions: read, checks: read, statuses: read, contents: write }
jobs:
  archive:
    runs-on: ubuntu-latest
    steps:
      - uses: Booyaka101/actions-attic@v1
```

The first run creates the `actions-attic` branch and starts walking history backwards. If it runs out of request budget it commits what it has and resumes the next night. Once history is captured, each run takes seconds.

## What it archives

| Path | Contents |
| --- | --- |
| `runs/YYYY-MM.jsonl` | one line per workflow run **attempt**: `id`, `name`, `status`, `conclusion`, `created_at`, `updated_at`, `run_started_at`, `head_sha`, `head_branch`, `event`, `actor`, `triggering_actor`, `run_number`, `run_attempt`, `workflow_id`, `html_url` |
| `checks/YYYY-MM.jsonl` | one line per check run: `id`, `name`, `status`, `conclusion`, `started_at`, `completed_at`, `head_sha`, `app` |
| `statuses/YYYY-MM.jsonl` | one line per commit status: `id`, `head_sha`, `state`, `context`, `description`, `target_url`, `created_at`, `updated_at` |
| `shas/YYYY-MM.txt` | commits whose checks and statuses have been fetched, so a resumed run does not refetch them |
| `manifest.json` | `schemaVersion`, `backfillFrontier`, `backfillComplete`, `backfillOldestMonth`, `backfillPartial`, `highestRunId`, `lastRun`, `months`, `counts` |

JSONL, sorted, deduped. A month with no runs gets no file. A run that was re-attempted keeps every attempt as its own record.

## The CLI

```
npm i -g actions-attic     # or: npx actions-attic --help
```

```
actions-attic sync <owner/repo>          top up new runs, then continue the backfill
actions-attic backfill <owner/repo>      walk history backwards only
actions-attic incremental <owner/repo>   append new runs only
actions-attic build                      build a SQLite index over the archive
actions-attic flake <workflow>           flake rate for one workflow
actions-attic stats                      what the archive currently holds
actions-attic runs                       archived runs as JSON lines
```

The CLI writes to a directory instead of a branch, so you can archive from your laptop, or point `--archive` at a checkout of the `actions-attic` branch and read it. It takes the token from `--token`, `GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`.

### Real output

Archiving two months of [`cli/cli`](https://github.com/cli/cli), a repository with several thousand runs a month, on a deliberately tiny 30-request budget so the resume path is exercised:

```
$ npx actions-attic backfill cli/cli --archive attic --months 2 --max-requests 30 --no-checks --no-statuses
backfilling 2026-08
2026-08-01..2026-08-31 hits the 1000-result cap; splitting
2026-08-01..2026-08-15 hits the 1000-result cap; splitting
2026-08-01..2026-08-07 hits the 1000-result cap; splitting
stopping inside 2026-08; the next run resumes at the windows still outstanding
attic: backfill 2026-08 in progress (2,612 runs)
2 file(s) written to attic (2612 runs, 0 checks, 0 statuses new)
30 API requests used
checkpointed: reached the max-requests ceiling of 30

$ npx actions-attic backfill cli/cli --archive attic --months 2 --max-requests 30 --no-checks --no-statuses
attic: backfill 2026-08 (2,435 runs)
30 API requests used
backfill frontier at 2026-08-01; run again to continue

$ npx actions-attic backfill cli/cli --archive attic --months 2 --max-requests 30 --no-checks --no-statuses
attic: backfill 2026-07 (2,101 runs)
25 API requests used
backfill complete
```

85 requests, 7,148 runs, no duplicates. The archived counts match what the API reports for the same windows exactly: 3,133 for July and 4,015 for August.

```
$ npx actions-attic flake "Unit and Integration Tests" --since 2026-07 --until 2026-07 --archive attic
Unit and Integration Tests: 272 runs, 266 success, 6 failure, flake rate 2.2% (peak 2026-07 at 2.2%)
```

Checked against the live API for the same window: `status=success` reports 266, `status=failure` reports 6.

```
$ npx actions-attic stats --archive attic
repo             cli/cli
archive          /work/attic
months           2026-07..2026-08 (2)
runs             7,148
checks           0
statuses         0
highest run id   33125555902
backfill         complete
last change      2026-08-28T01:11:00.124Z
```

`flake` counts only runs that concluded `success` or `failure`; cancelled, skipped and still-running runs are not flake signal. The peak is the worst month by failure rate.

## Configuration

| Input | Default | Notes |
| --- | --- | --- |
| `token` | `${{ github.token }}` | Needs `actions: read`, `checks: read`, `statuses: read`, `contents: write` |
| `branch` | `actions-attic` | Orphan branch holding the archive |
| `mode` | `auto` | `auto` tops up new runs then continues the backfill; also `backfill`, `incremental` |
| `backfill-months` | `14` | How far back to walk |
| `max-requests` | `800` | `GITHUB_TOKEN` gets 1,000 requests/hour/repository, so 800 leaves headroom |
| `max-pages` | `50` | Page ceiling for an incremental catch-up |
| `repository` | current repo | Archive a different repository |
| `skip-checks` / `skip-statuses` | `false` | Runs-only archiving, much cheaper |

Outputs: `runs-added`, `checks-added`, `statuses-added`, `committed`, `commit-sha`, `backfill-frontier`, `backfill-complete`, `requests-used`, `branch`.

## How it stays inside the rate limit

`GET /actions/runs` returns at most 1,000 results per search when filtered by `created`, so the backfill windows by month and halves any window that reports 1,000 or more — recursively, down to a single day. Every response's `x-ratelimit-remaining` and `x-ratelimit-reset` are read, and the walk stops cleanly at `max-requests` or when the live limit gets close.

Progress is checkpointed at three levels, so no work is ever repeated and none is lost:

- **month** — `backfillFrontier` is the first day of the oldest month fully captured
- **window** — a half-finished month records which date windows are done, and which are known to need splitting
- **page** — a window interrupted mid-pagination resumes at the next page

A secondary rate limit with a long `retry-after` checkpoints and exits 0 rather than failing the job. A short one is waited out.

## Reading the archive

```bash
git fetch origin actions-attic
git worktree add ../attic actions-attic
npx actions-attic build --archive ../attic          # -> ../attic/attic.db
npx actions-attic flake build-linux --since 2025-09 --archive ../attic
```

`build` produces a SQLite database (`runs`, `checks`, `statuses`, `meta`) using Node's built-in `node:sqlite`, indexed on name, conclusion, created_at and head_sha. Query it with anything that speaks SQLite:

```sql
SELECT name, COUNT(*) AS runs, ROUND(100.0 * SUM(conclusion='failure') / COUNT(*), 1) AS pct_failed
FROM runs WHERE conclusion IN ('success','failure') AND month >= '2026-01'
GROUP BY name ORDER BY pct_failed DESC;
```

The JSONL is plain text, so `grep`, `jq` and `git log` work on it directly. That is the point: the archive outlives this tool.

## Limitations

- **Single repository per archive.** No org-wide rollup.
- **No log text.** Job logs are a much larger retention problem and are out of scope; this archives the run, check and status metadata.
- **No artifacts.**
- A single day with 1,000 or more runs cannot be fully enumerated — GitHub will not serve past that cap for one search. actions-attic warns and takes the 1,000 it can get.
- Statuses need pull access. If the token cannot read them the run warns once and carries on with runs and checks.
- The backfill only reaches as far back as GitHub still has data. Run it **before** 1 October 2026 and you keep what would otherwise be deleted; run it after and you get whatever survived your retention setting.
- Data added to the archive is never removed by this tool. Deleting the branch deletes the archive.

## Requirements

Node 22.5 or newer (for `node:sqlite`). One runtime dependency, `@actions/core`, used only by the Action.

## Development

```bash
npm install
npm test          # builds, then runs node --test test/*.test.mjs
npm run build     # tsc -> lib/, esbuild -> dist/index.cjs
```

Fixtures under `test/fixtures/` are test-only and are regenerated with `node test/fixtures/generate.mjs`.

## First distribution step

Post in [community discussion #138249](https://github.com/orgs/community/discussions/138249) — the two-year-old thread where people have been asking GitHub for exactly this, still labelled "In Backlog". That is where the audience already is, and the October 1 date makes it timely.

## License

MIT
