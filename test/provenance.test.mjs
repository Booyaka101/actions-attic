import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Archive } from '../lib/archive.js';
import { FsBackend } from '../lib/backend.js';
import {
  NPM_PUBLISH_PREDICATE,
  REGISTRY,
  RegistryError,
  SLSA_PREDICATE,
  SLSA_V02_PREDICATE,
  assertPackageName,
  attestationsUrl,
  collectProvenance,
  extractRunPointer,
  formatProvenance,
  notesFor,
  packumentUrl,
  parseInvocationId,
  parsePackageSpec,
  referencedRepos,
  resolveProvenance,
} from '../lib/provenance.js';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(root, 'bin', 'actions-attic.mjs');
const REG = join(root, 'test', 'fixtures', 'registry');

/** The recorded responses this feature was built against; see record-registry.mjs. */
const fixture = (file) => JSON.parse(readFileSync(join(REG, file), 'utf8'));
const PACKUMENT = fixture('runner-drift.packument.json');
const ATT_120 = fixture('runner-drift-1.2.0.attestations.json');
const ATT_121 = fixture('runner-drift-1.2.1.attestations.json');
const CORE_PACKUMENT = fixture('actions-core.packument.json');
const CORE_ATT = fixture('actions-core-3.0.1.attestations.json');
const V02_ATT = fixture('sigstore-2.2.1.attestations.json');

// runner-drift publishes from Booyaka101/runner-drift; @actions/core publishes
// from actions/toolkit, which is what makes it the out-of-scope case.
const RUN_120 = 34305025325;
const RUN_121 = 34307443469;

const json = { 'content-type': 'application/json' };
const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: json });

/** A registry that answers only the URLs it was given; everything else 404s. */
function fakeRegistry(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const key = String(url);
    calls.push(key);
    const route = routes[key];
    if (route === undefined) return new Response('{"error":"Not found"}', { status: 404, headers: json });
    return typeof route === 'function' ? route(calls.filter((c) => c === key).length) : ok(route);
  };
  return { fetchImpl, calls, sleep: async () => {} };
}

const runnerDriftRoutes = () => ({
  [`${REGISTRY}/runner-drift`]: PACKUMENT,
  [`${REGISTRY}/-/npm/v1/attestations/runner-drift%401.2.0`]: ATT_120,
  [`${REGISTRY}/-/npm/v1/attestations/runner-drift%401.2.1`]: ATT_121,
});

const WINDOW = {
  retentionDays: 90,
  retentionSource: 'default',
  cutoffIso: '2026-09-09T03:00:00Z',
  deletionDate: '2026-10-01',
};

function runRecord(id, over = {}) {
  return {
    id,
    name: 'release',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-09-09T03:30:00Z',
    updated_at: '2026-09-09T03:34:00Z',
    run_started_at: '2026-09-09T03:30:00Z',
    head_sha: 'c'.repeat(40),
    head_branch: 'main',
    event: 'push',
    actor: 'Booyaka101',
    triggering_actor: 'Booyaka101',
    run_number: 12,
    run_attempt: 1,
    workflow_id: 9001,
    path: '.github/workflows/release.yml',
    display_title: 'Release 1.2.1',
    html_url: `https://github.com/Booyaka101/runner-drift/actions/runs/${id}`,
    ...over,
  };
}

/** A real on-disk attic, laid out the way the archiver writes one. */
async function makeArchive({ repo = 'Booyaka101/runner-drift', oldest = '2026-08', runs = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'attic-prov-'));
  const months = [...new Set(runs.map((r) => r.created_at.slice(0, 7)))].sort();
  await mkdir(join(dir, 'runs'), { recursive: true });
  for (const month of months) {
    const lines = runs.filter((r) => r.created_at.startsWith(month)).map((r) => JSON.stringify(r));
    await writeFile(join(dir, 'runs', `${month}.jsonl`), `${lines.join('\n')}\n`);
  }
  const manifest = {
    schemaVersion: 2,
    repo,
    backfillFrontier: null,
    backfillComplete: true,
    backfillOldestMonth: oldest,
    backfillPartial: null,
    highestRunId: runs.length ? Math.max(...runs.map((r) => r.id)) : null,
    lastRun: '2026-09-10T00:00:00Z',
    months,
    counts: { runs: runs.length, checks: 0, statuses: 0 },
    generator: 'actions-attic',
  };
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

const openArchive = async (dir) => Archive.open(await FsBackend.open(dir), 'unknown/unknown');

// ---------------------------------------------------------------- parsing

