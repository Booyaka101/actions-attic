import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api } from '../lib/api.js';
import { BranchBackend, gitBlobSha } from '../lib/backend.js';

const quiet = () => {};

/** In-memory Git Data API: refs, commits, trees and blobs, nothing else. */
function makeGitServer({ failRefCreate = 0, refCreateAlwaysFails = false } = {}) {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const refs = new Map();
  const state = { refCreateAttempts: 0, blobUploads: 0, commits: 0 };
  let counter = 0;
  const id = (prefix) => `${prefix}${String(++counter).padStart(36, '0')}`;

  const ok = (body) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' },
    });
  const fail = (status, message) =>
    new Response(JSON.stringify({ message }), {
      status,
      headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' },
    });

  async function fetchImpl(rawUrl, init = {}) {
    const url = new URL(rawUrl);
    const path = url.pathname.replace('/repos/acme/widget/git', '');
    const body = init.body ? JSON.parse(init.body) : null;
    const method = init.method ?? 'GET';

    if (method === 'GET' && path.startsWith('/ref/heads/')) {
      const name = decodeURIComponent(path.slice('/ref/heads/'.length));
      const sha = refs.get(name);
      return sha ? ok({ ref: `refs/heads/${name}`, object: { sha } }) : fail(404, 'Not Found');
    }
    if (method === 'GET' && path.startsWith('/commits/')) {
      const commit = commits.get(path.slice('/commits/'.length));
      return commit ? ok(commit) : fail(404, 'Not Found');
    }
    if (method === 'GET' && path.startsWith('/trees/')) {
      const tree = trees.get(path.slice('/trees/'.length).split('?')[0]);
      return tree ? ok({ sha: tree.sha, tree: tree.entries, truncated: false }) : fail(404, 'Not Found');
    }
    if (method === 'GET' && path.startsWith('/blobs/')) {
      const content = blobs.get(path.slice('/blobs/'.length));
      return content === undefined
        ? fail(404, 'Not Found')
        : ok({ content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' });
    }
    if (method === 'POST' && path === '/blobs') {
      state.blobUploads++;
      const content = Buffer.from(body.content, 'base64').toString('utf8');
      const sha = gitBlobSha(content);
      blobs.set(sha, content);
      return ok({ sha });
    }
    if (method === 'POST' && path === '/trees') {
      const entries = new Map();
      if (body.base_tree) for (const e of trees.get(body.base_tree).entries) entries.set(e.path, e);
      for (const e of body.tree) entries.set(e.path, { ...e });
      const key = [...entries.values()].map((e) => `${e.path}:${e.sha}`).sort().join('|');
      const existing = [...trees.values()].find((t) => t.key === key);
      if (existing) return ok({ sha: existing.sha });
      const sha = id('t');
      trees.set(sha, { sha, key, entries: [...entries.values()].map((e) => ({ ...e, type: 'blob' })) });
      return ok({ sha });
    }
    if (method === 'POST' && path === '/commits') {
      state.commits++;
      const sha = id('c');
      commits.set(sha, { sha, tree: { sha: body.tree }, parents: body.parents, message: body.message });
      return ok({ sha });
    }
    if (method === 'POST' && path === '/refs') {
      state.refCreateAttempts++;
      const name = body.ref.replace('refs/heads/', '');
      if (refCreateAlwaysFails) return fail(422, 'Reference update failed');
      if (state.refCreateAttempts <= failRefCreate) {
        // A racing job got there first, with a commit of its own.
        const raceBlob = gitBlobSha('race');
        blobs.set(raceBlob, 'race');
        const raceTree = id('t');
        trees.set(raceTree, {
          sha: raceTree,
          key: `.attic-race:${raceBlob}`,
          entries: [{ path: '.attic-race', mode: '100644', type: 'blob', sha: raceBlob }],
        });
        const raceCommit = id('c');
        commits.set(raceCommit, { sha: raceCommit, tree: { sha: raceTree }, parents: [], message: 'racing job' });
        refs.set(name, raceCommit);
        return fail(422, 'Reference already exists');
      }
      if (refs.has(name)) return fail(422, 'Reference already exists');
      refs.set(name, body.sha);
      return ok({ ref: body.ref, object: { sha: body.sha } });
    }
    if (method === 'PATCH' && path.startsWith('/refs/heads/')) {
      refs.set(decodeURIComponent(path.slice('/refs/heads/'.length)), body.sha);
      return ok({ object: { sha: body.sha } });
    }
    return fail(404, `unhandled ${method} ${path}`);
  }

  return { fetchImpl, state, refs, commits, trees };
}

function apiFor(fetchImpl) {
  return new Api({ token: 't', maxRequests: 5000, fetchImpl, log: quiet, warn: quiet, sleep: async () => {} });
}

test('the first commit creates the orphan branch with no parents', async () => {
  const git = makeGitServer();
  const backend = await BranchBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'actions-attic');
  assert.equal(backend.isNew, true);

  backend.write('manifest.json', '{"schemaVersion":1}\n');
  backend.write('runs/2026-08.jsonl', '{"id":1}\n');
  const result = await backend.commit('attic: first');

  assert.deepEqual(result.changed, ['manifest.json', 'runs/2026-08.jsonl']);
  assert.equal(git.refs.get('actions-attic'), result.sha);
  assert.deepEqual(git.commits.get(result.sha).parents, [], 'orphan branch: no parent commit');
});

