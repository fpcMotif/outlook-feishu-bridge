/* eslint-disable max-lines */
// Server-indexed Customer search (ADR-0016). Mirrors the Feishu Customer Table
// into a Convex table with a search index, so per-keystroke autocomplete in
// the SPA can run as a ranked Convex query — no client-side preload, no
// per-keystroke Bitable round-trip, scales past 50k rows.
//
// HARD RULE preserved (ADR-0010 / ADR-0012): we only READ the Bitable Customer
// Table. Writes land exclusively on Convex's own `customers` mirror table.
//
// Official Feishu doc:
//   search records:
//     https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/search
// Convex search index:
//   https://docs.convex.dev/database/text-search

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";

import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { callFeishu } from "./call";
import { toSearchQueryString } from "./cjkSearch";
import {
  addPrunePage,
  emptyPruneTotals,
  shouldPruneStaleRows,
  stalePageIds,
  type PruneTotals,
} from "./customerMirrorSync";
import {
  canonicalCustomerDomain,
  emailDomain,
  findCustomerByEmail,
  mapFeishuItemToCustomer,
  type CustomerRecord,
} from "./customers";
import {
  dedupeRowsByRecordId,
  mirrorDocToCustomer,
  projectionToRow,
  type CustomerUpsertRow,
} from "./customerMirrorRows";
import {
  DEV_CUSTOMER_FIXTURES,
  isDevCustomerFixturesEnabled,
  mergePreferredCustomers,
  searchDevCustomerFixtures,
} from "./devCustomerFixtures";
import {
  runCustomerSearch,
  type CustomerSearchOutcome,
  type CustomerSearchPort,
} from "./customerSearchEngine";

export { buildSearchBlob } from "./customerMirrorRows";

const CUSTOMER_TABLE_ID = "tbl4TE2GV472sKzp";
const PAGE_SIZE = 500;
// Cache-miss search only needs enough rows to fill the picker and warm the
// mirror around the user's exact query. Keep the full-sync page size at
// Feishu's documented max, but do not pull/write 500 rows on an interactive
// miss when the UI returns at most 50.
const CACHE_MISS_PAGE_SIZE = 50;
// Mirror Prune scans the whole mirror in bounded pages so each delete mutation
// stays well under Convex's per-transaction write budget; the action paginates
// externally (same shape as the full-sync page loop).
const PRUNE_PAGE_SIZE = 500;
const MIN_CUSTOMER_SEARCH_LENGTH = 2;
// Official Feishu limits (open.feishu.cn only - no third-party wrapper, no
// MAX_PAGES cap of our own). The earlier 20-page / 10,000-row ceiling was
// purely ours and silently truncated once the Customer Table grew past it; the
// loop now pages until Feishu itself says has_more=false.
//   - records/search: POST endpoint, max page_size=500, supports page_token,
//     returns has_more/page_token, and is rate-limited to 20 requests/sec.
//   - records/list: GET endpoint with the same page_size/page_token shape, but
//     Feishu marks it historical and recommends records/search instead.
//   docs:
//     records/search:  /document/server-docs/docs/bitable-v1/app-table-record/search
//     records/list:    /document/server-docs/docs/bitable-v1/app-table-record/list
const MIN_PAGE_REQUEST_INTERVAL_MS = 60;
// Server-side Mirror Kick cooldown (ADR-0016 amendment). Global + authoritative:
// the frontend module-level cooldown resets on reload/tab, so the on-demand kick
// is rate-limited here regardless of how many tabs/reloads fire it.
const MIRROR_KICK_COOLDOWN_MS = 15 * 60 * 1000;
// Single-flight lease for a full Mirror Refresh (ADR-0021 hardening). The cron
// fullSync and the on-demand kick both acquire the SAME start lease via
// startRefreshIfAllowed, so two refreshes can never run concurrently and race
// the prune's delete fan-out. 15 min >> one full sync (~45 s), so the lease only
// ever blocks genuine overlap, never a legitimately-spaced refresh.
const MIRROR_REFRESH_LEASE_MS = MIRROR_KICK_COOLDOWN_MS;
// Per-domain cooldown for matchEmailAndCacheMiss. Same window as the kick so a
// domain that fires a live probe doesn't re-probe within the same 15-min cycle.
const DOMAIN_MATCH_COOLDOWN_MS = 15 * 60 * 1000;
// Maximum pages fetched per matchEmailAndCacheMiss call. One filtered page of 50
// covers the common case; additional pages only run when the first page has no
// strict canonical match but has_more=true (superstring-domain rows pushed the
// target off page 1).
const MAX_CACHE_MISS_PAGES = 3;
// Drift alarm (ADR-0021 hardening). After a complete sync + prune the retained
// mirror count should track Feishu's reported total (plus a couple of dev
// fixtures). A retained count that still exceeds the source total by more than
// this ratio AND an absolute floor means orphans escaped the prune — surface it
// loudly so silent drift can never recur unseen.
const DRIFT_ALARM_RATIO = 0.05;
const DRIFT_ALARM_FLOOR = 10;
const CUSTOMER_FIELD_NAMES = [
  "Account Name",
  "Record Id",
  "域名",
  "全名",
  "Account No.",
  "Country and Regio",
  "Owner",
];

