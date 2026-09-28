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
import { RefBackend } from '../lib/backend.js';
import { RUNS_COUNT_CAP, formatPreflight, retentionPhrase, runPreflight } from '../lib/preflight.js';
import { runArchive } from '../lib/run.js';
import { makeGitServer } from './helpers/fake-git.mjs';

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
  // A date-only end covers that whole day, as it does on GitHub.
  const last = end.length === 10 ? `${end}T23:59:59Z` : end;
  return (r) => r.created_at >= start && r.created_at <= last;
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
  // GitHub caps total_count on a filtered runs query; Infinity is the pre-2026-09-25 behaviour.
  countCap = Infinity,
  // An open-ended count that lags the per-window ones, which GitHub does briefly.
  openEndedLag = 0,
} = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (u.pathname === '/repos/acme/widget/actions/permissions/artifact-and-log-retention') {
      return respond(retentionStatus, retentionStatus === 200 ? retention : { message: 'nope' });
    }
    if (u.pathname === '/repos/acme/widget/actions/runs') {
      const created = u.searchParams.get('created');
      const match = runs.filter(inWindow(created));
      const lag = created?.startsWith('<') ? openEndedLag : 0;
      const per = Number(u.searchParams.get('per_page') ?? '100');
      const page = Number(u.searchParams.get('page') ?? '1');
      return respond(200, {
        total_count: Math.max(0, Math.min(match.length, countCap) - lag),
        workflow_runs: match.slice((page - 1) * per, page * per),
      });
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

async function preflight({ files = {}, retentionDays = null, now = NOW, warn = quiet, maxRequests = 500, ...gh } = {}) {
  const { fetchImpl, calls } = github(gh);
  const api = new Api({ token: 't', maxRequests, fetchImpl, sleep: async () => {} });
  const archive = await Archive.open(memBackend(files), 'acme/widget');
  const result = await runPreflight({
    api,
    archive,
    owner: 'acme',
    repo: 'widget',
    retentionDays,
    now,
    log: quiet,
    warn,
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

const CAP = RUNS_COUNT_CAP;
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** `count` runs `stepMs` apart from `start`, all on one commit. */
function burst(firstId, start, count, stepMs, sha = 'aaa') {
  return Array.from({ length: count }, (_, i) => run(firstId + i, iso(Date.parse(start) + i * stepMs), sha));
}

/** An archive holding exactly `runs`, with their commits already fetched. */
function archiveOf(runs) {
  const files = {};
  for (const r of runs) {
    const month = r.created_at.slice(0, 7);
    files[`runs/${month}.jsonl`] = (files[`runs/${month}.jsonl`] ?? '') + `${JSON.stringify(r)}\n`;
    files[`shas/${month}.txt`] = `${r.head_sha}\n`;
  }
  return files;
}

const runsCalls = (calls) => calls.filter((c) => c.startsWith('/repos/acme/widget/actions/runs?'));
const countCalls = (calls) => runsCalls(calls).filter((c) => c.endsWith('&per_page=1'));
const listCalls = (calls) => runsCalls(calls).filter((c) => !c.endsWith('&per_page=1'));

/** Three months of 2,000 runs each, 2026-01 to 2026-03: 6,000 in all, past the cap. */
const busyQuarter = () => [
  ...burst(1, '2026-01-01T00:10:00Z', 2000, 1_200_000),
  ...burst(10_001, '2026-02-01T00:10:00Z', 2000, 1_200_000),
  ...burst(20_001, '2026-03-01T00:10:00Z', 2000, 1_200_000),
];

test('below the count cap one request still counts every at-risk run', async () => {
  const remote = burst(1, '2026-01-05T00:00:00Z', CAP - 1, 3_600_000);
  const { result, calls } = await preflight({
    runs: remote,
    files: archiveOf(remote),
    repoCreated: '2026-01-01T00:00:00Z',
    countCap: CAP,
  });
  assert.equal(result.atRisk.runs, CAP - 1);
  assert.equal(result.unarchived.total, 0);
  assert.deepEqual(countCalls(calls), ['/repos/acme/widget/actions/runs?created=%3C2026-06-01T12%3A00%3A00Z&per_page=1']);
  assert.equal(calls.length, 3);
});

test('a capped count is summed per month, and those counts are not asked for twice', async () => {
  const remote = busyQuarter();
  const { result, calls } = await preflight({
    runs: remote,
    files: archiveOf(remote.slice(0, -2)),
    repoCreated: '2026-01-01T00:00:00Z',
    countCap: CAP,
  });
  assert.equal(result.atRisk.runs, 6000);
  assert.equal(result.archived.runs, 5998);
  assert.deepEqual(result.unarchived, { runs: 2, checks: 0, statuses: 0, total: 2 });
  // The capped open-ended count, the pre-creation count, one per month 2026-01..2026-06.
  const counts = countCalls(calls);
  assert.equal(counts.length, 8);
  assert.equal(new Set(counts).size, counts.length);
  const listed = listCalls(calls);
  assert.ok(listed.length > 0 && listed.every((c) => c.includes('created=2026-03-')), listed.join('\n'));
});

test('a capped day is split down to the second until every count is exact', async () => {
  const remote = [run(1, '2026-01-05T00:00:00Z'), ...burst(10, '2026-02-10T08:00:00Z', 3000, 10_000)];
  const { result, calls } = await preflight({
    runs: remote,
    files: archiveOf(remote),
    repoCreated: '2026-01-01T00:00:00Z',
    countCap: CAP,
  });
  assert.equal(result.atRisk.runs, 3001);
  assert.equal(result.unarchived.total, 0);
  assert.equal(listCalls(calls).length, 0);
  const created = countCalls(calls).map((c) => new URL(`http://x${c}`).searchParams.get('created'));
  assert.ok(created.some((w) => /^2026-02-10T.*\.\.2026-02-10T/.test(w)), created.join('\n'));
});

test('a one-second window at the cap is counted as a lower bound and says so', async () => {
  const remote = burst(1, '2026-02-10T08:00:00Z', CAP + 1, 0);
  const warnings = [];
  const { result } = await preflight({
    runs: remote,
    files: archiveOf(remote),
    repoCreated: '2026-01-01T00:00:00Z',
    countCap: CAP,
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result.atRisk.runs, CAP);
  assert.ok(
    warnings.includes(
      '2026-02-10T08:00:00Z..2026-02-10T08:00:00Z has at least 2500 runs in one second; counting 2500, a lower bound',
    ),
    warnings.join('\n'),
  );
});

/** busyQuarter, all of it archived, with the cutoff on 2026-04-01. */
function archivedBusyQuarter(repoCreated) {
  const remote = busyQuarter();
  return preflight({
    runs: remote,
    files: archiveOf(remote),
    repoCreated,
    countCap: CAP,
    now: new Date('2026-06-30T12:00:00Z'),
  });
}

test('a fully archived busy repo counts past the cap without listing anything', async () => {
  // 1.4.0 reported 2,500 at risk and 2,500 archived here.
  const { result, calls } = await archivedBusyQuarter('2026-01-01T00:00:00Z');
  assert.equal(result.cutoffIso, '2026-04-01T12:00:00Z');
  assert.equal(result.atRisk.runs, 6000);
  assert.equal(result.archived.runs, 6000);
  assert.equal(result.unarchived.total, 0);
  assert.match(formatPreflight(result, 'x'), /Nothing at risk\. 6,000 records already in the attic\./);
  // The capped open-ended count, the pre-creation count, one per month 2026-01..2026-04.
  assert.equal(countCalls(calls).length, 6);
  assert.equal(listCalls(calls).length, 0);
});

test('a capped count does not ask about months from before Actions existed', async () => {
  const { result, calls } = await archivedBusyQuarter('2008-04-11T00:00:00Z');
  assert.equal(result.atRisk.runs, 6000);
  assert.equal(result.unarchived.total, 0);
  // The same 6 as a repository created in 2026-01, plus 2018-01..2025-12.
  assert.equal(countCalls(calls).length, 6 + 8 * 12);
});

test('a capped month still dedupes a re-attempted run when it is listed', async () => {
  const remote = [...burst(1, '2026-01-05T00:00:00Z', CAP, 600_000), { ...run(1, '2026-01-05T00:00:00Z', 'aaa'), run_attempt: 2 }];
  const { result } = await preflight({ runs: remote, repoCreated: '2026-01-01T00:00:00Z', countCap: CAP });
  assert.equal(result.unarchived.runs, CAP);
});

test('a stale open-ended count never reports fewer at risk than unarchived', async () => {
  // Seen live on Booyaka101/rimpatch: "at risk: 17 runs" above "Unarchived and at risk: 20 runs".
  const remote = burst(1, '2026-01-05T00:00:00Z', 20, 86_400_000);
  const { result } = await preflight({ runs: remote, repoCreated: '2026-01-01T00:00:00Z', openEndedLag: 3 });
  assert.equal(result.atRisk.runs, 20);
  assert.equal(result.unarchived.runs, 20);
  assert.equal(result.archived.runs, 0);
});

test('running out of budget mid exact count is the same error with advice', async () => {
  // repo, retention, the capped open-ended count, the pre-creation count, the capped
  // month; the first half of that month is the sixth request.
  const remote = burst(1, '2026-01-05T00:00:00Z', 3000, 600_000);
  await assert.rejects(
    preflight({ runs: remote, repoCreated: '2026-01-01T00:00:00Z', countCap: CAP, maxRequests: 5 }),
    /ran out of request budget after 5 requests.*backfill/s,
  );
});

test('preflight reads the archive ref the Action writes', async () => {
  const remote = [run(1, '2026-01-05T00:00:00Z', 'aaa'), run(2, '2026-08-29T00:00:00Z', 'bbb')];
  const gh = github({
    runs: remote,
    checksBySha: { aaa: [{ id: 11, started_at: '2026-01-05T00:01:00Z', head_sha: 'aaa' }] },
    repoCreated: '2026-01-01T00:00:00Z',
  });
  const git = makeGitServer();
  const fetchImpl = async (url, init) =>
    new URL(url).pathname.includes('/git/') ? git.fetchImpl(url, init) : gh.fetchImpl(url);
  const apiFor = () => new Api({ token: 't', maxRequests: 500, fetchImpl, sleep: async () => {} });

  const writer = apiFor();
  await runArchive({
    api: writer,
    backend: await RefBackend.open(writer, 'acme', 'widget', 'refs/attic/archive', { warn: quiet }),
    owner: 'acme',
    repo: 'widget',
    mode: 'backfill',
    months: 12,
    now: NOW,
    log: quiet,
    warn: quiet,
  });

  const reader = apiFor();
  const archive = await Archive.open(await RefBackend.open(reader, 'acme', 'widget', 'refs/attic/archive'), 'acme/widget');
  const result = await runPreflight({ api: reader, archive, owner: 'acme', repo: 'widget', now: NOW, log: quiet, warn: quiet });
  assert.deepEqual(result.atRisk, { runs: 1, checks: 1, statuses: 0 });
  assert.deepEqual(result.archived, { runs: 1, checks: 1, statuses: 0 });
  assert.equal(result.unarchived.total, 0);
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

test('a month at the cap with exactly the cap archived fails --fail-on-unarchived', async () => {
  // 5,000 runs remotely, 2,500 archived. The capped count reads 2,500 against 2,500,
  // which is how 1.4.0 came to exit 0 here.
  const remote = burst(1, '2026-01-01T00:10:00Z', 5000, 480_000);
  const server = await serve({ runs: remote, repoCreated: '2026-01-01T00:00:00Z', countCap: CAP });
  const dir = await writeArchiveDir(archiveOf(remote.slice(0, 2500)));
  try {
    const res = await atticPreflight(['--archive', dir, '--fail-on-unarchived'], server.url);
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /at risk: 5,000 runs, 0 check runs, 0 statuses/);
    assert.match(res.stdout, /Unarchived and at risk: 2,500 runs, 0 check runs, 0 statuses\./);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
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

test('the retention phrase agrees with its number and names the source in words', () => {
  // The job summaries print this too, which is how they came to say "1 days (api)".
  assert.equal(retentionPhrase({ retentionDays: 1, retentionSource: 'flag' }), '1 day (--retention-days)');
  assert.equal(retentionPhrase({ retentionDays: 90, retentionSource: 'api' }), '90 days (repository setting)');
  assert.equal(retentionPhrase({ retentionDays: 400, retentionSource: 'default' }), '400 days (GitHub default)');
});
