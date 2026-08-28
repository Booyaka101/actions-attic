import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(root, 'bin', 'actions-attic.mjs');
const FIXTURE = join(root, 'test', 'fixtures', 'archive');

async function attic(args, opts = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      cwd: opts.cwd ?? root,
      env: { ...process.env, GITHUB_TOKEN: opts.token ?? '', PATH: opts.path ?? process.env.PATH },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('--help works and names the deadline', async () => {
  const res = await attic(['--help']);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /actions-attic \d+\.\d+\.\d+/);
  assert.match(res.stdout, /2026-10-01/);
  assert.match(res.stdout, /actions-attic sync cli\/cli/);
});

test('--version prints just the version', async () => {
  const res = await attic(['--version']);
  assert.equal(res.code, 0);
  assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('no arguments prints help and exits non-zero', async () => {
  const res = await attic([]);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /USAGE/);
});

test('an unknown command is a usage error, not a stack trace', async () => {
  const res = await attic(['frobnicate']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /unknown command "frobnicate"/);
  assert.doesNotMatch(res.stderr, /at Object\./);
});

test('a bad repository name is rejected before any request', async () => {
  const res = await attic(['sync', 'not-a-repo'], { token: 'x' });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /must look like owner\/name/);
});

test('a bad --months value is rejected with the allowed range', async () => {
  const res = await attic(['sync', 'acme/widget', '--months', '999'], { token: 'x' });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /--months must be an integer between 1 and 120/);
});

test('a missing archive directory explains what to do', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'attic-empty-'));
  try {
    const res = await attic(['stats', '--archive', dir]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /no archive found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('flake over the fixture archive prints the documented line', async () => {
  const res = await attic(['flake', 'build-linux', '--since', '2025-09', '--archive', FIXTURE]);
  assert.equal(res.code, 0);
  assert.equal(
    res.stdout.trim(),
    'build-linux: 412 runs, 389 success, 23 failure, flake rate 5.6% (peak 2026-02 at 11.1%)',
  );
});

test('flake on an unknown workflow lists the workflows that are there', async () => {
  const res = await attic(['flake', 'nope', '--archive', FIXTURE]);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /Workflows in this window:\n {2}build-linux\n {2}docs/);
});

test('stats summarises the archive', async () => {
  const res = await attic(['stats', '--archive', FIXTURE]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /runs\s+454/);
  assert.match(res.stdout, /backfill\s+complete/);
});

test('build writes a SQLite index and reports the counts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'attic-cli-db-'));
  try {
    const res = await attic(['build', '--archive', FIXTURE, '--out', join(dir, 'attic.db'), '--json']);
    assert.equal(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.runs, 454);
    assert.equal(parsed.checks, 2);
    assert.equal(parsed.statuses, 1);
    assert.doesNotMatch(res.stderr, /ExperimentalWarning/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runs emits JSON lines and reports an empty window', async () => {
  const hit = await attic(['runs', '--archive', FIXTURE, '--since', '2026-05', '--until', '2026-05']);
  assert.equal(hit.code, 0);
  const lines = hit.stdout.trim().split('\n');
  assert.equal(lines.length, 46);
  assert.equal(JSON.parse(lines[0]).name, 'build-linux');

  const miss = await attic(['runs', '--archive', FIXTURE, '--since', '2030-01']);
  assert.equal(miss.code, 1);
  assert.match(miss.stderr, /no runs matched/);
});

test('a missing token is a usage error naming the ways to supply one', async () => {
  // PATH is emptied so the `gh auth token` fallback cannot resolve.
  const res = await attic(['sync', 'acme/widget'], { path: '' });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /no GitHub token found/);
  assert.match(res.stderr, /GITHUB_TOKEN/);
});
