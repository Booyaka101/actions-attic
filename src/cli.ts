/** actions-attic command line: archive, index and read a repository's Actions history. */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Api, BudgetExhausted, HttpError, NetworkError } from './api.js';
import { Archive, type RunRecord } from './archive.js';
import { FsBackend, RefBackend, normalizeRef } from './backend.js';
import { computeFlake, formatFlake } from './flake.js';
import { buildIndex } from './index.js';
import { assertMonth } from './months.js';
import { formatPreflight, resolveRetention, runPreflight } from './preflight.js';
import {
  RegistryError,
  collectProvenance,
  formatProvenance,
  parseInvocationId,
  referencedRepos,
  resolveProvenance,
} from './provenance.js';
import { MODES, type Mode, parseRepo, runArchive } from './run.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string; name: string };

const HELP = `actions-attic ${pkg.version}

Keep a permanent archive of a repository's GitHub Actions history.

  GitHub starts applying the Actions retention setting to checks, workflow runs and
  statuses on 2026-10-01. Public repositories cap out at 90 days. Archive first.

USAGE
  actions-attic <command> [options]

COMMANDS
  sync <owner/repo>          Top up new runs, then continue the backfill (default mode: auto)
  backfill <owner/repo>      Walk history backwards only
  incremental <owner/repo>   Append new runs only
  pull <owner/repo>          Copy an archive ref down into a local directory
  preflight <owner/repo>     What the 2026-10-01 retention change will delete, and what is archived
  provenance <package>       Which npm versions point signed provenance at a run, and is it archived
  show-run <id>              Print the archived record for one run id
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
  --ref <ref>                Archive ref for \`pull\`, \`preflight\` and \`provenance\` (default: refs/attic/archive)
  --api <url>                API base URL (default: https://api.github.com)

PREFLIGHT OPTIONS
  --retention-days <n>       Override the retention window instead of reading it from the API
  --fail-on-unarchived       Exit 1 when anything at risk is not archived yet
  --archive <dir>            Compare against a local archive directory instead of the archive ref

PROVENANCE OPTIONS
  --repo <owner/repo>        Repository the archive covers (default: from the archive, else the provenance)
  --version <v>              Check one published version instead of all of them
  --all                      List versions published without provenance too
  --probe-all                Ask the attestations endpoint about every version, not only advertised ones
  --registry <url>           npm registry (default: https://registry.npmjs.org)
  --fail-on-unarchived       Exit 1 when a referenced run is unarchived and due for deletion

SHOW-RUN OPTIONS
  <id>                       A run id, or the run URL a dangling provenance pointer names
  --attempt <n>              Which attempt to print (default: the highest archived)

READ OPTIONS
  --since <YYYY-MM>          Earliest month to include
  --until <YYYY-MM>          Latest month to include
  --workflow <name>          Filter runs by workflow name
  --min-runs <n>             Minimum decided runs for a month to count as the peak (default: 1)
  --out <file>               Database path for \`build\` (default: <archive>/attic.db)
  --json                     Machine-readable output

EXAMPLES
  actions-attic sync cli/cli --archive ./attic --months 14
  actions-attic preflight myorg/myrepo --fail-on-unarchived
  actions-attic provenance my-package --archive ./attic
  actions-attic show-run 34307443469 --archive ./attic
  actions-attic pull myorg/myrepo --archive ./attic
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
  return asUsage(() => assertMonth(value, `--${name}`));
}

/** Validation errors from the library are user mistakes at the CLI boundary. */
function asUsage<T>(fn: () => T): T {
  try {
    return fn();
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

function findToken(args: Args): string | null {
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
    // gh is not installed or not logged in; the caller decides whether that is fatal
  }
  return null;
}

function resolveToken(args: Args): string {
  const token = findToken(args);
  if (token) return token;
  throw new UsageError(
    'no GitHub token found. Pass --token, set GITHUB_TOKEN, or run `gh auth login`.\n' +
      'The token needs read access to actions, checks and statuses on the repository.',
  );
}

function githubApi(args: Args, token: string): Api {
  return new Api({
    token,
    maxRequests: int(args, 'max-requests', 800, 1, 1_000_000),
    baseUrl: str(args, 'api', process.env.GITHUB_API_URL ?? 'https://api.github.com'),
    log: (m) => process.stderr.write(`${m}\n`),
    warn: (m) => process.stderr.write(`warning: ${m}\n`),
  });
}

function requireRepo(args: Args): { owner: string; repo: string } {
  const value = args.positional[0];
  if (!value) throw new UsageError(`${args.command} needs a repository, e.g. \`actions-attic ${args.command} cli/cli\``);
  return asUsage(() => parseRepo(value));
}

