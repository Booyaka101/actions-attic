/**
 * Which published npm versions hold a signed pointer at a workflow run, and
 * whether the attic still has that run.
 *
 * A package published with provenance carries a SLSA v1 in-toto statement whose
 * `runDetails.metadata.invocationId` is the Actions run URL: `server_url` +
 * repository + `/actions/runs/` + `run_id` + `/attempts/` + `run_attempt`, as
 * the GitHub Actions build type specifies. SLSA's own words for the field are
 * that it "can be useful for finding associated logs or other ad-hoc analysis".
 *
 * The 2026-10-01 retention change does not touch the signature. Verifying a
 * package never fetches the run, so verification keeps working. What breaks is
 * the audit trail the pointer names: from that date the URL resolves to a 404
 * for every version whose run is older than the retention window.
 */

import type { Archive, RunRecord } from './archive.js';
import { type Month, monthOf } from './months.js';
import { type RetentionWindow, retentionLines } from './preflight.js';

export const REGISTRY = 'https://registry.npmjs.org';
export const SLSA_PREDICATE = 'https://slsa.dev/provenance/v1';
/** What npm published until early 2024. Still the only provenance older versions have. */
export const SLSA_V02_PREDICATE = 'https://slsa.dev/provenance/v0.2';
export const NPM_PUBLISH_PREDICATE = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';

/** What the invocationId points at, once parsed. */
export interface RunPointer {
  host: string;
  owner: string;
  repo: string;
  runId: number;
  attempt: number;
  url: string;
}

export type VersionState =
  /** The run attempt is in the attic. */
  | 'archived'
  /** In scope and inside the attic's range, but not there. */
  | 'missing'
  /** Older than the backfill has reached, so the attic never had it. */
  | 'before-archive'
  /** The run belongs to a repository this archive does not cover. */
  | 'out-of-scope'
  /** No archive was available to compare against. */
  | 'no-archive'
  /** Published without provenance, so it names no run. */
  | 'no-provenance'
  /** An attestation exists but no run could be read out of it. */
  | 'unreadable';

export interface VersionReport {
  version: string;
  /** When npm recorded the publish; the closest stand-in for an unarchived run. */
  publishedAt: string | null;
  state: VersionState;
  /** Why a version is unreadable, or which attempts the attic does hold. */
  note: string | null;
  run: RunPointer | null;
  /** `created_at` off the archived record, null when the run is not archived. */
  runCreatedAt: string | null;
  /** Created before the cutoff, so the retention change deletes it. */
  deleted: boolean;
  /** Deleted and not in the attic: the pointer is about to dangle. */
  atRisk: boolean;
}

export interface ProvenanceCounts {
  archived: number;
  missing: number;
  beforeArchive: number;
  outOfScope: number;
  noArchive: number;
  noProvenance: number;
  unreadable: number;
}

export interface ProvenanceResult extends Omit<RetentionWindow, 'repoCreatedAt'> {
  package: string;
  registry: string;
  /** The repository the archive covers, when one is known. */
  repo: string | null;
  versions: number;
  withProvenance: number;
  /** Oldest month the backfill has reached, which bounds what can be found. */
  archiveOldestMonth: Month | null;
  counts: ProvenanceCounts;
  /** Unarchived runs the 2026-10-01 change deletes. */
  unarchivedAtRisk: number;
  /** Unarchived runs that survive 2026-10-01 and age out afterwards. */
  unarchivedLater: number;
  /** Repositories named by provenance that this archive does not cover. */
  otherRepos: string[];
  reports: VersionReport[];
}

export class RegistryError extends Error {
  readonly url: string;
  readonly status: number | null;
  constructor(message: string, url: string, status: number | null) {
    super(message);
    this.name = 'RegistryError';
    this.url = url;
    this.status = status;
  }
}

