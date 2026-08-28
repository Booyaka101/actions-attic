import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Api } from '../lib/api.js';
import { Archive } from '../lib/archive.js';
import { FsBackend } from '../lib/backend.js';
import { captureWindow } from '../lib/collect.js';
import { makeContext } from '../lib/collect.js';
import { monthWindow } from '../lib/months.js';
import { runArchive } from '../lib/run.js';
import { makeFakeGitHub, makeRuns } from './helpers/fake-github.mjs';

const NOW = new Date('2026-03-20T02:00:00Z');
const quiet = () => {};

async function scratch() {
  return mkdtemp(join(tmpdir(), 'attic-test-'));
}

function apiFor(fetchImpl, maxRequests = 5000) {
  return new Api({ token: 't', maxRequests, fetchImpl, log: quiet, warn: quiet, sleep: async () => {} });
}

async function contextFor(dir, fetchImpl, maxRequests) {
  const backend = await FsBackend.open(dir);
  const archive = await Archive.open(backend, 'acme/widget');
  const api = apiFor(fetchImpl, maxRequests);
  return {
    api,
    backend,
    archive,
    ctx: makeContext({
      api,
      archive,
      owner: 'acme',
      repo: 'widget',
      skipChecks: true,
      skipStatuses: true,
      log: quiet,
      warn: quiet,
    }),
  };
}

