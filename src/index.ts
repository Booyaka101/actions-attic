/**
 * Build a SQLite index over the JSONL archive. Uses node:sqlite, which ships
 * with Node 22+, so the package stays at one runtime dependency.
 */

import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CheckRecord, Kind, RunRecord, StatusRecord } from './archive.js';
import { parseJsonl } from './archive.js';

export interface IndexCounts {
  runs: number;
  checks: number;
  statuses: number;
}

export interface IndexResult extends IndexCounts {
  dbPath: string;
  months: string[];
}

const SCHEMA = `
CREATE TABLE runs (
  id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  month TEXT NOT NULL,
  name TEXT,
  status TEXT,
  conclusion TEXT,
  created_at TEXT,
  updated_at TEXT,
  run_started_at TEXT,
  head_sha TEXT,
  head_branch TEXT,
  event TEXT,
  actor TEXT,
  triggering_actor TEXT,
  run_number INTEGER,
  workflow_id INTEGER,
  html_url TEXT,
  PRIMARY KEY (id, run_attempt)
);
CREATE INDEX runs_name ON runs (name);
CREATE INDEX runs_created ON runs (created_at);
CREATE INDEX runs_sha ON runs (head_sha);
CREATE INDEX runs_conclusion ON runs (conclusion);

CREATE TABLE checks (
  id INTEGER PRIMARY KEY,
  month TEXT NOT NULL,
  name TEXT,
  status TEXT,
  conclusion TEXT,
  started_at TEXT,
  completed_at TEXT,
  head_sha TEXT,
  app TEXT
);
CREATE INDEX checks_sha ON checks (head_sha);
CREATE INDEX checks_name ON checks (name);

CREATE TABLE statuses (
  id INTEGER PRIMARY KEY,
  month TEXT NOT NULL,
  head_sha TEXT,
  state TEXT,
  context TEXT,
  description TEXT,
  target_url TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX statuses_sha ON statuses (head_sha);
CREATE INDEX statuses_context ON statuses (context);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

export function archiveMonths(dir: string, kind: Kind): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(dir, kind));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
    .map((f) => f.slice(0, 7))
    .sort();
}

function readMonth<T>(dir: string, kind: Kind, month: string): T[] {
  const path = join(dir, kind, `${month}.jsonl`);
  return parseJsonl<T>(readFileSync(path, 'utf8'), path);
}

export function buildIndex(dir: string, dbPath: string): IndexResult {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-journal`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA);
    const counts: IndexCounts = { runs: 0, checks: 0, statuses: 0 };

    const insertRun = db.prepare(
      `INSERT OR REPLACE INTO runs (id, run_attempt, month, name, status, conclusion, created_at, updated_at,
        run_started_at, head_sha, head_branch, event, actor, triggering_actor, run_number, workflow_id, html_url)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertCheck = db.prepare(
      `INSERT OR REPLACE INTO checks (id, month, name, status, conclusion, started_at, completed_at, head_sha, app)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    const insertStatus = db.prepare(
      `INSERT OR REPLACE INTO statuses (id, month, head_sha, state, context, description, target_url, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );

    db.exec('BEGIN');
    for (const month of archiveMonths(dir, 'runs')) {
      for (const r of readMonth<RunRecord>(dir, 'runs', month)) {
        insertRun.run(
          r.id, r.run_attempt ?? 1, month, r.name, r.status, r.conclusion, r.created_at, r.updated_at,
          r.run_started_at, r.head_sha, r.head_branch, r.event, r.actor, r.triggering_actor,
          r.run_number, r.workflow_id, r.html_url,
        );
        counts.runs++;
      }
    }
    for (const month of archiveMonths(dir, 'checks')) {
      for (const c of readMonth<CheckRecord>(dir, 'checks', month)) {
        insertCheck.run(c.id, month, c.name, c.status, c.conclusion, c.started_at, c.completed_at, c.head_sha, c.app);
        counts.checks++;
      }
    }
    for (const month of archiveMonths(dir, 'statuses')) {
      for (const s of readMonth<StatusRecord>(dir, 'statuses', month)) {
        insertStatus.run(
          s.id, month, s.head_sha, s.state, s.context, s.description, s.target_url, s.created_at, s.updated_at,
        );
        counts.statuses++;
      }
    }
    const meta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)');
    meta.run('source', dir);
    meta.run('builtAt', new Date().toISOString());
    db.exec('COMMIT');

    const months = [
      ...new Set([...archiveMonths(dir, 'runs'), ...archiveMonths(dir, 'checks'), ...archiveMonths(dir, 'statuses')]),
    ].sort();
    return { ...counts, dbPath, months };
  } finally {
    db.close();
  }
}

/** Row counts straight out of the built database, for verification. */
export function indexCounts(dbPath: string): IndexCounts {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const one = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { runs: one('runs'), checks: one('checks'), statuses: one('statuses') };
  } finally {
    db.close();
  }
}