async function openArchive(dir: string, repo = 'unknown/unknown'): Promise<{ archive: Archive; dir: string }> {
  const backend = await FsBackend.open(dir);
  if (backend.paths().length === 0) {
    throw new UsageError(
      `no archive found in ${display(dir)}. Run \`actions-attic sync <owner/repo> --archive ${display(dir)}\` ` +
        `first, or \`actions-attic pull <owner/repo> --archive ${display(dir)}\` to fetch an existing one.`,
    );
  }
  return { archive: await Archive.open(backend, repo), dir };
}

async function cmdSync(args: Args, mode: Mode): Promise<number> {
  const { owner, repo } = requireRepo(args);
  const dir = resolve(str(args, 'archive', 'attic'));
  const api = githubApi(args, resolveToken(args));

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

  const where = display(dir);
  const counts = [
    plural(summary.runs, 'run'),
    plural(summary.checks, 'check'),
    plural(summary.statuses, 'status', 'statuses'),
  ].join(', ');
  process.stdout.write(
    summary.commit
      ? `${summary.message}\nwrote ${plural(summary.commit.changed.length, 'file')} to ${where} (${counts} new)\n`
      : `no change; the archive at ${where} is already up to date\n`,
  );
  process.stdout.write(`${plural(summary.requests, 'API request')} used\n`);
  if (summary.archive.manifest.backfillComplete) {
    process.stdout.write('backfill complete\n');
  } else if (summary.frontier) {
    process.stdout.write(`backfill frontier at ${summary.frontier}; run again to continue\n`);
  }
  if (summary.checkpoint) process.stdout.write(`checkpointed: ${summary.checkpoint}\n`);
  return 0;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * Show a path relative to the working directory when it sits underneath it.
 * Always with forward slashes: this is a label, and it reads the same on every
 * platform next to the `./attic` the user typed.
 */
function display(dir: string): string {
  const rel = relative(process.cwd(), dir);
  const inside = rel && !rel.startsWith('..') && !isAbsolute(rel);
  return (inside ? `./${rel}` : dir).split(sep).join('/');
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

/**
 * Copy the archive ref into a directory. Reading it over the API rather than
 * with git means no refspec to remember and no git in the way.
 */
async function cmdPull(args: Args): Promise<number> {
  const { owner, repo } = requireRepo(args);
  const dir = resolve(str(args, 'archive', 'attic'));
  const ref = asUsage(() => normalizeRef(str(args, 'ref', 'refs/attic/archive')));
  const api = githubApi(args, resolveToken(args));

  const remote = await RefBackend.open(api, owner, repo, ref);
  if (remote.isNew) {
    throw new UsageError(
      `${owner}/${repo} has no archive at ${ref}. Check the ref, or run \`actions-attic sync ${owner}/${repo}\` ` +
        'to build one locally.',
    );
  }

  const local = await FsBackend.open(dir);
  const paths = remote.paths();
  for (const path of paths) {
    const content = await remote.read(path);
    if (content !== null) local.write(path, content);
  }
  const written = await local.commit('pull');

  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify({ ref, archive: dir, files: paths.length, changed: written?.changed ?? [] }, null, 2)}
`);
    return 0;
  }
  process.stdout.write(
    `pulled ${plural(paths.length, 'file')} from ${owner}/${repo} ${ref} into ${display(dir)}
` +
      `${plural(written ? written.changed.length : 0, 'file')} changed, ${plural(api.requests, 'API request')} used
`,
  );
  return 0;
}

/**
 * What the retention change will delete and how much of it is archived. Reads
 * the archive ref over the API like `pull` does, or a local directory when
 * --archive is given, which may be empty: "nothing archived" is a real answer.
 */
async function cmdPreflight(args: Args): Promise<number> {
  const { owner, repo } = requireRepo(args);
  const retentionRaw = args.flags.get('retention-days');
  const retentionDays = retentionRaw === undefined ? null : int(args, 'retention-days', 90, 1, 3650);
  const api = githubApi(args, resolveToken(args));

  let archive: Archive;
  let next: string;
  const localDir = args.flags.get('archive');
  if (localDir !== undefined) {
    if (typeof localDir !== 'string') throw new UsageError('--archive needs a value');
    const dir = resolve(localDir);
    archive = await Archive.open(await FsBackend.open(dir), `${owner}/${repo}`);
    next = `actions-attic backfill ${owner}/${repo} --archive ${display(dir)}`;
  } else {
    const ref = asUsage(() => normalizeRef(str(args, 'ref', 'refs/attic/archive')));
    const backend = await RefBackend.open(api, owner, repo, ref);
    if (backend.isNew) process.stderr.write(`${owner}/${repo} has no archive at ${ref} yet\n`);
    archive = await Archive.open(backend, `${owner}/${repo}`);
    next = `actions-attic backfill ${owner}/${repo}`;
  }

  const result = await runPreflight({
    api,
    archive,
    owner,
    repo,
    retentionDays,
    log: (m) => process.stderr.write(`${m}\n`),
    warn: (m) => process.stderr.write(`warning: ${m}\n`),
  });

  if (args.flags.get('json') === true) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${formatPreflight(result, next)}\n`);
  return args.flags.get('fail-on-unarchived') === true && result.unarchived.total > 0 ? 1 : 0;
}

