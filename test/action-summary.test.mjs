/**
 * The job summary the Action writes, driven end to end through the built
 * bundle. Every other test calls the pieces directly, and both summary bugs
 * 1.4.0 was written with (one out-of-scope note per version, "1 days (api)")
 * passed all of them. They were caught by reading a real run's summary, which
 * is what this file automates.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { makeGitServer } from './helpers/fake-git.mjs';
import { makeFakeGitHub, makeRuns } from './helpers/fake-github.mjs';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(root, 'dist', 'index.cjs');
const REG = join(root, 'test', 'fixtures', 'registry');

const fixture = (file) => JSON.parse(readFileSync(join(REG, file), 'utf8'));
const PACKUMENT = fixture('runner-drift.packument.json');
const ATT_121 = fixture('runner-drift-1.2.1.attestations.json');
const CORE_PACKUMENT = fixture('actions-core.packument.json');
const CORE_ATT = fixture('actions-core-3.0.1.attestations.json');

const headers = {
  'content-type': 'application/json',
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': '4999',
  'x-ratelimit-reset': '99999999999',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });

/** Put a fetchImpl behind a real socket, because the Action runs in its own process. */
async function serve(fetchImpl) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined;
      const url = `http://127.0.0.1:${server.address().port}${req.url}`;
      Promise.resolve(fetchImpl(url, { method: req.method, body }))
        .then(async (out) => {
          res.writeHead(out.status, { 'content-type': 'application/json' });
          res.end(Buffer.from(await out.arrayBuffer()));
        })
        .catch((err) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: String(err) }));
        });
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
  };
}

/**
 * The GitHub endpoints the Action reaches for: Git Data for the archive ref,
 * the repository and its retention setting, and the Actions history. The git
 * fake is hard-wired to acme/widget, so the path is rewritten to let a test
 * host the archive under any name.
 */
function makeGitHub({ runs = [], retentionDays = null } = {}) {
  const git = makeGitServer();
  const gh = makeFakeGitHub({ runs });
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname.includes('/git/')) {
      return git.fetchImpl(url.replace(/\/repos\/[^/]+\/[^/]+\/git\//, '/repos/acme/widget/git/'), init);
    }
    if (pathname.endsWith('/actions/permissions/artifact-and-log-retention')) {
      return retentionDays === null ? json({ message: 'Not Found' }, 404) : json({ days: retentionDays });
    }
    if (/^\/repos\/[^/]+\/[^/]+$/.test(pathname)) {
      return json({ visibility: 'private', created_at: '2020-01-01T00:00:00Z' });
    }
    return gh.fetchImpl(url, init);
  };
  return { fetchImpl, git, gh };
}

/** A registry that answers only the paths it was given. */
const registryFor = (routes) => async (url) => {
  const body = routes[new URL(url).pathname];
  return body === undefined ? json({ error: 'Not found' }, 404) : json(body);
};

function parseOutputs(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^([^<]+)<<(.+)$/.exec(lines[i]);
    if (!match) continue;
    const end = lines.indexOf(match[2], i + 1);
    out[match[1]] = lines.slice(i + 1, end).join('\n');
    i = end;
  }
  return out;
}

/** Run the bundle the way the runner does: inputs in the environment, nothing else. */
async function runAction(inputs, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'attic-action-'));
  const summaryPath = join(dir, 'summary.md');
  const outputPath = join(dir, 'outputs.txt');
  await writeFile(summaryPath, '');
  await writeFile(outputPath, '');

  // A real runner sets all of these, and this suite runs on one.
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (/^(INPUT_|GITHUB_|ACTIONS_|RUNNER_|GH_|NPM_CONFIG_)/.test(key)) delete childEnv[key];
  }
  Object.assign(childEnv, {
    GITHUB_STEP_SUMMARY: summaryPath,
    GITHUB_OUTPUT: outputPath,
    GITHUB_REPOSITORY: 'acme/widget',
    GITHUB_SERVER_URL: 'https://github.com',
    ...env,
  });
  for (const [name, value] of Object.entries(inputs)) childEnv[`INPUT_${name.toUpperCase()}`] = String(value);

  let code = 0;
  let stdout = '';
  try {
    ({ stdout } = await exec(process.execPath, [BUNDLE], { cwd: root, env: childEnv, maxBuffer: 32 * 1024 * 1024 }));
  } catch (err) {
    code = err.code ?? 1;
    stdout = err.stdout ?? '';
  }
  const summary = await readFile(summaryPath, 'utf8');
  const outputs = parseOutputs(await readFile(outputPath, 'utf8'));
  await rm(dir, { recursive: true, force: true });
  return { code, stdout, summary, outputs };
}

/**
 * GitHub renders the summary as CommonMark, so a raw HTML block swallows
 * everything up to the next blank line and markdown inside it renders with its
 * punctuation showing. Checked against api.github.com/markdown: a table cell
 * keeps `[text](url)` and `**YES**` literal, and a paragraph written straight
 * after a heading keeps its backticks.
 */
