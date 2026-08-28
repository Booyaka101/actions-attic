import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api } from '../lib/api.js';
import { RefBackend, normalizeRef } from '../lib/backend.js';
import { makeGitServer } from './helpers/fake-git.mjs';

const quiet = () => {};

function apiFor(fetchImpl) {
  return new Api({ token: 't', maxRequests: 5000, fetchImpl, log: quiet, warn: quiet, sleep: async () => {} });
}

test('the first commit creates the ref with no parents', async () => {
  const git = makeGitServer();
  const backend = await RefBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'actions-attic');
  assert.equal(backend.isNew, true);

  backend.write('manifest.json', '{"schemaVersion":1}\n');
  backend.write('runs/2026-08.jsonl', '{"id":1}\n');
  const result = await backend.commit('attic: first');

  assert.deepEqual(result.changed, ['manifest.json', 'runs/2026-08.jsonl']);
  assert.equal(git.refs.get('heads/actions-attic'), result.sha);
  assert.deepEqual(git.commits.get(result.sha).parents, [], 'orphan history: no parent commit');
});

test('unchanged content uploads no blobs and makes no commit', async () => {
  const git = makeGitServer();
  const backend = await RefBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'actions-attic');
  backend.write('manifest.json', '{"a":1}\n');
  assert.ok(await backend.commit('one'));
  const uploads = git.state.blobUploads;
  const commits = git.state.commits;

  const second = await RefBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'actions-attic');
  second.write('manifest.json', '{"a":1}\n');
  assert.equal(await second.commit('two'), null);
  assert.equal(git.state.blobUploads, uploads, 'no blob re-upload for identical content');
  assert.equal(git.state.commits, commits, 'no empty commit');
});

test('content written to the ref reads back through the blob API', async () => {
  const git = makeGitServer();
  const first = await RefBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'actions-attic');
  first.write('runs/2026-08.jsonl', '{"id":7}\n');
  await first.commit('seed');

  const second = await RefBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'actions-attic');
  assert.deepEqual(second.paths(), ['runs/2026-08.jsonl']);
  assert.equal(await second.read('runs/2026-08.jsonl'), '{"id":7}\n');
  assert.equal(await second.read('runs/2025-01.jsonl'), null);
});

test('a 422 race on ref creation is retried once and succeeds', async () => {
  const git = makeGitServer({ failRefCreate: 1 });
  const warnings = [];
  const backend = await RefBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'actions-attic', {
    warn: (m) => warnings.push(m),
  });
  backend.write('manifest.json', '{"a":1}\n');
  const result = await backend.commit('attic: first');

  assert.ok(result, 'the retry must land the commit');
  assert.ok(warnings.some((w) => /moved under us/.test(w)), warnings.join('\n'));
  assert.equal(git.refs.get('heads/actions-attic'), result.sha);
  assert.ok(git.commits.get(result.sha).parents.length === 1, 'the retry rebases onto the winning commit');
});

test('a second failure to update the ref is loud, not silent', async () => {
  const git = makeGitServer({ refCreateAlwaysFails: true });
  const backend = await RefBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'actions-attic', { warn: quiet });
  backend.write('manifest.json', '{"a":1}\n');
  await assert.rejects(backend.commit('attic: racing'), /could not update refs\/heads\/actions-attic after one retry/);
  assert.equal(git.state.refCreateAttempts, 2, 'exactly one retry');
});

test('a bare name is a branch, anything under refs/ is taken as written', () => {
  assert.equal(normalizeRef('actions-attic'), 'refs/heads/actions-attic');
  assert.equal(normalizeRef('refs/attic/archive'), 'refs/attic/archive');
  assert.equal(normalizeRef('  refs/attic/archive/  '), 'refs/attic/archive');
  assert.equal(normalizeRef('refs/heads/my/archive'), 'refs/heads/my/archive');
  assert.throws(() => normalizeRef(''), /must not be empty/);
  assert.throws(() => normalizeRef('refs/oops'), /refs\/<namespace>\/<name>/);
});

test('the default ref is written outside refs/heads, so it is not a branch', async () => {
  const git = makeGitServer();
  const backend = await RefBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'refs/attic/archive');
  backend.write('manifest.json', '{"schemaVersion":1}\n');
  const result = await backend.commit('attic: first');

  assert.ok(result);
  assert.equal(git.refs.get('attic/archive'), result.sha);
  assert.equal(git.refs.get('heads/actions-attic'), undefined, 'nothing was written under refs/heads/');
  assert.deepEqual([...git.refs.keys()], ['attic/archive']);
});

test('an existing archive on a custom ref reads back', async () => {
  const git = makeGitServer();
  const first = await RefBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'refs/attic/archive');
  first.write('runs/2026-08.jsonl', '{"id":7}\n');
  await first.commit('seed');

  const second = await RefBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'refs/attic/archive');
  assert.equal(second.isNew, false);
  assert.equal(await second.read('runs/2026-08.jsonl'), '{"id":7}\n');
  assert.equal(second.ref, 'refs/attic/archive');
});

test('two archives on different refs in one repo do not see each other', async () => {
  const git = makeGitServer();
  const a = await RefBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'refs/attic/archive');
  a.write('runs/2026-08.jsonl', '{"id":1}\n');
  await a.commit('a');

  const b = await RefBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'refs/attic/other');
  assert.equal(b.isNew, true, 'a second ref starts empty');
  b.write('runs/2026-08.jsonl', '{"id":2}\n');
  await b.commit('b');

  const reread = await RefBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'refs/attic/archive');
  assert.equal(await reread.read('runs/2026-08.jsonl'), '{"id":1}\n');
});