test('a bucket at the 1,000-result cap splits into two half-month buckets', async () => {
  const dir = await scratch();
  try {
    const runs = makeRuns({ month: '2026-03', count: 1000, days: 31 });
    const { fetchImpl } = makeFakeGitHub({ runs });
    const { ctx } = await contextFor(dir, fetchImpl);

    const result = await captureWindow(ctx, monthWindow('2026-03'));

    assert.deepEqual(result.windows, ['2026-03-01..2026-03-15', '2026-03-16..2026-03-31']);
    assert.equal(result.complete, true);
    assert.equal(new Set(result.runs.map((r) => `${r.id}:${r.run_attempt}`)).size, 1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a window under the cap is walked whole', async () => {
  const dir = await scratch();
  try {
    const { fetchImpl } = makeFakeGitHub({ runs: makeRuns({ month: '2026-03', count: 999, days: 31 }) });
    const { ctx } = await contextFor(dir, fetchImpl);
    const result = await captureWindow(ctx, monthWindow('2026-03'));
    assert.deepEqual(result.windows, ['2026-03-01..2026-03-31']);
    assert.equal(result.runs.length, 999);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a single day over the cap is reported instead of splitting forever', async () => {
  const dir = await scratch();
  try {
    const runs = makeRuns({ month: '2026-03', count: 1200, days: 1 });
    const { fetchImpl } = makeFakeGitHub({ runs });
    const { ctx } = await contextFor(dir, fetchImpl);
    const warnings = [];
    ctx.warn = (m) => warnings.push(m);
    const result = await captureWindow(ctx, monthWindow('2026-03'));
    assert.ok(result.windows.includes('2026-03-01..2026-03-01'));
    assert.ok(warnings.some((w) => /single day/.test(w)), warnings.join('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resume from the frontier after budget exhaustion loses no run', async () => {
  const dir = await scratch();
  try {
    const runs = [
      ...makeRuns({ month: '2026-03', count: 120, startId: 3_000_000, days: 20 }),
      ...makeRuns({ month: '2026-02', count: 140, startId: 2_000_000, days: 20 }),
      ...makeRuns({ month: '2026-01', count: 160, startId: 1_000_000, days: 20 }),
    ];
    const { fetchImpl, state } = makeFakeGitHub({ runs });

    const invocations = [];
    let guard = 0;
    for (;;) {
      if (++guard > 10) assert.fail('backfill did not converge');
      const backend = await FsBackend.open(dir);
      const summary = await runArchive({
        api: apiFor(fetchImpl, 2), // two requests per invocation: one month per run at most
        backend,
        owner: 'acme',
        repo: 'widget',
        mode: 'backfill',
        months: 3,
        skipChecks: true,
        skipStatuses: true,
        now: NOW,
        log: quiet,
        warn: quiet,
      });
      invocations.push({ frontier: summary.frontier, added: summary.runs });
      if (summary.frontier === null && summary.backfill?.finished) break;
    }

    assert.ok(invocations.length >= 3, `expected multiple invocations, got ${invocations.length}`);
    assert.ok(
      invocations.slice(0, -1).some((i) => i.frontier !== null),
      'expected a checkpointed frontier partway through',
    );

    const archive = await Archive.open(await FsBackend.open(dir), 'acme/widget');
    const stored = await archive.readAll('runs');
    assert.equal(stored.length, runs.length);
    assert.equal(new Set(stored.map((r) => `${r.id}:${r.run_attempt}`)).size, runs.length);
    assert.equal(archive.manifest.backfillFrontier, null);
    assert.equal(archive.manifest.counts.runs, runs.length);
    assert.ok(state.requests > 3, 'the fake API should have been hit across several invocations');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('re-running the same night dedupes and makes no second commit', async () => {
  const dir = await scratch();
  try {
    const runs = makeRuns({ month: '2026-03', count: 40, days: 20 });
    const checks = { [runs[0].head_sha]: [{ id: 1, name: 'lint', status: 'completed', conclusion: 'success', started_at: '2026-03-01T10:00:00Z', completed_at: '2026-03-01T10:05:00Z', head_sha: runs[0].head_sha, app: { slug: 'github-actions' } }] };
    const { fetchImpl } = makeFakeGitHub({ runs, checks });

    const first = await runArchive({
      api: apiFor(fetchImpl), backend: await FsBackend.open(dir), owner: 'acme', repo: 'widget',
      mode: 'backfill', months: 1, skipStatuses: true, now: NOW, log: quiet, warn: quiet,
    });
    assert.equal(first.runs, 40);
    assert.equal(first.checks, 1);
    assert.ok(first.commit, 'the first run must commit');

    const second = await runArchive({
      api: apiFor(fetchImpl), backend: await FsBackend.open(dir), owner: 'acme', repo: 'widget',
      mode: 'backfill', months: 1, skipStatuses: true, now: NOW, log: quiet, warn: quiet,
    });
    assert.equal(second.runs, 0);
    assert.equal(second.checks, 0);
    assert.equal(second.commit, null, 'a repeated run must not commit');

    const third = await runArchive({
      api: apiFor(fetchImpl), backend: await FsBackend.open(dir), owner: 'acme', repo: 'widget',
      mode: 'incremental', months: 1, skipStatuses: true, now: NOW, log: quiet, warn: quiet,
    });
    assert.equal(third.commit, null, 'a consecutive incremental must not commit');

    const archive = await Archive.open(await FsBackend.open(dir), 'acme/widget');
    assert.equal((await archive.readAll('runs')).length, 40);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a re-attempt is kept as its own record', async () => {
  const dir = await scratch();
  try {
    const runs = makeRuns({ month: '2026-03', count: 5, days: 5 });
    const fake = makeFakeGitHub({ runs });
    await runArchive({
      api: apiFor(fake.fetchImpl), backend: await FsBackend.open(dir), owner: 'acme', repo: 'widget',
      mode: 'backfill', months: 1, skipChecks: true, skipStatuses: true, now: NOW, log: quiet, warn: quiet,
    });

    const retried = { ...runs[0], run_attempt: 2, conclusion: 'success', updated_at: '2026-03-19T11:00:00Z' };
    const second = makeFakeGitHub({ runs: [retried, ...runs.slice(1)] });
    const summary = await runArchive({
      api: apiFor(second.fetchImpl), backend: await FsBackend.open(dir), owner: 'acme', repo: 'widget',
      mode: 'incremental', months: 1, skipChecks: true, skipStatuses: true, now: NOW, log: quiet, warn: quiet,
    });

    assert.equal(summary.runs, 1);
    const archive = await Archive.open(await FsBackend.open(dir), 'acme/widget');
    const stored = await archive.readAll('runs');
    assert.equal(stored.length, 6);
    assert.deepEqual(stored.filter((r) => r.id === runs[0].id).map((r) => r.run_attempt).sort(), [1, 2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a repo with zero runs creates an archive and exits cleanly', async () => {
  const dir = await scratch();
  try {
    const { fetchImpl } = makeFakeGitHub({ runs: [] });
    const summary = await runArchive({
      api: apiFor(fetchImpl), backend: await FsBackend.open(dir), owner: 'acme', repo: 'empty',
      mode: 'backfill', months: 2, now: NOW, log: quiet, warn: quiet,
    });
    assert.equal(summary.runs, 0);
    assert.ok(summary.commit, 'the first run still writes a manifest');
    assert.deepEqual(summary.commit.changed, ['manifest.json']);
    assert.equal(summary.frontier, null);

    const backend = await FsBackend.open(dir);
    assert.deepEqual(backend.paths(), ['manifest.json'], 'no empty month files');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a 403 on statuses is survivable: runs and checks still archive', async () => {
  const dir = await scratch();
  try {
    const runs = makeRuns({ month: '2026-03', count: 3, days: 3 });
    const checks = Object.fromEntries(
      runs.map((r) => [r.head_sha, [{ id: r.id, name: 'ci', status: 'completed', conclusion: 'success', started_at: r.created_at, completed_at: r.updated_at, head_sha: r.head_sha, app: { slug: 'github-actions' } }]]),
    );
    const { fetchImpl } = makeFakeGitHub({ runs, checks, statusesForbidden: true });
    const warnings = [];
    const summary = await runArchive({
      api: apiFor(fetchImpl), backend: await FsBackend.open(dir), owner: 'acme', repo: 'widget',
      mode: 'backfill', months: 1, now: NOW, log: quiet, warn: (m) => warnings.push(m),
    });
    assert.equal(summary.runs, 3);
    assert.equal(summary.checks, 3);
    assert.equal(summary.statuses, 0);
    assert.ok(warnings.some((w) => /403/.test(w)), warnings.join('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a secondary rate limit checkpoints instead of throwing', async () => {
  const dir = await scratch();
  try {
    const runs = [
      ...makeRuns({ month: '2026-03', count: 30, startId: 3_000_000, days: 10 }),
      ...makeRuns({ month: '2026-02', count: 30, startId: 2_000_000, days: 10 }),
    ];
    const { fetchImpl } = makeFakeGitHub({ runs, secondaryLimitAfter: 1, retryAfter: 3600 });
    const summary = await runArchive({
      api: apiFor(fetchImpl), backend: await FsBackend.open(dir), owner: 'acme', repo: 'widget',
      mode: 'backfill', months: 2, skipChecks: true, skipStatuses: true, now: NOW, log: quiet, warn: quiet,
    });
    assert.match(summary.checkpoint ?? '', /secondary rate limit/);
    assert.equal(summary.runs, 30, 'the month fetched before the limit is kept');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a month too big for one budget resumes mid-month instead of restarting', async () => {
  const dir = await scratch();
  try {
    // 2,500 runs in one month forces repeated 1,000-cap splits; six requests
    // per invocation cannot finish it, so the sub-month checkpoint has to work.
    const runs = makeRuns({ month: '2026-03', count: 2500, days: 31 });
    const { fetchImpl, state } = makeFakeGitHub({ runs });

    const spend = [];
    let guard = 0;
    for (;;) {
      if (++guard > 40) assert.fail('backfill livelocked: it never finished the month');
      const before = state.requests;
      const summary = await runArchive({
        api: apiFor(fetchImpl, 6),
        backend: await FsBackend.open(dir),
        owner: 'acme',
        repo: 'widget',
        mode: 'backfill',
        months: 1,
        skipChecks: true,
        skipStatuses: true,
        now: new Date('2026-03-20T02:00:00Z'),
        log: quiet,
        warn: quiet,
      });
      spend.push({ requests: state.requests - before, added: summary.runs });
      if (summary.backfill?.finished) break;
      assert.ok(
        summary.archive.manifest.backfillPartial,
        'an unfinished month must leave a sub-month checkpoint',
      );
    }

    assert.ok(guard > 2, `expected several invocations, took ${guard}`);
    assert.ok(
      spend.filter((s) => s.added === 0).length <= 1,
      `almost every invocation should make progress: ${JSON.stringify(spend)}`,
    );

    const archive = await Archive.open(await FsBackend.open(dir), 'acme/widget');
    const stored = await archive.readAll('runs');
    assert.equal(stored.length, 2500);
    assert.equal(new Set(stored.map((r) => r.id)).size, 2500);
    assert.equal(archive.manifest.backfillPartial, null, 'the checkpoint is cleared once the month is done');
    assert.equal(archive.manifest.backfillComplete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