/**
 * Which published versions of an npm package carry a signed pointer at a
 * workflow run, and whether the attic still holds it. The registry half needs
 * no credentials; a token only buys the repository's real retention setting and
 * the archive ref when --archive is not given.
 */
async function cmdProvenance(args: Args): Promise<number> {
  const spec = args.positional[0];
  if (!spec) {
    throw new UsageError('provenance needs a package, e.g. `actions-attic provenance runner-drift --archive ./attic`');
  }
  const stderr = (m: string) => process.stderr.write(`${m}\n`);
  const warn = (m: string) => process.stderr.write(`warning: ${m}\n`);

  const collected = await collectProvenance(spec, {
    version: args.flags.get('version') === undefined ? null : str(args, 'version', ''),
    probeAll: args.flags.get('probe-all') === true,
    registry: str(args, 'registry', process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org'),
    log: stderr,
    warn,
  });

  let scope = args.flags.get('repo') === undefined ? null : asUsage(() => parseRepo(str(args, 'repo', '')));
  const token = findToken(args);
  const api = token === null ? null : githubApi(args, token);
  const localDir = args.flags.get('archive');

  let archive: Archive | null = null;
  let where = '';
  if (localDir !== undefined) {
    if (typeof localDir !== 'string') throw new UsageError('--archive needs a value');
    const dir = resolve(localDir);
    archive = await Archive.open(await FsBackend.open(dir), 'unknown/unknown');
    // A fresh archive has no repo in its manifest yet, and falling through with no
    // scope reads GitHub's platform default instead of the repository's own setting.
    scope ??= archiveRepo(archive) ?? soleRepo(collected, warn);
    where = ` --archive ${display(dir)}`;
  } else {
    scope ??= soleRepo(collected, warn);
    if (!api) {
      warn('no GitHub token, so the archive ref cannot be read. Pass --archive <dir>, or --token.');
    } else if (scope) {
      const ref = asUsage(() => normalizeRef(str(args, 'ref', 'refs/attic/archive')));
      const backend = await RefBackend.open(api, scope.owner, scope.repo, ref);
      if (backend.isNew) stderr(`${scope.owner}/${scope.repo} has no archive at ${ref} yet`);
      archive = await Archive.open(backend, `${scope.owner}/${scope.repo}`);
    }
  }

  // Without an archive there is nothing to check against, and a gate that passes
  // on no evidence is worse than one that fails.
  if (archive === null && args.flags.get('fail-on-unarchived') === true) {
    throw new UsageError(
      '--fail-on-unarchived has nothing to check against. Pass --archive <dir>, or a token so the archive ref can be read.',
    );
  }

  const retentionRaw = args.flags.get('retention-days');
  const window = await resolveRetention({
    api: scope ? api : null,
    owner: scope?.owner ?? '',
    repo: scope?.repo ?? '',
    retentionDays: retentionRaw === undefined ? null : int(args, 'retention-days', 90, 1, 3650),
    log: stderr,
    warn,
  });

  const result = await resolveProvenance({ collected, archive, scope, window });

  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const next = `actions-attic backfill ${result.repo ?? '<owner/repo>'}${where}`;
    process.stdout.write(`${formatProvenance(result, next, args.flags.get('all') === true)}\n`);
  }
  return args.flags.get('fail-on-unarchived') === true && result.unarchivedAtRisk > 0 ? 1 : 0;
}

