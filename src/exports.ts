/** Library surface, for anyone who wants to drive the archive from their own code. */

export { Api, BudgetExhausted, HttpError, NetworkError } from './api.js';
export type { ApiOptions, ListOptions, ListResult } from './api.js';
export { Archive, SCHEMA_VERSION, emptyManifest, parseJsonl, recordPath, shaPath } from './archive.js';
export type { CheckRecord, Kind, Manifest, RunRecord, StatusRecord } from './archive.js';
export { BranchBackend, FsBackend, RefBackend, gitBlobSha, normalizeRef } from './backend.js';
export type { Backend, CommitResult } from './backend.js';
export { backfill, backfillMessage, remainingMonths } from './backfill.js';
export type { BackfillOptions, BackfillResult } from './backfill.js';
export { SEARCH_CAP, captureWindow, makeContext, toCheckRecord, toRunRecord, toStatusRecord } from './collect.js';
export type { Context } from './collect.js';
export { computeFlake, formatFlake } from './flake.js';
export type { FlakeOptions, FlakeReport, MonthlyFlake } from './flake.js';
export { archiveMonths, buildIndex, indexCounts } from './index.js';
export type { IndexCounts, IndexResult } from './index.js';
export { incremental, incrementalMessage } from './incremental.js';
export type { IncrementalOptions, IncrementalResult } from './incremental.js';
export * from './months.js';
export { MODES, parseRepo, runArchive } from './run.js';
export type { Mode, RunOptions, RunSummary } from './run.js';
