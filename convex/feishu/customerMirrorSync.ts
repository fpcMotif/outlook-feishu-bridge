// Pure pagination/orchestration state machine for the Customer Mirror full
// sync (ADR-0016, audit be-customers-2). Everything here is PURE — no ctx, no
// db, no I/O — so the page-to-page advance, completeness/watermark accounting,
// and stop-reason logic can be unit-tested in isolation. The Convex action in
// customersMirror.ts owns the effectful fetch/apply per page and delegates
// every decision to the helpers below.
//
// The Mirror Refresh pages the Customer Table until Feishu reports
// has_more=false, then stamps the Mirror Watermark. A clean stop is only truly
// complete when the rows we paged match Feishu's reported `total`; a shortfall
// or a non-clean stop reason is promoted to a hard, audited failure.

// One Feishu record/search page response (the fields the loop reads).
export interface SearchResponse {
  items?: { record_id: string; fields: Record<string, unknown> }[];
  has_more?: boolean;
  page_token?: string;
  // Feishu records/search returns the table's total record count on every page
  // (official field "total" / 总记录数) — the authoritative completeness signal.
  total?: number;
}

export type MirrorStopReason =
  | "complete"
  | "missingPageToken"
  | "duplicatePageToken"
  | "incompleteTotal";

export interface PageWriteStats {
  inserted: number;
  updated: number;
  unchanged: number;
  duplicateRows: number;
}

export interface SyncTotals extends PageWriteStats {
  pages: number;
  rows: number;
  // sourceRows counts only rows paged from Feishu (excludes dev fixtures);
  // reportedTotal is the max `total` Feishu reported across pages. A gap
  // between them means the mirror is silently incomplete.
  sourceRows: number;
  reportedTotal: number;
}

export interface AppliedPage extends PageWriteStats {
  rowCount: number;
  firstRecordId: string;
  lastRecordId: string;
}

export function emptyTotals(): SyncTotals {
  return {
    pages: 0,
    rows: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    duplicateRows: 0,
    sourceRows: 0,
    reportedTotal: 0,
  };
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// 20 requests/sec is Feishu's documented ceiling; pace pages ~60ms apart.
export function pageSlotWaitMs(
  previousRequestStartedAt: number,
  minIntervalMs: number,
  now: number,
): number {
  if (previousRequestStartedAt === 0) return 0;
  return minIntervalMs - (now - previousRequestStartedAt);
}

// Fold one applied page into the running totals (in place, like the original).
export function addPageTotals(totals: SyncTotals, page: AppliedPage): void {
  totals.pages += 1;
  totals.rows += page.rowCount;
  totals.sourceRows += page.rowCount;
  totals.inserted += page.inserted;
  totals.updated += page.updated;
  totals.unchanged += page.unchanged;
  totals.duplicateRows += page.duplicateRows;
}

export function maxReportedTotal(current: number, page: SearchResponse): number {
  return Math.max(current, page.total ?? 0);
}

export function stopReasonForPage(
  data: SearchResponse,
  seenPageTokens: Set<string>,
): MirrorStopReason | null {
  if (data.has_more !== true) return "complete";
  if (!data.page_token) return "missingPageToken";
  if (seenPageTokens.has(data.page_token)) return "duplicatePageToken";
  return null;
}

// Decide whether to keep paging. On a continue, the next page_token is recorded
// in seenPageTokens (loop-detection) and returned; otherwise a stop reason is.
export function nextPageTokenOrStop(
  data: SearchResponse,
  seenPageTokens: Set<string>,
  pageNumber: number,
): { pageToken?: string; stopReason?: MirrorStopReason } {
  const stopReason = stopReasonForPage(data, seenPageTokens);
  if (stopReason === "complete") return { stopReason };
  if (stopReason !== null) {
    console.error(`[customers-mirror] stopped early: reason=${stopReason} after page=${pageNumber}`);
    return { stopReason };
  }
  const nextPageToken = data.page_token;
  if (!nextPageToken) return { stopReason: "missingPageToken" };
  seenPageTokens.add(nextPageToken);
  return { pageToken: nextPageToken };
}

// A clean has_more=false stop is only truly complete if we paged at least as
// many source rows as Feishu's reported `total`. A shortfall means rows went
// missing silently — promote it to a hard, audited failure (ADR-0016).
export function completenessStopReason(
  stopReason: MirrorStopReason,
  totals: SyncTotals,
): MirrorStopReason {
  if (stopReason !== "complete") return stopReason;
  if (totals.reportedTotal > totals.sourceRows) {
    console.error(
      `[customers-mirror] incompleteTotal: reportedTotal=${totals.reportedTotal} ` +
        `sourceRows=${totals.sourceRows}`,
    );
    return "incompleteTotal";
  }
  return stopReason;
}

export function logMirrorPage(pageNumber: number, page: AppliedPage, data: SearchResponse): void {
  console.log(
    `[customers-mirror] page=${pageNumber} items=${page.rowCount} inserted=${page.inserted} ` +
      `updated=${page.updated} unchanged=${page.unchanged} duplicateRows=${page.duplicateRows} ` +
      `hasMore=${data.has_more === true} nextToken=${Boolean(data.page_token)} ` +
      `first=${page.firstRecordId} last=${page.lastRecordId}`,
  );
}

// --- Mirror Prune (tombstone) ----------------------------------------------
// The mirror upserts keyed by recordId but never deleted rows, so a Customer
// removed/re-imported in Feishu (which mints a fresh record_id) left an orphan
// in Convex forever — the mirror drifted to 2-5x the live Customer Table. The
// Mirror Prune deletes any Convex row whose recordId was NOT observed in the
// authoritative source during a *complete* sync. Everything here is PURE so the
// stale-detection and the all-or-nothing safety gate are unit-testable; the
// effectful pagination + delete fan-out lives in customersMirror.ts (ADR-0021).

// A row read back from the mirror during the prune scan — only its id and its
// natural key matter for the stale decision.
export interface PrunableRow<TId> {
  _id: TId;
  recordId: string;
}

export interface PruneTotals {
  scanned: number;
  deleted: number;
}

export function emptyPruneTotals(): PruneTotals {
  return { scanned: 0, deleted: 0 };
}

// Ids of mirror rows whose recordId was not seen in THIS sync's source set —
// these are orphans and must be tombstoned. Pure.
export function stalePageIds<TId>(
  rows: readonly PrunableRow<TId>[],
  seenRecordIds: ReadonlySet<string>,
): TId[] {
  const ids: TId[] = [];
  for (const row of rows) {
    if (!seenRecordIds.has(row.recordId)) ids.push(row._id);
  }
  return ids;
}

// HARD SAFETY GATE: prune ONLY after a fully verified, complete sync. A partial
// or failed page run (missingPageToken / duplicatePageToken / incompleteTotal)
// must never delete — otherwise a transient Feishu error or a truncated page
// walk would wipe live rows that simply were not paged this run. Pure.
export function shouldPruneStaleRows(stopReason: MirrorStopReason): boolean {
  return stopReason === "complete";
}

// Fold one scanned page into the running prune totals (in place).
export function addPrunePage<TId>(
  totals: PruneTotals,
  scannedRows: readonly PrunableRow<TId>[],
  deletedIds: readonly TId[],
): void {
  totals.scanned += scannedRows.length;
  totals.deleted += deletedIds.length;
}
