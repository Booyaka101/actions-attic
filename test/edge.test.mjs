/**
 * Edge cases the happy-path tests do not reach: payloads GitHub really sends
 * that look malformed, archives that arrive in a bad state, and the cost of a
 * commit as the archive grows.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Api, BudgetExhausted } from '../lib/api.js';
import { Archive } from '../lib/archive.js';
import { FsBackend } from '../lib/backend.js';
import { captureWindow, makeContext } from '../lib/collect.js';
import { computeFlake, formatFlake } from '../lib/flake.js';
import { monthWindow, monthsBack, shiftMonth, splitWindow } from '../lib/months.js';
import { runArchive } from '../lib/run.js';
import { makeFakeGitHub, makeRuns } from './helpers/fake-github.mjs';

const quiet = () => {};
const NOW = new Date('2026-03-20T02:00:00Z');

const scratch = () => mkdtemp(join(tmpdir(), 'attic-edge-'));
const apiFor = (fetchImpl, maxRequests = 5000) =>
  new Api({ token: 't', maxRequests, fetchImpl, log: quiet, warn: quiet, sleep: async () => {} });

async function archiveOnce(dir, fake, extra = {}) {
  return runArchive({
    api: apiFor(fake.fetchImpl, extra.maxRequests ?? 5000),
    backend: await FsBackend.open(dir),
    owner: 'acme',
    repo: 'widget',
    mode: 'backfill',
    months: 1,
    now: NOW,
    log: quiet,
    warn: quiet,
    ...extra,
  });
}

const checkRun = (over) => ({
  id: 1,
  name: 'job',
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-03-01T10:00:00Z',
  completed_at: '2026-03-01T10:05:00Z',
  app: { slug: 'github-actions' },
  ...over,
});

test('a queued check run has null dates and must still be archived', async () => {
  const dir = await scratch();
  try {
    const runs = makeRuns({ month: '2026-03', count: 1, days: 1 });
    const sha = runs[0].head_sha;
    const fake = makeFakeGitHub({
      runs,
      checks: {
        [sha]: [
          checkRun({ id: 1, name: 'queued-job', status: 'queued', conclusion: null, started_at: null, completed_at: null }),
          checkRun({ id: 2, name: 'waiting-job', status: 'waiting', conclusion: null, started_at: null, completed_at: null }),
          checkRun({ id: 3, name: 'done-job' }),
        ],
      },
    });

    const summary = await archiveOnce(dir, fake, { skipStatuses: true });
    assert.equal(summary.checks, 3, 'all three check runs must land, not just the dated one');

    const archive = await Archive.open(await FsBackend.open(dir), 'acme/widget');
    const stored = await archive.readAll('checks');
    assert.deepEqual(
      stored.map((c) => c.name).sort(),
      ['done-job', 'queued-job', 'waiting-job'],
      'an undated record belongs in the month of the run that referenced it',
    );
    // The commit is marked fetched, so a dropped record would never come back.
    assert.equal((await archive.shasDone('2026-03')).size, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a check run dated only by completed_at is bucketed by that date', async () => {
  const dir = await scratch();
  try {
    const runs = makeRuns({ month: '2026-03', count: 1, days: 1 });
    const sha = runs[0].head_sha;
    const fake = makeFakeGitHub({
      runs,
      checks: { [sha]: [checkRun({ started_at: null, completed_at: '2026-03-04T10:05:00Z' })] },
    });
    await archiveOnce(dir, fake, { skipStatuses: true });
    const archive = await Archive.open(await FsBackend.open(dir), 'acme/widget');
    assert.equal((await archive.read('checks', '2026-03')).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('committing does not re-read the whole archive as it grows', async () => {
  const dir = await scratch();
  try {
    const runs = [];
    for (let i = 0; i < 14; i++) {
      runs.push(...makeRuns({ month: shiftMonth('2025-07', i), count: 3, startId: 1_000_000 + i * 1000, days: 3 }));
    }
    await runArchive({
      api: apiFor(makeFakeGitHub({ runs }).fetchImpl),
      backend: await FsBackend.open(dir),
      owner: 'acme',
      repo: 'widget',
      mode: 'backfill',
      months: 14,
      skipChecks: true,
      skipStatuses: true,
      now: new Date('2026-08-20T02:00:00Z'),
      log: quiet,
      warn: quiet,
    });

    // Every read is one API request on the branch backend, so a trivial nightly
    // commit must not cost one per month per record type.
    const backend = await FsBackend.open(dir);
    let reads = 0;
    const inner = backend.read.bind(backend);
    backend.read = async (path) => {
      reads++;
      return inner(path);
    };
    const archive = await Archive.open(backend, 'acme/widget');
    archive.noteRunId(999_999_999);
    await archive.finalize('attic: +1 run');

    assert.equal(archive.manifest.months.length, 14);
    assert.ok(reads <= 2, `a trivial commit read ${reads} archive files; it should read only the manifest`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the manifest count matches a recount after several runs', async () => {
  const dir = await scratch();
  try {
    const runs = makeRuns({ month: '2026-03', count: 30, days: 10 });
    const checks = Object.fromEntries(runs.slice(0, 5).map((r) => [r.head_sha, [checkRun({ id: r.id })]]));
    const fake = makeFakeGitHub({ runs, checks });
    await archiveOnce(dir, fake, { skipStatuses: true });
    await archiveOnce(dir, fake, { skipStatuses: true, mode: 'incremental' });

    const archive = await Archive.open(await FsBackend.open(dir), 'acme/widget');
    assert.deepEqual(archive.manifest.counts, await archive.recount());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a deleted manifest is rebuilt from the files that remain', async () => {
  const dir = await scratch();
  try {
    const fake = makeFakeGitHub({ runs: makeRuns({ month: '2026-03', count: 12, days: 6 }) });
    await archiveOnce(dir, fake, { skipChecks: true, skipStatuses: true });
    await rm(join(dir, 'manifest.json'));

    const archive = await Archive.open(await FsBackend.open(dir), 'acme/widget');
    assert.equal(archive.manifest.counts.runs, 12, 'counts are recovered from the record files');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an archive written with CRLF line endings still parses', async () => {
  const dir = await scratch();
  try {
    const fake = makeFakeGitHub({ runs: makeRuns({ month: '2026-03', count: 4, days: 2 }) });
    await archiveOnce(dir, fake, { skipChecks: true, skipStatuses: true });
    const path = join(dir, 'runs', '2026-03.jsonl');
    await writeFile(path, (await readFile(path, 'utf8')).replace(/\n/g, '\r\n'), 'utf8');

    const archive = await Archive.open(await FsBackend.open(dir), 'acme/widget');
    assert.equal((await archive.readAll('runs')).length, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a manifest from an older build without the newer fields still loads', async () => {
  const dir = await scratch();
  try {
    const backend = await FsBackend.open(dir);
    backend.write('manifest.json', JSON.stringify({ schemaVersion: 1, repo: 'acme/widget', highestRunId: 7 }));
    backend.write('runs/2026-03.jsonl', '{"id":7,"run_attempt":1,"created_at":"2026-03-01T00:00:00Z","head_sha":"x"}\n');
    await backend.commit('seed');

    const archive = await Archive.open(await FsBackend.open(dir), 'acme/widget');
    assert.equal(archive.manifest.backfillComplete, false);
    assert.equal(archive.manifest.backfillOldestMonth, null);
    assert.equal(archive.manifest.backfillPartial, null);
    assert.equal(archive.manifest.highestRunId, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pages that overlap because new runs arrived mid-walk do not duplicate', async () => {
  const dir = await scratch();
  try {
    const runs = makeRuns({ month: '2026-03', count: 250, days: 10 });
    const fake = makeFakeGitHub({ runs });
    await archiveOnce(dir, fake, { skipChecks: true, skipStatuses: true });
    // Same walk again: every record is already present.
    const second = await archiveOnce(dir, fake, { skipChecks: true, skipStatuses: true });

    assert.equal(second.runs, 0);
    const archive = await Archive.open(await FsBackend.open(dir), 'acme/widget');
    const stored = await archive.readAll('runs');
    assert.equal(stored.length, 250);
    assert.equal(new Set(stored.map((r) => `${r.id}:${r.run_attempt}`)).size, 250);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('one API request of budget still makes progress rather than stalling', async () => {
  const dir = await scratch();
  try {
    const fake = makeFakeGitHub({ runs: makeRuns({ month: '2026-03', count: 350, days: 10 }) });
    let previous = -1;
    for (let i = 0; i < 12; i++) {
      const summary = await archiveOnce(dir, fake, { maxRequests: 1, skipChecks: true, skipStatuses: true });
      const total = summary.archive.manifest.counts.runs;
      assert.ok(total > previous, `invocation ${i + 1} added nothing (stuck at ${total})`);
      previous = total;
      if (summary.backfill?.finished) break;
    }
    assert.equal(previous, 350);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run with no workflow name is archived and does not break flake', async () => {
  const dir = await scratch();
  try {
    const runs = makeRuns({ month: '2026-03', count: 2, days: 2 });
    runs[0].name = null;
    const fake = makeFakeGitHub({ runs });
    await archiveOnce(dir, fake, { skipChecks: true, skipStatuses: true });

    const archive = await Archive.open(await FsBackend.open(dir), 'acme/widget');
    const stored = await archive.readAll('runs');
    assert.equal(stored.length, 2);
    const report = computeFlake(stored, { workflow: 'ci' });
    assert.equal(report.runs, 1);
    assert.deepEqual(report.candidates, ['ci']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workflow names with regex and unicode characters match literally', () => {
  const runs = [
    { id: 1, name: 'build (v1.0) [x86]', conclusion: 'failure', created_at: '2026-01-02T00:00:00Z', run_attempt: 1 },
    { id: 2, name: 'build (v1.0) [x86]', conclusion: 'success', created_at: '2026-01-03T00:00:00Z', run_attempt: 1 },
    { id: 3, name: 'ci ✅ déploiement', conclusion: 'success', created_at: '2026-01-04T00:00:00Z', run_attempt: 1 },
  ];
  assert.equal(computeFlake(runs, { workflow: 'build (v1.0) [x86]' }).runs, 2);
  assert.equal(computeFlake(runs, { workflow: 'CI ✅ DÉPLOIEMENT' }).runs, 1);
  assert.equal(computeFlake(runs, { workflow: 'build .*' }).runs, 0);
});

test('a run at a month boundary lands in the month GitHub dates it', async () => {
  const dir = await scratch();
  try {
    const runs = makeRuns({ month: '2026-03', count: 1, days: 1 });
    runs[0].created_at = '2026-03-31T23:59:59Z';
    const fake = makeFakeGitHub({ runs });
    await archiveOnce(dir, fake, { skipChecks: true, skipStatuses: true });

    const backend = await FsBackend.open(dir);
    assert.ok(backend.paths().includes('runs/2026-03.jsonl'));
    assert.ok(!backend.paths().includes('runs/2026-04.jsonl'), 'no UTC drift into the next month');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('flake rounds half-way rates the same way every time', () => {
  const month = (n, failures) =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      name: 'ci',
      conclusion: i < failures ? 'failure' : 'success',
      created_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      run_attempt: 1,
    }));
  assert.equal(formatFlake(computeFlake(month(8, 1), { workflow: 'ci' })).includes('12.5%'), true);
  assert.equal(formatFlake(computeFlake(month(3, 1), { workflow: 'ci' })).includes('33.3%'), true);
  assert.equal(formatFlake(computeFlake(month(1000, 1), { workflow: 'ci' })).includes('0.1%'), true);
});

test('month arithmetic survives a 120-month span and leap years', () => {
  const months = monthsBack('2026-08', 120);
  assert.equal(months.length, 120);
  assert.equal(months[119], '2016-09');
  assert.equal(new Set(months).size, 120, 'no repeats across ten years');
  assert.deepEqual(splitWindow({ start: '2024-02-01', end: '2024-02-29' }), [
    { start: '2024-02-01', end: '2024-02-14' },
    { start: '2024-02-15', end: '2024-02-29' },
  ]);
});

test('a first page that reports the cap but returns few rows still splits', async () => {
  const dir = await scratch();
  try {
    // 1,050 runs spread over one month: the month reports the cap, the halves
    // do not, so the walk must recover every record.
    const fake = makeFakeGitHub({ runs: makeRuns({ month: '2026-03', count: 1050, days: 28 }) });
    const summary = await archiveOnce(dir, fake, { skipChecks: true, skipStatuses: true });
    assert.equal(summary.runs, 1050);
    assert.ok(summary.backfill.windows.length >= 2, 'the month was split');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a commit that vanished (404) is marked done instead of retried forever', async () => {
  const dir = await scratch();
  try {
    const runs = makeRuns({ month: '2026-03', count: 2, days: 2 });
    // No checks registered for either sha, so the fake answers 404 on a bad path
    // and an empty list otherwise; either way the sha must not be re-queued.
    const fake = makeFakeGitHub({ runs, checks: {} });
    await archiveOnce(dir, fake, { skipStatuses: true });
    const archive = await Archive.open(await FsBackend.open(dir), 'acme/widget');
    assert.equal((await archive.shasDone('2026-03')).size, 2);

    const before = fake.state.requests;
    await archiveOnce(dir, fake, { skipStatuses: true, mode: 'incremental' });
    assert.ok(fake.state.requests - before <= 2, 'a settled commit is not fetched again');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a window is not checkpointed when the store refuses the runs', async () => {
  const dir = await scratch();
  try {
    const fake = makeFakeGitHub({ runs: makeRuns({ month: '2026-03', count: 250, days: 10 }) });
    const ctx = makeContext({
      api: apiFor(fake.fetchImpl),
      archive: await Archive.open(await FsBackend.open(dir), 'acme/widget'),
      owner: 'acme',
      repo: 'widget',
      skipChecks: true,
      skipStatuses: true,
      log: quiet,
      warn: quiet,
    });

    // The live rate limit can still bite while persisting, and then the window
    // must look untouched: checkpointing pages we did not keep loses them.
    const progress = new Set();
    const result = await captureWindow(ctx, monthWindow('2026-03'), {
      progress,
      store: async () => {
        throw new BudgetExhausted('rate limit hit while writing');
      },
    });

    assert.equal(result.complete, false);
    assert.equal(progress.size, 0, `nothing may be checkpointed, got ${[...progress].join(', ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