test('parseInvocationId reads the format the Actions build type specifies', () => {
  const full = parseInvocationId('https://github.com/Booyaka101/runner-drift/actions/runs/34307443469/attempts/2');
  assert.deepEqual(full, {
    host: 'https://github.com',
    owner: 'Booyaka101',
    repo: 'runner-drift',
    runId: 34307443469,
    attempt: 2,
    url: 'https://github.com/Booyaka101/runner-drift/actions/runs/34307443469/attempts/2',
  });

  // The attempt segment is optional in the wild; a run URL without one is attempt 1.
  assert.equal(parseInvocationId('https://github.com/acme/widget/actions/runs/7/').attempt, 1);
  assert.equal(parseInvocationId('https://ghe.example.com/acme/widget/actions/runs/7').host, 'https://ghe.example.com');
  assert.equal(parseInvocationId('  https://github.com/acme/widget/actions/runs/7  ').runId, 7);
});

test('parseInvocationId refuses anything that is not a run URL', () => {
  for (const bad of [
    '',
    'not a url',
    'https://github.com/acme/widget',
    'https://github.com/acme/widget/actions/workflows/ci.yml',
    'https://github.com/acme/widget/actions/runs/abc',
    'ftp://github.com/acme/widget/actions/runs/7',
    'https://github.com/acme/widget/actions/runs/99999999999999999999',
  ]) {
    assert.equal(parseInvocationId(bad), null, bad);
  }
});

test('package specs parse with and without a scope or version', () => {
  assert.deepEqual(parsePackageSpec('runner-drift'), { name: 'runner-drift', version: null });
  assert.deepEqual(parsePackageSpec('runner-drift@1.2.1'), { name: 'runner-drift', version: '1.2.1' });
  assert.deepEqual(parsePackageSpec('@actions/core'), { name: '@actions/core', version: null });
  assert.deepEqual(parsePackageSpec('@actions/core@3.0.1'), { name: '@actions/core', version: '3.0.1' });
});

test('a package name that could walk the URL is rejected', () => {
  for (const bad of ['../evil', '.hidden', '_private', 'a b', 'a/b/c', '']) {
    assert.throws(() => assertPackageName(bad), RegistryError, bad);
  }
});

test('a scoped name is URL-encoded in both endpoints', () => {
  assert.equal(packumentUrl(REGISTRY, '@actions/core'), `${REGISTRY}/%40actions%2Fcore`);
  assert.equal(
    attestationsUrl(REGISTRY, '@actions/core', '3.0.1'),
    `${REGISTRY}/-/npm/v1/attestations/%40actions%2Fcore%403.0.1`,
  );
  assert.equal(
    attestationsUrl(REGISTRY, 'runner-drift', '1.2.1'),
    `${REGISTRY}/-/npm/v1/attestations/runner-drift%401.2.1`,
  );
});

// ------------------------------------------------------------- the bundle

test('the run comes out of a real recorded bundle', () => {
  const { run, note } = extractRunPointer(ATT_121);
  assert.equal(note, null);
  assert.equal(run.owner, 'Booyaka101');
  assert.equal(run.repo, 'runner-drift');
  assert.equal(run.runId, RUN_121);
  assert.equal(run.attempt, 1);
  assert.equal(extractRunPointer(ATT_120).run.runId, RUN_120);
});

test('a bundle from another repository is read the same way', () => {
  const { run } = extractRunPointer(CORE_ATT);
  assert.equal(`${run.owner}/${run.repo}`, 'actions/toolkit');
  assert.equal(run.runId, 24743632039);
});

test('a real SLSA v0.2 bundle resolves, since the oldest runs are the ones at risk', () => {
  assert.deepEqual(
    V02_ATT.attestations.map((a) => a.predicateType).sort(),
    [NPM_PUBLISH_PREDICATE, SLSA_V02_PREDICATE].sort(),
  );
  const { run, note } = extractRunPointer(V02_ATT);
  assert.equal(note, null);
  assert.equal(`${run.owner}/${run.repo}`, 'sigstore/sigstore-js');
  assert.equal(run.runId, 7837180521);
  assert.equal(run.attempt, 1);
  assert.equal(run.url, 'https://github.com/sigstore/sigstore-js/actions/runs/7837180521/attempts/1');
});

test('a v0.2 bundle with no environment block falls back to the git remote and the build id', () => {
  const bare = {
    attestations: [
      {
        predicateType: SLSA_V02_PREDICATE,
        bundle: {
          dsseEnvelope: {
            payload: payload({
              predicateType: SLSA_V02_PREDICATE,
              predicate: {
                invocation: { configSource: { uri: 'git+https://ghe.example.com/acme/widget@refs/heads/main' } },
                metadata: { buildInvocationId: '99-3' },
              },
            }),
          },
        },
      },
    ],
  };
  const { run, note } = extractRunPointer(bare);
  assert.equal(note, null);
  assert.equal(run.host, 'https://ghe.example.com');
  assert.equal(run.url, 'https://ghe.example.com/acme/widget/actions/runs/99/attempts/3');
  assert.equal(`${run.owner}/${run.repo}`, 'acme/widget');
  assert.equal(run.runId, 99);
  assert.equal(run.attempt, 3);
});

