import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Archive, parseJsonl } from '../lib/archive.js';
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
  assert.equal(archive.manifest.schemaVersion, 1);
  assert.equal(archive.manifest.backfillFrontier, null);
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
