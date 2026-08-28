#!/usr/bin/env node
// Regenerates test/fixtures/archive, a deterministic stand-in archive used by
// the flake, SQLite-index and CLI tests. Test-only; nothing here ships.
//
//   node test/fixtures/generate.mjs
//
// The numbers are chosen so `flake build-linux --since 2025-09` prints exactly
// "build-linux: 412 runs, 389 success, 23 failure, flake rate 5.6% (peak 2026-02 at 11.1%)".

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, 'archive');

/** month -> [runs, failures] for build-linux */
const PLAN = [
  ['2025-09', 42, 4],
  ['2025-10', 42, 4],
  ['2025-11', 42, 4],
  ['2025-12', 42, 2],
  ['2026-01', 42, 2],
  ['2026-02', 36, 4],
  ['2026-03', 42, 1],
  ['2026-04', 42, 1],
  ['2026-05', 42, 0],
  ['2026-06', 38, 0],
];

let id = 5_000_000_000;
const nextId = () => ++id;

function run({ month, day, name, conclusion, attempt = 1, runId = nextId(), sha }) {
  const created = `${month}-${String(day).padStart(2, '0')}T09:00:00Z`;
  return {
    id: runId,
    name,
    status: conclusion === null ? 'in_progress' : 'completed',
    conclusion,
    created_at: created,
    updated_at: `${month}-${String(day).padStart(2, '0')}T09:20:00Z`,
    run_started_at: created,
    head_sha: sha ?? `${'0'.repeat(33)}${String(runId).slice(-7)}`,
    head_branch: 'main',
    event: 'push',
    actor: 'octocat',
    triggering_actor: 'octocat',
    run_number: runId % 100000,
    run_attempt: attempt,
    workflow_id: name === 'build-linux' ? 111 : 222,
    html_url: `https://github.com/acme/widget/actions/runs/${runId}`,
  };
}

const byMonth = new Map();
const push = (month, record) => {
  const list = byMonth.get(month) ?? [];
  list.push(record);
  byMonth.set(month, list);
};

for (const [month, total, failures] of PLAN) {
  for (let i = 0; i < total; i++) {
    const day = (i % 27) + 1;
    push(month, run({ month, day, name: 'build-linux', conclusion: i < failures ? 'failure' : 'success' }));
  }
  // Noise the flake maths must ignore: undecided conclusions and another workflow.
  push(month, run({ month, day: 28, name: 'build-linux', conclusion: 'cancelled' }));
  push(month, run({ month, day: 28, name: 'build-linux', conclusion: 'skipped' }));
  push(month, run({ month, day: 28, name: 'build-linux', conclusion: null }));
  push(month, run({ month, day: 28, name: 'docs', conclusion: 'failure' }));
}

// Outside the --since 2025-09 window, so it must not be counted.
push('2025-08', run({ month: '2025-08', day: 4, name: 'build-linux', conclusion: 'failure' }));
push('2025-08', run({ month: '2025-08', day: 4, name: 'build-linux', conclusion: 'success' }));

// A re-attempt: same run id, second attempt, stored as its own record.
const retried = nextId();
push('2026-06', run({ month: '2026-06', day: 15, name: 'build-linux', conclusion: 'failure', runId: retried, attempt: 1, sha: 'a'.repeat(40) }));
push('2026-06', run({ month: '2026-06', day: 15, name: 'build-linux', conclusion: 'success', runId: retried, attempt: 2, sha: 'a'.repeat(40) }));

const checks = [
  {
    id: 900001,
    name: 'build-linux / gcc',
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-06-15T09:00:00Z',
    completed_at: '2026-06-15T09:12:00Z',
    head_sha: 'a'.repeat(40),
    app: 'github-actions',
  },
  {
    id: 900002,
    name: 'codecov/patch',
    status: 'completed',
    conclusion: 'failure',
    started_at: '2026-06-15T09:01:00Z',
    completed_at: '2026-06-15T09:14:00Z',
    head_sha: 'a'.repeat(40),
    app: 'codecov',
  },
];

const statuses = [
  {
    id: 800001,
    head_sha: 'a'.repeat(40),
    state: 'success',
    context: 'continuous-integration/legacy',
    description: 'Build finished',
    target_url: 'https://ci.example.com/1',
    created_at: '2026-06-15T09:15:00Z',
    updated_at: '2026-06-15T09:15:00Z',
  },
];

rmSync(root, { recursive: true, force: true });
for (const dir of ['runs', 'checks', 'statuses', 'shas']) mkdirSync(join(root, dir), { recursive: true });

const sortKey = (r) => `${r.created_at ?? r.started_at}|${String(r.id).padStart(20, '0')}|${r.run_attempt ?? 1}`;
const write = (path, records) =>
  writeFileSync(join(root, path), `${[...records].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)).map((r) => JSON.stringify(r)).join('\n')}\n`);

let runCount = 0;
for (const [month, records] of [...byMonth].sort()) {
  write(`runs/${month}.jsonl`, records);
  runCount += records.length;
}
write('checks/2026-06.jsonl', checks);
write('statuses/2026-06.jsonl', statuses);
writeFileSync(join(root, 'shas/2026-06.txt'), `${'a'.repeat(40)}\n`);

const months = [...byMonth.keys()].sort();
writeFileSync(
  join(root, 'manifest.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      repo: 'acme/widget',
      backfillFrontier: null,
      backfillComplete: true,
      backfillOldestMonth: '2025-08',
      highestRunId: id,
      lastRun: '2026-07-01T02:00:00Z',
      months,
      counts: { runs: runCount, checks: checks.length, statuses: statuses.length },
      generator: 'actions-attic',
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote ${runCount} runs, ${checks.length} checks, ${statuses.length} statuses across ${months.length} months`);