test('unchanged content uploads no blobs and makes no commit', async () => {
  const git = makeGitServer();
  const backend = await BranchBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'actions-attic');
  backend.write('manifest.json', '{"a":1}\n');
  assert.ok(await backend.commit('one'));
  const uploads = git.state.blobUploads;
  const commits = git.state.commits;

  const second = await BranchBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'actions-attic');
  second.write('manifest.json', '{"a":1}\n');
  assert.equal(await second.commit('two'), null);
  assert.equal(git.state.blobUploads, uploads, 'no blob re-upload for identical content');
  assert.equal(git.state.commits, commits, 'no empty commit');
});

test('content written to the branch reads back through the blob API', async () => {
  const git = makeGitServer();
  const first = await BranchBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'actions-attic');
  first.write('runs/2026-08.jsonl', '{"id":7}\n');
  await first.commit('seed');

  const second = await BranchBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'actions-attic');
  assert.deepEqual(second.paths(), ['runs/2026-08.jsonl']);
  assert.equal(await second.read('runs/2026-08.jsonl'), '{"id":7}\n');
  assert.equal(await second.read('runs/2025-01.jsonl'), null);
});

test('a 422 race on branch creation is retried once and succeeds', async () => {
  const git = makeGitServer({ failRefCreate: 1 });
  const warnings = [];
  const backend = await BranchBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'actions-attic', {
    warn: (m) => warnings.push(m),
  });
  backend.write('manifest.json', '{"a":1}\n');
  const result = await backend.commit('attic: first');

  assert.ok(result, 'the retry must land the commit');
  assert.ok(warnings.some((w) => /moved under us/.test(w)), warnings.join('\n'));
  assert.equal(git.refs.get('actions-attic'), result.sha);
  assert.ok(git.commits.get(result.sha).parents.length === 1, 'the retry rebases onto the winning commit');
});

test('a second failure to update the ref is loud, not silent', async () => {
  const git = makeGitServer({ refCreateAlwaysFails: true });
  const backend = await BranchBackend.open(apiFor(git.fetchImpl), 'acme', 'widget', 'actions-attic', { warn: quiet });
  backend.write('manifest.json', '{"a":1}\n');
  await assert.rejects(backend.commit('attic: racing'), /could not update refs\/heads\/actions-attic after one retry/);
  assert.equal(git.state.refCreateAttempts, 2, 'exactly one retry');
});