test('a v0.2 remote with a .git suffix and a junk run id still resolve', () => {
  const doc = {
    attestations: [
      {
        predicateType: SLSA_V02_PREDICATE,
        bundle: {
          dsseEnvelope: {
            payload: payload({
              predicateType: SLSA_V02_PREDICATE,
              predicate: {
                invocation: {
                  configSource: { uri: 'git+https://github.com/acme/widget.git@refs/tags/v1' },
                  // A run id that does not parse falls through to the build id
                  // rather than reporting the whole statement as unreadable.
                  environment: { GITHUB_RUN_ID: 'not-a-number' },
                },
                metadata: { buildInvocationId: '5000000453-2' },
              },
            }),
          },
        },
      },
    ],
  };
  const { run, note } = extractRunPointer(doc);
  assert.equal(note, null);
  assert.equal(`${run.owner}/${run.repo}`, 'acme/widget');
  assert.equal(run.runId, 5000000453);
  assert.equal(run.attempt, 2);
});

test('a v0.2 bundle that names no run says so rather than claiming one', () => {
  const empty = {
    attestations: [
      {
        predicateType: SLSA_V02_PREDICATE,
        bundle: {
          dsseEnvelope: {
            payload: payload({ predicateType: SLSA_V02_PREDICATE, predicate: { invocation: {}, metadata: {} } }),
          },
        },
      },
    ],
  };
  const { run, note } = extractRunPointer(empty);
  assert.equal(run, null);
  assert.match(note, /v0\.2 statement names no Actions run/);
});

test('the recorded bundle really does carry npm publish alongside SLSA', () => {
  const types = ATT_121.attestations.map((a) => a.predicateType).sort();
  assert.deepEqual(types, [NPM_PUBLISH_PREDICATE, SLSA_PREDICATE].sort());
});

const payload = (statement) => Buffer.from(JSON.stringify(statement), 'utf8').toString('base64');
const slsaBundle = (statement) => ({
  attestations: [{ predicateType: SLSA_PREDICATE, bundle: { dsseEnvelope: { payload: payload(statement) } } }],
});

test('every broken bundle gets a reason instead of a throw', () => {
  const cases = [
    [null, /attestations document is empty/],
    [{}, /attestations document is empty/],
    [{ attestations: [] }, /attestations document is empty/],
    [
      { attestations: [{ predicateType: NPM_PUBLISH_PREDICATE, bundle: {} }] },
      /no SLSA provenance statement in the bundle \(only npm publish\)/,
    ],
    [
      { attestations: [{ predicateType: 'https://example.test/other', bundle: {} }] },
      /^no SLSA provenance statement in the bundle$/,
    ],
    [{ attestations: [{ predicateType: SLSA_PREDICATE, bundle: {} }] }, /DSSE envelope carries no payload/],
    [
      { attestations: [{ predicateType: SLSA_PREDICATE, bundle: { dsseEnvelope: { payload: '!!!not base64!!!' } } }] },
      /DSSE payload is not base64-encoded JSON/,
    ],
    [slsaBundle({ predicate: {} }), /no runDetails\.metadata\.invocationId/],
    [
      slsaBundle({ predicate: { runDetails: { metadata: { invocationId: '' } } } }),
      /no runDetails\.metadata\.invocationId/,
    ],
    [
      slsaBundle({ predicate: { runDetails: { metadata: { invocationId: 'https://gitlab.example/pipelines/7' } } } }),
      /invocationId is not an Actions run URL: https:\/\/gitlab\.example\/pipelines\/7/,
    ],
  ];
  for (const [doc, pattern] of cases) {
    const { run, note } = extractRunPointer(doc);
    assert.equal(run, null);
    assert.match(note, pattern);
  }
});

// -------------------------------------------------------------- collecting

test('collectProvenance asks only about the versions the packument advertises', async () => {
  const reg = fakeRegistry(runnerDriftRoutes());
  const collected = await collectProvenance('runner-drift', reg);

  assert.equal(collected.package, 'runner-drift');
  assert.equal(collected.versions.length, 6);
  // Newest publish first, so the table reads the way npm's own listing does.
  assert.deepEqual(
    collected.versions.map((v) => v.version),
    ['1.2.1', '1.2.0', '1.1.0', '1.0.2', '1.0.1', '1.0.0'],
  );
  assert.equal(collected.versions.filter((v) => v.hasAttestation).length, 2);
  assert.equal(collected.versions[0].run.runId, RUN_121);
  assert.equal(collected.versions[1].run.runId, RUN_120);
  assert.equal(collected.versions[2].run, null);
  assert.equal(collected.versions[0].publishedAt, '2026-09-09T03:33:11.528Z');

  // One packument plus one attestation per advertised version, not six probes.
  assert.equal(reg.calls.length, 3);
  assert.deepEqual(referencedRepos(collected), ['Booyaka101/runner-drift']);
});

