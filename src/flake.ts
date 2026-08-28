/** Flake statistics over archived runs. */

import type { RunRecord } from './archive.js';
import { type Month, monthOf } from './months.js';

export interface FlakeOptions {
  workflow: string;
  since?: Month;
  until?: Month;
  /** Months with fewer decided runs than this cannot be the peak. */
  minRuns?: number;
}

export interface MonthlyFlake {
  month: Month;
  runs: number;
  success: number;
  failure: number;
  rate: number;
}

export interface FlakeReport {
  workflow: string;
  runs: number;
  success: number;
  failure: number;
  rate: number;
  peak: MonthlyFlake | null;
  months: MonthlyFlake[];
  /** Workflow names present in the window, for a useful "no match" message. */
  candidates: string[];
}

/** Only decided runs count: a cancelled or skipped run is not a flake signal. */
const DECIDED = new Set(['success', 'failure']);

function rate(success: number, failure: number): number {
  const total = success + failure;
  return total === 0 ? 0 : (failure / total) * 100;
}

export function computeFlake(runs: RunRecord[], opts: FlakeOptions): FlakeReport {
  const minRuns = opts.minRuns ?? 1;
  const candidates = new Set<string>();
  const monthly = new Map<Month, { success: number; failure: number }>();
  let success = 0;
  let failure = 0;
  let canonical = opts.workflow;

  for (const run of runs) {
    const month = monthOf(run.created_at);
    if (opts.since && month < opts.since) continue;
    if (opts.until && month > opts.until) continue;
    if (run.name) candidates.add(run.name);
    if (!matches(run, opts.workflow)) continue;
    if (run.name) canonical = run.name;
    const conclusion = run.conclusion ?? '';
    if (!DECIDED.has(conclusion)) continue;

    const bucket = monthly.get(month) ?? { success: 0, failure: 0 };
    if (conclusion === 'success') {
      bucket.success++;
      success++;
    } else {
      bucket.failure++;
      failure++;
    }
    monthly.set(month, bucket);
  }

  const months: MonthlyFlake[] = [...monthly]
    .map(([month, b]) => ({
      month,
      runs: b.success + b.failure,
      success: b.success,
      failure: b.failure,
      rate: rate(b.success, b.failure),
    }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));

  let peak: MonthlyFlake | null = null;
  for (const m of months) {
    if (m.runs < minRuns || m.failure === 0) continue;
    if (!peak || m.rate > peak.rate || (m.rate === peak.rate && m.month < peak.month)) peak = m;
  }

  return {
    workflow: canonical,
    runs: success + failure,
    success,
    failure,
    rate: rate(success, failure),
    peak,
    months,
    candidates: [...candidates].sort(),
  };
}

/** Name match is case-insensitive; a workflow id also selects. */
function matches(run: RunRecord, workflow: string): boolean {
  if (run.name != null && run.name.toLowerCase() === workflow.toLowerCase()) return true;
  return String(run.workflow_id) === workflow;
}

const n = (value: number) => value.toLocaleString('en-US');

export function formatFlake(report: FlakeReport): string {
  const head = `${report.workflow}: ${n(report.runs)} runs, ${n(report.success)} success, ${n(report.failure)} failure`;
  const rateText = `flake rate ${report.rate.toFixed(1)}%`;
  const peak = report.peak ? ` (peak ${report.peak.month} at ${report.peak.rate.toFixed(1)}%)` : '';
  return `${head}, ${rateText}${peak}`;
}
