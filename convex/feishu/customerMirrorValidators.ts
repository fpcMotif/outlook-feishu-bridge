// Centralized Convex arg/return validators for the customer-mirror registration
// surface (customersMirror.ts). Convex validates each function's ACTUAL return
// value against `returns:` at runtime, so declaring them is Convex best practice
// (drift surfaces as a ReturnsValidationError instead of silently shipping the
// wrong shape). Centralizing the shapes here keeps customersMirror.ts a thin
// registration surface while every function still declares args + returns.
import { v } from "convex/values";
import { paginationResultValidator } from "convex/server";

// Slim Customer projection (customers.ts CustomerRecord) — what the mirror query
// and the live search return. Optional columns are absent (not "") when unset;
// owner is null when the Bitable Owner cell is empty.
export const customerRecordValidator = v.object({
  recordId: v.string(),
  name: v.string(),
  domain: v.optional(v.string()),
  fullName: v.optional(v.string()),
  accountNo: v.optional(v.string()),
  countryRegion: v.optional(v.string()),
  owner: v.union(v.object({ openId: v.string(), name: v.string() }), v.null()),
});

// One Customer row upserted into the mirror (applyPage args element).
export const mirrorRowValidator = v.object({
  recordId: v.string(),
  name: v.string(),
  domain: v.optional(v.string()),
  domainKey: v.optional(v.string()),
  fullName: v.optional(v.string()),
  accountNo: v.optional(v.string()),
  countryRegion: v.optional(v.string()),
  ownerOpenId: v.optional(v.string()),
  ownerName: v.optional(v.string()),
  searchBlob: v.string(),
});

// Why a mirror page walk stopped (shared by recordSyncCompletion args and the
// fullSync/kick result).
export const mirrorStopReasonValidator = v.union(
  v.literal("complete"),
  v.literal("missingPageToken"),
  v.literal("duplicatePageToken"),
  v.literal("incompleteTotal"),
);

// Check-and-set lease outcome shared by startRefreshIfAllowed /
// startDomainMatchIfAllowed: started, or skipped with the remaining cooldown.
export const leaseResultValidator = v.union(
  v.object({ started: v.literal(true) }),
  v.object({ started: v.literal(false), remainingMs: v.number() }),
);

export const applyPageResultValidator = v.object({
  inserted: v.number(),
  updated: v.number(),
  unchanged: v.number(),
  duplicateRows: v.number(),
});

export const pruneScanResultValidator = paginationResultValidator(
  v.object({ _id: v.id("customers"), recordId: v.string() }),
);

export const deleteResultValidator = v.object({ deleted: v.number() });

// recordSyncCompletion args (the watermark row). Mirror Prune accounting
// (ADR-0021) is 0 unless the run completed (the prune is gated on completeness).
export const recordSyncCompletionArgs = {
  lastFullSyncAt: v.number(),
  lastRowCount: v.number(),
  lastPageCount: v.number(),
  lastPageSize: v.number(),
  lastInsertedCount: v.number(),
  lastUpdatedCount: v.number(),
  lastUnchangedCount: v.number(),
  lastDuplicateCount: v.number(),
  lastReportedTotal: v.number(),
  lastSourceRowCount: v.number(),
  lastHadMore: v.boolean(),
  lastStopReason: mirrorStopReasonValidator,
  lastDurationMs: v.number(),
  lastFinishedAt: v.number(),
  lastSourceTableId: v.string(),
  lastPruneScannedCount: v.number(),
  lastDeletedStaleCount: v.number(),
};

// fullSync / kick (and the no-op skippedKickResult) — page-walk + prune accounting.
export const fullSyncResultValidator = v.object({
  pages: v.number(),
  rows: v.number(),
  inserted: v.number(),
  updated: v.number(),
  unchanged: v.number(),
  duplicateRows: v.number(),
  sourceRows: v.number(),
  reportedTotal: v.number(),
  hadMore: v.boolean(),
  stopReason: mirrorStopReasonValidator,
  durationMs: v.number(),
  pageSize: v.number(),
  sourceTableId: v.string(),
  pruneScanned: v.number(),
  deletedStale: v.number(),
});

export const searchResultValidator = v.object({
  records: v.array(customerRecordValidator),
  mirroredAt: v.union(v.number(), v.null()),
});

export const searchCustomersResultValidator = v.object({
  records: v.array(customerRecordValidator),
  source: v.union(v.literal("mirror"), v.literal("live")),
  backfilled: v.number(),
  mirroredAt: v.union(v.number(), v.null()),
});

export const matchByEmailResultValidator = v.object({
  customer: v.union(customerRecordValidator, v.null()),
});

export const matchEmailAndCacheMissResultValidator = v.object({
  customer: v.union(customerRecordValidator, v.null()),
  backfilled: v.number(),
});
