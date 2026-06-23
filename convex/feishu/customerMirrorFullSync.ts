// ActionCtx full-sync orchestration for the Customer mirror (ADR-0016 /
// ADR-0021): page the live Feishu Customer Table, upsert each page into the
// Convex mirror, then run the Mirror Prune. The registered fullSync/kick actions
// call runFullSync here; the pure pagination/stop-reason state machine lives in
// customerMirrorSync.ts.
//
// HARD RULE preserved (ADR-0010 / ADR-0012): only READs the Bitable Customer
// Table; writes land exclusively on the `customers` mirror via applyPage.

import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { callFeishu } from "./call";
import {
  addPageTotals,
  addPrunePage,
  completenessStopReason,
  emptyPruneTotals,
  emptyTotals,
  logMirrorPage,
  maxReportedTotal,
  nextPageTokenOrStop,
  pageSlotWaitMs,
  shouldPruneStaleRows,
  sleep,
  stalePageIds,
  type AppliedPage,
  type FeishuRecord,
  type MirrorStopReason,
  type PageWriteStats,
  type PruneTotals,
  type SearchResponse,
  type SyncTotals,
} from "./customerMirrorSync";
import { mapFeishuItemToCustomer } from "./customers";
import { projectionToRow } from "./customerMirrorRows";
import {
  DEV_CUSTOMER_FIXTURES,
  isDevCustomerFixturesEnabled,
} from "./devCustomerFixtures";
import {
  CUSTOMER_FIELD_NAMES,
  CUSTOMER_TABLE_ID,
  MIN_PAGE_REQUEST_INTERVAL_MS,
  PAGE_SIZE,
  PRUNE_PAGE_SIZE,
  requireAppToken,
} from "./customerMirrorConfig";
import { finishFullSync, type FullSyncResult } from "./customerMirrorCompletion";

export { skippedKickResult, type FullSyncResult } from "./customerMirrorCompletion";

async function waitForPageSlot(previousRequestStartedAt: number): Promise<number> {
  await sleep(pageSlotWaitMs(previousRequestStartedAt, MIN_PAGE_REQUEST_INTERVAL_MS, Date.now()));
  return Date.now();
}

async function fetchMirrorPage(
  ctx: ActionCtx,
  appToken: string,
  pageToken: string | undefined,
): Promise<SearchResponse> {
  const queryParams: Record<string, string> = { page_size: String(PAGE_SIZE) };
  if (pageToken) queryParams.page_token = pageToken;
  return await callFeishu<SearchResponse>(ctx, {
    path: `/bitable/v1/apps/${appToken}/tables/${CUSTOMER_TABLE_ID}/records/search`,
    method: "POST",
    auth: "tenant",
    json: { field_names: CUSTOMER_FIELD_NAMES },
    query: queryParams,
    label: "Customers mirror - Bitable page",
  });
}

// One page applied to the mirror, plus the recordIds it wrote — the prune step
// folds these into the "seen this sync" set so live rows are never tombstoned.
type AppliedPageWithIds = AppliedPage & { recordIds: string[] };

async function applyMirrorItems(
  ctx: ActionCtx,
  items: readonly FeishuRecord[],
  mirroredAt: number,
): Promise<AppliedPageWithIds> {
  const firstRecordId = items[0]?.record_id ?? "(none)";
  const lastRecordId = items.at(-1)?.record_id ?? "(none)";
  if (items.length === 0) {
    return {
      inserted: 0,
      updated: 0,
      unchanged: 0,
      duplicateRows: 0,
      rowCount: 0,
      firstRecordId,
      lastRecordId,
      recordIds: [],
    };
  }
  const projected = items.map((it) => projectionToRow(mapFeishuItemToCustomer(it)));
  const writeStats: PageWriteStats = await ctx.runMutation(
    internal.feishu.customersMirror.applyPage,
    { rows: projected, mirroredAt },
  );
  // Use the stored key (projectionToRow.recordId), NOT item.record_id, so the
  // seen-set matches what the prune scan reads back from the mirror.
  return {
    ...writeStats,
    rowCount: projected.length,
    firstRecordId,
    lastRecordId,
    recordIds: projected.map((row) => row.recordId),
  };
}