function assertRenderable(summary) {
  const lines = summary.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line === '') return;
    if (line.startsWith('<')) {
      assert.doesNotMatch(line, /\*\*|\[[^\]]*\]\(|`/, `markdown inside an HTML block stays literal: ${line}`);
      return;
    }
    assert.equal(lines[i - 1] ?? '', '', `markdown needs a blank line to escape the HTML block above it: ${line}`);
  });
}

/** Old enough that no retention window in these tests still covers it. */
function monthsAgo(n) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 7);
}

test('the provenance summary names the window in words and keeps the notes worth reading', async () => {
  const gh = await serve(makeGitHub({ retentionDays: 90 }).fetchImpl);
  const registry = await serve(
    registryFor({
      '/%40actions%2Fcore': CORE_PACKUMENT,
      '/-/npm/v1/attestations/%40actions%2Fcore%403.0.1': CORE_ATT,
    }),
  );
  try {
    const { code, summary, outputs } = await runAction(
      { token: 't', mode: 'provenance', package: '@actions/core', registry: registry.url },
      { GITHUB_API_URL: gh.url },
    );

    assert.equal(code, 0);
    assertRenderable(summary);
    assert.match(summary, /Retention window 90 days \(repository setting\)/);
    assert.doesNotMatch(summary, /\d+ days \(api\)/, 'the summary must not print the raw source name');
    assert.match(
      summary,
      /<td>3\.0\.1<\/td><td><a href="https:\/\/github\.com\/actions\/toolkit\/actions\/runs\/\d+\/attempts\/\d+">actions\/toolkit #\d+\/\d+<\/a><\/td>/,
      'the version and its run belong in the table, as a link that renders',
    );

    // The row already says out-of-scope, so repeating "run belongs to actions/toolkit"
    // once per version is the noise that made a real summary 32 lines long.
    assert.doesNotMatch(summary, /run belongs to/);
    assert.match(summary, /names a repository this archive does not cover/);
    assert.equal(outputs['retention-days'], '90');
    assert.equal(outputs['retention-source'], 'api');
    assert.equal(JSON.parse(outputs['provenance-json']).package, '@actions/core');
  } finally {
    await Promise.all([gh.close(), registry.close()]);
  }
});

test('a provenance run with nothing archived fails the step and shows why', async () => {
  const gh = await serve(makeGitHub().fetchImpl);
  const registry = await serve(
    registryFor({
      '/runner-drift': PACKUMENT,
      '/-/npm/v1/attestations/runner-drift%401.2.1': ATT_121,
    }),
  );
  try {
    const { code, stdout, summary, outputs } = await runAction(
      {
        token: 't',
        mode: 'provenance',
        package: 'runner-drift',
        registry: registry.url,
        'retention-days': '1',
        'fail-on-unarchived': 'true',
      },
      { GITHUB_API_URL: gh.url, GITHUB_REPOSITORY: 'Booyaka101/runner-drift' },
    );

    assert.equal(code, 1, 'fail-on-unarchived with an at-risk run must fail the step');
    assertRenderable(summary);
    assert.match(stdout, /::error::.*not archived/);
    assert.match(summary, /Retention window 1 day \(--retention-days\)/);
    assert.match(summary, /<strong>YES<\/strong>/, 'an at-risk row is marked');

    // 1.2.0 advertises an attestation this registry does not serve. The table
    // leaves it out, so its note is the only sign it was skipped.
    assert.match(summary, /<code>1\.2\.0<\/code>: the attestations endpoint returned 404 for this version/);
    assert.ok(Number(outputs['unarchived-total']) > 0);
  } finally {
    await Promise.all([gh.close(), registry.close()]);
  }
});

test('the preflight summary counts what is at risk and agrees with its own window', async () => {
  const runs = makeRuns({ month: monthsAgo(2), count: 12, startId: 500_000, days: 20 });
  const gh = await serve(makeGitHub({ runs }).fetchImpl);
  try {
    const { code, stdout, summary, outputs } = await runAction(
      { token: 't', mode: 'preflight', 'retention-days': '1' },
      { GITHUB_API_URL: gh.url },
    );

    assert.equal(code, 0, `a report without fail-on-unarchived never fails the step:\n${stdout}`);
    assertRenderable(summary);
    assert.match(summary, /Retention window: 1 day \(--retention-days\)\./);
    assert.match(summary, /\*\*12 records are not archived\*\*/);
    assert.match(summary, /<td>workflow runs<\/td><td>12<\/td><td>0<\/td><td>12<\/td>/);
    assert.equal(outputs['unarchived-total'], '12');
    assert.equal(JSON.parse(outputs['preflight-json']).retentionSource, 'flag');
  } finally {
    await gh.close();
  }
});

test('an archiving run commits, reports the counts it committed, and links the commit', async () => {
  const runs = makeRuns({ month: monthsAgo(1), count: 9, startId: 700_000, days: 9 });
  const github = makeGitHub({ runs });
  const gh = await serve(github.fetchImpl);
  try {
    const { code, stdout, summary, outputs } = await runAction(
      { token: 't', mode: 'incremental', 'skip-checks': 'true', 'skip-statuses': 'true' },
      { GITHUB_API_URL: gh.url },
    );

    assert.equal(code, 0, stdout);
    assertRenderable(summary);
    assert.equal(outputs['runs-added'], '9');
    assert.equal(outputs.committed, 'true');
    assert.equal(outputs.ref, 'refs/attic/archive');
    assert.equal(outputs.branch, '', 'the default ref is not a branch');
    assert.match(summary, /<h3>actions-attic: acme\/widget<\/h3>/);
    assert.match(summary, /<td>workflow runs<\/td><td>9<\/td><td>9<\/td>/, 'new this run and total archived');
    assert.match(summary, /\[Browse this commit\]\(https:\/\/github\.com\/acme\/widget\/tree\/[0-9a-f]+\)/);
    assert.equal(github.git.refs.get('attic/archive'), outputs['commit-sha']);
  } finally {
    await gh.close();
  }
});
