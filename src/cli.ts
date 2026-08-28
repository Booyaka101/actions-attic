/** actions-attic command line: archive, index and read a repository's Actions history. */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Api, BudgetExhausted, HttpError, NetworkError } from './api.js';
import { Archive, type RunRecord } from './archive.js';
import { FsBackend } from './backend.js';
import { computeFlake, formatFlake } from './flake.js';
import { buildIndex } from './index.js';
import { assertMonth } from './months.js';
import { MODES, type Mode, parseRepo, runArchive } from './run.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string; name: string };

const HELP = `actions-attic ${pkg.version} — keep a permanent archive of a repository's GitHub Actions history.

  GitHub starts applying the Actions retention setting to checks, workflow runs and
  statuses on 2026-10-01. Public repositories cap out at 90 days. Archive first.

USAGE
  actions-attic <command> [options]

COMMANDS
  sync <owner/repo>          Top up new runs, then continue the backfill (default mode: auto)
  backfill <owner/repo>      Walk history backwards only
  incremental <owner/repo>   Append new runs only
  build                      Build a SQLite index over the archive
  flake <workflow>           Flake rate for one workflow
  stats                      What the archive currently holds
  runs                       List archived runs as JSON lines

ARCHIVE OPTIONS
  --archive <dir>            Archive directory (default: ./attic)

FETCH OPTIONS (sync, backfill, incremental)
  --token <token>            GitHub token. Falls back to GITHUB_TOKEN, GH_TOKEN, then \`gh auth token\`
  --months <n>               How far back to backfill (default: 14)
  --max-requests <n>         Request ceiling for this invocation (default: 800)
  --max-pages <n>            Page ceiling for an incremental catch-up (default: 50)
  --no-checks                Skip check runs
  --no-statuses              Skip commit statuses
  --api <url>                API base URL (default: https://api.github.com)

READ OPTIONS
  --since <YYYY-MM>          Earliest month to include
  --until <YYYY-MM>          Latest month to include
  --workflow <name>          Filter runs by workflow name
  --min-runs <n>             Minimum decided runs for a month to count as the peak (default: 1)
  --out <file>               Database path for \`build\` (default: <archive>/attic.db)
  --json                     Machine-readable output

EXAMPLES
  actions-attic sync cli/cli --archive ./attic --months 14
  actions-attic build --archive ./attic
  actions-attic flake build-linux --since 2025-09 --archive ./attic
  actions-attic stats --archive ./attic

Full docs: https://github.com/Booyaka101/actions-attic
`;

interface Args {
  command: string | null;
  positional: string[];
  flags: Map<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (name.startsWith('no-')) {
        flags.set(name, true);
        continue;
      }
      if (next === undefined || next.startsWith('--')) flags.set(name, true);
      else {
        flags.set(name, next);
        i++;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      flags.set(arg.replace(/^-+/, ''), true);
      continue;
    }
    positional.push(arg);
  }
  return { command: positional[0] ?? null, positional: positional.slice(1), flags };
}

function str(args: Args, name: string, fallback: string): string {
  const value = args.flags.get(name);
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new UsageError(`--${name} needs a value`);
  return value;
}

function int(args: Args, name: string, fallback: number, min: number, max: number): number {
  const value = args.flags.get(name);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`--${name} must be an integer between ${min} and ${max}, got "${String(value)}"`);
  }
  return n;
}

function month(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new UsageError(`--${name} needs a value like 2026-04`);
  try {
    return assertMonth(value, `--${name}`);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function resolveToken(args: Args): string {
  const explicit = args.flags.get('token');
  if (typeof explicit === 'string' && explicit) return explicit;
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_ATTIC_TOKEN']) {
    const value = process.env[key];
    if (value) return value;
  }
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (token) {
      process.stderr.write('using the token from `gh auth token`\n');
      return token;
    }
  } catch {
    // gh is not installed or not logged in; fall through to the explicit message
  }
  throw new UsageError(
    'no GitHub token found. Pass --token, set GITHUB_TOKEN, or run `gh auth login`.\n' +
      'The token needs read access to actions, checks and statuses on the repository.',
  );
}