function requireAppToken(): string {
  const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  if (!appToken) throw new Error("FEISHU_BITABLE_APP_TOKEN must be set");
  return appToken;
}

// Upsert a page of Customers into the mirror table, keyed by Bitable recordId.
// Bounded write fan-out per call so a single mutation stays well under Convex's
// per-transaction document budget (the cron paginates externally).
export const applyPage = internalMutation({
  args: {
    rows: v.array(
      v.object({
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
      }),
    ),
    mirroredAt: v.number(),
  },
  handler: async (ctx, args) => {
    const rows = dedupeRowsByRecordId(args.rows);
    const duplicateRows = args.rows.length - rows.length;
    const existingRows = await Promise.all(
      rows.map(async (row) => ({
        row,
        existing: await ctx.db
          .query("customers")
          .withIndex("by_recordId", (q) => q.eq("recordId", row.recordId))
          .unique(),
      })),
    );
    const writes = await Promise.all(
      existingRows.map(async ({ row, existing }) => {
        // Explicit undefined for every optional column before spreading `row`
        // so ctx.db.patch removes a field whose Bitable cell was cleared.
        // Convex strips undefined from action→mutation args, but inside a
        // mutation handler explicit undefined IS propagated by db.patch (it
        // removes the key). Without this, cleared cells can never be reflected.
        const fields = {
          domain: undefined,
          domainKey: undefined,
          fullName: undefined,
          accountNo: undefined,
          countryRegion: undefined,
          ownerOpenId: undefined,
          ownerName: undefined,
          ...row,
          mirroredAt: args.mirroredAt,
        };
        if (existing) {
          if (!customerRowChanged(existing, row)) {
            return "unchanged" as const;
          }
          await ctx.db.patch(existing._id, fields);
          return "updated" as const;
        }
        await ctx.db.insert("customers", fields);
        return "inserted" as const;
      }),
    );
    const inserted = writes.filter((result) => result === "inserted").length;
    const updated = writes.filter((result) => result === "updated").length;
    const unchanged = writes.length - inserted - updated;
    return { inserted, updated, unchanged, duplicateRows };
  },
});

// Mirror Prune scan (ADR-0016 / ADR-0021). Paginated read of the mirror that
// returns only {_id, recordId} so the orchestrating action can decide which
// rows are orphans (recordId not seen during a complete sync) without shipping
// whole documents back. Read-only.
export const listRowsForPrune = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const result = await ctx.db.query("customers").paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((row) => ({ _id: row._id, recordId: row.recordId })),
    };
  },
});

// Tombstone a bounded batch of mirror rows. Only ever called by the prune step
// after a complete, completeness-verified sync (see shouldPruneStaleRows); the
// action bounds the batch via PRUNE_PAGE_SIZE so this mutation stays within the
// per-transaction write budget.
export const deleteRowsById = internalMutation({
  args: { ids: v.array(v.id("customers")) },
  handler: async (ctx, args) => {
    await Promise.all(args.ids.map((id) => ctx.db.delete(id)));
    return { deleted: args.ids.length };
  },
});