export interface RegistryOptions {
  registry?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

interface Client {
  registry: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

function client(opts: RegistryOptions): Client {
  return {
    registry: (opts.registry ?? process.env.NPM_CONFIG_REGISTRY ?? REGISTRY).replace(/\/+$/, ''),
    fetchImpl: opts.fetchImpl ?? fetch,
    sleep: opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
    timeoutMs: opts.timeoutMs ?? 20_000,
    log: opts.log ?? (() => {}),
    warn: opts.warn ?? (() => {}),
  };
}

/** npm's own name rules, loosely: no spaces, no path tricks, one optional scope. */
const NAME_RE = /^(?:@[^/\s@]+\/)?[^/\s@]+$/;

export function assertPackageName(name: string): string {
  if (!NAME_RE.test(name) || name.startsWith('.') || name.startsWith('_') || name.includes('..')) {
    throw new RegistryError(`"${name}" is not a valid npm package name`, '', null);
  }
  return name;
}

/** `pkg`, `pkg@1.2.3`, `@scope/pkg` and `@scope/pkg@1.2.3` all parse. */
export function parsePackageSpec(spec: string): { name: string; version: string | null } {
  const at = spec.lastIndexOf('@');
  if (at > 0) return { name: assertPackageName(spec.slice(0, at)), version: spec.slice(at + 1) || null };
  return { name: assertPackageName(spec), version: null };
}

/** A scope's slash has to be encoded; npm serves both forms, tests pin one. */
export function packumentUrl(registry: string, name: string): string {
  return `${registry}/${encodeURIComponent(name)}`;
}

export function attestationsUrl(registry: string, name: string, version: string): string {
  return `${registry}/-/npm/v1/attestations/${encodeURIComponent(`${name}@${version}`)}`;
}

/** GET one JSON document. A 404 is an answer here, not a failure. */
async function getJson(c: Client, url: string): Promise<unknown | null> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await c.fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'actions-attic' },
        signal: AbortSignal.timeout(c.timeoutMs),
      });
    } catch (err) {
      if (attempt < 3) {
        await c.sleep(500 * attempt);
        continue;
      }
      const why = err instanceof Error ? err.message : String(err);
      throw new RegistryError(`could not reach ${url} (${why}). Check your network or proxy settings.`, url, null);
    }

    if (res.status === 404) return null;

    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '0');
      const wait = retryAfter > 0 && retryAfter <= 30 ? retryAfter * 1000 : 500 * attempt;
      c.warn(`the registry returned ${res.status} for ${url}; retrying in ${Math.round(wait / 1000)}s`);
      await c.sleep(wait);
      continue;
    }

    const text = await res.text();
    if (!res.ok) {
      const detail = text.trim().slice(0, 200);
      throw new RegistryError(
        `the registry returned ${res.status} for ${url}${detail ? `: ${detail}` : ''}`,
        url,
        res.status,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RegistryError(`the registry returned something that is not JSON for ${url}`, url, res.status);
    }
  }
}

interface Packument {
  versions: Record<string, { dist?: { attestations?: { url?: string } } }>;
  time: Record<string, string>;
}

export async function fetchPackument(name: string, opts: RegistryOptions = {}): Promise<Packument> {
  const c = client(opts);
  const url = packumentUrl(c.registry, assertPackageName(name));
  const data = (await getJson(c, url)) as Packument | null;
  if (!data) throw new RegistryError(`no package named "${name}" on ${c.registry}`, url, 404);
  if (!data.versions || typeof data.versions !== 'object') {
    throw new RegistryError(`${name} has no version list on ${c.registry}`, url, null);
  }
  return { versions: data.versions, time: data.time ?? {} };
}

/**
 * Read the run out of an attestations document. Everything that can go wrong
 * with someone else's signed payload gets a reason rather than a throw: a
 * bundle with only npm's publish attestation, a payload that is not base64,
 * JSON that is not an in-toto statement, an invocationId that is not a run URL.
 */
export function extractRunPointer(doc: unknown): { run: RunPointer | null; note: string | null } {
  const list = (doc as { attestations?: unknown } | null)?.attestations;
  if (!Array.isArray(list) || list.length === 0) return { run: null, note: 'the attestations document is empty' };

  const slsa = list.find((a) => READERS.has((a as { predicateType?: unknown })?.predicateType as string));
  if (!slsa) {
    const seen = list
      .map((a) => (a as { predicateType?: unknown })?.predicateType)
      .filter((t): t is string => typeof t === 'string');
    const only = seen.length === 1 && seen[0] === NPM_PUBLISH_PREDICATE ? ' (only npm publish)' : '';
    return { run: null, note: `no SLSA provenance statement in the bundle${only}` };
  }

  const payload = (slsa as { bundle?: { dsseEnvelope?: { payload?: unknown } } }).bundle?.dsseEnvelope?.payload;
  if (typeof payload !== 'string' || payload === '') return { run: null, note: 'the DSSE envelope carries no payload' };

  let statement: { predicate?: unknown };
  try {
    const json = Buffer.from(payload, 'base64').toString('utf8');
    statement = JSON.parse(json) as typeof statement;
  } catch {
    return { run: null, note: 'the DSSE payload is not base64-encoded JSON' };
  }

  const read = READERS.get((slsa as { predicateType: string }).predicateType);
  return read!(statement?.predicate);
}

