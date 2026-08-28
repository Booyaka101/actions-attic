/**
 * The on-disk (or on-branch) format:
 *
 *   runs/YYYY-MM.jsonl      one workflow run attempt per line
 *   checks/YYYY-MM.jsonl    one check run per line
 *   statuses/YYYY-MM.jsonl  one commit status per line
 *   shas/YYYY-MM.txt        head SHAs whose checks + statuses have been fetched
 *   manifest.json           { schemaVersion, backfillFrontier, highestRunId, lastRun, ... }
 *
 * Everything is append-and-dedupe: re-running a night never duplicates a record
 * and never produces an empty commit.
 */

import type { Backend, CommitResult } from './backend.js';
import { type Month, monthOf } from './months.js';

export const SCHEMA_VERSION = 1;

export interface RunRecord {
  id: number;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  created_at: string;
  updated_at: string | null;
  run_started_at: string | null;
  head_sha: string;
  head_branch: string | null;
  event: string | null;
  actor: string | null;
  triggering_actor: string | null;
  run_number: number | null;
  run_attempt: number | null;
  workflow_id: number | null;
  html_url: string | null;
}

export interface CheckRecord {
  id: number;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  head_sha: string;
  app: string | null;
}

export interface StatusRecord {
  id: number;
  head_sha: string;
  state: string | null;
  context: string | null;
  description: string | null;
  target_url: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface Manifest {
  schemaVersion: number;
  repo: string;
  /** First day of the oldest month the backfill has completed, or null when done. */
  backfillFrontier: string | null;
  /**
   * True once the backfill has reached the configured depth. Without it a null
   * frontier could not be told apart from "no month has completed yet".
   */
  backfillComplete: boolean;
  /** Oldest month the backfill has fully captured, ever. */
  backfillOldestMonth: Month | null;
  /**
   * Sub-month checkpoint. A busy month can exceed one run's request budget, so
   * the date windows already walked are recorded and skipped on resume.
   */
  backfillPartial: { month: Month; done: string[] } | null;
  highestRunId: number | null;
  /** Timestamp of the last run that changed the archive. */
  lastRun: string | null;
  months: Month[];
  counts: { runs: number; checks: number; statuses: number };
  generator: string;
}

export type Kind = 'runs' | 'checks' | 'statuses';

const KEYS: Record<Kind, (r: any) => string> = {
  // A re-attempt reuses the run id, so the attempt number is part of the identity.
  runs: (r: RunRecord) => `${r.id}:${r.run_attempt ?? 1}`,
  checks: (r: CheckRecord) => String(r.id),
  statuses: (r: StatusRecord) => String(r.id),
};

const SORT_KEYS: Record<Kind, (r: any) => string> = {
  runs: (r: RunRecord) => `${r.created_at ?? ''}|${String(r.id).padStart(20, '0')}|${r.run_attempt ?? 1}`,
  checks: (r: CheckRecord) => `${r.started_at ?? r.completed_at ?? ''}|${String(r.id).padStart(20, '0')}`,
  statuses: (r: StatusRecord) => `${r.created_at ?? ''}|${String(r.id).padStart(20, '0')}`,
};

const MONTH_OF: Record<Kind, (r: any) => Month> = {
  runs: (r: RunRecord) => monthOf(r.created_at),
  checks: (r: CheckRecord) => monthOf(r.started_at ?? r.completed_at ?? ''),
  statuses: (r: StatusRecord) => monthOf(r.created_at),
};

export function recordPath(kind: Kind, month: Month): string {
  return `${kind}/${month}.jsonl`;
}

export function shaPath(month: Month): string {
  return `shas/${month}.txt`;
}

export function parseJsonl<T>(text: string | null, source: string): T[] {
  if (!text) return [];
  const out: T[] = [];
  let lineNo = 0;
  for (const line of text.split('\n')) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      throw new Error(`${source}:${lineNo} is not valid JSON. The archive file looks corrupted.`);
    }
  }
  return out;
}