// Mirror Refresh start lease (ADR-0016 amendment + ADR-0021 single-flight). The
// single shared gate that BOTH the cron fullSync and the on-demand kick acquire:
// it atomically check-and-sets lastRefreshStartedAt, returning started=false
// (with the remaining cooldown) when a refresh already started within the
// window — so concurrent refreshes collapse to one and can never race the
// prune's delete fan-out. The state row may not exist yet on a fresh deployment,
// so insert a minimal never-completed row in that case.
export const startRefreshIfAllowed = internalMutation({
  args: { startedAt: v.number(), cooldownMs: v.number() },
  handler: async (ctx, args): Promise<{ started: true } | { started: false; remainingMs: number }> => {
    const existing = await ctx.db.query("customersMirrorState").first();
    const lastStartedAt = existing?.lastRefreshStartedAt ?? null;
    if (lastStartedAt !== null) {
      const elapsedMs = Math.max(0, args.startedAt - lastStartedAt);
      if (elapsedMs < args.cooldownMs) {
        return { started: false, remainingMs: args.cooldownMs - elapsedMs };
      }
    }
    if (existing) {
      await ctx.db.patch(existing._id, { lastRefreshStartedAt: args.startedAt });
    } else {
      await ctx.db.insert("customersMirrorState", {
        lastFullSyncAt: 0,
        lastRowCount: 0,
        lastRefreshStartedAt: args.startedAt,
      });
    }
    return { started: true };
  },
});