test('--probe-all asks about every version instead', async () => {
  const reg = fakeRegistry(runnerDriftRoutes());
  const collected = await collectProvenance('runner-drift', { ...reg, probeAll: true });
  assert.equal(reg.calls.length, 7);
  assert.equal(collected.versions.filter((v) => v.hasAttestation).length, 2);
  // A version that never had an attestation is not an error worth a note.
  assert.equal(collected.versions.find((v) => v.version === '1.0.0').note, null);
});

test('a 404 from the attestations endpoint is reported for that version alone', async () => {
  const routes = runnerDriftRoutes();
  delete routes[`${REGISTRY}/-/npm/v1/attestations/runner-drift%401.2.0`];
  const collected = await collectProvenance('runner-drift', fakeRegistry(routes));

  const broken = collected.versions.find((v) => v.version === '1.2.0');
  assert.equal(broken.hasAttestation, false);
  assert.equal(broken.run, null);
  assert.match(broken.note, /returned 404 for this version/);
  assert.equal(collected.versions.find((v) => v.version === '1.2.1').run.runId, RUN_121);
});

test('a version pin collects just that version', async () => {
  const collected = await collectProvenance('runner-drift@1.2.0', fakeRegistry(runnerDriftRoutes()));
  assert.deepEqual(
    collected.versions.map((v) => v.version),
    ['1.2.0'],
  );
  assert.equal(collected.versions[0].run.runId, RUN_120);
});

test('an unknown package and an unknown version both say so plainly', async () => {
  const reg = fakeRegistry(runnerDriftRoutes());
  await assert.rejects(
    () => collectProvenance('no-such-package-here', reg),
    (err) => {
      assert.ok(err instanceof RegistryError);
      assert.equal(err.status, 404);
      assert.match(err.message, /no package named "no-such-package-here"/);
      return true;
    },
  );
  await assert.rejects(() => collectProvenance('runner-drift@9.9.9', reg), /runner-drift has no version 9\.9\.9/);
});

test('--registry points every request at the mirror, including the attestations', async () => {
  const mirror = 'https://npm.internal.example/proxy';
  const reg = fakeRegistry({
    [`${mirror}/runner-drift`]: PACKUMENT,
    [`${mirror}/-/npm/v1/attestations/runner-drift%401.2.0`]: ATT_120,
    [`${mirror}/-/npm/v1/attestations/runner-drift%401.2.1`]: ATT_121,
  });
  // The packument names registry.npmjs.org in dist.attestations.url; the mirror wins.
  const collected = await collectProvenance('runner-drift', { ...reg, registry: `${mirror}/` });
  assert.equal(collected.registry, mirror);
  assert.equal(collected.versions[0].run.runId, RUN_121);
  assert.ok(
    reg.calls.every((c) => c.startsWith(mirror)),
    reg.calls.join('\n'),
  );
});

test('a registry that serves HTML is an error, not a crash', async () => {
  const reg = fakeRegistry({
    [`${REGISTRY}/runner-drift`]: () => new Response('<html>proxy login</html>', { status: 200 }),
  });
  await assert.rejects(() => collectProvenance('runner-drift', reg), /something that is not JSON/);
});

test('a 503 is retried, and retry-after is honoured', async () => {
  let waited = 0;
  const reg = fakeRegistry({
    ...runnerDriftRoutes(),
    [`${REGISTRY}/runner-drift`]: (n) =>
      n < 3 ? new Response('upstream', { status: 503, headers: { 'retry-after': '2' } }) : ok(PACKUMENT),
  });
  const collected = await collectProvenance('runner-drift', {
    ...reg,
    sleep: async (ms) => {
      waited += ms;
    },
  });
  assert.equal(collected.versions.length, 6);
  assert.equal(waited, 4000);
});

test('a registry that never answers gives a message, not a stack trace', async () => {
  let tries = 0;
  const fetchImpl = async () => {
    tries++;
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    () => collectProvenance('runner-drift', { fetchImpl, sleep: async () => {} }),
    (err) => {
      assert.ok(err instanceof RegistryError);
      assert.equal(err.status, null);
      assert.match(err.message, /could not reach .*fetch failed.*Check your network or proxy settings/s);
      return true;
    },
  );
  assert.equal(tries, 3);
});

test('a 403 is raised with the body the registry sent', async () => {
  const reg = fakeRegistry({
    [`${REGISTRY}/runner-drift`]: () => new Response('{"error":"payment required"}', { status: 403, headers: json }),
  });
  await assert.rejects(() => collectProvenance('runner-drift', reg), /returned 403 .*payment required/s);
});

