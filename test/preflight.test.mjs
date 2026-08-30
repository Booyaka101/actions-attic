import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Api } from '../lib/api.js';
import { Archive } from '../lib/archive.js';
import { formatPreflight, runPreflight } from '../lib/preflight.js';

const quiet = () => {};
const NOW = new Date('2026-08-30T12:00:00Z');
// 90 days before NOW.
const CUTOFF_90 = '2026-06-01T12:00:00Z';

function respond(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function inWindow(created) {
  if (!created) return () => true;
  if (created.startsWith('<')) return (r) => r.created_at < created.slice(1);
  const [start, end] = created.split('..');
  return (r) => r.created_at >= start && r.created_at <= end;
}

/** Just enough GitHub: repo info, retention, run search, per-commit checks and statuses. */
function github({
  runs = [],
  checksBySha = {},
  statusesBySha = {},
  retention = { days: 90, maximum_allowed_days: 400 },
  retentionStatus = 200,
  visibility = 'private',
  repoCreated = '2025-06-01T00:00:00Z',
} = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (u.pathname === '/repos/acme/widget/actions/permissions/artifact-and-log-retention') {
      return respond(retentionStatus, retentionStatus === 200 ? retention : { message: 'nope' });
    }
    if (u.pathname === '/repos/acme/widget/actions/runs') {
      const match = runs.filter(inWindow(u.searchParams.get('created')));
      const per = Number(u.searchParams.get('per_page') ?? '100');
      const page = Number(u.searchParams.get('page') ?? '1');
      return respond(200, { total_count: match.length, workflow_runs: match.slice((page - 1) * per, page * per) });
    }
    let m = /^\/repos\/acme\/widget\/commits\/([^/]+)\/check-runs$/.exec(u.pathname);
    if (m) {
      const items = checksBySha[m[1]] ?? [];
      return respond(200, { total_count: items.length, check_runs: items });
    }
    m = /^\/repos\/acme\/widget\/commits\/([^/]+)\/statuses$/.exec(u.pathname);
    if (m) return respond(200, statusesBySha[m[1]] ?? []);
    if (u.pathname === '/repos/acme/widget') {
      return respond(200, { visibility, private: visibility !== 'public', created_at: repoCreated });
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { fetchImpl, calls };
}

function memBackend(files = {}) {
  const store = new Map(Object.entries(files));
  return {
    paths: () => [...store.keys()],
    read: async (p) => store.get(p) ?? null,
    write: (p, c) => void store.set(p, c),
    commit: async () => null,
    describe: () => 'mem',
  };
}

const jsonl = (records) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;

function run(id, created_at, head_sha = `sha${id}`) {
  return { id, name: 'ci', status: 'completed', conclusion: 'success', created_at, head_sha, run_attempt: 1 };
}

async function preflight({ files = {}, retentionDays = null, now = NOW, ...gh } = {}) {
  const { fetchImpl, calls } = github(gh);
  const api = new Api({ token: 't', maxRequests: 500, fetchImpl, sleep: async () => {} });
  const archive = await Archive.open(memBackend(files), 'acme/widget');
  const result = await runPreflight({
    api,
    archive,
    owner: 'acme',
    repo: 'widget',
    retentionDays,
    now,
    log: quiet,
    warn: quiet,
  });
  return { result, calls, api };
}

test('the API value wins when no flag is given, including a 400-day window', async () => {
  const { result } = await preflight({ retention: { days: 400, maximum_allowed_days: 400 } });
  assert.equal(result.retentionDays, 400);
  assert.equal(result.retentionSource, 'api');
  assert.equal(result.deletionDate, '2026-10-01');
  assert.equal(result.cutoffIso, new Date(NOW.getTime() - 400 * 86_400_000).toISOString().replace('.000Z', 'Z'));
});

test('a 403 from the retention endpoint falls back to the flag', async () => {
  const { result } = await preflight({ retentionStatus: 403, retentionDays: 30 });
  assert.equal(result.retentionDays, 30);
  assert.equal(result.retentionSource, 'flag');
});

test('a 403 with no flag fires the 90-day platform default and says so', async () => {
  const { result } = await preflight({ retentionStatus: 403 });
  assert.equal(result.retentionDays, 90);
  assert.equal(result.retentionSource, 'default');
  assert.equal(result.cutoffIso, CUTOFF_90);
});

test('a configured value above 90 clamps to 90 on a public repo', async () => {
  const { result } = await preflight({ retention: { days: 400, maximum_allowed_days: 400 }, visibility: 'public' });
  assert.equal(result.retentionDays, 90);
  assert.equal(result.retentionSource, 'api');
});

test('the resolved value clamps to maximum_allowed_days when the API supplies one', async () => {
  const { result } = await preflight({ retention: { days: 90, maximum_allowed_days: 90 }, retentionDays: 400 });
  assert.equal(result.retentionDays, 90);
  assert.equal(result.retentionSource, 'flag');
});

test('zero records older than the cutoff reports nothing at risk', async () => {
  const { result } = await preflight({ runs: [run(1, '2026-08-29T00:00:00Z')] });
  assert.deepEqual(result.atRisk, { runs: 0, checks: 0, statuses: 0 });
  assert.deepEqual(result.unarchived, { runs: 0, checks: 0, statuses: 0, total: 0 });
  assert.match(formatPreflight(result, 'x'), /Nothing at risk\. No records are older than the cutoff\./);
});

test('everything archived costs three requests and reports the attic total', async () => {
  const remote = [run(1, '2026-01-05T00:00:00Z', 'aaa'), run(2, '2026-02-06T00:00:00Z', 'bbb')];
  const { result, calls } = await preflight({
    runs: remote,
    files: {
      'runs/2026-01.jsonl': jsonl([remote[0]]),
      'runs/2026-02.jsonl': jsonl([remote[1]]),
      'checks/2026-01.jsonl': jsonl([{ id: 11, started_at: '2026-01-05T00:01:00Z', head_sha: 'aaa' }]),
      'statuses/2026-02.jsonl': jsonl([{ id: 21, created_at: '2026-02-06T00:01:00Z', head_sha: 'bbb' }]),
      'shas/2026-01.txt': 'aaa\n',
      'shas/2026-02.txt': 'bbb\n',
    },
  });
  assert.deepEqual(result.atRisk, { runs: 2, checks: 1, statuses: 1 });
  assert.deepEqual(result.archived, { runs: 2, checks: 1, statuses: 1 });
  assert.equal(result.unarchived.total, 0);
  // repo info, retention, one counting probe; no per-month listing, no commit fetches
  assert.equal(calls.length, 3);
  assert.match(formatPreflight(result, 'x'), /Nothing at risk\. 4 records already in the attic\./);
});

test('a partial archive localizes the gap and fetches only the missing commits', async () => {
  const remote = [
    run(1, '2026-01-05T00:00:00Z', 'aaa'),
    run(2, '2026-01-06T00:00:00Z', 'bbb'),
    run(3, '2026-02-07T00:00:00Z', 'ccc'),
  ];
  const { result } = await preflight({
    runs: remote,
    files: {
      'runs/2026-01.jsonl': jsonl([remote[0]]),
      'runs/2026-02.jsonl': jsonl([remote[2]]),
      'checks/2026-01.jsonl': jsonl([{ id: 11, started_at: '2026-01-05T00:01:00Z', head_sha: 'aaa' }]),
      'shas/2026-01.txt': 'aaa\n',
      'shas/2026-02.txt': 'ccc\n',
    },
    checksBySha: {
      bbb: [
        { id: 12, started_at: '2026-01-06T00:01:00Z', head_sha: 'bbb' },
        { id: 13, started_at: '2026-01-06T00:02:00Z', head_sha: 'bbb' },
      ],
    },
    statusesBySha: { bbb: [{ id: 22, created_at: '2026-01-06T00:01:00Z' }] },
    repoCreated: '2026-01-01T00:00:00Z',
  });
  assert.deepEqual(result.atRisk, { runs: 3, checks: 3, statuses: 1 });
  assert.deepEqual(result.archived, { runs: 2, checks: 1, statuses: 0 });
  assert.deepEqual(result.unarchived, { runs: 1, checks: 2, statuses: 1, total: 4 });
});

test('an archive that does not exist yet leaves everything unarchived', async () => {
  const remote = [run(1, '2026-01-05T00:00:00Z', 'aaa'), run(2, '2026-08-29T00:00:00Z', 'new')];
  const { result } = await preflight({
    runs: remote,
    checksBySha: { aaa: [{ id: 11, started_at: '2026-01-05T00:01:00Z', head_sha: 'aaa' }] },
    statusesBySha: { aaa: [{ id: 21, created_at: '2026-01-05T00:01:00Z' }] },
    repoCreated: '2026-01-01T00:00:00Z',
  });
  assert.deepEqual(result.atRisk, { runs: 1, checks: 1, statuses: 1 });
  assert.deepEqual(result.archived, { runs: 0, checks: 0, statuses: 0 });
  assert.deepEqual(result.unarchived, { runs: 1, checks: 1, statuses: 1, total: 3 });
});

test('checks and statuses dated after the cutoff on an old commit are not at risk', async () => {
  const remote = [run(1, '2026-01-05T00:00:00Z', 'aaa')];
  const { result } = await preflight({
    runs: remote,
    checksBySha: {
      aaa: [
        { id: 11, started_at: '2026-01-05T00:01:00Z', head_sha: 'aaa' },
        { id: 12, started_at: '2026-08-29T00:00:00Z', head_sha: 'aaa' },
      ],
    },
    statusesBySha: { aaa: [{ id: 21, created_at: '2026-08-29T00:00:00Z' }] },
    repoCreated: '2026-01-01T00:00:00Z',
  });
  assert.deepEqual(result.atRisk, { runs: 1, checks: 1, statuses: 0 });
  assert.deepEqual(result.unarchived, { runs: 1, checks: 1, statuses: 0, total: 2 });
});

test('--retention-days shifts the cutoff and with it the counts', async () => {
  const remote = [run(1, '2026-06-15T00:00:00Z', 'aaa'), run(2, '2026-01-05T00:00:00Z', 'bbb')];
  const gh = { runs: remote, repoCreated: '2026-01-01T00:00:00Z' };
  const wide = await preflight({ ...gh, retentionDays: 30 });
  const narrow = await preflight({ ...gh, retentionDays: 200 });
  assert.equal(wide.result.atRisk.runs, 2);
  assert.equal(narrow.result.atRisk.runs, 1);
});

test('running out of budget is an error with advice, not a checkpoint message', async () => {
  const remote = [run(1, '2026-01-05T00:00:00Z', 'aaa')];
  const { fetchImpl } = github({ runs: remote, repoCreated: '2026-01-01T00:00:00Z' });
  const api = new Api({ token: 't', maxRequests: 3, fetchImpl, sleep: async () => {} });
  const archive = await Archive.open(memBackend(), 'acme/widget');
  await assert.rejects(
    runPreflight({ api, archive, owner: 'acme', repo: 'widget', now: NOW, log: quiet, warn: quiet }),
    /ran out of request budget.*backfill/s,
  );
});

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(root, 'bin', 'actions-attic.mjs');

/** Serve the same mock GitHub over real HTTP for the CLI's --api flag. */
async function serve(gh) {
  const { fetchImpl } = github(gh);
  const server = createServer(async (req, res) => {
    if (/^\/repos\/acme\/widget\/git\/ref\//.test(req.url)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"message":"Not Found"}');
      return;
    }
    try {
      const mocked = await fetchImpl(`http://x${req.url}`);
      res.writeHead(mocked.status, { 'content-type': 'application/json' });
      res.end(await mocked.text());
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function atticPreflight(args, apiUrl) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, 'preflight', 'acme/widget', '--api', apiUrl, ...args], {
      cwd: root,
      env: { ...process.env, GITHUB_TOKEN: 'test-token' },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function writeArchiveDir(files) {
  const dir = await mkdtemp(join(tmpdir(), 'attic-preflight-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, dirname(path)), { recursive: true });
    await writeFile(join(dir, path), content, 'utf8');
  }
  return dir;
}

test('the CLI fails on unarchived records before a backfill and passes after one', async () => {
  const remote = [run(1, '2026-01-05T00:00:00Z', 'aaa')];
  const gh = {
    runs: remote,
    checksBySha: { aaa: [{ id: 11, started_at: '2026-01-05T00:01:00Z', head_sha: 'aaa' }] },
    repoCreated: '2026-01-01T00:00:00Z',
  };
  const server = await serve(gh);
  const empty = await writeArchiveDir({});
  const filled = await writeArchiveDir({
    'runs/2026-01.jsonl': jsonl([remote[0]]),
    'checks/2026-01.jsonl': jsonl([{ id: 11, started_at: '2026-01-05T00:01:00Z', head_sha: 'aaa' }]),
    'shas/2026-01.txt': 'aaa\n',
  });
  try {
    const before = await atticPreflight(['--archive', empty, '--fail-on-unarchived'], server.url);
    assert.equal(before.code, 1);
    assert.match(before.stdout, /Unarchived and at risk: 1 run, 1 check run, 0 statuses\. Run: actions-attic backfill acme\/widget/);

    const after = await atticPreflight(['--archive', filled, '--fail-on-unarchived'], server.url);
    assert.equal(after.code, 0, after.stdout + after.stderr);
    assert.match(after.stdout, /Nothing at risk\. 2 records already in the attic\./);
  } finally {
    await server.close();
    await rm(empty, { recursive: true, force: true });
    await rm(filled, { recursive: true, force: true });
  }
});

test('--json prints only the structured result', async () => {
  const server = await serve({ runs: [run(1, '2026-01-05T00:00:00Z', 'aaa')], repoCreated: '2026-01-01T00:00:00Z' });
  const dir = await writeArchiveDir({});
  try {
    const res = await atticPreflight(['--archive', dir, '--json', '--retention-days', '30'], server.url);
    assert.equal(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.retentionSource, 'flag');
    assert.equal(parsed.retentionDays, 30);
    assert.equal(parsed.deletionDate, '2026-10-01');
    assert.ok(parsed.cutoffIso > '2020');
    assert.equal(typeof parsed.unarchived.total, 'number');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing archive ref reads as an empty archive, not an error', async () => {
  const server = await serve({ runs: [run(1, '2026-01-05T00:00:00Z', 'aaa')], repoCreated: '2026-01-01T00:00:00Z' });
  try {
    const res = await atticPreflight(['--retention-days', '90'], server.url);
    assert.equal(res.code, 0);
    assert.match(res.stderr, /has no archive at refs\/attic\/archive yet/);
    assert.match(res.stdout, /Unarchived and at risk: 1 run, 0 check runs, 0 statuses/);
  } finally {
    await server.close();
  }
});

test('the text report ends with the worked-example lines', () => {
  const result = {
    retentionDays: 90,
    retentionSource: 'api',
    cutoffIso: CUTOFF_90,
    deletionDate: '2026-10-01',
    atRisk: { runs: 1842, checks: 0, statuses: 0 },
    archived: { runs: 1840, checks: 0, statuses: 0 },
    unarchived: { runs: 2, checks: 0, statuses: 0, total: 2 },
  };
  const text = formatPreflight(result, 'actions-attic backfill acme/widget');
  assert.match(text, /retention window: 90 days \(repository setting\)/);
  assert.match(text, /at risk: 1,842 runs, 0 check runs, 0 statuses/);
  assert.ok(
    text.endsWith('Unarchived and at risk: 2 runs, 0 check runs, 0 statuses. Run: actions-attic backfill acme/widget'),
    text,
  );
});