function requireRepo(args: Args): { owner: string; repo: string } {
  const value = args.positional[0];
  if (!value) throw new UsageError(`${args.command} needs a repository, e.g. \`actions-attic ${args.command} cli/cli\``);
  try {
    return parseRepo(value);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

async function openArchive(dir: string, repo = 'unknown/unknown'): Promise<{ archive: Archive; dir: string }> {
  const backend = await FsBackend.open(dir);
  if (backend.paths().length === 0) {
    throw new UsageError(
      `no archive found in ${dir}. Run \`actions-attic sync <owner/repo> --archive ${dir}\` first, ` +
        'or point --archive at a checkout of your actions-attic branch.',
    );
  }
  return { archive: await Archive.open(backend, repo), dir };
}

async function cmdSync(args: Args, mode: Mode): Promise<number> {
  const { owner, repo } = requireRepo(args);
  const dir = resolve(str(args, 'archive', 'attic'));
  const api = new Api({
    token: resolveToken(args),
    maxRequests: int(args, 'max-requests', 800, 1, 1_000_000),
    baseUrl: str(args, 'api', process.env.GITHUB_API_URL ?? 'https://api.github.com'),
    log: (m) => process.stderr.write(`${m}\n`),
    warn: (m) => process.stderr.write(`warning: ${m}\n`),
  });

  const summary = await runArchive({
    api,
    backend: await FsBackend.open(dir),
    owner,
    repo,
    mode,
    months: int(args, 'months', 14, 1, 120),
    maxPages: int(args, 'max-pages', 50, 1, 1000),
    skipChecks: args.flags.get('no-checks') === true,
    skipStatuses: args.flags.get('no-statuses') === true,
    log: (m) => process.stderr.write(`${m}\n`),
    warn: (m) => process.stderr.write(`warning: ${m}\n`),
  });

  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify(jsonSummary(summary, dir), null, 2)}\n`);
    return 0;
  }

  const counts = `${summary.runs} runs, ${summary.checks} checks, ${summary.statuses} statuses`;
  process.stdout.write(
    summary.commit
      ? `${summary.message}\n${summary.commit.changed.length} file(s) written to ${dir} (${counts} new)\n`
      : `no change (${counts} new); archive at ${dir} is already up to date\n`,
  );
  process.stdout.write(`${summary.requests} API requests used\n`);
  if (summary.frontier) {
    process.stdout.write(`backfill frontier at ${summary.frontier}; run again to continue\n`);
  } else if (summary.backfill?.finished) {
    process.stdout.write('backfill complete\n');
  }
  if (summary.checkpoint) process.stdout.write(`checkpointed: ${summary.checkpoint}\n`);
  return 0;
}

function jsonSummary(summary: Awaited<ReturnType<typeof runArchive>>, dir: string) {
  return {
    archive: dir,
    mode: summary.mode,
    message: summary.message,
    committed: summary.commit !== null,
    changedFiles: summary.commit?.changed ?? [],
    added: { runs: summary.runs, checks: summary.checks, statuses: summary.statuses },
    requests: summary.requests,
    backfillFrontier: summary.frontier,
    backfillFinished: summary.backfill?.finished ?? null,
    checkpoint: summary.checkpoint,
    totals: summary.archive.manifest.counts,
  };
}

async function cmdBuild(args: Args): Promise<number> {
  const dir = resolve(str(args, 'archive', 'attic'));
  await openArchive(dir);
  const out = resolve(str(args, 'out', `${dir}/attic.db`));
  const result = buildIndex(dir, out);
  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `indexed ${result.runs} runs, ${result.checks} checks, ${result.statuses} statuses ` +
      `across ${result.months.length} month(s) into ${out}\n`,
  );
  return 0;
}

async function loadRuns(args: Args): Promise<RunRecord[]> {
  const dir = resolve(str(args, 'archive', 'attic'));
  const { archive } = await openArchive(dir);
  return archive.readAll<RunRecord>('runs');
}

async function cmdFlake(args: Args): Promise<number> {
  const workflow = args.positional[0] ?? (args.flags.get('workflow') as string | undefined);
  if (!workflow || typeof workflow !== 'string') {
    throw new UsageError('flake needs a workflow name, e.g. `actions-attic flake build-linux`');
  }
  const report = computeFlake(await loadRuns(args), {
    workflow,
    since: month(args, 'since'),
    until: month(args, 'until'),
    minRuns: int(args, 'min-runs', 1, 1, 1_000_000),
  });

  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  if (report.runs === 0) {
    const known = report.candidates.length
      ? `\nWorkflows in this window: ${report.candidates.join(', ')}`
      : '\nThe archive has no runs in this window.';
    process.stdout.write(`${workflow}: no completed runs in the selected window.${known}\n`);
    return 1;
  }
  process.stdout.write(`${formatFlake(report)}\n`);
  return 0;
}

async function cmdStats(args: Args): Promise<number> {
  const dir = resolve(str(args, 'archive', 'attic'));
  const { archive } = await openArchive(dir);
  const m = archive.manifest;
  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify(m, null, 2)}\n`);
    return 0;
  }
  const months = m.months.length ? `${m.months[0]}..${m.months[m.months.length - 1]}` : 'none';
  process.stdout.write(
    [
      `repo             ${m.repo}`,
      `archive          ${dir}`,
      `months           ${months} (${m.months.length})`,
      `runs             ${m.counts.runs.toLocaleString('en-US')}`,
      `checks           ${m.counts.checks.toLocaleString('en-US')}`,
      `statuses         ${m.counts.statuses.toLocaleString('en-US')}`,
      `highest run id   ${m.highestRunId ?? '-'}`,
      `backfill         ${m.backfillComplete ? 'complete' : m.backfillFrontier ? `resuming before ${m.backfillFrontier}` : 'not started'}`,
      `last change      ${m.lastRun ?? '-'}`,
      '',
    ].join('\n'),
  );
  return 0;
}

