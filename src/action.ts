/** GitHub Action entry point. */

import * as core from '@actions/core';
import { Api, BudgetExhausted, HttpError, NetworkError } from './api.js';
import { RefBackend, normalizeRef } from './backend.js';
import { MODES, type Mode, parseRepo, runArchive } from './run.js';

function input(name: string, fallback: string): string {
  const value = core.getInput(name);
  return value === '' ? fallback : value;
}

function intInput(name: string, fallback: number, min: number, max: number): number {
  const raw = input(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`input "${name}" must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

/** Tolerates an unset input, which core.getBooleanInput rejects outright. */
function boolInput(name: string): boolean {
  const raw = core.getInput(name).trim().toLowerCase();
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`input "${name}" must be true or false, got "${raw}"`);
}

/** Outside refs/heads/, so the archive is not a branch anyone has to look after. */
const DEFAULT_REF = 'refs/attic/archive';

export async function run(): Promise<void> {
  const token = input('token', process.env.GITHUB_TOKEN ?? '');
  if (!token) {
    core.setFailed('no token available. Pass `token: ${{ github.token }}` or set GITHUB_TOKEN.');
    return;
  }

  const mode = input('mode', 'auto') as Mode;
  if (!MODES.includes(mode)) {
    core.setFailed(`input "mode" must be one of ${MODES.join(', ')}, got "${mode}"`);
    return;
  }

  // The archive always lives in the repository running the workflow, which is
  // the only one github.token can write to. `repository` only chooses whose
  // Actions history to read.
  const host = process.env.GITHUB_REPOSITORY ?? '';
  if (!host) {
    core.setFailed('GITHUB_REPOSITORY is not set, so there is nowhere to write the archive.');
    return;
  }
  const { owner: hostOwner, repo: hostRepo } = parseRepo(host);
  const { owner, repo } = parseRepo(input('repository', host));

  // `branch` predates 1.1.0. Honouring it means upgrading never silently moves
  // an existing archive to the new default ref.
  const explicitRef = core.getInput('ref').trim();
  const legacyBranch = core.getInput('branch').trim();
  if (explicitRef && legacyBranch) core.warning('both `ref` and `branch` are set; using `ref`.');
  const ref = normalizeRef(explicitRef || legacyBranch || DEFAULT_REF);
  const months = intInput('backfill-months', 14, 1, 120);
  const maxRequests = intInput('max-requests', 800, 1, 1_000_000);
  const maxPages = intInput('max-pages', 50, 1, 1000);
  const skipChecks = boolInput('skip-checks');
  const skipStatuses = boolInput('skip-statuses');

  const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const api = new Api({
    token,
    maxRequests,
    baseUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
    log: (m) => core.info(m),
    warn: (m) => core.warning(m),
  });

  core.info(
    `actions-attic: ${owner}/${repo} -> ${hostOwner}/${hostRepo} ${ref} ` +
      `(mode ${mode}, budget ${maxRequests} requests)`,
  );

  const backend = await RefBackend.open(api, hostOwner, hostRepo, ref, {
    committer: { name: 'actions-attic', email: 'actions-attic@users.noreply.github.com' },
    warn: (m) => core.warning(m),
  });
  if (backend.isNew) core.info(`${ref} does not exist yet; this run will create it`);

  const summary = await runArchive({
    api,
    backend,
    owner,
    repo,
    mode,
    months,
    maxPages,
    skipChecks,
    skipStatuses,
    log: (m) => core.info(m),
    warn: (m) => core.warning(m),
  });

  core.setOutput('runs-added', summary.runs);
  core.setOutput('checks-added', summary.checks);
  core.setOutput('statuses-added', summary.statuses);
  core.setOutput('committed', summary.commit !== null);
  core.setOutput('commit-sha', summary.commit?.sha ?? '');
  core.setOutput('backfill-frontier', summary.frontier ?? '');
  core.setOutput('backfill-complete', summary.archive.manifest.backfillComplete);
  core.setOutput('requests-used', summary.requests);
  core.setOutput('ref', ref);
  core.setOutput('branch', ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '');
  core.setOutput('source-repository', `${owner}/${repo}`);
  const browseUrl = summary.commit?.sha
    ? `${serverUrl}/${hostOwner}/${hostRepo}/tree/${summary.commit.sha}`
    : '';
  core.setOutput('archive-url', browseUrl);

  if (summary.commit) {
    core.info(`committed ${summary.commit.sha ?? ''}: ${summary.message}`);
    if (browseUrl) core.info(`browse it at ${browseUrl}`);
  } else {
    core.info('nothing new to archive; no commit made');
  }

  if (summary.checkpoint) {
    core.notice(
      `checkpointed at ${summary.frontier ?? 'the current frontier'}: ${summary.checkpoint}. ` +
        'The next scheduled run resumes from here.',
    );
  }

  const totals = summary.archive.manifest.counts;
  const n = (value: number) => value.toLocaleString('en-US');
  const state = summary.archive.manifest.backfillComplete
    ? 'Backfill complete.'
    : `Backfill in progress${summary.frontier ? `, frontier \`${summary.frontier}\`` : ''}. The next run continues from here.`;

  await core.summary
    .addHeading(`actions-attic: ${owner}/${repo}`, 3)
    .addRaw(
      summary.commit
        ? `Committed \`${summary.message}\` to \`${ref}\`.${browseUrl ? ` [Browse this commit](${browseUrl})` : ''}`
        : `Nothing new on \`${ref}\`; no commit made.`,
      true,
    )
    .addBreak()
    .addTable([
      [
        { data: 'record type', header: true },
        { data: 'new this run', header: true },
        { data: 'total archived', header: true },
      ],
      ['workflow runs', n(summary.runs), n(totals.runs)],
      ['check runs', n(summary.checks), n(totals.checks)],
      ['commit statuses', n(summary.statuses), n(totals.statuses)],
    ])
    .addRaw(`${state} ${n(summary.requests)} API request${summary.requests === 1 ? '' : 's'} used.`, true)
    .write();
}

run().catch((err: unknown) => {
  // Budget and rate-limit stops are a normal outcome: the archive is committed
  // and the next scheduled run resumes from the frontier.
  if (err instanceof BudgetExhausted) {
    core.notice(`stopped early: ${err.reason}. The next scheduled run resumes from the frontier.`);
    return;
  }
  if (err instanceof NetworkError) {
    core.setFailed(err.message);
    return;
  }
  if (err instanceof HttpError) {
    if (err.status === 403) {
      core.setFailed(
        `GitHub returned 403: ${err.message}\n` +
          'Check the workflow has `permissions: { actions: read, checks: read, statuses: read, contents: write }`.',
      );
      return;
    }
    if (err.status === 404) {
      core.setFailed(`GitHub returned 404: ${err.message}\nCheck the repository and token permissions.`);
      return;
    }
    core.setFailed(err.message);
    return;
  }
  core.setFailed(err instanceof Error ? err.message : String(err));
});
