import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Archive, SCHEMA_VERSION, parseJsonl } from '../lib/archive.js';
import { FsBackend, gitBlobSha } from '../lib/backend.js';
import { archiveMonths, buildIndex, indexCounts } from '../lib/index.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'archive');

test('gitBlobSha matches git\'s own object id', () => {
  // `git hash-object -t blob /dev/null` and `echo -n hello | git hash-object --stdin`
  assert.equal(gitBlobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(gitBlobSha('hello'), 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
});

test('the SQLite index row counts match the JSONL line counts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'attic-db-'));
  try {
    const db = join(dir, 'attic.db');
    const result = buildIndex(FIXTURE, db);

    const lines = { runs: 0, checks: 0, statuses: 0 };
    for (const kind of ['runs', 'checks', 'statuses']) {
      for (const month of archiveMonths(FIXTURE, kind)) {
        lines[kind] += parseJsonl(readFileSync(join(FIXTURE, kind, `${month}.jsonl`), 'utf8'), 'fixture').length;
      }
    }

    assert.deepEqual({ runs: result.runs, checks: result.checks, statuses: result.statuses }, lines);
    assert.deepEqual(indexCounts(db), lines);
    assert.equal(lines.runs, 454);
    assert.ok(result.months.includes('2026-06'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a re-attempt survives the index as its own row', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'attic-db-'));
  try {
    const db = join(dir, 'attic.db');
    buildIndex(FIXTURE, db);
    const { DatabaseSync } = await import('node:sqlite');
    const handle = new DatabaseSync(db, { readOnly: true });
    const rows = handle.prepare('SELECT run_attempt FROM runs WHERE head_sha = ? ORDER BY run_attempt').all('a'.repeat(40));
    handle.close();
    assert.deepEqual(rows.map((r) => r.run_attempt), [1, 2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the manifest counts agree with what is on disk', async () => {
  const archive = await Archive.open(await FsBackend.open(FIXTURE), 'acme/widget');
  assert.equal(archive.manifest.counts.runs, (await archive.readAll('runs')).length);
  assert.equal(archive.manifest.counts.checks, (await archive.readAll('checks')).length);
  assert.equal(archive.manifest.backfillFrontier, null);
});

// The fixture archive is the one 1.3.0 wrote: schemaVersion 1 on disk, and run
// records with neither `path` nor `display_title`. 1.4.0 has to read it as it
// stands, without a rewalk.
test('a schemaVersion 1 archive still reads, with the schema 2 fields null', async () => {
  assert.equal(JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8')).schemaVersion, 1);
  const onDisk = parseJsonl(readFileSync(join(FIXTURE, 'runs', '2025-08.jsonl'), 'utf8'), 'fixture');
  assert.ok(!('path' in onDisk[0]), 'the fixture must stay schema 1 on disk');

  const archive = await Archive.open(await FsBackend.open(FIXTURE), 'acme/widget');
  assert.equal(archive.manifest.schemaVersion, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 2);

  const runs = await archive.readAll('runs');
  assert.equal(runs.length, 454);
  for (const run of runs) {
    assert.equal(run.path, null);
    assert.equal(run.display_title, null);
  }
  assert.equal(runs[0].id, 5000000451);
  assert.equal(runs[0].name, 'build-linux');
});

test('a schema 2 record round-trips both new fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'attic-schema2-'));
  try {
    const record = {
      id: 34307443469,
      name: 'release',
      created_at: '2026-09-09T10:00:00Z',
      head_sha: 'f'.repeat(40),
      run_attempt: 1,
      path: '.github/workflows/release.yml',
      display_title: 'Release 1.2.1',
    };
    const backend = await FsBackend.open(dir);
    const archive = await Archive.open(backend, 'acme/widget');
    assert.equal(await archive.add('runs', [record], '2026-09'), 1);
    await archive.finalize('seed');

    const reopened = await Archive.open(await FsBackend.open(dir), 'acme/widget');
    assert.equal(reopened.manifest.schemaVersion, 2);
    const [stored] = await reopened.read('runs', '2026-09');
    assert.equal(stored.path, '.github/workflows/release.yml');
    assert.equal(stored.display_title, 'Release 1.2.1');
    assert.deepEqual((await reopened.runAttempts(34307443469)).map((r) => r.run_attempt), [1]);
    assert.deepEqual(await reopened.runAttempts(1), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runAttempts finds every attempt of one id across the archive', async () => {
  const archive = await Archive.open(await FsBackend.open(FIXTURE), 'acme/widget');
  const attempts = await archive.runAttempts(5000000453);
  assert.deepEqual(attempts.map((r) => r.run_attempt), [1, 2]);
  assert.equal(attempts[0].head_sha, 'a'.repeat(40));
  assert.deepEqual(await archive.runAttempts(999), []);
});

test('a corrupt JSONL line names the file and line number', () => {
  assert.throws(() => parseJsonl('{"a":1}\nnot json\n', 'runs/2026-01.jsonl'), /runs\/2026-01\.jsonl:2/);
});

test('a manifest from a newer schema refuses to load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'attic-schema-'));
  try {
    const backend = await FsBackend.open(dir);
    backend.write('manifest.json', JSON.stringify({ schemaVersion: 99 }));
    await backend.commit('seed');
    await assert.rejects(Archive.open(await FsBackend.open(dir), 'acme/widget'), /newer than this build/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writing identical content twice does not report a change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'attic-fs-'));
  try {
    const backend = await FsBackend.open(dir);
    backend.write('runs/2026-01.jsonl', '{"id":1}\n');
    assert.deepEqual((await backend.commit('one')).changed, ['runs/2026-01.jsonl']);
    backend.write('runs/2026-01.jsonl', '{"id":1}\n');
    assert.equal(await backend.commit('two'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
