/**
 * The Action's real wiring: runArchive on top of the branch backend, where
 * every archive read and the commit itself cost API requests. The CLI's file
 * backend hides all of that, so these cases only show up here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api } from '../lib/api.js';
import { Archive } from '../lib/archive.js';
import { BranchBackend } from '../lib/backend.js';
import { runArchive } from '../lib/run.js';
import { makeGitServer } from './helpers/fake-git.mjs';
import { makeFakeGitHub, makeRuns } from './helpers/fake-github.mjs';

const quiet = () => {};

/** One endpoint surface: Git Data for the branch, REST for the Actions data. */
function makeServer(runs) {
  const git = makeGitServer();
  const gh = makeFakeGitHub({ runs });
  const fetchImpl = async (url, init) =>
    new URL(url).pathname.includes('/git/') ? git.fetchImpl(url, init) : gh.fetchImpl(url, init);
  return { fetchImpl, git, gh };
}

function apiFor(fetchImpl, maxRequests) {
  return new Api({ token: 't', maxRequests, fetchImpl, log: quiet, warn: quiet, sleep: async () => {} });
}

async function night(server, maxRequests, months = 3) {
  const api = apiFor(server.fetchImpl, maxRequests);
  const backend = await BranchBackend.open(api, 'acme', 'widget', 'actions-attic', { warn: quiet });
  return runArchive({
    api,
    backend,
    owner: 'acme',
    repo: 'widget',
    mode: 'auto',
    months,
    skipChecks: true,
    skipStatuses: true,
    now: new Date('2026-03-20T02:00:00Z'),
    log: quiet,
    warn: quiet,
  });
}

const threeMonths = () => [
  ...makeRuns({ month: '2026-03', count: 250, startId: 3_000_000, days: 20 }),
  ...makeRuns({ month: '2026-02', count: 250, startId: 2_000_000, days: 20 }),
  ...makeRuns({ month: '2026-01', count: 250, startId: 1_000_000, days: 20 }),
];

test('a night that spends its whole budget still commits what it captured', async () => {
  const server = makeServer(threeMonths());

  // The ceiling is low enough that the walk alone would consume all of it. If
  // the commit is not reserved for, the night's work is silently thrown away
  // and the archive never advances.
  const first = await night(server, 8);

  assert.ok(first.runs > 0, 'the walk captured runs');
  assert.ok(first.commit, 'a budget-exhausted night must still land a commit');
  assert.ok(first.checkpoint, 'and must record why it stopped');
  assert.equal(server.git.refs.get('actions-attic'), first.commit.sha);

  const verify = await Archive.open(
    await BranchBackend.open(apiFor(server.fetchImpl, 500), 'acme', 'widget', 'actions-attic'),
    'acme/widget',
  );
  assert.equal(verify.manifest.counts.runs, first.runs, 'what was reported is what is on the branch');
});

test('successive budget-limited nights converge on the whole history', async () => {
  const runs = threeMonths();
  const server = makeServer(runs);

  let last = null;
  for (let i = 0; i < 25; i++) {
    const summary = await night(server, 8);
    if (i > 0 && last !== null) {
      assert.ok(
        summary.archive.manifest.counts.runs >= last,
        `night ${i + 1} went backwards: ${last} -> ${summary.archive.manifest.counts.runs}`,
      );
    }
    last = summary.archive.manifest.counts.runs;
    if (summary.backfill?.finished) break;
  }

  assert.equal(last, runs.length, `expected all ${runs.length} runs, archived ${last}`);
});

test('a quiet night on a large archive costs only a handful of requests', async () => {
  const server = makeServer(threeMonths());
  for (let i = 0; i < 25; i++) {
    const summary = await night(server, 500);
    if (summary.backfill?.finished) break;
  }

  const uploadsBefore = server.git.state.blobUploads;
  const api = apiFor(server.fetchImpl, 500);
  const backend = await BranchBackend.open(api, 'acme', 'widget', 'actions-attic', { warn: quiet });
  const summary = await runArchive({
    api,
    backend,
    owner: 'acme',
    repo: 'widget',
    mode: 'auto',
    months: 3,
    skipChecks: true,
    skipStatuses: true,
    now: new Date('2026-03-20T02:00:00Z'),
    log: quiet,
    warn: quiet,
  });

  assert.equal(summary.commit, null, 'nothing new, so no commit');
  assert.equal(server.git.state.blobUploads, uploadsBefore, 'no blobs uploaded');
  assert.ok(api.requests <= 8, `a no-op night used ${api.requests} requests; it should read the ref, the archive head and one run page`);
});

test('a month is never marked complete before its runs are on the branch', async () => {
  const runs = threeMonths();
  const server = makeServer(runs);
  const byMonth = new Map();
  for (const r of runs) {
    const m = r.created_at.slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + 1);
  }

  for (let i = 0; i < 30; i++) {
    const summary = await night(server, 8);

    // Audit the branch independently of the run that just wrote it.
    const audit = await Archive.open(
      await BranchBackend.open(apiFor(server.fetchImpl, 9999), 'acme', 'widget', 'actions-attic'),
      'acme/widget',
    );
    assert.deepEqual(await audit.recount(), audit.manifest.counts, 'the manifest must match what is on the branch');

    const oldest = audit.manifest.backfillOldestMonth;
    if (oldest) {
      // Every month at or newer than the frontier is claimed as fully captured.
      for (const [month, expected] of byMonth) {
        if (month < oldest) continue;
        assert.equal(
          (await audit.read('runs', month)).length,
          expected,
          `${month} is claimed complete but holds fewer runs than the API has`,
        );
      }
    }
    if (summary.backfill?.finished) return;
  }
  assert.fail('backfill never finished');
});