function archiveRepo(archive: Archive): { owner: string; repo: string } | null {
  const repo = archive.manifest.repo;
  if (!repo || repo === 'unknown/unknown') return null;
  try {
    return parseRepo(repo);
  } catch {
    return null;
  }
}

/** When neither --repo nor the archive names the repository, the provenance does. */
function soleRepo(
  collected: Awaited<ReturnType<typeof collectProvenance>>,
  warn: (msg: string) => void,
): { owner: string; repo: string } | null {
  const repos = referencedRepos(collected);
  if (repos.length === 1) return parseRepo(repos[0]);
  if (repos.length > 1) {
    warn(`this package's provenance names ${repos.length} repositories (${repos.join(', ')}); pass --repo to pick one`);
  }
  return null;
}

/** The local answer for a run whose html_url the retention change has deleted. */
async function cmdShowRun(args: Args): Promise<number> {
  // Trimmed once, because the attempt suffix is matched against the same string
  // parseInvocationId parses; a pasted URL with trailing space must agree.
  const raw = args.positional[0]?.trim();
  if (!raw) throw new UsageError('show-run needs a run id, e.g. `actions-attic show-run 34307443469 --archive ./attic`');

  // The run URL is what a dangling provenance pointer hands you, so paste it
  // straight in. `/attempts/N` in the URL picks that attempt.
  const fromUrl = raw.includes('://') ? parseInvocationId(raw) : null;
  if (raw.includes('://') && !fromUrl) throw new UsageError(`"${raw}" is not an Actions run URL`);
  const id = fromUrl ? fromUrl.runId : Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new UsageError(`run id must be a positive integer, got "${raw}"`);

  const dir = resolve(str(args, 'archive', 'attic'));
  const { archive } = await openArchive(dir);
  const attempts = await archive.runAttempts(id);
  if (attempts.length === 0) {
    process.stderr.write(`run ${id} is not in the archive at ${display(dir)}\n`);
    return 1;
  }

  const held = attempts.map((r) => r.run_attempt ?? 1);
  const urlAttempt = fromUrl && /\/attempts\/\d+\/?$/.test(raw) ? fromUrl.attempt : null;
  const wanted =
    args.flags.get('attempt') === undefined ? urlAttempt : int(args, 'attempt', 1, 1, 1_000_000);
  const record = wanted === null ? attempts[attempts.length - 1] : attempts.find((r) => (r.run_attempt ?? 1) === wanted);
  if (!record) {
    process.stderr.write(`run ${id} has no attempt ${wanted} in the archive; it holds attempt ${held.join(', ')}\n`);
    return 1;
  }

  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return 0;
  }
  const rows = Object.entries(record).map(([key, value]) => [key, value === null ? '-' : String(value)]);
  process.stdout.write(`${table(rows as [string, string][])}\n`);
  if (held.length > 1) process.stdout.write(`  ${plural(held.length, 'attempt')} archived: ${held.join(', ')}\n`);
  return 0;
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
    `indexed ${plural(result.runs, 'run')}, ${plural(result.checks, 'check')}, ` +
      `${plural(result.statuses, 'status', 'statuses')} across ${plural(result.months.length, 'month')} ` +
      `into ${display(out)}\n`,
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
    process.stdout.write(`${workflow}: no completed runs in the selected window.\n${suggest(workflow, report.candidates)}\n`);
    return 1;
  }
  process.stdout.write(`${formatFlake(report)}\n`);
  return 0;
}

