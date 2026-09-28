/**
 * How much Actions history the 2026-10-01 retention change will delete, and how
 * much of it the attic already holds.
 *
 * Runs are counted from the runs endpoint's `total_count`, which is exact below
 * RUNS_COUNT_CAP. A count at the cap is split into smaller windows until each
 * one reads below it, so a busy repository costs a few more requests but the
 * number stays exact. Checks and statuses have no counting endpoint, so they
 * are read from the archive, plus a per-commit fetch for only the commits the
 * archive has not covered. A populated archive makes preflight cheap; an empty
 * one costs roughly what the backfill it recommends would.
 */

import { Api, BudgetExhausted, type RetentionSettings } from './api.js';
import type { Archive, CheckRecord, RunRecord, StatusRecord } from './archive.js';
import { captureShas, captureWindow, makeContext } from './collect.js';
import {
  type Month,
  type Window,
  formatWindow,
  indexToMonth,
  monthOf,
  monthToIndex,
  monthWindow,
  splitWindow,
  toInstant,
} from './months.js';

export const DELETION_DATE = '2026-10-01';
/**
 * Since 2026-09-25 a filtered runs query reports at most this in `total_count`,
 * so a count at this value means "this many or more".
 * https://github.blog/changelog/2026-09-25-changes-to-query-results-in-the-github-actions-api-and-ui
 */
export const RUNS_COUNT_CAP = 2500;
/** Nothing on GitHub Actions is older than this. */
const ACTIONS_EPOCH = '2018-01-01T00:00:00Z';
/** GitHub's platform default for every repository. 400 is only the private-repo maximum. */
export const DEFAULT_RETENTION_DAYS = 90;
export const PUBLIC_MAX_RETENTION_DAYS = 90;

export type RetentionSource = 'flag' | 'api' | 'default';

export interface Tally {
  runs: number;
  checks: number;
  statuses: number;
}

