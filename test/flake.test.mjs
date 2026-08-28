import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Archive } from '../lib/archive.js';
import { FsBackend } from '../lib/backend.js';
import { computeFlake, formatFlake } from '../lib/flake.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'archive');

async function fixtureRuns() {
  const archive = await Archive.open(await FsBackend.open(FIXTURE), 'acme/widget');
  return archive.readAll('runs');
}

test('flake output matches the documented line exactly', async () => {
  const report = computeFlake(await fixtureRuns(), { workflow: 'build-linux', since: '2025-09' });
  assert.equal(
    formatFlake(report),
    'build-linux: 412 runs, 389 success, 23 failure, flake rate 5.6% (peak 2026-02 at 11.1%)',
  );
});

test('only success and failure count towards the rate', async () => {
  const report = computeFlake(await fixtureRuns(), { workflow: 'build-linux', since: '2025-09' });
  assert.equal(report.runs, report.success + report.failure);
  assert.equal(report.runs, 412);
  assert.equal(report.peak.month, '2026-02');
  assert.equal(report.peak.failure, 4);
  assert.equal(report.peak.runs, 36);
});

test('--since excludes earlier months', async () => {
  const runs = await fixtureRuns();
  const all = computeFlake(runs, { workflow: 'build-linux' });
  const windowed = computeFlake(runs, { workflow: 'build-linux', since: '2025-09' });
  assert.equal(all.runs, windowed.runs + 2, '2025-08 holds two extra decided runs');
});

test('--until excludes later months', async () => {
  const report = computeFlake(await fixtureRuns(), { workflow: 'build-linux', since: '2025-09', until: '2025-09' });
  assert.equal(report.runs, 42);
  assert.equal(report.failure, 4);
  assert.equal(formatFlake(report), 'build-linux: 42 runs, 38 success, 4 failure, flake rate 9.5% (peak 2025-09 at 9.5%)');
});

test('a workflow with no failures reports no peak', async () => {
  const report = computeFlake(await fixtureRuns(), { workflow: 'build-linux', since: '2026-05', until: '2026-05' });
  assert.equal(report.failure, 0);
  assert.equal(report.peak, null);
  assert.equal(formatFlake(report), 'build-linux: 42 runs, 42 success, 0 failure, flake rate 0.0%');
});

test('an unknown workflow reports zero runs and lists what is there', async () => {
  const report = computeFlake(await fixtureRuns(), { workflow: 'nope' });
  assert.equal(report.runs, 0);
  assert.deepEqual(report.candidates, ['build-linux', 'docs']);
});

test('--min-runs keeps a thin month from owning the peak', async () => {
  const runs = [
    { id: 1, name: 'ci', conclusion: 'failure', created_at: '2026-01-02T00:00:00Z', run_attempt: 1 },
    { id: 2, name: 'ci', conclusion: 'success', created_at: '2026-02-02T00:00:00Z', run_attempt: 1 },
    { id: 3, name: 'ci', conclusion: 'failure', created_at: '2026-02-03T00:00:00Z', run_attempt: 1 },
    { id: 4, name: 'ci', conclusion: 'success', created_at: '2026-02-04T00:00:00Z', run_attempt: 1 },
    { id: 5, name: 'ci', conclusion: 'success', created_at: '2026-02-05T00:00:00Z', run_attempt: 1 },
  ];
  assert.equal(computeFlake(runs, { workflow: 'ci' }).peak.month, '2026-01');
  assert.equal(computeFlake(runs, { workflow: 'ci', minRuns: 2 }).peak.month, '2026-02');
});

test('a workflow can also be selected by workflow_id', async () => {
  const report = computeFlake(await fixtureRuns(), { workflow: '111', since: '2025-09' });
  assert.equal(report.runs, 412);
});

test('a workflow name matches case-insensitively and reports its real casing', async () => {
  const runs = [
    { id: 1, name: 'CI', conclusion: 'success', created_at: '2026-01-02T00:00:00Z', run_attempt: 1 },
    { id: 2, name: 'CI', conclusion: 'failure', created_at: '2026-01-03T00:00:00Z', run_attempt: 1 },
  ];
  const report = computeFlake(runs, { workflow: 'ci' });
  assert.equal(report.runs, 2);
  assert.equal(report.workflow, 'CI');
  assert.equal(formatFlake(report), 'CI: 2 runs, 1 success, 1 failure, flake rate 50.0% (peak 2026-01 at 50.0%)');
});
