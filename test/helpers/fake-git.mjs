/**
 * In-memory Git Data API: refs, commits, trees and blobs, nothing else.
 * Test-only. Shared by the branch-backend and budget-reserve tests.
 */

import { gitBlobSha } from '../../lib/backend.js';

/** In-memory Git Data API: refs, commits, trees and blobs, nothing else. */
export function makeGitServer({ failRefCreate = 0, refCreateAlwaysFails = false } = {}) {
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

    if (method === 'GET' && path.startsWith('/ref/')) {
      const name = decodeURIComponent(path.slice('/ref/'.length));
      const sha = refs.get(name);
      return sha ? ok({ ref: `refs/${name}`, object: { sha } }) : fail(404, 'Not Found');
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
      const name = body.ref.replace(/^refs\//, '');
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
    if (method === 'PATCH' && path.startsWith('/refs/')) {
      refs.set(decodeURIComponent(path.slice('/refs/'.length)), body.sha);
      return ok({ object: { sha: body.sha } });
    }
    return fail(404, `unhandled ${method} ${path}`);
  }

  return { fetchImpl, state, refs, commits, trees };
}