async function cmdRuns(args: Args): Promise<number> {
  const runs = await loadRuns(args);
  const since = month(args, 'since');
  const until = month(args, 'until');
  const workflow = args.flags.get('workflow');
  let printed = 0;
  for (const run of runs) {
    const m = run.created_at.slice(0, 7);
    if (since && m < since) continue;
    if (until && m > until) continue;
    if (typeof workflow === 'string' && run.name !== workflow) continue;
    process.stdout.write(`${JSON.stringify(run)}\n`);
    printed++;
  }
  if (printed === 0) {
    process.stderr.write('no runs matched the selected window\n');
    return 1;
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.get('version') === true || args.flags.get('v') === true || args.command === 'version') {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (args.command === null || args.command === 'help' || args.flags.get('help') === true || args.flags.get('h') === true) {
    process.stdout.write(HELP);
    return args.command === null && args.flags.size === 0 ? 1 : 0;
  }

  switch (args.command) {
    case 'sync':
      return cmdSync(args, 'auto');
    case 'backfill':
      return cmdSync(args, 'backfill');
    case 'incremental':
      return cmdSync(args, 'incremental');
    case 'build':
      return cmdBuild(args);
    case 'flake':
      return cmdFlake(args);
    case 'stats':
      return cmdStats(args);
    case 'runs':
      return cmdRuns(args);
    default:
      throw new UsageError(`unknown command "${args.command}". Run \`actions-attic --help\`.`);
  }
}

export async function cli(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    if (err instanceof BudgetExhausted) {
      process.stderr.write(`stopped early: ${err.reason}\nRe-run later to resume from the checkpoint.\n`);
      return 0;
    }
    if (err instanceof NetworkError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    if (err instanceof HttpError) {
      process.stderr.write(`${describeHttp(err)}\n`);
      return 1;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function describeHttp(err: HttpError): string {
  if (err.status === 401) return 'GitHub rejected the token (401). Check it is valid and not expired.';
  if (err.status === 404) {
    return 'GitHub returned 404. Check the repository name, and that the token can see it (private repos need repo access).';
  }
  if (err.status === 403) {
    return `GitHub returned 403. The token is missing a permission for this endpoint.\n${err.message}`;
  }
  return err.message;
}

export { MODES };