export interface RetentionOptions {
  /** Null when no token is available; the platform default is used instead. */
  api: Api | null;
  owner: string;
  repo: string;
  /** An explicit --retention-days value, which outranks the API. */
  retentionDays?: number | null;
  now?: Date;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface RetentionWindow {
  retentionDays: number;
  retentionSource: RetentionSource;
  /** Records created before this instant are deleted once the change lands. */
  cutoffIso: string;
  deletionDate: string;
  /** When the repository itself was created, when the API said. */
  repoCreatedAt: string | null;
}

export interface PreflightOptions extends RetentionOptions {
  api: Api;
  archive: Archive;
}

export interface PreflightResult extends Omit<RetentionWindow, 'repoCreatedAt'> {
  atRisk: Tally;
  archived: Tally;
  unarchived: Tally & { total: number };
}

/** The raw `total_count` for one `created=` filter, capped at RUNS_COUNT_CAP. */
async function totalCount(api: Api, owner: string, repo: string, created: string): Promise<number> {
  const { data } = await api.request<{ total_count?: unknown }>(`/repos/${owner}/${repo}/actions/runs`, {
    params: { created, per_page: 1 },
  });
  return typeof data?.total_count === 'number' ? data.total_count : 0;
}

/**
 * Runs created inside `window`, counted exactly: a total at RUNS_COUNT_CAP is
 * halved with splitWindow and both halves counted. Only a one-second window
 * still at the cap cannot be split, and that one is returned as a lower bound.
 * Both bounds must be dates or both instants: after an instant start, GitHub
 * reads a date end as that day's midnight.
 */
export async function countRunsExact(
  api: Api,
  owner: string,
  repo: string,
  window: Window,
  warn: (msg: string) => void = () => {},
): Promise<number> {
  const total = await totalCount(api, owner, repo, formatWindow(window));
  if (total < RUNS_COUNT_CAP) return total;
  const halves = splitWindow(window);
  if (!halves) {
    warn(`${formatWindow(window)} has at least ${RUNS_COUNT_CAP} runs in one second; counting ${total}, a lower bound`);
    return total;
  }
  let sum = 0;
  for (const half of halves) sum += await countRunsExact(api, owner, repo, half, warn);
  return sum;
}

/** Runs created before `month`, exact past the cap by counting up from ACTIONS_EPOCH. */
async function countRunsBefore(
  api: Api,
  owner: string,
  repo: string,
  month: Month,
  warn: (msg: string) => void,
): Promise<number> {
  const before = `${month}-01T00:00:00Z`;
  const total = await totalCount(api, owner, repo, `<${before}`);
  if (total < RUNS_COUNT_CAP) return total;
  return countRunsExact(api, owner, repo, { start: ACTIONS_EPOCH, end: toInstant(Date.parse(before) - 1000) }, warn);
}

function outOfBudget(api: Api): Error {
  return new Error(
    `preflight ran out of request budget after ${api.requests} requests` +
      `${api.exhaustReason() ? ` (${api.exhaustReason()})` : ''}. ` +
      'Raise --max-requests, or run `actions-attic backfill` first so preflight can count from the archive instead.',
  );
}

/**
 * The window the 2026-10-01 change will enforce: an explicit override, else the
 * repository's own artifact-and-log retention setting, else GitHub's platform
 * default, clamped to the repository maximum and to 90 days when it is public.
 *
 * Shared by `preflight` and `provenance`, so there is one answer to what gets
 * deleted and when.
 */
export async function resolveRetention(opts: RetentionOptions): Promise<RetentionWindow> {
  const log = opts.log ?? (() => {});
  const warn = opts.warn ?? (() => {});
  const now = opts.now ?? new Date();

  let isPublic = false;
  let repoCreatedAt: string | null = null;
  let settings: RetentionSettings | null = null;
  if (opts.api) {
    const info = await opts.api.request<{ visibility?: string; created_at?: string }>(
      `/repos/${opts.owner}/${opts.repo}`,
    );
    isPublic = info.data?.visibility === 'public';
    repoCreatedAt = typeof info.data?.created_at === 'string' ? info.data.created_at : null;
    settings = await opts.api.getRetentionSettings(opts.owner, opts.repo);
  }

  let retentionDays: number;
  let retentionSource: RetentionSource;
  if (opts.retentionDays != null) {
    retentionDays = opts.retentionDays;
    retentionSource = 'flag';
  } else if (settings) {
    retentionDays = settings.days;
    retentionSource = 'api';
  } else {
    retentionDays = DEFAULT_RETENTION_DAYS;
    retentionSource = 'default';
    warn(
      (opts.api
        ? 'the retention settings endpoint was not readable with this token (classic PATs need the repo scope); '
        : opts.owner === ''
          ? 'no repository to read the retention setting from; '
          : "no GitHub token, so the repository's own retention setting could not be read; ") +
        `assuming GitHub's ${DEFAULT_RETENTION_DAYS}-day platform default`,
    );
  }
  if (settings?.maximumAllowedDays != null && retentionDays > settings.maximumAllowedDays) {
    log(`${retentionDays} days is above this repository's maximum of ${settings.maximumAllowedDays}; using the maximum`);
    retentionDays = settings.maximumAllowedDays;
  }
  if (isPublic && retentionDays > PUBLIC_MAX_RETENTION_DAYS) {
    log(`public repositories cap at ${PUBLIC_MAX_RETENTION_DAYS} days; clamping ${retentionDays}`);
    retentionDays = PUBLIC_MAX_RETENTION_DAYS;
  }

  return {
    retentionDays,
    retentionSource,
    cutoffIso: toInstant(now.getTime() - retentionDays * 86_400_000),
    deletionDate: DELETION_DATE,
    repoCreatedAt,
  };
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightResult> {
  try {
    return await preflight(opts);
  } catch (err) {
    // Unlike sync, preflight keeps no checkpoint, so a budget stop is an error
    // with advice rather than a "resume later".
    if (err instanceof BudgetExhausted) throw outOfBudget(opts.api);
    throw err;
  }
}

async function preflight(opts: PreflightOptions): Promise<PreflightResult> {
  const log = opts.log ?? (() => {});
  const warn = opts.warn ?? (() => {});
  const { api, archive, owner, repo } = opts;

  const retention = await resolveRetention(opts);
  const { retentionDays, retentionSource, cutoffIso } = retention;
  const cutoffMonth = monthOf(cutoffIso);

  const ctx = makeContext({ api, archive, owner, repo, skipChecks: false, skipStatuses: false, log, warn });

  // What the archive already holds from before the cutoff. A check that never
  // started has no date of its own; its month file places it before the cutoff.
  const archived: Tally = { runs: 0, checks: 0, statuses: 0 };
  const archivedRunIds = new Map<Month, Set<number>>();
  const pendingShas = new Map<string, Month>();
  const archiveMonths = archive.months().filter((m) => m <= cutoffMonth);
  for (const month of archiveMonths) {
    const ids = new Set<number>();
    const done = await archive.shasDone(month);
    for (const run of await archive.read<RunRecord>('runs', month)) {
      if (run.created_at >= cutoffIso) continue;
      ids.add(run.id);
      if (run.head_sha && !done.has(run.head_sha) && !pendingShas.has(run.head_sha)) {
        pendingShas.set(run.head_sha, month);
      }
    }
    archivedRunIds.set(month, ids);
    archived.runs += ids.size;
    for (const check of await archive.read<CheckRecord>('checks', month)) {
      const date = check.started_at ?? check.completed_at;
      if (!date || date < cutoffIso) archived.checks++;
    }
    for (const status of await archive.read<StatusRecord>('statuses', month)) {
      if (!status.created_at || status.created_at < cutoffIso) archived.statuses++;
    }
  }

  // Below the cap the open-ended count is exact, and when it matches the archive
  // it is the only request. Otherwise one count per month localizes the gap and
  // only the mismatched months pay for a full listing. The skips further down
  // apply only past the cap, so uncapped requests stay exactly what 1.4.0 made.
  let atRiskRuns = await totalCount(api, owner, repo, `<${cutoffIso}`);
  const capped = atRiskRuns >= RUNS_COUNT_CAP;

  const candidates = [...archiveMonths];
  if (retention.repoCreatedAt) candidates.push(monthOf(retention.repoCreatedAt));
  // No later than the cutoff month, or a repository created after it would count
  // its own newer runs as predating it.
  const oldest = candidates.reduce((a, b) => (a < b ? a : b), cutoffMonth);
  const firstMonth = capped && oldest < monthOf(ACTIONS_EPOCH) ? monthOf(ACTIONS_EPOCH) : oldest;
  const months: Month[] = [];
  for (let i = monthToIndex(firstMonth); i <= monthToIndex(cutoffMonth); i++) months.push(indexToMonth(i));
  const atRiskWindow = (month: Month): Window => {
    const { start, end } = monthWindow(month);
    return {
      start: `${start}T00:00:00Z`,
      end: month === cutoffMonth ? toInstant(Date.parse(cutoffIso) - 1000) : `${end}T23:59:59Z`,
    };
  };

  // Actions often starts years after the repository does. Once the first month
  // reads empty, a binary search finds how many after it are empty too, so that
  // stretch costs a few requests rather than one a month.
  const emptyLead = async (rest: Month[]): Promise<number> => {
    let lo = 0;
    let hi = rest.length;
    while (hi - lo >= 4) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const span = { start: atRiskWindow(rest[lo]).start, end: atRiskWindow(rest[mid - 1]).end };
      if ((await totalCount(api, owner, repo, formatWindow(span))) > 0) hi = mid;
      else lo = mid;
    }
    return lo;
  };

  let unarchivedRuns = 0;
  if (capped || atRiskRuns !== archived.runs) {
    if (capped) log(`GitHub stops counting at ${RUNS_COUNT_CAP.toLocaleString('en-US')}; counting runs month by month`);
    // Clamped to ACTIONS_EPOCH, there is nothing older to count.
    const preScope = firstMonth > oldest ? 0 : await countRunsBefore(api, owner, repo, firstMonth, warn);
    if (preScope > 0) {
      // Runs from before the repository's own creation date (a transferred
      // repo). Nothing this old is archived, and without listing them their
      // checks and statuses cannot be counted.
      warn(`${preScope} runs predate ${firstMonth}; counting them as unarchived without their checks and statuses`);
      unarchivedRuns += preScope;
    }

    // GitHub's counts can briefly disagree with each other, so report the sum
    // the unarchived runs were reconciled against rather than the open-ended one.
    atRiskRuns = preScope;
    for (let i = 0; i < months.length; i++) {
      const month = months[i];
      const ids = archivedRunIds.get(month) ?? new Set<number>();
      const remote = await countRunsExact(api, owner, repo, atRiskWindow(month), warn);
      atRiskRuns += remote;
      if (capped && i === 0 && remote === 0) i += await emptyLead(months.slice(1));
      // Nothing on GitHub is nothing unarchived, whatever the attic kept of the month.
      if (remote === ids.size || (capped && remote === 0)) continue;

      const listed: RunRecord[] = [];
      const res = await captureWindow(ctx, monthWindow(month), {
        store: async (batch) => {
          listed.push(...batch);
        },
      });
      if (!res.complete) throw outOfBudget(api);
      const done = await archive.shasDone(month);
      for (const run of listed) {
        if (run.created_at >= cutoffIso || ids.has(run.id)) continue;
        ids.add(run.id); // a re-attempted run appears once per attempt in the listing
        unarchivedRuns++;
        if (run.head_sha && !done.has(run.head_sha) && !pendingShas.has(run.head_sha)) {
          pendingShas.set(run.head_sha, month);
        }
      }
    }
  }

  // Checks and statuses for commits the archive has not fetched yet.
  const fresh: Tally = { runs: 0, checks: 0, statuses: 0 };
  if (pendingShas.size > 0) {
    log(`fetching checks/statuses for ${pendingShas.size} commit${pendingShas.size === 1 ? '' : 's'} not yet in the archive`);
    const res = await captureShas(ctx, [...pendingShas.keys()]);
    if (!res.complete) throw outOfBudget(api);
    for (const check of res.checks) {
      const date = check.started_at ?? check.completed_at;
      if (date && date >= cutoffIso) continue;
      const month = date ? monthOf(date) : pendingShas.get(check.head_sha)!;
      if (!(await archive.keys('checks', month)).has(String(check.id))) fresh.checks++;
    }
    for (const status of res.statuses) {
      if (status.created_at && status.created_at >= cutoffIso) continue;
      const month = status.created_at ? monthOf(status.created_at) : pendingShas.get(status.head_sha)!;
      if (!(await archive.keys('statuses', month)).has(String(status.id))) fresh.statuses++;
    }
  }

  const archivedRuns = Math.max(0, atRiskRuns - unarchivedRuns);
  const unarchived = {
    runs: unarchivedRuns,
    checks: fresh.checks,
    statuses: fresh.statuses,
    total: unarchivedRuns + fresh.checks + fresh.statuses,
  };
  return {
    retentionDays,
    retentionSource,
    cutoffIso,
    deletionDate: DELETION_DATE,
    atRisk: {
      runs: atRiskRuns,
      checks: archived.checks + fresh.checks,
      statuses: archived.statuses + fresh.statuses,
    },
    archived: { runs: archivedRuns, checks: archived.checks, statuses: archived.statuses },
    unarchived,
  };
}

const n = (value: number) => value.toLocaleString('en-US');
const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`;

function tally(t: Tally): string {
  return `${plural(t.runs, 'run')}, ${plural(t.checks, 'check run')}, ${plural(t.statuses, 'status', 'statuses')}`;
}

/** How the window was decided, in the words the report uses. */
export const RETENTION_SOURCES: Record<RetentionSource, string> = {
  flag: '--retention-days',
  api: 'repository setting',
  default: 'GitHub default',
};

/** "90 days (repository setting)", so the reports and the job summaries agree. */
export function retentionPhrase(window: { retentionDays: number; retentionSource: RetentionSource }): string {
  return `${plural(window.retentionDays, 'day')} (${RETENTION_SOURCES[window.retentionSource]})`;
}

/** The two header lines every retention report opens with. */
export function retentionLines(window: Omit<RetentionWindow, 'repoCreatedAt'>, noun: string): string[] {
  return [
    `retention window: ${retentionPhrase(window)}`,
    `from ${window.deletionDate}, ${noun} created before ${window.cutoffIso} are deleted`,
  ];
}

/** Plain-text report. `nextCommand` is what to run when something is unarchived. */
export function formatPreflight(result: PreflightResult, nextCommand: string): string {
  const lines = [
    ...retentionLines(result, 'records'),
    `at risk: ${tally(result.atRisk)}`,
    `already archived: ${tally(result.archived)}`,
  ];
  if (result.unarchived.total > 0) {
    lines.push(`Unarchived and at risk: ${tally(result.unarchived)}. Run: ${nextCommand}`);
  } else {
    const total = result.archived.runs + result.archived.checks + result.archived.statuses;
    lines.push(
      total > 0
        ? `Nothing at risk. ${plural(total, 'record')} already in the attic.`
        : 'Nothing at risk. No records are older than the cutoff.',
    );
  }
  return lines.join('\n');
}
