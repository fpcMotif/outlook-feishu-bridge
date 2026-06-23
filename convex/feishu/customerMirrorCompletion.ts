// Result shaping + watermark persistence for the Customer mirror full sync
// (ADR-0016 / ADR-0021). Split out of customerMirrorFullSync.ts so the page-walk
// orchestration and this completion layer each stay under the architecture line
// limit. The FullSyncResult type and skippedKickResult are re-exported by
// customerMirrorFullSync.ts so the registration file's imports are unchanged.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type {
  MirrorStopReason,
  PruneTotals,
  SyncTotals,
} from "./customerMirrorSync";
import { CUSTOMER_TABLE_ID, PAGE_SIZE } from "./customerMirrorConfig";

// Drift alarm (ADR-0021 hardening). A retained count that still exceeds the
// source total beyond this ratio AND floor means orphans escaped the prune.
const DRIFT_ALARM_RATIO = 0.05;
const DRIFT_ALARM_FLOOR = 10;

export interface FullSyncResult {
  pages: number;
  rows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  duplicateRows: number;
  sourceRows: number;
  reportedTotal: number;
  hadMore: boolean;
  stopReason: MirrorStopReason;
  durationMs: number;
  pageSize: number;
  sourceTableId: string;
  // Mirror Prune outcome (ADR-0021): rows scanned + orphans tombstoned. Both 0
  // on a non-complete sync, which is gated to skip the prune entirely.
  pruneScanned: number;
  deletedStale: number;
}

async function recordMirrorCompletion(
  ctx: ActionCtx,
  result: FullSyncResult,
  mirroredAt: number,
  finishedAt: number,
) {
  await ctx.runMutation(internal.feishu.customersMirror.recordSyncCompletion, {
    lastFullSyncAt: mirroredAt,
    lastRowCount: result.rows,
    lastPageCount: result.pages,
    lastPageSize: PAGE_SIZE,
    lastInsertedCount: result.inserted,
    lastUpdatedCount: result.updated,
    lastUnchangedCount: result.unchanged,
    lastDuplicateCount: result.duplicateRows,
    lastReportedTotal: result.reportedTotal,
    lastSourceRowCount: result.sourceRows,
    lastHadMore: result.hadMore,
    lastStopReason: result.stopReason,
    lastDurationMs: result.durationMs,
    lastFinishedAt: finishedAt,
    lastSourceTableId: CUSTOMER_TABLE_ID,
    lastPruneScannedCount: result.pruneScanned,
    lastDeletedStaleCount: result.deletedStale,
  });
}

export async function finishFullSync(
  ctx: ActionCtx,
  totals: SyncTotals,
  mirroredAt: number,
  hadMore: boolean,
  stopReason: MirrorStopReason,
  prune: PruneTotals,
): Promise<FullSyncResult> {
  const finishedAt = Date.now();
  const result = {
    ...totals,
    hadMore,
    stopReason,
    durationMs: finishedAt - mirroredAt,
    pageSize: PAGE_SIZE,
    sourceTableId: CUSTOMER_TABLE_ID,
    pruneScanned: prune.scanned,
    deletedStale: prune.deleted,
  };
  await recordMirrorCompletion(ctx, result, mirroredAt, finishedAt);
  warnOnResidualDrift(stopReason, totals.reportedTotal, prune);
  if (stopReason !== "complete") {
    throw new Error(
      `Customers mirror stopped before completion: reason=${stopReason} pages=${totals.pages} ` +
        `rows=${totals.rows} sourceRows=${totals.sourceRows} reportedTotal=${totals.reportedTotal}`,
    );
  }
  return result;
}

// Drift alarm (ADR-0021 hardening). After a complete sync + prune the retained
// count (scanned − deleted) should track Feishu's reported total. If it still
// exceeds the source total beyond the ratio AND floor, orphans escaped the prune
// — log loudly so the original 2-5x drift can never recur silently. Pure
// observability; never throws.
function warnOnResidualDrift(
  stopReason: MirrorStopReason,
  reportedTotal: number,
  prune: PruneTotals,
): void {
  if (stopReason !== "complete" || reportedTotal <= 0) return;
  const retained = prune.scanned - prune.deleted;
  const overcount = retained - reportedTotal;
  const threshold = Math.max(DRIFT_ALARM_FLOOR, Math.floor(reportedTotal * DRIFT_ALARM_RATIO));
  if (overcount > threshold) {
    console.error(
      `[customers-mirror] DRIFT ALARM retained=${retained} exceeds source reportedTotal=` +
        `${reportedTotal} by ${overcount} after prune (deletedStale=${prune.deleted}); ` +
        `orphans escaped the prune`,
    );
  }
}

// A Mirror Kick that lands inside the cooldown window does no Feishu paging and
// writes no watermark — a structural no-op result (ADR-0016 amendment).
export function skippedKickResult(): FullSyncResult {
  return {
    pages: 0,
    rows: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    duplicateRows: 0,
    sourceRows: 0,
    reportedTotal: 0,
    hadMore: false,
    stopReason: "complete",
    durationMs: 0,
    pageSize: PAGE_SIZE,
    sourceTableId: CUSTOMER_TABLE_ID,
    pruneScanned: 0,
    deletedStale: 0,
  };
}