function toJsonl(records: unknown[]): string {
  return records.length ? `${records.map((r) => JSON.stringify(r)).join('\n')}\n` : '';
}

export function emptyManifest(repo: string): Manifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    repo,
    backfillFrontier: null,
    backfillComplete: false,
    backfillOldestMonth: null,
    backfillPartial: null,
    highestRunId: null,
    lastRun: null,
    months: [],
    counts: { runs: 0, checks: 0, statuses: 0 },
    generator: 'actions-attic',
  };
}

export class Archive {
  manifest: Manifest;
  private dirty = false;
  private readonly cache = new Map<string, any[]>();
  private readonly keyCache = new Map<string, Set<string>>();
  private readonly shaCache = new Map<Month, Set<string>>();

  private constructor(
    private readonly backend: Backend,
    manifest: Manifest,
  ) {
    this.manifest = manifest;
  }

  static async open(backend: Backend, repo: string): Promise<Archive> {
    const raw = await backend.read('manifest.json');
    let manifest = emptyManifest(repo);
    if (raw) {
      let parsed: Partial<Manifest>;
      try {
        parsed = JSON.parse(raw) as Partial<Manifest>;
      } catch {
        throw new Error(`manifest.json in ${backend.describe()} is not valid JSON. Delete it to start a fresh archive.`);
      }
      if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > SCHEMA_VERSION) {
        throw new Error(
          `archive schemaVersion ${parsed.schemaVersion} is newer than this build understands (${SCHEMA_VERSION}). Upgrade actions-attic.`,
        );
      }
      manifest = { ...manifest, ...parsed, schemaVersion: SCHEMA_VERSION, repo: parsed.repo ?? repo };
      manifest.counts = { ...emptyManifest(repo).counts, ...(parsed.counts ?? {}) };
    }
    return new Archive(backend, manifest);
  }

  get backendName(): string {
    return this.backend.describe();
  }

  get changed(): boolean {
    return this.dirty;
  }

  /** Months present in the archive, oldest first. */
  months(): Month[] {
    const set = new Set<Month>();
    for (const path of this.backend.paths()) {
      const m = /^(?:runs|checks|statuses)\/(\d{4}-\d{2})\.jsonl$/.exec(path);
      if (m) set.add(m[1]);
    }
    return [...set].sort();
  }

  async read<T>(kind: Kind, month: Month): Promise<T[]> {
    const path = recordPath(kind, month);
    const cached = this.cache.get(path);
    if (cached) return cached as T[];
    const records = parseJsonl<T>(await this.backend.read(path), path);
    this.cache.set(path, records);
    return records;
  }

  async readAll<T>(kind: Kind, months?: Month[]): Promise<T[]> {
    const out: T[] = [];
    for (const month of months ?? this.months()) out.push(...(await this.read<T>(kind, month)));
    return out;
  }

  /** Merge records in, deduping by kind key. Returns how many were new. */
  async add(kind: Kind, records: unknown[]): Promise<number> {
    if (records.length === 0) return 0;
    const byMonth = new Map<Month, unknown[]>();
    for (const record of records) {
      const month = MONTH_OF[kind](record);
      if (!/^\d{4}-\d{2}$/.test(month)) continue; // undated record: nothing sane to bucket it into
      const list = byMonth.get(month);
      if (list) list.push(record);
      else byMonth.set(month, [record]);
    }

    let added = 0;
    for (const [month, incoming] of byMonth) {
      const existing = await this.read<unknown>(kind, month);
      const seen = await this.keys(kind, month);
      const fresh = incoming.filter((r) => {
        const key = KEYS[kind](r);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (fresh.length === 0) continue;
      const merged = [...existing, ...fresh].sort((a, b) => (SORT_KEYS[kind](a) < SORT_KEYS[kind](b) ? -1 : 1));
      this.cache.set(recordPath(kind, month), merged);
      this.backend.write(recordPath(kind, month), toJsonl(merged));
      added += fresh.length;
      this.dirty = true;
    }
    return added;
  }

  /** Dedupe keys already stored for a month, cached per read. */
  async keys(kind: Kind, month: Month): Promise<Set<string>> {
    const cacheKey = `${kind}:${month}`;
    const cached = this.keyCache.get(cacheKey);
    if (cached) return cached;
    const set = new Set((await this.read<unknown>(kind, month)).map((r) => KEYS[kind](r)));
    this.keyCache.set(cacheKey, set);
    return set;
  }

  async hasRun(id: number, attempt: number, month: Month): Promise<boolean> {
    return (await this.keys('runs', month)).has(`${id}:${attempt}`);
  }

  /** SHAs whose checks and statuses have already been fetched for this month. */
  async shasDone(month: Month): Promise<Set<string>> {
    const cached = this.shaCache.get(month);
    if (cached) return cached;
    const raw = await this.backend.read(shaPath(month));
    const set = new Set((raw ?? '').split('\n').map((s) => s.trim()).filter(Boolean));
    this.shaCache.set(month, set);
    return set;
  }

  async markShasDone(month: Month, shas: string[]): Promise<void> {
    if (shas.length === 0) return;
    const set = await this.shasDone(month);
    let changed = false;
    for (const sha of shas) {
      if (!set.has(sha)) {
        set.add(sha);
        changed = true;
      }
    }
    if (!changed) return;
    this.backend.write(shaPath(month), `${[...set].sort().join('\n')}\n`);
    this.dirty = true;
  }

  /** Frontier is derived: it is the oldest completed month, or null once done. */
  setBackfillProgress(oldestMonth: Month | null, complete: boolean): void {
    const frontier = complete || !oldestMonth ? null : `${oldestMonth}-01`;
    const m = this.manifest;
    if (m.backfillFrontier === frontier && m.backfillComplete === complete && m.backfillOldestMonth === oldestMonth) {
      return;
    }
    m.backfillFrontier = frontier;
    m.backfillComplete = complete;
    m.backfillOldestMonth = oldestMonth;
    this.dirty = true;
  }

  /** Windows already walked inside a half-finished month. */
  partialWindows(month: Month): Set<string> {
    const partial = this.manifest.backfillPartial;
    return new Set(partial && partial.month === month ? partial.done : []);
  }

  setPartialWindows(month: Month, done: Set<string>): void {
    const next = done.size ? { month, done: [...done].sort() } : null;
    if (JSON.stringify(next) === JSON.stringify(this.manifest.backfillPartial)) return;
    this.manifest.backfillPartial = next;
    this.dirty = true;
  }

  noteRunId(id: number): void {
    if (this.manifest.highestRunId === null || id > this.manifest.highestRunId) {
      this.manifest.highestRunId = id;
      this.dirty = true;
    }
  }

  /**
   * Write the manifest and commit. Returns null when nothing changed, which is
   * what keeps a second consecutive incremental run from making an empty commit.
   */
  async finalize(message: string, now: Date = new Date()): Promise<CommitResult | null> {
    if (this.dirty || !this.backend.paths().includes('manifest.json')) {
      const months = this.months();
      const counts = { runs: 0, checks: 0, statuses: 0 };
      for (const month of months) {
        counts.runs += (await this.read('runs', month)).length;
        counts.checks += (await this.read('checks', month)).length;
        counts.statuses += (await this.read('statuses', month)).length;
      }
      this.manifest = {
        ...this.manifest,
        schemaVersion: SCHEMA_VERSION,
        months,
        counts,
        lastRun: now.toISOString(),
      };
      this.backend.write('manifest.json', `${JSON.stringify(this.manifest, null, 2)}\n`);
    }
    return this.backend.commit(message);
  }
}
