/**
 * The capture primitives shared by backfill and incremental: turn API payloads
 * into archive records, walk a created= window while respecting the endpoint's
 * 1,000-result cap, and fetch per-SHA checks and statuses.
 */

import { Api, BudgetExhausted, HttpError } from './api.js';
import type { Archive, CheckRecord, RunRecord, StatusRecord } from './archive.js';
import { type Month, type Window, formatWindow, monthWindow, splitWindow } from './months.js';

/** GitHub returns at most 1,000 results per search on these filters. */
export const SEARCH_CAP = 1000;

export interface Context {
  api: Api;
  archive: Archive;
  owner: string;
  repo: string;
  skipChecks: boolean;
  skipStatuses: boolean;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  /** Flipped when statuses 403 on a repo whose token lacks pull access. */
  statusesForbidden: boolean;
}

export function makeContext(init: Omit<Context, 'statusesForbidden'>): Context {
  return { ...init, statusesForbidden: false };
}

export function toRunRecord(raw: any): RunRecord {
  return {
    id: raw.id,
    name: raw.name ?? null,
    status: raw.status ?? null,
    conclusion: raw.conclusion ?? null,
    created_at: raw.created_at,
    updated_at: raw.updated_at ?? null,
    run_started_at: raw.run_started_at ?? null,
    head_sha: raw.head_sha,
    head_branch: raw.head_branch ?? null,
    event: raw.event ?? null,
    actor: raw.actor?.login ?? null,
    triggering_actor: raw.triggering_actor?.login ?? null,
    run_number: raw.run_number ?? null,
    run_attempt: raw.run_attempt ?? null,
    workflow_id: raw.workflow_id ?? null,
    html_url: raw.html_url ?? null,
  };
}

export function toCheckRecord(raw: any, headSha: string): CheckRecord {
  return {
    id: raw.id,
    name: raw.name ?? null,
    status: raw.status ?? null,
    conclusion: raw.conclusion ?? null,
    started_at: raw.started_at ?? null,
    completed_at: raw.completed_at ?? null,
    head_sha: raw.head_sha ?? headSha,
    app: raw.app?.slug ?? null,
  };
}

export function toStatusRecord(raw: any, headSha: string): StatusRecord {
  return {
    id: raw.id,
    head_sha: headSha,
    state: raw.state ?? null,
    context: raw.context ?? null,
    description: raw.description ?? null,
    target_url: raw.target_url ?? null,
    created_at: raw.created_at,
    updated_at: raw.updated_at ?? null,
  };
}

export interface WindowResult {
  runs: RunRecord[];
  /** Sub-windows actually walked, after any 1,000-cap splits. */
  windows: string[];
  complete: boolean;
  /**
   * Checkpoint: windows finished, plus `range:split` markers so a resume can
   * skip straight past a window it already knows is over the cap.
   */
  progress: Set<string>;
}

/**
 * Walk `created=start..end`, halving the window whenever the endpoint reports
 * it would hit the 1,000-result cap. Partial results survive a budget abort,
 * and `progress` lets the next invocation pick up mid-month.
 */
export async function captureWindow(ctx: Context, window: Window, progress = new Set<string>()): Promise<WindowResult> {
  const runs: RunRecord[] = [];
  const windows: string[] = [];
  let complete = true;
  try {
    await walkWindow(ctx, window, runs, windows, progress);
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    complete = false;
  }
  return { runs, windows, complete, progress };
}

async function walkWindow(
  ctx: Context,
  window: Window,
  out: RunRecord[],
  windows: string[],
  progress: Set<string>,
): Promise<void> {
  const key = formatWindow(window);
  if (progress.has(key)) return; // already captured by an earlier invocation

  if (!progress.has(`${key}:split`)) {
    const raw: any[] = [];
    let capped = false;
    const startPage = pagesDone(progress, key) + 1;
    try {
      const res = await ctx.api.list<any>(
        `/repos/${ctx.owner}/${ctx.repo}/actions/runs`,
        { created: key },
        {
          key: 'workflow_runs',
          sink: raw,
          startPage,
          onPage: (page) => setPagesDone(progress, key, page),
          onFirstPage: (total) => {
            if (total < SEARCH_CAP) return true;
            capped = true;
            return false;
          },
        },
      );
      if (!capped && !res.complete) {
        ctx.warn(`stopped paginating ${key} early; it will resume on the next run`);
        throw new BudgetExhausted('page cap reached while walking a window');
      }
    } finally {
      // Pages that did land are kept even when the budget cut the walk short.
      for (const item of raw) out.push(toRunRecord(item));
    }

    if (!capped) {
      clearPagesDone(progress, key);
      windows.push(key);
      progress.add(key);
      return;
    }
    ctx.log(`${key} hits the ${SEARCH_CAP}-result cap; splitting`);
    clearPagesDone(progress, key);
    progress.add(`${key}:split`);
  }

  const halves = splitWindow(window);
  if (!halves) {
    ctx.warn(
      `${key} has at least ${SEARCH_CAP} runs in a single day; ` +
        `GitHub will not return more than ${SEARCH_CAP} for one search, so that day is capped`,
    );
    // Take everything GitHub will still hand over for that day.
    const raw: any[] = [];
    await ctx.api.list<any>(
      `/repos/${ctx.owner}/${ctx.repo}/actions/runs`,
      { created: key },
      { key: 'workflow_runs', sink: raw, maxPages: SEARCH_CAP / 100 },
    );
    for (const item of raw) out.push(toRunRecord(item));
    windows.push(key);
    progress.add(key);
    return;
  }
  for (const half of halves) await walkWindow(ctx, half, out, windows, progress);
  progress.add(key);
}