// Per-domain cooldown gate for matchEmailAndCacheMiss. Follows the same
// check-and-set pattern as startRefreshIfAllowed: one mutation that atomically
// reads the last attempt timestamp and writes a new one, so concurrent SPA
// sessions for the same domain collapse to a single live Feishu probe.
export const startDomainMatchIfAllowed = internalMutation({
  args: { domain: v.string(), startedAt: v.number(), cooldownMs: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<{ started: true } | { started: false; remainingMs: number }> => {
    const existing = await ctx.db
      .query("customerDomainMatchCooldowns")
      .withIndex("by_domain", (q) => q.eq("domain", args.domain))
      .unique();
    if (existing) {
      const elapsedMs = Math.max(0, args.startedAt - existing.lastAttemptAt);
      if (elapsedMs < args.cooldownMs) {
        return { started: false, remainingMs: args.cooldownMs - elapsedMs };
      }
      await ctx.db.patch(existing._id, { lastAttemptAt: args.startedAt });
    } else {
      await ctx.db.insert("customerDomainMatchCooldowns", {
        domain: args.domain,
        lastAttemptAt: args.startedAt,
      });
    }
    return { started: true };
  },
});

// Stamp the watermark row once per successful fullSync run.
export const recordSyncCompletion = internalMutation({
  args: {
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
    lastStopReason: v.union(
      v.literal("complete"),
      v.literal("missingPageToken"),
      v.literal("duplicatePageToken"),
      v.literal("incompleteTotal"),
    ),
    lastDurationMs: v.number(),
    lastFinishedAt: v.number(),
    lastSourceTableId: v.string(),
    // Mirror Prune accounting (ADR-0021): rows scanned in the post-sync prune
    // and how many orphans were tombstoned. Both 0 when the sync did not
    // complete (prune is gated on a verified-complete run).
    lastPruneScannedCount: v.number(),
    lastDeletedStaleCount: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("customersMirrorState").first();
    if (existing) {
      await ctx.db.patch(existing._id, args);
    } else {
      await ctx.db.insert("customersMirrorState", args);
    }
  },
});

interface FeishuRecord {
  record_id: string;
  fields: Record<string, unknown>;
}
interface SearchResponse {
  items?: FeishuRecord[];
  has_more?: boolean;
  page_token?: string;
  // Feishu records/search returns the table's total record count on every page
  // (official field "total" / 总记录数) — the authoritative completeness signal.
  total?: number;
}

type MirrorStopReason =
  | "complete"
  | "missingPageToken"
  | "duplicatePageToken"
  | "incompleteTotal";

interface PageWriteStats {
  inserted: number;
  updated: number;
  unchanged: number;
  duplicateRows: number;
}

interface FullSyncResult {
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

interface SyncTotals extends PageWriteStats {
  pages: number;
  rows: number;
  // sourceRows counts only rows paged from Feishu (excludes dev fixtures);
  // reportedTotal is the max `total` Feishu reported across pages. A gap
  // between them means the mirror is silently incomplete.
  sourceRows: number;
  reportedTotal: number;
}

interface AppliedPage extends PageWriteStats {
  rowCount: number;
  firstRecordId: string;
  lastRecordId: string;
}

function customerRowChanged(
  existing: CustomerUpsertRow,
  next: CustomerUpsertRow,
): boolean {
  return (
    existing.recordId !== next.recordId ||
    existing.name !== next.name ||
    existing.domain !== next.domain ||
    // domainKey participates so the first full sync after the column shipped
    // re-stamps every row (undefined !== canonical value). The applyPage
    // explicit-undefined spread also triggers this check when a cell is cleared.
    existing.domainKey !== next.domainKey ||
    existing.fullName !== next.fullName ||
    existing.accountNo !== next.accountNo ||
    existing.countryRegion !== next.countryRegion ||
    existing.ownerOpenId !== next.ownerOpenId ||
    existing.ownerName !== next.ownerName ||
    existing.searchBlob !== next.searchBlob
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForPageSlot(previousRequestStartedAt: number): Promise<number> {
  const waitMs =
    previousRequestStartedAt === 0
      ? 0
      : MIN_PAGE_REQUEST_INTERVAL_MS - (Date.now() - previousRequestStartedAt);
  await sleep(waitMs);
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
  // seen-set matches exactly what the prune scan reads back from the mirror.
  return {
    ...writeStats,
    rowCount: projected.length,
    firstRecordId,
    lastRecordId,
    recordIds: projected.map((row) => row.recordId),
  };
}

function addPageTotals(totals: SyncTotals, page: AppliedPage): void {
  totals.pages += 1;
  totals.rows += page.rowCount;
  totals.sourceRows += page.rowCount;
  totals.inserted += page.inserted;
  totals.updated += page.updated;
  totals.unchanged += page.unchanged;
  totals.duplicateRows += page.duplicateRows;
}

function stopReasonForPage(
  data: SearchResponse,
  seenPageTokens: Set<string>,
): MirrorStopReason | null {
  if (data.has_more !== true) return "complete";
  if (!data.page_token) return "missingPageToken";
  if (seenPageTokens.has(data.page_token)) return "duplicatePageToken";
  return null;
}

function logMirrorPage(pageNumber: number, page: AppliedPage, data: SearchResponse): void {
  console.log(
    `[customers-mirror] page=${pageNumber} items=${page.rowCount} inserted=${page.inserted} ` +
      `updated=${page.updated} unchanged=${page.unchanged} duplicateRows=${page.duplicateRows} ` +
      `hasMore=${data.has_more === true} nextToken=${Boolean(data.page_token)} ` +
      `first=${page.firstRecordId} last=${page.lastRecordId}`,
  );
}

function nextPageTokenOrStop(
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
// any row whose recordId was not observed during THIS sync — those are orphans
// from Feishu deletes / re-imports (which mint fresh record_ids) that the
// upsert-only mirror could never remove, so it drifted to 2-5x the live table.
// CALLERS MUST gate on shouldPruneStaleRows(finalStopReason): never prune after
// a partial/failed page walk, or a transient Feishu error would wipe live rows.
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

async function finishFullSync(
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

// Drift alarm (ADR-0021 hardening). After a complete sync the prune has run, so
// the retained mirror count (scanned − deleted) should track Feishu's reported
// total (plus a handful of dev fixtures). If it still exceeds the source total
// beyond the ratio AND the absolute floor, orphans escaped the prune — log
// loudly so the overcount that caused the original 2-5x drift can never recur
// silently. Pure observability; never throws.
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

// A clean has_more=false stop is only truly complete if we paged at least as
// many source rows as Feishu's reported `total`. A shortfall means rows went
// missing silently — promote it to a hard, audited failure (ADR-0016).
function completenessStopReason(
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

// Page through the live Customer Table → upsert into the Convex mirror.
// Tenant-token; runs on the Convex action runtime; called from the cron and
// (optionally) from `kick` for an on-demand refresh.
interface PageWalkResult {
  totals: SyncTotals;
  hadMore: boolean;
  stopReason: MirrorStopReason;
}

// Page the live Customer Table → upsert each page into the mirror, recording
// every written recordId into `seenRecordIds` (the prune's liveness set).
async function walkMirrorPages(
  ctx: ActionCtx,
  appToken: string,
  mirroredAt: number,
  seenRecordIds: Set<string>,
): Promise<PageWalkResult> {
  const seenPageTokens = new Set<string>();
  const totals: SyncTotals = {
    pages: 0,
    rows: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    duplicateRows: 0,
    sourceRows: 0,
    reportedTotal: 0,
  };
  let hadMore = false;
  let stopReason: MirrorStopReason = "complete";
  let pageToken: string | undefined;
  let previousRequestStartedAt = 0;
  for (;;) {
    previousRequestStartedAt = await waitForPageSlot(previousRequestStartedAt);
    const data = await fetchMirrorPage(ctx, appToken, pageToken);
    totals.reportedTotal = Math.max(totals.reportedTotal, data.total ?? 0);
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

async function runFullSync(
  ctx: ActionCtx,
  options: { startedAt?: number } = {},
): Promise<FullSyncResult> {
  const appToken = requireAppToken();
  // The caller (kick / fullSync) has already acquired the refresh start lease via
  // startRefreshIfAllowed, which stamps lastRefreshStartedAt — so this run does no
  // extra start-stamping (ADR-0021 single-flight).
  const mirroredAt = options.startedAt ?? Date.now();
  // Every recordId written to the mirror this run (source pages + dev fixtures).
  // The prune tombstones any mirror row NOT in this set after a complete sync.
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

export const fullSync = internalAction({
  args: {},
  handler: async (ctx): Promise<FullSyncResult> => {
    const started = Date.now();
    // Single-flight (ADR-0021 hardening): the weekly cron and the on-demand kick
    // share ONE start lease, so a cron refresh that overlaps an in-flight kick
    // (or vice-versa) backs off instead of running concurrently and racing the
    // prune's delete fan-out against the other run's inserts.
    const lease = await ctx.runMutation(
      internal.feishu.customersMirror.startRefreshIfAllowed,
      { startedAt: started, cooldownMs: MIRROR_REFRESH_LEASE_MS },
    );
    if (!lease.started) {
      const remainingS = Math.round(lease.remainingMs / 1000);
      console.log(`[customers-mirror] fullSync skipped (refresh in flight, ${remainingS}s remaining)`);
      return skippedKickResult();
    }
    const out = await runFullSync(ctx, { startedAt: started });
    console.log(
      `[customers-mirror] fullSync ok pages=${out.pages} rows=${out.rows} ` +
        `inserted=${out.inserted} updated=${out.updated} unchanged=${out.unchanged} ` +
        `duplicateRows=${out.duplicateRows} sourceRows=${out.sourceRows} ` +
        `reportedTotal=${out.reportedTotal} pruneScanned=${out.pruneScanned} ` +
        `deletedStale=${out.deletedStale} ` +
        `stopReason=${out.stopReason} duration=${Date.now() - started}ms`,
    );
    return out;
  },
});

// A Mirror Kick that lands inside the cooldown window does no Feishu paging and
// writes no watermark — a structural no-op result (ADR-0016 amendment).
function skippedKickResult(): FullSyncResult {
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

// Public on-demand Mirror Kick — the SPA forces a refresh when the picker opens.
// Globally rate-limited server-side (ADR-0016 amendment): if any full refresh
// started within the cooldown, skip the Feishu re-page entirely. The weekly cron
// (fullSync) is on its own path and never gated here.
export const kick = action({
  args: {},
  handler: async (ctx): Promise<FullSyncResult> => {
    const now = Date.now();
    const start = await ctx.runMutation(
      internal.feishu.customersMirror.startRefreshIfAllowed,
      { startedAt: now, cooldownMs: MIRROR_KICK_COOLDOWN_MS },
    );
    if (!start.started) {
      const remainingS = Math.round(start.remainingMs / 1000);
      console.log(`[customers-mirror] kick skipped (cooldown, ${remainingS}s remaining)`);
      return skippedKickResult();
    }
    return await runFullSync(ctx, { startedAt: now });
  },
});

// Live leg of the Customer search (ADR-0016 § "Per-request cache miss"): falls
// through to the LIVE Feishu /records/search with the same `or` `contains`
// filter the legacy per-keystroke path used, then INCREMENTALLY upserts any new
// rows into the mirror so the next identical query hits the fast path. Slower
// than the mirror query (200-500 ms cross-border), but the latency hit lands
// exactly when the mirror missed — and it self-heals for next time. Only ever
// invoked by the Customer-search engine after a mirror miss.
async function liveSearchAndBackfill(
  ctx: ActionCtx,
  q: string,
  mineFor?: string,
): Promise<{ records: CustomerRecord[]; backfilled: number }> {
  const appToken = requireAppToken();
  const started = Date.now();
  const data: SearchResponse = await callFeishu<SearchResponse>(ctx, {
    path: `/bitable/v1/apps/${appToken}/tables/${CUSTOMER_TABLE_ID}/records/search`,
    method: "POST",
    auth: "tenant",
    json: {
      field_names: CUSTOMER_FIELD_NAMES,
      filter: {
        conjunction: "or",
        conditions: [
          { field_name: "Account Name", operator: "contains", value: [q] },
          { field_name: "域名", operator: "contains", value: [q] },
        ],
      },
    },
    query: { page_size: String(CACHE_MISS_PAGE_SIZE) },
    label: "Customers mirror — live search on cache miss",
  });
  const backfilledRecords: CustomerRecord[] = (data.items ?? []).map((item) =>
    mapFeishuItemToCustomer(item),
  );
  if (backfilledRecords.length > 0) {
    await ctx.runMutation(internal.feishu.customersMirror.applyPage, {
      rows: backfilledRecords.map((customer) => projectionToRow(customer)),
      mirroredAt: Date.now(),
    });
  }
  const records = mergePreferredCustomers(
    searchDevCustomerFixtures(q, mineFor),
    mineFor === undefined
      ? backfilledRecords
      : backfilledRecords.filter((record) => record.owner?.openId === mineFor),
  );
  console.log(
    `[customers-mirror] live search q="${q.slice(0, 40)}" -> ${records.length}/${backfilledRecords.length} backfilled (${Date.now() - started}ms)`,
  );
  return { records, backfilled: backfilledRecords.length };
}

// The real Customer-search port: the mirror leg via the internal ranked query,
// the live leg via Feishu + backfill. The engine (customerSearchEngine.
// runCustomerSearch) owns the strategy — min-length gate, mirror-first, live on
// miss — this adapter only supplies the I/O.
function makeCustomerSearchPort(ctx: ActionCtx): CustomerSearchPort<CustomerRecord> {
  return {
    mirrorSearch: async (q, mineFor) => {
      const hit: { records: CustomerRecord[]; mirroredAt: number | null } = await ctx.runQuery(
        internal.feishu.customersMirror.search,
        mineFor === undefined ? { q } : { q, mineFor },
      );
      return hit;
    },
    liveSearch: (q, mineFor) => liveSearchAndBackfill(ctx, q, mineFor),
  };
}

// The ONE public Customer-search entry point (ADR-0016 amendment): the SPA no
// longer decides mirror-vs-live — the engine does, server-side. Registered as
// an action because the live fallback calls Feishu, which a query cannot; the
// returned `source` is the provenance the taskpane can badge and both sides'
// logs join on.
export const searchCustomers = action({
  args: {
    q: v.string(),
    mineFor: v.optional(v.string()),
    // When false the engine skips the live Feishu leg even on a mirror miss —
    // used by the SPA hook during an active negative-cache TTL so the mirror is
    // always consulted (it may have been backfilled by matchEmailAndCacheMiss)
    // without paying another cross-border live search.
    liveAllowed: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<CustomerSearchOutcome<CustomerRecord>> => {
    return await runCustomerSearch(makeCustomerSearchPort(ctx), {
      q: args.q,
      mineFor: args.mineFor,
      minLength: MIN_CUSTOMER_SEARCH_LENGTH,
      liveAllowed: args.liveAllowed,
    });
  },
});

export const matchByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args): Promise<{ customer: CustomerRecord | null }> => {
    const domain = canonicalCustomerDomain(emailDomain(args.email));
    if (!domain) return { customer: null };
    // Probe the canonical-key index first. The old by_domain probe compared a
    // lowercased canonical domain against the RAW 域名 cell, so any cell with
    // casing/padding could never match — a permanent miss no re-sync fixed.
    // The by_domain fallback only covers rows synced before domainKey existed;
    // the next full sync re-stamps every row and the fallback goes dead.
    const hit =
      (await ctx.db
        .query("customers")
        .withIndex("by_domainKey", (q) => q.eq("domainKey", domain))
        .first()) ??
      (await ctx.db
        .query("customers")
        .withIndex("by_domain", (q) => q.eq("domain", domain))
        .first());
    if (hit) {
      if (hit.recordId === "dev_fixture_fanpc_customer") {
        console.log(
          `[dev-customer-fixture] TEST ONLY matched fanpc customer for ${domain}`,
        );
      }
      return { customer: mirrorDocToCustomer(hit) };
    }
    const fixture = searchDevCustomerFixtures(domain)[0] ?? null;
    if (fixture) {
      console.log(`[dev-customer-fixture] TEST ONLY matched in-memory fixture for ${domain}`);
    }
    return { customer: fixture };
  },
});

// Cache-aside lazy fill for the domain auto-match. Called by the SPA only
// AFTER matchByEmail returned null. Fires a live Feishu /records/search
// filtered to the canonical domain (≤ CACHE_MISS_PAGE_SIZE rows per page,
// up to MAX_CACHE_MISS_PAGES pages), upserts results into the mirror, and
// returns the strict canonical match so the taskpane can select it immediately.
//
// Server-side per-domain cooldown (startDomainMatchIfAllowed) prevents
// repeated live probes within the same 15-min window — concurrent SPA sessions
// and rapid re-opens collapse to one actual Feishu call. The client-side
// 5-min negative-cache TTL (EMPTY_DOMAIN_MATCH_TTL_MS in the SPA hook) is
// advisory; the server gate is authoritative.
//
// Pagination: a `contains` filter can return superstring rows before the target
// (e.g. notacme.com before acme.com). If the first page has no strict match
// but has_more=true we fetch at most two more pages before giving up.
//
// The filter uses `contains` with the canonical (lowercased) domain so cells
// holding surrounding text still match. A cell whose casing differs from the
// canonical form may evade this probe; it is healed by the next full sync.
export const matchEmailAndCacheMiss = action({
  args: { email: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ customer: CustomerRecord | null; backfilled: number }> => {
    const domain = canonicalCustomerDomain(emailDomain(args.email));
    if (!domain) return { customer: null, backfilled: 0 };
    const gate: { started: true } | { started: false; remainingMs: number } =
      await ctx.runMutation(internal.feishu.customersMirror.startDomainMatchIfAllowed, {
        domain,
        startedAt: Date.now(),
        cooldownMs: DOMAIN_MATCH_COOLDOWN_MS,
      });
    if (!gate.started) {
      const remainingS = Math.round((gate as { started: false; remainingMs: number }).remainingMs / 1000);
      console.log(
        `[customers-mirror] matchEmailAndCacheMiss domain="${domain}" -> skipped (cooldown, ${remainingS}s remaining)`,
      );
      return { customer: null, backfilled: 0 };
    }
    const appToken = requireAppToken();
    const started = Date.now();
    const { customer, allRecords } = await pageDomainMatchOnCacheMiss(
      ctx,
      appToken,
      domain,
      args.email,
    );
    if (allRecords.length > 0) {
      await ctx.runMutation(internal.feishu.customersMirror.applyPage, {
        rows: allRecords.map((c) => projectionToRow(c)),
        mirroredAt: Date.now(),
      });
    }
    console.log(
      `[customers-mirror] matchEmailAndCacheMiss domain="${domain}" -> ` +
        `${customer ? "hit" : "miss"}/${allRecords.length} backfilled (${Date.now() - started}ms)`,
    );
    return { customer, backfilled: allRecords.length };
  },
});

// Page the Customer Table by `域名 contains <domain>` until a strict canonical
// match is found (findCustomerByEmail — NOT "first row returned", since `contains`
// can pull in superstring domains like notacme.com for acme.com) or the pages run
// out (≤ MAX_CACHE_MISS_PAGES). Returns the match plus every row seen so the
// caller can backfill the mirror with them.
async function pageDomainMatchOnCacheMiss(
  ctx: ActionCtx,
  appToken: string,
  domain: string,
  email: string,
): Promise<{ customer: CustomerRecord | null; allRecords: CustomerRecord[] }> {
  const allRecords: CustomerRecord[] = [];
  let pageToken: string | undefined;
  let customer: CustomerRecord | null = null;
  for (let page = 0; page < MAX_CACHE_MISS_PAGES; page++) {
    const data: SearchResponse = await callFeishu<SearchResponse>(ctx, {
      path: `/bitable/v1/apps/${appToken}/tables/${CUSTOMER_TABLE_ID}/records/search`,
      method: "POST",
      auth: "tenant",
      json: {
        field_names: CUSTOMER_FIELD_NAMES,
        filter: {
          conjunction: "and",
          conditions: [{ field_name: "域名", operator: "contains", value: [domain] }],
        },
      },
      query: pageToken
        ? { page_size: String(CACHE_MISS_PAGE_SIZE), page_token: pageToken }
        : { page_size: String(CACHE_MISS_PAGE_SIZE) },
      label: "Customers mirror — live domain match on cache miss",
    });
    const pageRecords = (data.items ?? []).map((item) => mapFeishuItemToCustomer(item));
    allRecords.push(...pageRecords);
    customer = findCustomerByEmail(allRecords, email);
    if (customer !== null || !data.has_more || !data.page_token) break;
    pageToken = data.page_token;
  }
  return { customer, allRecords };
}

// Ranked mirror search. Uses Convex's `withSearchIndex` for prefix + score
// ranking on the `searchBlob` column. Optional `mineFor` filters to customers
// whose Owner == that open_id (the "Show mine" toggle from CustomerPicker,
// ADR-0013). INTERNAL: this is the mirror leg of the Customer-search engine —
// the SPA enters through `searchCustomers`, never this query directly.
export const search = internalQuery({
  args: {
    q: v.string(),
    mineFor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ records: CustomerRecord[]; mirroredAt: number | null }> => {
    const q = args.q.trim();
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
    const state = await ctx.db.query("customersMirrorState").first();
    // CJK queries are bigram-expanded so they match the bigram-augmented blob
    // (cjkSearch.ts); a query with no searchable content (e.g. all punctuation)
    // collapses to "" and is treated as a miss.
    const searchTokens = toSearchQueryString(q);
    if (q.length < MIN_CUSTOMER_SEARCH_LENGTH || searchTokens === "") {
      return { records: [], mirroredAt: state?.lastFullSyncAt ?? null };
    }
    const hits = await ctx.db
      .query("customers")
      .withSearchIndex("by_text", (b) => {
        let s = b.search("searchBlob", searchTokens);
        if (args.mineFor) s = s.eq("ownerOpenId", args.mineFor);
        return s;
      })
      .take(limit);
    const records: CustomerRecord[] = mergePreferredCustomers(
      searchDevCustomerFixtures(q, args.mineFor),
      hits.map((hit) => mirrorDocToCustomer(hit)),
    ).slice(0, limit);
    return { records, mirroredAt: state?.lastFullSyncAt ?? null };
  },
});
