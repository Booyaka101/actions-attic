/**
 * The nightly path: walk the run list newest-first until a whole page is
 * already archived. Typically one or two requests.
 */

import { BudgetExhausted } from './api.js';
import type { RunRecord } from './archive.js';
import { type Context, type StoreResult, addResults, storeMonth, toRunRecord } from './collect.js';
import { type Month, monthOf } from './months.js';

export interface IncrementalOptions {
  /** Safety stop for the very first incremental after a long gap. */
  maxPages?: number;
}

export interface IncrementalResult {
  added: StoreResult;
  scanned: number;
  months: Month[];
  complete: boolean;
  stoppedBecause: string | null;
}

export async function incremental(ctx: Context, opts: IncrementalOptions = {}): Promise<IncrementalResult> {
  const maxPages = opts.maxPages ?? 50;
  const raw: any[] = [];
  let complete = true;
  let stoppedBecause: string | null = null;
  let reachedKnown = false;

  try {
    const res = await ctx.api.list<any>(
      `/repos/${ctx.owner}/${ctx.repo}/actions/runs`,
      {},
      {
        key: 'workflow_runs',
        maxPages,
        sink: raw,
        // Stop at the first page where every attempt is already on record. A
        // re-attempt gets a new key, so it still counts as new work.
        stop: async (page) => {
          for (const item of page) {
            const known = await ctx.archive.hasRun(item.id, item.run_attempt ?? 1, monthOf(item.created_at));
            if (!known) return false;
          }
          reachedKnown = true;
          return true;
        },
      },
    );
    if (res.complete) reachedKnown = true;
    if (!res.complete && !reachedKnown) {
      complete = false;
      stoppedBecause = `stopped after ${maxPages} pages; run again to continue catching up`;
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    complete = false;
    stoppedBecause = err.reason;
  }

  const byMonth = new Map<Month, RunRecord[]>();
  for (const item of raw) {
    const run = toRunRecord(item);
    const month = monthOf(run.created_at);
    const list = byMonth.get(month);
    if (list) list.push(run);
    else byMonth.set(month, [run]);
  }

  let added: StoreResult = { runs: 0, checks: 0, statuses: 0 };
  for (const [month, runs] of [...byMonth].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const stored = await storeMonth(ctx, month, runs);
    added = addResults(added, stored.added);
    if (!stored.complete) {
      complete = false;
      stoppedBecause ??= ctx.api.exhaustReason() ?? 'request budget exhausted fetching checks';
      break;
    }
  }

  return { added, scanned: raw.length, months: [...byMonth.keys()].sort(), complete, stoppedBecause };
}

export function incrementalMessage(result: IncrementalResult): string | null {
  const parts: string[] = [];
  if (result.added.runs) parts.push(`+${result.added.runs.toLocaleString('en-US')} runs`);
  if (result.added.checks) parts.push(`+${result.added.checks.toLocaleString('en-US')} checks`);
  if (result.added.statuses) parts.push(`+${result.added.statuses.toLocaleString('en-US')} statuses`);
  return parts.length ? `attic: ${parts.join(', ')}` : null;
}
