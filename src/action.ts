/** GitHub Action entry point. */

import * as core from '@actions/core';
import { Api, BudgetExhausted, HttpError, NetworkError } from './api.js';
import { BranchBackend } from './backend.js';
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

  const slug = input('repository', process.env.GITHUB_REPOSITORY ?? '');
  if (!slug) {
    core.setFailed('could not work out which repository to archive; set GITHUB_REPOSITORY or the `repository` input.');
    return;
  }
  const { owner, repo } = parseRepo(slug);
  const branch = input('branch', 'actions-attic');
  const months = intInput('backfill-months', 14, 1, 120);
  const maxRequests = intInput('max-requests', 800, 1, 1_000_000);
  const maxPages = intInput('max-pages', 50, 1, 1000);
  const skipChecks = boolInput('skip-checks');
  const skipStatuses = boolInput('skip-statuses');

  const api = new Api({
    token,
    maxRequests,
    baseUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
    log: (m) => core.info(m),
    warn: (m) => core.warning(m),
  });

  core.info(`actions-attic: ${owner}/${repo} -> ${branch} (mode ${mode}, budget ${maxRequests} requests)`);

  const backend = await BranchBackend.open(api, owner, repo, branch, {
    committer: { name: 'actions-attic', email: 'actions-attic@users.noreply.github.com' },
    warn: (m) => core.warning(m),
  });
  if (backend.isNew) core.info(`branch ${branch} does not exist yet; this run will create it`);

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
  core.setOutput('backfill-complete', summary.frontier === null);
  core.setOutput('requests-used', summary.requests);
  core.setOutput('branch', branch);

  if (summary.commit) core.info(`committed ${summary.commit.sha ?? ''} — ${summary.message}`);
  else core.info('nothing new to archive; no commit made');

  if (summary.checkpoint) {
    core.notice(
      `checkpointed at ${summary.frontier ?? 'the current frontier'}: ${summary.checkpoint}. ` +
        'The next scheduled run resumes from here.',
    );
  }

  const totals = summary.archive.manifest.counts;
  await core.summary
    .addHeading('actions-attic', 3)
    .addRaw(`Archive branch \`${branch}\` — ${summary.commit ? `committed \`${summary.message}\`` : 'no change'}`)
    .addTable([
      [
        { data: 'record', header: true },
        { data: 'new this run', header: true },
        { data: 'total archived', header: true },
      ],
      ['runs', String(summary.runs), totals.runs.toLocaleString('en-US')],
      ['checks', String(summary.checks), totals.checks.toLocaleString('en-US')],
      ['statuses', String(summary.statuses), totals.statuses.toLocaleString('en-US')],
    ])
    .addRaw(
      summary.frontier
        ? `Backfill frontier: \`${summary.frontier}\` — the next run resumes before this month.`
        : 'Backfill complete.',
    )
    .addRaw(` ${summary.requests} API requests used.`)
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
