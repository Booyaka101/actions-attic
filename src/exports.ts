/** Library surface, for anyone who wants to drive the archive from their own code. */

export { Api, BudgetExhausted, HttpError, NetworkError } from './api.js';
export type { ApiOptions, ListOptions, ListResult, RetentionSettings } from './api.js';
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
export {
  DEFAULT_RETENTION_DAYS,
  DELETION_DATE,
  PUBLIC_MAX_RETENTION_DAYS,
  RETENTION_SOURCES,
  formatPreflight,
  resolveRetention,
  retentionPhrase,
  retentionLines,
  runPreflight,
} from './preflight.js';
export type {
  PreflightOptions,
  PreflightResult,
  RetentionOptions,
  RetentionSource,
  RetentionWindow,
  Tally,
} from './preflight.js';
export {
  NPM_PUBLISH_PREDICATE,
  REGISTRY,
  RegistryError,
  SLSA_PREDICATE,
  SLSA_V02_PREDICATE,
  assertPackageName,
  attestationsUrl,
  collectProvenance,
  extractRunPointer,
  fetchPackument,
  formatProvenance,
  notesFor,
  packumentUrl,
  parseInvocationId,
  parsePackageSpec,
  referencedRepos,
  resolveProvenance,
  runUrl,
  stateCells,
  verdict as provenanceVerdict,
} from './provenance.js';
export type {
  CollectOptions,
  Collected,
  CollectedVersion,
  ProvenanceCounts,
  ProvenanceResult,
  RegistryOptions,
  ResolveOptions,
  RunPointer,
  VersionReport,
  VersionState,
} from './provenance.js';
export { MODES, parseRepo, runArchive } from './run.js';
export type { Mode, RunOptions, RunSummary } from './run.js';
