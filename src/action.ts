/** GitHub Action entry point. */

import * as core from '@actions/core';
import { Api, BudgetExhausted, HttpError, NetworkError } from './api.js';
import { Archive } from './archive.js';
import { RefBackend, normalizeRef } from './backend.js';
import { type PreflightResult, formatPreflight, runPreflight } from './preflight.js';
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

  const mode = input('mode', 'auto');
  if (mode !== 'preflight' && !MODES.includes(mode as Mode)) {
    core.setFailed(`input "mode" must be one of ${MODES.join(', ')}, preflight, got "${mode}"`);
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

  if (mode === 'preflight') {
    await preflightRun(api, backend, owner, repo);
    return;
  }

  const summary = await runArchive({
    api,
    backend,
    owner,
    repo,
    mode: mode as Mode,
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

/** Report what the retention change will delete. Reads the archive, never writes it. */
async function preflightRun(api: Api, backend: RefBackend, owner: string, repo: string): Promise<void> {
  const retentionRaw = core.getInput('retention-days').trim();
  const retentionDays = retentionRaw === '' ? null : intInput('retention-days', 90, 1, 3650);
  const failOn = boolInput('fail-on-unarchived');

  const archive = await Archive.open(backend, `${owner}/${repo}`);
  const result = await runPreflight({
    api,
    archive,
    owner,
    repo,
    retentionDays,
    log: (m) => core.info(m),
    warn: (m) => core.warning(m),
  });

  core.setOutput('retention-days', result.retentionDays);
  core.setOutput('retention-source', result.retentionSource);
  core.setOutput('unarchived-total', result.unarchived.total);
  core.setOutput('preflight-json', JSON.stringify(result));

  const next = 'run this workflow with mode auto or backfill until the backfill completes';
  core.info(formatPreflight(result, next));
  await writePreflightSummary(result, api.requests);

  if (failOn && result.unarchived.total > 0) {
    core.setFailed(
      `${result.unarchived.total.toLocaleString('en-US')} at-risk records are not archived; ${next}.`,
    );
  }
}

async function writePreflightSummary(result: PreflightResult, requests: number): Promise<void> {
  const n = (value: number) => value.toLocaleString('en-US');
  const verdict =
    result.unarchived.total > 0
      ? `**${n(result.unarchived.total)} records are not archived** and will be deleted once they age past the window.`
      : 'Everything at risk is already in the attic.';
  await core.summary
    .addHeading('actions-attic preflight', 3)
    .addRaw(
      `Retention window: ${n(result.retentionDays)} days (${result.retentionSource}). ` +
        `From ${result.deletionDate}, records created before \`${result.cutoffIso}\` are deleted. ${verdict}`,
      true,
    )
    .addBreak()
    .addTable([
      [
        { data: 'record type', header: true },
        { data: 'at risk', header: true },
        { data: 'archived', header: true },
        { data: 'unarchived', header: true },
      ],
      ['workflow runs', n(result.atRisk.runs), n(result.archived.runs), n(result.unarchived.runs)],
      ['check runs', n(result.atRisk.checks), n(result.archived.checks), n(result.unarchived.checks)],
      ['commit statuses', n(result.atRisk.statuses), n(result.archived.statuses), n(result.unarchived.statuses)],
    ])
    .addRaw(`${n(requests)} API request${requests === 1 ? '' : 's'} used.`, true)
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
