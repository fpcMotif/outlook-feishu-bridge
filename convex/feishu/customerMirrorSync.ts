// The Customer Mirror Refresh engine (ADR-0016). PURE helpers + a port-injected
// driver (runMirrorRefresh) — no ctx/db/I/O — so the page-walk, completeness,
// prune gate, and watermark accounting are unit-testable in isolation against an
// in-memory fake; the Convex adapter (customersMirror.ts) supplies the real port.
// A clean stop is only truly complete when paged rows match Feishu's `total`.

// One Feishu Base record as the page loop reads it.
export interface FeishuRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

// One Feishu record/search page response (the fields the loop reads).
export interface SearchResponse {
  items?: FeishuRecord[];
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

// --- Mirror Prune (tombstone, ADR-0021) ------------------------------------
// The mirror upserts but never deleted, so a Customer removed/re-imported in
// Feishu (fresh record_id) left an orphan forever — drifting to 2-5x the live
// table. Prune tombstones any mirror row whose recordId was NOT observed during
// a *complete* sync. PURE: stale-detection + the all-or-nothing gate are testable.

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

// --- Mirror Refresh engine ---------------------------------------------------
// Port-injected driver for one Mirror Refresh: page-walk → completeness → the
// all-or-nothing prune gate → finish (ADR-0019 extract-then-test, ADR-0021 prune).

// ~60ms between pages keeps the walk under Feishu's documented 20 req/sec ceiling.
export const MIRROR_PAGE_REQUEST_INTERVAL_MS = 60;

// One applied page plus the recordIds it wrote (folded into the "seen this sync" set).
export interface AppliedPageWithIds extends AppliedPage {
  recordIds: string[];
}

export interface PageWalkResult {
  totals: SyncTotals;
  hadMore: boolean;
  stopReason: MirrorStopReason;
}

// The seam: everything effectful the Mirror Refresh needs. The prod adapter wires
// these to Convex/Feishu; tests pass an in-memory fake (a virtual clock, scripted
// pages, a Map-backed apply/tombstone) and exercise the whole engine without Convex.
export interface MirrorRefreshPort<R> {
  clock: { now: () => number; sleep: (ms: number) => Promise<void> };
  fetchPage: (pageToken: string | undefined) => Promise<SearchResponse>;
  applyPage: (items: readonly FeishuRecord[], mirroredAt: number) => Promise<AppliedPageWithIds>;
  applyDevFixtures: (totals: SyncTotals, mirroredAt: number, seen: Set<string>) => Promise<void>;
  // Invoked ONLY when the engine's prune gate passes (never on a non-complete sync).
  tombstone: (seen: Set<string>) => Promise<PruneTotals>;
  finish: (args: {
    totals: SyncTotals;
    mirroredAt: number;
    hadMore: boolean;
    stopReason: MirrorStopReason;
    prune: PruneTotals;
  }) => Promise<R>;
}

// Page the source via the port until a stop reason fires, recording every written
// recordId into `seenRecordIds` (the prune's liveness set) via the tested helpers.
async function walkMirrorPages<R>(
  port: MirrorRefreshPort<R>,
  mirroredAt: number,
  seenRecordIds: Set<string>,
): Promise<PageWalkResult> {
  const seenPageTokens = new Set<string>();
  const totals = emptyTotals();
  let hadMore = false;
  let stopReason: MirrorStopReason = "complete";
  let pageToken: string | undefined;
  let previousRequestStartedAt = 0;
  for (;;) {
    const waitMs = pageSlotWaitMs(
      previousRequestStartedAt,
      MIRROR_PAGE_REQUEST_INTERVAL_MS,
      port.clock.now(),
    );
    await port.clock.sleep(waitMs);
    previousRequestStartedAt = port.clock.now();
    const data = await port.fetchPage(pageToken);
    totals.reportedTotal = maxReportedTotal(totals.reportedTotal, data);
    const page = await port.applyPage(data.items ?? [], mirroredAt);
    addPageTotals(totals, page);
    for (const recordId of page.recordIds) seenRecordIds.add(recordId);
    hadMore = data.has_more === true;
    logMirrorPage(totals.pages, page, data);
    const next = nextPageTokenOrStop(data, seenPageTokens, totals.pages);
    if (next.stopReason) {
      stopReason = next.stopReason;
      break;
    }
    pageToken = next.pageToken;
  }
  return { totals, hadMore, stopReason };
}

// Drive one full Mirror Refresh through the injected port — page-walk, completeness,
// and the prune gate decided here in pure code; only I/O crosses the port. Returns
// what finish produces (the Convex adapter throws on a non-complete stop).
export async function runMirrorRefresh<R>(
  port: MirrorRefreshPort<R>,
  options: { startedAt?: number } = {},
): Promise<R> {
  const mirroredAt = options.startedAt ?? port.clock.now();
  const seenRecordIds = new Set<string>();
  const { totals, hadMore, stopReason } = await walkMirrorPages(port, mirroredAt, seenRecordIds);
  await port.applyDevFixtures(totals, mirroredAt, seenRecordIds);
  const finalStopReason = completenessStopReason(stopReason, totals);
  // Prune ONLY on a verified-complete sync — a partial/failed walk leaves the
  // mirror untouched so a transient Feishu error can never wipe live rows (ADR-0021).
  const prune = shouldPruneStaleRows(finalStopReason)
    ? await port.tombstone(seenRecordIds)
    : emptyPruneTotals();
  return port.finish({ totals, mirroredAt, hadMore, stopReason: finalStopReason, prune });
}