export async function captureMonth(ctx: Context, month: Month, progress?: Set<string>): Promise<WindowResult> {
  return captureWindow(ctx, monthWindow(month), progress);
}

// Page-level checkpoints live in the same set as window checkpoints, as
// `range@N` meaning pages 1..N of that window are already captured.
function pagesDone(progress: Set<string>, key: string): number {
  for (const entry of progress) {
    if (entry.startsWith(`${key}@`)) return Number(entry.slice(key.length + 1)) || 0;
  }
  return 0;
}

function setPagesDone(progress: Set<string>, key: string, page: number): void {
  clearPagesDone(progress, key);
  progress.add(`${key}@${page}`);
}

function clearPagesDone(progress: Set<string>, key: string): void {
  for (const entry of [...progress]) {
    if (entry.startsWith(`${key}@`)) progress.delete(entry);
  }
}

export interface ShaResult {
  checks: CheckRecord[];
  statuses: StatusRecord[];
  done: string[];
  complete: boolean;
}

/** Fetch check runs and commit statuses for SHAs not already indexed. */
export async function captureShas(ctx: Context, shas: string[]): Promise<ShaResult> {
  const checks: CheckRecord[] = [];
  const statuses: StatusRecord[] = [];
  const done: string[] = [];
  const base = `/repos/${ctx.owner}/${ctx.repo}/commits`;

  for (const sha of shas) {
    if (ctx.api.budgetExhausted()) return { checks, statuses, done, complete: false };
    try {
      if (!ctx.skipChecks) {
        const res = await ctx.api.list<any>(`${base}/${sha}/check-runs`, { filter: 'all' }, { key: 'check_runs' });
        for (const item of res.items) checks.push(toCheckRecord(item, sha));
      }
      if (!ctx.skipStatuses && !ctx.statusesForbidden) {
        try {
          const res = await ctx.api.list<any>(`${base}/${sha}/statuses`, {}, { key: null });
          for (const item of res.items) statuses.push(toStatusRecord(item, sha));
        } catch (err) {
          if (err instanceof HttpError && err.status === 403) {
            ctx.statusesForbidden = true;
            ctx.warn(
              'commit statuses returned 403; this token lacks pull access to statuses. ' +
                'Continuing with runs and checks only. Add `statuses: read` to the workflow permissions to include them.',
            );
          } else throw err;
        }
      }
      done.push(sha);
    } catch (err) {
      if (err instanceof BudgetExhausted) return { checks, statuses, done, complete: false };
      if (err instanceof HttpError && err.status === 404) {
        // The commit is gone (force-pushed branch, deleted fork). Nothing to archive.
        done.push(sha);
        continue;
      }
      throw err;
    }
  }
  return { checks, statuses, done, complete: true };
}

export interface StoreResult {
  runs: number;
  checks: number;
  statuses: number;
}

/** Persist a month's runs plus the checks and statuses for its new SHAs. */
export async function storeMonth(
  ctx: Context,
  month: Month,
  runs: RunRecord[],
): Promise<{ added: StoreResult; complete: boolean }> {
  const added: StoreResult = { runs: 0, checks: 0, statuses: 0 };
  added.runs = await ctx.archive.add('runs', runs);
  for (const run of runs) ctx.archive.noteRunId(run.id);

  if (ctx.skipChecks && ctx.skipStatuses) return { added, complete: true };

  const known = await ctx.archive.shasDone(month);
  const pending: string[] = [];
  const seen = new Set<string>();
  for (const run of await ctx.archive.read<RunRecord>('runs', month)) {
    if (!run.head_sha || known.has(run.head_sha) || seen.has(run.head_sha)) continue;
    seen.add(run.head_sha);
    pending.push(run.head_sha);
  }
  if (pending.length === 0) return { added, complete: true };

  ctx.log(`${month}: fetching checks/statuses for ${pending.length} new commit${pending.length === 1 ? '' : 's'}`);
  const res = await captureShas(ctx, pending);
  added.checks = await ctx.archive.add('checks', res.checks);
  added.statuses = await ctx.archive.add('statuses', res.statuses);
  await ctx.archive.markShasDone(month, res.done);
  return { added, complete: res.complete };
}

export function addResults(a: StoreResult, b: StoreResult): StoreResult {
  return { runs: a.runs + b.runs, checks: a.checks + b.checks, statuses: a.statuses + b.statuses };
}