// --------------------------------------------------------------- resolving

async function resolveRunnerDrift({ archiveDir, scope = { owner: 'Booyaka101', repo: 'runner-drift' }, window = WINDOW }) {
  const collected = await collectProvenance('runner-drift', fakeRegistry(runnerDriftRoutes()));
  const archive = archiveDir === null ? null : await openArchive(archiveDir);
  return resolveProvenance({ collected, archive, scope, window });
}

test('an archived run reads as archived and a missing one as missing', async () => {
  const dir = await makeArchive({ runs: [runRecord(RUN_121)] });
  try {
    const result = await resolveRunnerDrift({ archiveDir: dir });
    assert.equal(result.versions, 6);
    assert.equal(result.withProvenance, 2);
    assert.equal(result.counts.noProvenance, 4);
    assert.equal(result.counts.archived, 1);
    assert.equal(result.counts.missing, 1);

    const archived = result.reports.find((r) => r.version === '1.2.1');
    assert.equal(archived.state, 'archived');
    assert.equal(archived.runCreatedAt, '2026-09-09T03:30:00Z');
    assert.equal(archived.atRisk, false);

    const missing = result.reports.find((r) => r.version === '1.2.0');
    assert.equal(missing.state, 'missing');
    assert.equal(missing.runCreatedAt, null);
    // Published 02:58, cutoff 03:00, so the retention change takes this one.
    assert.equal(missing.deleted, true);
    assert.equal(missing.atRisk, true);
    assert.equal(result.unarchivedAtRisk, 1);
    assert.equal(result.unarchivedLater, 0);
    assert.equal(result.repo, 'Booyaka101/runner-drift');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unarchived run that survives the change counts as later, not at risk', async () => {
  const dir = await makeArchive({ runs: [runRecord(RUN_121)] });
  try {
    const result = await resolveRunnerDrift({
      archiveDir: dir,
      window: { ...WINDOW, cutoffIso: '2026-06-15T00:00:00Z' },
    });
    const missing = result.reports.find((r) => r.version === '1.2.0');
    assert.equal(missing.state, 'missing');
    assert.equal(missing.deleted, false);
    assert.equal(missing.atRisk, false);
    assert.equal(result.unarchivedAtRisk, 0);
    assert.equal(result.unarchivedLater, 1);

    // Nothing is due on the date itself, which must not read as "all archived".
    const text = formatProvenance(result, 'actions-attic backfill');
    assert.match(text, /1 run survives 2026-10-01 and ages out of the retention window/);
    assert.doesNotMatch(text, /is in the attic\./);
    assert.match(text, /^1[.]2[.]0 .* no {8}later$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run older than the backfill reaches is before-archive, not missing', async () => {
  const dir = await makeArchive({
    oldest: '2026-10',
    runs: [runRecord(RUN_121, { created_at: '2026-10-02T00:00:00Z' })],
  });
  try {
    const result = await resolveRunnerDrift({ archiveDir: dir });
    const early = result.reports.find((r) => r.version === '1.2.0');
    assert.equal(early.state, 'before-archive');
    assert.match(early.note, /published before 2026-10, the oldest month the backfill has reached/);
    assert.equal(result.counts.beforeArchive, 1);
    assert.equal(result.counts.missing, 0);
    assert.equal(result.archiveOldestMonth, '2026-10');
    assert.match(formatProvenance(result, 'x'), /predates 2026-10.*Raise --months to go further back/s);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an archived run under a different attempt says which attempts are held', async () => {
  const dir = await makeArchive({
    runs: [runRecord(RUN_121, { run_attempt: 2 }), runRecord(RUN_121, { run_attempt: 3 })],
  });
  try {
    const collected = await collectProvenance('runner-drift@1.2.1', fakeRegistry(runnerDriftRoutes()));
    const result = await resolveProvenance({
      collected,
      archive: await openArchive(dir),
      scope: { owner: 'Booyaka101', repo: 'runner-drift' },
      window: WINDOW,
    });
    const report = result.reports[0];
    assert.equal(report.state, 'missing');
    assert.equal(report.note, 'attempt 1 is not archived; the attic holds attempt 2, 3');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run in another repository is out of scope, never unarchived', async () => {
  const reg = fakeRegistry({
    [`${REGISTRY}/%40actions%2Fcore`]: CORE_PACKUMENT,
    [`${REGISTRY}/-/npm/v1/attestations/%40actions%2Fcore%403.0.1`]: CORE_ATT,
  });
  const collected = await collectProvenance('@actions/core@3.0.1', reg);
  const dir = await makeArchive({ runs: [runRecord(RUN_121)] });
  try {
    const result = await resolveProvenance({
      collected,
      archive: await openArchive(dir),
      scope: { owner: 'Booyaka101', repo: 'runner-drift' },
      window: WINDOW,
    });
    const report = result.reports[0];
    assert.equal(report.state, 'out-of-scope');
    assert.equal(report.atRisk, false);
    assert.equal(report.deleted, false);
    assert.equal(report.note, 'run belongs to actions/toolkit');
    assert.equal(result.unarchivedAtRisk, 0);
    assert.deepEqual(result.otherRepos, ['actions/toolkit']);
    assert.deepEqual(reg.calls, [
      `${REGISTRY}/%40actions%2Fcore`,
      `${REGISTRY}/-/npm/v1/attestations/%40actions%2Fcore%403.0.1`,
    ]);
    assert.match(formatProvenance(result, 'x'), /names a repository this archive does not cover \(actions\/toolkit\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the owner and repo compare case-insensitively', async () => {
  const dir = await makeArchive({ runs: [runRecord(RUN_121)] });
  try {
    const result = await resolveRunnerDrift({ archiveDir: dir, scope: { owner: 'booyaka101', repo: 'RUNNER-DRIFT' } });
    assert.equal(result.counts.outOfScope, 0);
    assert.equal(result.counts.archived, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('with no archive to compare against, nothing is claimed to be missing', async () => {
  const result = await resolveRunnerDrift({ archiveDir: null });
  assert.equal(result.counts.noArchive, 2);
  assert.equal(result.counts.missing, 0);
  assert.equal(result.unarchivedAtRisk, 0);
  assert.equal(result.archiveOldestMonth, null);
  assert.match(formatProvenance(result, 'actions-attic backfill <owner/repo>'), /no archive to compare against/);
});

test('an unreadable attestation is counted separately from a missing run', async () => {
  const routes = runnerDriftRoutes();
  routes[`${REGISTRY}/-/npm/v1/attestations/runner-drift%401.2.0`] = {
    attestations: [{ predicateType: NPM_PUBLISH_PREDICATE, bundle: { dsseEnvelope: { payload: 'e30=' } } }],
  };
  const collected = await collectProvenance('runner-drift', fakeRegistry(routes));
  const dir = await makeArchive({ runs: [runRecord(RUN_121)] });
  try {
    const result = await resolveProvenance({
      collected,
      archive: await openArchive(dir),
      scope: { owner: 'Booyaka101', repo: 'runner-drift' },
      window: WINDOW,
    });
    assert.equal(result.counts.unreadable, 1);
    assert.equal(result.counts.missing, 0);
    assert.equal(result.unarchivedAtRisk, 0);
    const report = result.reports.find((r) => r.version === '1.2.0');
    assert.equal(report.state, 'unreadable');
    assert.match(report.note, /only npm publish/);
    assert.match(formatProvenance(result, 'x'), /1 attestation could not be read/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a package with no provenance at all is reported, not treated as a failure', async () => {
  const noAttestations = {
    ...PACKUMENT,
    versions: Object.fromEntries(Object.keys(PACKUMENT.versions).map((v) => [v, {}])),
  };
  const collected = await collectProvenance(
    'runner-drift',
    fakeRegistry({ [`${REGISTRY}/runner-drift`]: noAttestations }),
  );
  const result = await resolveProvenance({ collected, archive: null, scope: null, window: WINDOW });

  assert.equal(result.withProvenance, 0);
  assert.equal(result.counts.noProvenance, 6);
  assert.equal(result.unarchivedAtRisk, 0);
  const text = formatProvenance(result, 'actions-attic backfill <owner/repo>');
  assert.match(text, /No published version of runner-drift carries provenance, so none of them names a workflow run\./);
  // Nothing to tabulate, so no table and no next-step nagging.
  assert.doesNotMatch(text, /at risk/);
  assert.doesNotMatch(text, /Run: /);
});

// -------------------------------------------------------------- formatting

test('the report tabulates the versions that carry provenance', async () => {
  const dir = await makeArchive({ runs: [runRecord(RUN_121)] });
  try {
    const result = await resolveRunnerDrift({ archiveDir: dir });
    const text = formatProvenance(result, 'actions-attic backfill Booyaka101/runner-drift --archive ./attic');

    assert.match(text, /^runner-drift: 6 published versions, 2 with provenance$/m);
    assert.match(text, /^retention window: 90 days \(GitHub default\)$/m);
    assert.match(text, /^from 2026-10-01, runs created before 2026-09-09T03:00:00Z are deleted$/m);
    const table = [
      'version  run                                     created     archived  at risk',
      '1.2.1    Booyaka101/runner-drift #34307443469/1  2026-09-09  yes       no',
      '1.2.0    Booyaka101/runner-drift #34305025325/1  2026-09-09  no        YES',
    ].join('\n');
    assert.ok(text.includes(table), text);
    assert.match(text, /1 provenance-referenced run is not in the attic and will be deleted on 2026-10-01\./);
    assert.match(text, /^Run: actions-attic backfill Booyaka101\/runner-drift --archive \.\/attic$/m);
    // Versions published without provenance stay out of the way until asked for.
    assert.doesNotMatch(text, /^1\.1\.0/m);
    assert.ok(
      formatProvenance(result, 'x', true).includes(
        '1.1.0    -                                       2026-08-12  -         -',
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the shared note filter keeps the skipped versions and drops the noise', async () => {
  const routes = runnerDriftRoutes();
  delete routes[`${REGISTRY}/-/npm/v1/attestations/runner-drift%401.2.0`];
  const collected = await collectProvenance('runner-drift', fakeRegistry(routes));
  // Scoped elsewhere, so 1.2.1 is out of scope and its note only repeats the row.
  const result = await resolveProvenance({
    collected,
    archive: null,
    scope: { owner: 'acme', repo: 'widget' },
    window: WINDOW,
  });
  assert.deepEqual(
    notesFor(result).map((r) => r.version),
    ['1.2.0'],
  );
  // The job summary reads the same list, which is how it stopped listing one
  // "run belongs to ..." line per version of a package built elsewhere.
  assert.equal(
    result.reports.filter((r) => r.note).length > notesFor(result).length,
    true,
  );
});

test('a version npm advertises and then 404s is named, not silently dropped', async () => {
  const routes = runnerDriftRoutes();
  delete routes[`${REGISTRY}/-/npm/v1/attestations/runner-drift%401.2.0`];
  const collected = await collectProvenance('runner-drift', fakeRegistry(routes));
  const result = await resolveProvenance({ collected, archive: null, scope: null, window: WINDOW });

  // It counts as no-provenance, so the table skips it; the note is the only
  // thing telling you a version was advertised and then not served.
  assert.equal(result.counts.noProvenance, 5);
  const text = formatProvenance(result, 'actions-attic backfill <owner/repo>');
  assert.match(text, /^1\.2\.0: the attestations endpoint returned 404 for this version$/m);
});

test('everything archived says so and asks for nothing', async () => {
  const dir = await makeArchive({
    runs: [runRecord(RUN_121), runRecord(RUN_120, { created_at: '2026-09-09T02:55:00Z' })],
  });
  try {
    const result = await resolveRunnerDrift({ archiveDir: dir });
    assert.equal(result.unarchivedAtRisk, 0);
    const text = formatProvenance(result, 'actions-attic backfill Booyaka101/runner-drift');
    assert.match(text, /Every provenance-referenced run for Booyaka101\/runner-drift is in the attic\./);
    assert.doesNotMatch(text, /Run: /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------- CLI

/** The fixture registry over real HTTP, so the CLI's own fetch is exercised. */
async function serveRegistry(routes) {
  const server = createServer((req, res) => {
    const body = routes[req.url];
    if (body === undefined) {
      res.writeHead(404, json).end('{"error":"Not found"}');
      return;
    }
    res.writeHead(200, json).end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((d) => server.close(d)) };
}

const SERVED = {
  '/runner-drift': PACKUMENT,
  '/-/npm/v1/attestations/runner-drift%401.2.0': ATT_120,
  '/-/npm/v1/attestations/runner-drift%401.2.1': ATT_121,
};

/** No PATH and no token: a real GitHub call or a git shell-out would fail loudly. */
async function attic(args) {
  const env = { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '', ACTIONS_ATTIC_TOKEN: '', PATH: '', NPM_CONFIG_REGISTRY: '' };
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], { cwd: root, env, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('the provenance command reports, and only fails when asked to', async () => {
  const server = await serveRegistry(SERVED);
  const dir = await makeArchive({ runs: [runRecord(RUN_121)] });
  try {
    const args = ['provenance', 'runner-drift', '--archive', dir, '--registry', server.url, '--retention-days', '1'];
    const res = await attic(args);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /runner-drift: 6 published versions, 2 with provenance/);
    assert.match(res.stdout, /Booyaka101\/runner-drift #34305025325\/1/);
    assert.match(res.stdout, /1 provenance-referenced run is not in the attic/);
    // The repository came from the archive manifest, so --repo was not needed.
    assert.match(res.stdout, /Run: actions-attic backfill Booyaka101\/runner-drift --archive /);

    const failing = await attic([...args, '--fail-on-unarchived']);
    assert.equal(failing.code, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await server.close();
  }
});

test('a version with no publish date counts as due, not as safe', async () => {
  const collected = {
    package: 'runner-drift',
    registry: REGISTRY,
    versions: [
      // A mirror packument without a `time` map. fetchPackument tolerates that,
      // so the resolver has to decide what an unknown date means.
      { version: '1.2.1', publishedAt: null, hasAttestation: true, run: extractRunPointer(ATT_121).run, note: null },
    ],
  };
  const result = await resolveProvenance({ collected, archive: null, scope: null, window: WINDOW });
  const [report] = result.reports;
  assert.equal(report.deleted, true);
  assert.match(report.note, /no publish date on this registry/);
});

test('--fail-on-unarchived refuses to pass when there is no archive to check', async () => {
  const server = await serveRegistry(SERVED);
  try {
    const res = await attic([
      'provenance',
      'runner-drift',
      '--registry',
      server.url,
      '--retention-days',
      '1',
      '--fail-on-unarchived',
    ]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /--fail-on-unarchived has nothing to check against/);
  } finally {
    await server.close();
  }
});

test('--repo with no value is a usage error, not a silently ignored flag', async () => {
  const server = await serveRegistry(SERVED);
  try {
    const res = await attic(['provenance', 'runner-drift', '--registry', server.url, '--repo']);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /--repo needs a value/);
  } finally {
    await server.close();
  }
});

test('an archive with no repository yet still names one, from the provenance', async () => {
  const server = await serveRegistry(SERVED);
  const dir = await mkdtemp(join(tmpdir(), 'attic-prov-empty-'));
  try {
    const res = await attic([
      'provenance',
      'runner-drift',
      '--archive',
      dir,
      '--registry',
      server.url,
      '--retention-days',
      '1',
    ]);
    assert.equal(res.code, 0);
    // A fresh archive has no repo in its manifest, so the next step used to read
    // `backfill <owner/repo>`, which is not a command anyone can paste.
    assert.match(res.stdout, /Run: actions-attic backfill Booyaka101\/runner-drift --archive /);
    assert.doesNotMatch(res.stdout, /<owner\/repo>/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await server.close();
  }
});

test('--json prints the structured result and nothing else', async () => {
  const server = await serveRegistry(SERVED);
  const dir = await makeArchive({ runs: [runRecord(RUN_121)] });
  try {
    const res = await attic([
      'provenance',
      'runner-drift',
      '--archive',
      dir,
      '--registry',
      server.url,
      '--retention-days',
      '1',
      '--json',
    ]);
    assert.equal(res.code, 0);
    const result = JSON.parse(res.stdout);
    assert.equal(result.package, 'runner-drift');
    assert.equal(result.repo, 'Booyaka101/runner-drift');
    assert.equal(result.retentionSource, 'flag');
    assert.equal(result.unarchivedAtRisk, 1);
    assert.equal(result.reports.find((r) => r.version === '1.2.1').run.runId, RUN_121);
    assert.doesNotMatch(res.stdout, /published versions/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await server.close();
  }
});

test('a package with no provenance exits 0 from the CLI too', async () => {
  const versions = Object.fromEntries(Object.keys(PACKUMENT.versions).map((v) => [v, {}]));
  const server = await serveRegistry({ '/runner-drift': { ...PACKUMENT, versions } });
  const dir = await makeArchive({ runs: [] });
  try {
    const res = await attic([
      'provenance',
      'runner-drift',
      '--archive',
      dir,
      '--registry',
      server.url,
      '--fail-on-unarchived',
    ]);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /No published version of runner-drift carries provenance/);
    // No token and no --retention-days, so it falls back to the platform default.
    assert.match(res.stderr, /no GitHub token, so the repository's own retention setting could not be read/);
    assert.match(res.stdout, /^retention window: 90 days \(GitHub default\)$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await server.close();
  }
});

test('an unknown package is a clear message, not a stack trace', async () => {
  const server = await serveRegistry(SERVED);
  try {
    const res = await attic(['provenance', 'nope-not-here', '--registry', server.url]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /no package named "nope-not-here"/);
    assert.doesNotMatch(res.stderr, /at Object\./);
  } finally {
    await server.close();
  }
});

test('provenance without a package is a usage error', async () => {
  const res = await attic(['provenance']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /provenance needs a package/);
});

test('--repo overrides what the archive claims, so another repo reads as out of scope', async () => {
  const server = await serveRegistry(SERVED);
  const dir = await makeArchive({ runs: [runRecord(RUN_121)] });
  try {
    const res = await attic([
      'provenance',
      'runner-drift',
      '--archive',
      dir,
      '--registry',
      server.url,
      '--repo',
      'acme/widget',
      '--json',
    ]);
    assert.equal(res.code, 0);
    const result = JSON.parse(res.stdout);
    assert.equal(result.repo, 'acme/widget');
    assert.equal(result.counts.outOfScope, 2);
    assert.equal(result.unarchivedAtRisk, 0);
    assert.deepEqual(result.otherRepos, ['Booyaka101/runner-drift']);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await server.close();
  }
});
