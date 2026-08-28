/**
 * One orchestration for both entry points. `auto` tops up new runs first (cheap)
 * and then spends whatever request budget is left continuing the backfill.
 */

import { Api, BudgetExhausted } from './api.js';
import { Archive } from './archive.js';
import type { Backend, CommitResult } from './backend.js';
import { type BackfillResult, backfill, backfillMessage } from './backfill.js';
import { type Context, makeContext } from './collect.js';
import { type IncrementalResult, incremental, incrementalMessage } from './incremental.js';

export type Mode = 'auto' | 'backfill' | 'incremental';

export const MODES: Mode[] = ['auto', 'backfill', 'incremental'];

export interface RunOptions {
  api: Api;
  backend: Backend;
  owner: string;
  repo: string;
  mode: Mode;
  months: number;
  maxPages?: number;
  skipChecks?: boolean;
  skipStatuses?: boolean;
  now?: Date;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface RunSummary {
  mode: Mode;
  backfill: BackfillResult | null;
  incremental: IncrementalResult | null;
  commit: CommitResult | null;
  message: string | null;
  frontier: string | null;
  runs: number;
  checks: number;
  statuses: number;
  requests: number;
  /** Set when work stopped early for budget; the next run resumes from here. */
  checkpoint: string | null;
  archive: Archive;
}

export async function runArchive(opts: RunOptions): Promise<RunSummary> {
  const log = opts.log ?? (() => {});
  const warn = opts.warn ?? (() => {});
  const archive = await Archive.open(opts.backend, `${opts.owner}/${opts.repo}`);
  const ctx: Context = makeContext({
    api: opts.api,
    archive,
    owner: opts.owner,
    repo: opts.repo,
    skipChecks: opts.skipChecks ?? false,
    skipStatuses: opts.skipStatuses ?? false,
    log,
    warn,
  });

  const firstEver = archive.manifest.lastRun === null;
  const backfillDone = archive.manifest.backfillComplete;

  let inc: IncrementalResult | null = null;
  let back: BackfillResult | null = null;

  const wantIncremental = opts.mode === 'incremental' || (opts.mode === 'auto' && !firstEver);
  const wantBackfill = opts.mode === 'backfill' || (opts.mode === 'auto' && (firstEver || !backfillDone));

  // Whatever happens in here, the archive still gets committed below. Losing a
  // night's captured runs to an exception is worse than any partial state.
  let interrupted: string | null = null;
  try {
    if (wantIncremental) {
      log('incremental: scanning for new runs');
      inc = await incremental(ctx, { maxPages: opts.maxPages });
    }
    if (wantBackfill && !opts.api.budgetExhausted()) {
      back = await backfill(ctx, { months: opts.months, now: opts.now });
    } else if (wantBackfill) {
      log('skipping backfill: no request budget left this run');
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    interrupted = err.reason;
    log(`stopped early: ${err.reason}`);
  }

  const message =
    [back ? backfillMessage(back) : null, inc ? incrementalMessage(inc) : null].filter(Boolean).join(', ') ||
    (archive.changed ? 'attic: update manifest' : null);

  // Saving progress has to outrank the request ceiling, or a run that spends
  // its whole budget walking history throws that work away and never advances.
  opts.api.beginCheckpoint();
  const commit = archive.changed || message ? await archive.finalize(message ?? 'attic: update', opts.now) : null;

  const runs = (back?.added.runs ?? 0) + (inc?.added.runs ?? 0);
  const checks = (back?.added.checks ?? 0) + (inc?.added.checks ?? 0);
  const statuses = (back?.added.statuses ?? 0) + (inc?.added.statuses ?? 0);
  const checkpoint = back?.stoppedBecause ?? inc?.stoppedBecause ?? interrupted;

  return {
    mode: opts.mode,
    backfill: back,
    incremental: inc,
    commit,
    message,
    frontier: archive.manifest.backfillFrontier,
    runs,
    checks,
    statuses,
    requests: opts.api.requests,
    checkpoint,
    archive,
  };
}

export function parseRepo(value: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(value.trim());
  if (!match) throw new Error(`repository must look like owner/name, got "${value}"`);
  return { owner: match[1], repo: match[2] };
}