/** Closest workflow names first; a busy repo can hold dozens. */
function suggest(query: string, candidates: string[]): string {
  if (candidates.length === 0) return 'The archive has no runs in this window.';
  const needle = query.toLowerCase();
  const ranked = [...candidates].sort((a, b) => score(b, needle) - score(a, needle));
  const shown = ranked.slice(0, 10);
  const rest = ranked.length - shown.length;
  return (
    `Workflows in this window:\n${shown.map((c) => `  ${c}`).join('\n')}` +
    (rest > 0 ? `\n  ... and ${rest} more (--json lists them all)` : '')
  );
}

function score(name: string, needle: string): number {
  const lower = name.toLowerCase();
  if (lower === needle) return 3;
  if (lower.includes(needle)) return 2;
  return needle.split(/\s+/).some((word) => word.length > 2 && lower.includes(word)) ? 1 : 0;
}

async function cmdStats(args: Args): Promise<number> {
  const dir = resolve(str(args, 'archive', 'attic'));
  const { archive } = await openArchive(dir);
  const m = archive.manifest;
  // Reading a directory is free, so always report what is really on disk rather
  // than trusting the manifest's running total.
  const actual = await archive.recount();

  if (args.flags.get('json') === true) {
    process.stdout.write(`${JSON.stringify({ ...m, archive: dir, actualCounts: actual }, null, 2)}\n`);
    return 0;
  }

  const backfill = m.backfillComplete
    ? 'complete'
    : m.backfillFrontier
      ? `resuming before ${m.backfillFrontier}`
      : 'not started';
  const rows: [string, string][] = [
    ['repository', m.repo],
    ['archive', display(dir)],
    ['months', m.months.length ? `${m.months[0]} .. ${m.months[m.months.length - 1]}  (${m.months.length})` : 'none'],
    ['runs', count(actual.runs, m.counts.runs)],
    ['checks', count(actual.checks, m.counts.checks)],
    ['statuses', count(actual.statuses, m.counts.statuses)],
    ['highest run id', m.highestRunId === null ? '-' : String(m.highestRunId)],
    ['backfill', backfill],
    ['last change', m.lastRun ?? '-'],
    ['schema', `v${m.schemaVersion}`],
  ];
  process.stdout.write(`${table(rows)}\n`);
  return 0;
}

function count(actual: number, claimed: number): string {
  const n = actual.toLocaleString('en-US');
  return actual === claimed ? n : `${n}  (manifest says ${claimed.toLocaleString('en-US')}; run sync to reconcile)`;
}

/** Two aligned columns. Keeps `stats` readable when a value is long. */
function table(rows: [string, string][]): string {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}   ${value}`).join('\n');
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
  // `--version` after a command belongs to that command, so `provenance pkg --version`
  // with no value is that command's usage error, not a silent version print.
  const wantsVersion = args.flags.get('version') === true || args.flags.get('v') === true;
  if (args.command === 'version' || (args.command === null && wantsVersion)) {
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
    case 'pull':
      return cmdPull(args);
    case 'preflight':
      return cmdPreflight(args);
    case 'provenance':
      return cmdProvenance(args);
    case 'show-run':
      return cmdShowRun(args);
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
    if (err instanceof NetworkError || err instanceof RegistryError) {
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
