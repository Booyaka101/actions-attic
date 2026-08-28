/**
 * Walk history backwards a month at a time, checkpointing the frontier so the
 * next invocation resumes exactly where the request budget ran out.
 */

import type { Manifest } from './archive.js';
import { type Context, type StoreResult, addResults, captureMonth, storeRuns, storeShas } from './collect.js';
import { type Month, currentMonth, monthsBack, shiftMonth } from './months.js';

export interface BackfillOptions {
  months: number;
  now?: Date;
}

export interface BackfillResult {
  added: StoreResult;
  monthsCompleted: Month[];
  /** Months touched, including one the budget left half-done. */
  monthsTouched: Month[];
  /** Sub-windows walked, so a caller can see where a 1,000-cap split happened. */
  windows: string[];
  frontier: string | null;
  finished: boolean;
  stoppedBecause: string | null;
}

/** Months still to walk, newest first, given how deep the backfill already got. */
export function remainingMonths(manifest: Manifest, months: number, now = new Date()): Month[] {
  const targets = monthsBack(currentMonth(now), months);
  const oldestTarget = targets[targets.length - 1];
  const reached = manifest.backfillOldestMonth;
  if (!reached) return targets;
  if (reached <= oldestTarget) return []; // already at least this deep
  const resumeAt = shiftMonth(reached, -1);
  const index = targets.indexOf(resumeAt);
  return index === -1 ? targets : targets.slice(index);
}

export async function backfill(ctx: Context, opts: BackfillOptions): Promise<BackfillResult> {
  const now = opts.now ?? new Date();
  const targets = monthsBack(currentMonth(now), opts.months);
  const oldestTarget = targets[targets.length - 1];
  const todo = remainingMonths(ctx.archive.manifest, opts.months, now);

  let added: StoreResult = { runs: 0, checks: 0, statuses: 0 };
  const monthsCompleted: Month[] = [];
  const monthsTouched: Month[] = [];
  const windows: string[] = [];
  let reached = ctx.archive.manifest.backfillOldestMonth;
  let stoppedBecause: string | null = null;

  if (todo.length === 0) {
    ctx.archive.setBackfillProgress(reached, true);
    return {
      added,
      monthsCompleted,
      monthsTouched,
      windows,
      frontier: null,
      finished: true,
      stoppedBecause: null,
    };
  }

  for (const month of todo) {
    if (ctx.api.budgetExhausted()) {
      stoppedBecause = ctx.api.exhaustReason();
      break;
    }
    ctx.log(`backfilling ${month}`);
    monthsTouched.push(month);
    // Runs are written window by window rather than collected first, so the
    // window checkpoint can never run ahead of what is actually stored.
    const progress = ctx.archive.partialWindows(month);
    const monthly: StoreResult = { runs: 0, checks: 0, statuses: 0 };
    const captured = await captureMonth(ctx, month, {
      progress,
      store: async (batch) => {
        monthly.runs += await storeRuns(ctx, month, batch);
      },
    });
    const stored = captured.complete ? await storeShas(ctx, month, monthly) : { complete: false };
    windows.push(...captured.windows);
    added = addResults(added, monthly);

    if (!captured.complete || !stored.complete) {
      ctx.archive.setPartialWindows(month, progress);
      stoppedBecause = ctx.api.exhaustReason() ?? 'request budget exhausted mid-month';
      ctx.log(`stopping inside ${month}; the next run resumes at the windows still outstanding`);
      break;
    }
    ctx.archive.setPartialWindows(month, new Set());
    monthsCompleted.push(month);
    reached = month;
  }

  const finished = reached !== null && reached <= oldestTarget;
  ctx.archive.setBackfillProgress(reached, finished);

  return {
    added,
    monthsCompleted,
    monthsTouched,
    windows,
    frontier: ctx.archive.manifest.backfillFrontier,
    finished,
    stoppedBecause,
  };
}

const n = (value: number) => value.toLocaleString('en-US');

export function backfillMessage(result: BackfillResult): string | null {
  if (result.monthsCompleted.length > 0) {
    const months = [...result.monthsCompleted].sort();
    const span = months.length === 1 ? months[0] : `${months[0]}..${months[months.length - 1]}`;
    return `attic: backfill ${span} (${n(result.added.runs)} runs)`;
  }
  if (result.added.runs > 0 || result.added.checks > 0) {
    const month = result.monthsTouched[result.monthsTouched.length - 1] ?? 'history';
    return `attic: backfill ${month} in progress (${n(result.added.runs)} runs)`;
  }
  return null;
}