/** SLSA v1 names the run URL outright. */
function readSlsaV1(predicate: unknown): { run: RunPointer | null; note: string | null } {
  const invocationId = (predicate as { runDetails?: { metadata?: { invocationId?: unknown } } })?.runDetails?.metadata
    ?.invocationId;
  if (typeof invocationId !== 'string' || invocationId === '') {
    return { run: null, note: 'the SLSA statement has no runDetails.metadata.invocationId' };
  }
  const run = parseInvocationId(invocationId);
  return run ? { run, note: null } : { run: null, note: `invocationId is not an Actions run URL: ${invocationId}` };
}

const CONFIG_SOURCE_RE = /^git\+(https?:\/\/[^/]+)\/([^/]+)\/([^/@]+?)(?:\.git)?(?:@|$)/;
const BUILD_INVOCATION_RE = /^(\d+)-(\d+)$/;

/** The first of the two places v0.2 keeps a number that actually parses. */
const firstInt = (...values: (string | undefined)[]): number => {
  for (const value of values) {
    const parsed = Number(value);
    if (value !== undefined && value !== '' && Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return Number.NaN;
};

/**
 * SLSA v0.2 names no run URL. It carries the Actions environment instead, which
 * the build type spec turns into the same URL. `metadata.buildInvocationId` is
 * `<run id>-<attempt>` and `invocation.configSource.uri` is the git remote, so a
 * bundle that omits the environment block still resolves.
 */
function readSlsaV02(predicate: unknown): { run: RunPointer | null; note: string | null } {
  const p = predicate as {
    invocation?: { configSource?: { uri?: unknown }; environment?: Record<string, unknown> };
    metadata?: { buildInvocationId?: unknown };
  };
  const env = p?.invocation?.environment ?? {};
  const uri = typeof p?.invocation?.configSource?.uri === 'string' ? p.invocation.configSource.uri : '';
  const source = CONFIG_SOURCE_RE.exec(uri);
  const build = BUILD_INVOCATION_RE.exec(typeof p?.metadata?.buildInvocationId === 'string' ? p.metadata.buildInvocationId : '');

  const slug = typeof env.GITHUB_REPOSITORY === 'string' ? env.GITHUB_REPOSITORY.split('/') : null;
  const owner = slug?.length === 2 ? slug[0] : source?.[2];
  const repo = slug?.length === 2 ? slug[1] : source?.[3];
  const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const runId = firstInt(str(env.GITHUB_RUN_ID), build?.[1]);
  const attempt = firstInt(str(env.GITHUB_RUN_ATTEMPT), build?.[2]) || 1;

  if (!owner || !repo || !Number.isSafeInteger(runId)) {
    return { run: null, note: 'the SLSA v0.2 statement names no Actions run' };
  }
  const host = source?.[1] ?? 'https://github.com';
  return { run: { host, owner, repo, runId, attempt, url: runUrl(host, owner, repo, runId, attempt) }, note: null };
}

const READERS = new Map([
  [SLSA_PREDICATE, readSlsaV1],
  [SLSA_V02_PREDICATE, readSlsaV02],
]);

/** The URL the GitHub Actions build type specifies for a run attempt. */
export function runUrl(host: string, owner: string, repo: string, runId: number, attempt: number): string {
  return `${host}/${owner}/${repo}/actions/runs/${runId}/attempts/${attempt}`;
}

const INVOCATION_RE = /^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?\/?$/;

/** The format the GitHub Actions build type specifies, attempt optional. */
export function parseInvocationId(url: string): RunPointer | null {
  const m = INVOCATION_RE.exec(url.trim());
  if (!m) return null;
  const runId = Number(m[4]);
  if (!Number.isSafeInteger(runId)) return null;
  return { host: m[1], owner: m[2], repo: m[3], runId, attempt: m[5] ? Number(m[5]) : 1, url: url.trim() };
}

export interface CollectOptions extends RegistryOptions {
  /** Only this version, instead of every published one. */
  version?: string | null;
  /**
   * Hit the attestations endpoint for every version, rather than only those the
   * packument advertises an attestation for. Slower; a way to double-check npm.
   */
  probeAll?: boolean;
}

export interface CollectedVersion {
  version: string;
  publishedAt: string | null;
  /** The packument said an attestation exists, or --probe-all found one. */
  hasAttestation: boolean;
  run: RunPointer | null;
  note: string | null;
}

export interface Collected {
  package: string;
  registry: string;
  versions: CollectedVersion[];
}

/**
 * Registry half of the job: every published version, newest publish first, with
 * the run its provenance names. Nothing here touches the archive or GitHub.
 */
export async function collectProvenance(spec: string, opts: CollectOptions = {}): Promise<Collected> {
  const c = client(opts);
  const { name, version: pinned } = parsePackageSpec(spec);
  const packument = await fetchPackument(name, opts);

  let names = Object.keys(packument.versions);
  if (opts.version ?? pinned) {
    const wanted = (opts.version ?? pinned) as string;
    if (!names.includes(wanted)) {
      throw new RegistryError(`${name} has no version ${wanted} on ${c.registry}`, packumentUrl(c.registry, name), 404);
    }
    names = [wanted];
  }
  // Publish order, newest first. The packument's key order is not guaranteed
  // and semver ordering would need a parser this package does not carry.
  names.sort((a, b) => (packument.time[a] ?? '').localeCompare(packument.time[b] ?? '')).reverse();

  const probes = names.filter((v) => opts.probeAll || packument.versions[v]?.dist?.attestations?.url !== undefined);
  if (probes.length > 1) c.log(`${name}: reading attestations for ${probes.length} of ${names.length} versions`);

  const versions: CollectedVersion[] = [];
  for (const version of names) {
    const publishedAt = packument.time[version] ?? null;
    // The packument says up front which versions have an attestation, so the
    // endpoint is only asked about those. The URL is always built from the
    // configured registry rather than the one the packument names, so --registry
    // still points at a mirror. --probe-all asks about every version instead.
    const advertised = packument.versions[version]?.dist?.attestations?.url !== undefined;
    if (!advertised && !opts.probeAll) {
      versions.push({ version, publishedAt, hasAttestation: false, run: null, note: null });
      continue;
    }
    const doc = await getJson(c, attestationsUrl(c.registry, name, version));
    if (doc === null) {
      // Advertised but not served: npm is still processing the publish, or the
      // attestation was withdrawn. Either way there is no pointer to follow.
      const note = advertised ? 'the attestations endpoint returned 404 for this version' : null;
      versions.push({ version, publishedAt, hasAttestation: false, run: null, note });
      continue;
    }
    const { run, note } = extractRunPointer(doc);
    versions.push({ version, publishedAt, hasAttestation: true, run, note });
  }

  return { package: name, registry: c.registry, versions };
}

/** Every distinct repository the collected provenance names, `owner/repo`. */
export function referencedRepos(collected: Collected): string[] {
  const seen = new Set<string>();
  for (const v of collected.versions) {
    if (v.run) seen.add(`${v.run.owner}/${v.run.repo}`);
  }
  return [...seen].sort();
}

export interface ResolveOptions {
  collected: Collected;
  /** Null when there is nothing to compare against. */
  archive: Archive | null;
  /** The repository the archive covers; any other is reported out of scope. */
  scope: { owner: string; repo: string } | null;
  window: Omit<RetentionWindow, 'repoCreatedAt'>;
}

/** Cross-reference the collected runs with the attic. */
export async function resolveProvenance(opts: ResolveOptions): Promise<ProvenanceResult> {
  const { collected, archive, scope, window } = opts;
  const oldest = archive?.manifest.backfillOldestMonth ?? null;
  const counts: ProvenanceCounts = {
    archived: 0,
    missing: 0,
    beforeArchive: 0,
    outOfScope: 0,
    noArchive: 0,
    noProvenance: 0,
    unreadable: 0,
  };
  const reports: VersionReport[] = [];
  let withProvenance = 0;

  for (const v of collected.versions) {
    const base = { version: v.version, publishedAt: v.publishedAt, run: v.run, note: v.note };
    if (!v.hasAttestation) {
      counts.noProvenance++;
      reports.push({ ...base, state: 'no-provenance', runCreatedAt: null, deleted: false, atRisk: false });
      continue;
    }
    withProvenance++;
    if (!v.run) {
      counts.unreadable++;
      reports.push({ ...base, state: 'unreadable', runCreatedAt: null, deleted: false, atRisk: false });
      continue;
    }

    const { state, runCreatedAt, note } = await placeRun(v.run, archive, scope, oldest, v.publishedAt);
    const when = runCreatedAt ?? v.publishedAt;
    // A registry with no `time` map leaves the date unknown. Unknown counts as due,
    // because a tool that exists to warn must not report a run as safe on no evidence.
    const deleted = state !== 'out-of-scope' && (when === null || when < window.cutoffIso);
    const atRisk = deleted && (state === 'missing' || state === 'before-archive');
    const undated = when === null && state !== 'out-of-scope' ? 'no publish date on this registry, so this counts as due' : null;
    counts[COUNT_KEY[state]]++;
    reports.push({ ...base, note: note ?? v.note ?? undated, state, runCreatedAt, deleted, atRisk });
  }

  const unarchived = reports.filter((r) => r.state === 'missing' || r.state === 'before-archive');
  const { retentionDays, retentionSource, cutoffIso, deletionDate } = window;
  return {
    retentionDays,
    retentionSource,
    cutoffIso,
    deletionDate,
    package: collected.package,
    registry: collected.registry,
    repo: scope ? `${scope.owner}/${scope.repo}` : null,
    versions: collected.versions.length,
    withProvenance,
    archiveOldestMonth: oldest,
    counts,
    unarchivedAtRisk: unarchived.filter((r) => r.atRisk).length,
    unarchivedLater: unarchived.filter((r) => !r.atRisk).length,
    otherRepos: [
      ...new Set(reports.filter((r) => r.state === 'out-of-scope').map((r) => `${r.run!.owner}/${r.run!.repo}`)),
    ].sort(),
    reports,
  };
}

const COUNT_KEY: Record<VersionState, keyof ProvenanceCounts> = {
  archived: 'archived',
  missing: 'missing',
  'before-archive': 'beforeArchive',
  'out-of-scope': 'outOfScope',
  'no-archive': 'noArchive',
  'no-provenance': 'noProvenance',
  unreadable: 'unreadable',
};

/** Where one run sits relative to the attic: found, never covered, or elsewhere. */
async function placeRun(
  run: RunPointer,
  archive: Archive | null,
  scope: { owner: string; repo: string } | null,
  oldest: Month | null,
  publishedAt: string | null,
): Promise<{ state: VersionState; runCreatedAt: string | null; note: string | null }> {
  const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (scope && !(sameRepo(run.owner, scope.owner) && sameRepo(run.repo, scope.repo))) {
    return { state: 'out-of-scope', runCreatedAt: null, note: `run belongs to ${run.owner}/${run.repo}` };
  }
  if (!archive) return { state: 'no-archive', runCreatedAt: null, note: null };

  const attempts = await archive.runAttempts(run.runId);
  const exact = attempts.find((r: RunRecord) => (r.run_attempt ?? 1) === run.attempt);
  if (exact) return { state: 'archived', runCreatedAt: exact.created_at, note: null };

  if (attempts.length > 0) {
    const held = attempts.map((r) => r.run_attempt ?? 1).join(', ');
    return {
      state: 'missing',
      runCreatedAt: null,
      note: `attempt ${run.attempt} is not archived; the attic holds attempt ${held}`,
    };
  }
  if (oldest && publishedAt && monthOf(publishedAt) < oldest) {
    return {
      state: 'before-archive',
      runCreatedAt: null,
      note: `published before ${oldest}, the oldest month the backfill has reached`,
    };
  }
  return { state: 'missing', runCreatedAt: null, note: null };
}

const n = (value: number) => value.toLocaleString('en-US');
const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;
/** Verb or pronoun agreeing with a count that is the subject of the sentence. */
const agree = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** The at-risk cell for a version the cutoff spares; `atRisk` overrides it with YES. */
const AT_RISK: Record<VersionState, string> = {
  archived: 'no',
  missing: 'later',
  'before-archive': 'later',
  'out-of-scope': '-',
  'no-archive': '?',
  'no-provenance': '-',
  unreadable: '-',
};

const ARCHIVED: Record<VersionState, string> = {
  archived: 'yes',
  missing: 'no',
  'before-archive': 'no',
  'out-of-scope': '-',
  'no-archive': '?',
  'no-provenance': '-',
  unreadable: '-',
};

/** The two verdict cells for one version, so the table and the job summary agree. */
/**
 * The notes worth printing, for the report and the job summary alike. Out-of-scope
 * notes only repeat the repository the row and the verdict already name. Everything
 * else stays, including the versions the table leaves out: a version npm advertises
 * an attestation for and then 404s counts as no-provenance, and its note is the one
 * signal that it was skipped.
 */
export function notesFor(result: ProvenanceResult): VersionReport[] {
  return result.reports.filter((r) => r.note && r.state !== 'out-of-scope');
}

export function stateCells(r: VersionReport): { archived: string; atRisk: string } {
  return {
    archived: ARCHIVED[r.state],
    atRisk: r.atRisk ? 'YES' : AT_RISK[r.state],
  };
}

/** Left-aligned columns, sized to their contents. */
function columns(rows: string[][]): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ').trimEnd());
}

/**
 * Plain-text report. `nextCommand` is what to run when something is unarchived;
 * `showAll` adds the versions published without provenance.
 */
export function formatProvenance(result: ProvenanceResult, nextCommand: string, showAll = false): string {
  const lines = [
    `${result.package}: ${plural(result.versions, 'published version')}, ${n(result.withProvenance)} with provenance`,
    ...retentionLines(result, 'runs'),
  ];

  const shown = result.reports.filter((r) => showAll || r.state !== 'no-provenance');
  if (shown.length > 0) {
    const rows = [['version', 'run', 'created', 'archived', 'at risk']];
    for (const r of shown) {
      const cells = stateCells(r);
      rows.push([
        r.version,
        r.run ? `${r.run.owner}/${r.run.repo} #${r.run.runId}/${r.run.attempt}` : '-',
        (r.runCreatedAt ?? r.publishedAt ?? '-').slice(0, 10),
        cells.archived,
        cells.atRisk,
      ]);
    }
    lines.push('', ...columns(rows));
  }

  const notes = notesFor(result);
  if (notes.length > 0) lines.push('', ...notes.map((r) => `${r.version}: ${r.note}`));

  lines.push('', ...verdict(result, nextCommand));
  return lines.join('\n');
}

/** The closing sentences: what is at risk, what is elsewhere, what to do about it. */
export function verdict(result: ProvenanceResult, nextCommand: string): string[] {
  const lines: string[] = [];
  if (result.withProvenance === 0) {
    lines.push(`No published version of ${result.package} carries provenance, so none of them names a workflow run.`);
    return lines;
  }
  if (result.counts.noArchive > 0) {
    lines.push(
      `${plural(result.counts.noArchive, 'run')} named by provenance, with no archive to compare against. ` +
        'Pass --archive, or let it read the archive ref.',
    );
  }
  if (result.unarchivedAtRisk > 0) {
    const count = result.unarchivedAtRisk;
    lines.push(
      `${plural(count, 'provenance-referenced run')} ${agree(count, 'is', 'are')} not in the attic and ` +
        `will be deleted on ${result.deletionDate}.`,
      `Run: ${nextCommand}`,
    );
  } else if (result.counts.archived > 0 && result.unarchivedLater === 0) {
    lines.push(`Every provenance-referenced run for ${result.repo ?? result.package} is in the attic.`);
  }
  if (result.unarchivedLater > 0) {
    const count = result.unarchivedLater;
    lines.push(
      `${plural(count, 'run')} ${agree(count, 'survives', 'survive')} ${result.deletionDate} and ` +
        `${agree(count, 'ages', 'age')} out of the retention window afterwards; archive ` +
        `${agree(count, 'it', 'them')} before then.`,
    );
  }
  if (result.counts.beforeArchive > 0) {
    lines.push(
      `${plural(result.counts.beforeArchive, 'run')} ` +
        `${agree(result.counts.beforeArchive, 'predates', 'predate')} ${result.archiveOldestMonth}, ` +
        'the oldest month the backfill has reached. Raise --months to go further back.',
    );
  }
  if (result.otherRepos.length > 0) {
    lines.push(
      `${plural(result.counts.outOfScope, 'version')} ` +
        `${agree(result.counts.outOfScope, 'names', 'name')} a repository this archive does not cover ` +
        `(${result.otherRepos.join(', ')}); archive those separately.`,
    );
  }
  if (result.counts.unreadable > 0) {
    lines.push(`${plural(result.counts.unreadable, 'attestation')} could not be read; see the notes above.`);
  }
  return lines;
}