async function applyDevFixtures(
  ctx: ActionCtx,
  totals: SyncTotals,
  mirroredAt: number,
  seenRecordIds: Set<string>,
) {
  if (!isDevCustomerFixturesEnabled()) return;
  const fixtureStats: PageWriteStats = await ctx.runMutation(
    internal.feishu.customersMirror.applyPage,
    {
      rows: DEV_CUSTOMER_FIXTURES.map((customer) => projectionToRow(customer)),
      mirroredAt,
    },
  );
  // Fixtures are written to the mirror but are NOT Feishu rows, so they must be
  // marked "seen" or the prune would tombstone them on every dev sync.
  for (const customer of DEV_CUSTOMER_FIXTURES) seenRecordIds.add(customer.recordId);
  totals.rows += DEV_CUSTOMER_FIXTURES.length;
  totals.inserted += fixtureStats.inserted;
  totals.updated += fixtureStats.updated;
  totals.unchanged += fixtureStats.unchanged;
  totals.duplicateRows += fixtureStats.duplicateRows;
}

// Mirror Prune (ADR-0021). Scan the whole mirror in bounded pages and tombstone
// any row whose recordId was not observed during THIS sync — orphans from Feishu
// deletes / re-imports (fresh record_ids) the upsert-only mirror could never
// remove, so it drifted to 2-5x the live table. CALLERS MUST gate on
// shouldPruneStaleRows(finalStopReason): never prune after a partial/failed walk
// or a transient Feishu error would wipe live rows.
async function pruneStaleRows(
  ctx: ActionCtx,
  seenRecordIds: ReadonlySet<string>,
): Promise<PruneTotals> {
  const totals = emptyPruneTotals();
  let cursor: string | null = null;
  for (;;) {
    const result: {
      page: { _id: Id<"customers">; recordId: string }[];
      isDone: boolean;
      continueCursor: string;
    } = await ctx.runQuery(internal.feishu.customersMirror.listRowsForPrune, {
      paginationOpts: { numItems: PRUNE_PAGE_SIZE, cursor },
    });
    const staleIds = stalePageIds(result.page, seenRecordIds);
    if (staleIds.length > 0) {
      await ctx.runMutation(internal.feishu.customersMirror.deleteRowsById, { ids: staleIds });
    }
    addPrunePage(totals, result.page, staleIds);
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  console.log(
    `[customers-mirror] prune scanned=${totals.scanned} deletedStale=${totals.deleted}`,
  );
  return totals;
}

interface PageWalkResult {
  totals: SyncTotals;
  hadMore: boolean;
  stopReason: MirrorStopReason;
}

// Page the live Customer Table → upsert each page into the mirror, recording
// every written recordId into `seenRecordIds` (the prune's liveness set).
// Tenant-token; runs on the action runtime; called from the cron and `kick`.
async function walkMirrorPages(
  ctx: ActionCtx,
  appToken: string,
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
    previousRequestStartedAt = await waitForPageSlot(previousRequestStartedAt);
    const data = await fetchMirrorPage(ctx, appToken, pageToken);
    totals.reportedTotal = maxReportedTotal(totals.reportedTotal, data);
    const page = await applyMirrorItems(ctx, data.items ?? [], mirroredAt);
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

export async function runFullSync(
  ctx: ActionCtx,
  options: { startedAt?: number } = {},
): Promise<FullSyncResult> {
  const appToken = requireAppToken();
  // The caller (kick / fullSync) already acquired the refresh start lease via
  // startRefreshIfAllowed (ADR-0021 single-flight), so this run does no extra
  // start-stamping.
  const mirroredAt = options.startedAt ?? Date.now();
  // Every recordId written this run (source pages + dev fixtures). The prune
  // tombstones any mirror row NOT in this set after a complete sync.
  const seenRecordIds = new Set<string>();
  const { totals, hadMore, stopReason } = await walkMirrorPages(
    ctx,
    appToken,
    mirroredAt,
    seenRecordIds,
  );
  await applyDevFixtures(ctx, totals, mirroredAt, seenRecordIds);
  const finalStopReason = completenessStopReason(stopReason, totals);
  // Prune is gated on a verified-complete sync: a partial/failed walk leaves the
  // mirror untouched so a transient Feishu error can never wipe live rows.
  const prune = shouldPruneStaleRows(finalStopReason)
    ? await pruneStaleRows(ctx, seenRecordIds)
    : emptyPruneTotals();
  return await finishFullSync(ctx, totals, mirroredAt, hadMore, finalStopReason, prune);
}
