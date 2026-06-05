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
  runMirrorRefresh,
  sleep,
  stalePageIds,
  type AppliedPageWithIds,
  type FeishuRecord,
  type MirrorRefreshPort,
  type MirrorStopReason,
  type PageWriteStats,
  type PruneTotals,
  type SearchResponse,
  type SyncTotals,
} from "./customerMirrorSync";
import {
  canonicalCustomerDomain,
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
  searchDevCustomerFixtures,
} from "./devCustomerFixtures";
import { mergePreferredCustomers } from "./searchResultMerge";

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
        const fields = { ...row, mirroredAt: args.mirroredAt };
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

function customerRowChanged(
  existing: CustomerUpsertRow,
  next: CustomerUpsertRow,
): boolean {
  return (
    existing.recordId !== next.recordId ||
    existing.name !== next.name ||
    existing.domain !== next.domain ||
    existing.fullName !== next.fullName ||
    existing.accountNo !== next.accountNo ||
    existing.countryRegion !== next.countryRegion ||
    existing.ownerOpenId !== next.ownerOpenId ||
    existing.ownerName !== next.ownerName ||
    existing.searchBlob !== next.searchBlob
  );
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

// The real Mirror Refresh port: pace via Date.now/sleep, fetch via Feishu, and
// apply/tombstone/finish via Convex. The engine (customerMirrorSync.runMirrorRefresh)
// owns the page-walk, completeness promotion, and the all-or-nothing prune gate;
// this adapter only supplies the I/O — and finishFullSync escalates a non-complete
// stop into a thrown error (ADR-0021), which keeps the engine itself non-throwing.
function makeMirrorRefreshPort(
  ctx: ActionCtx,
  appToken: string,
): MirrorRefreshPort<FullSyncResult> {
  return {
    clock: { now: () => Date.now(), sleep },
    fetchPage: (pageToken) => fetchMirrorPage(ctx, appToken, pageToken),
    applyPage: (items, mirroredAt) => applyMirrorItems(ctx, items, mirroredAt),
    applyDevFixtures: (totals, mirroredAt, seen) =>
      applyDevFixtures(ctx, totals, mirroredAt, seen),
    tombstone: (seen) => pruneStaleRows(ctx, seen),
    finish: ({ totals, mirroredAt, hadMore, stopReason, prune }) =>
      finishFullSync(ctx, totals, mirroredAt, hadMore, stopReason, prune),
  };
}

async function runFullSync(
  ctx: ActionCtx,
  options: { startedAt?: number } = {},
): Promise<FullSyncResult> {
  // The caller (kick / fullSync) has already acquired the refresh start lease via
  // startRefreshIfAllowed (ADR-0021 single-flight); the engine does no start-stamping.
  const appToken = requireAppToken();
  return await runMirrorRefresh(makeMirrorRefreshPort(ctx, appToken), {
    startedAt: options.startedAt,
  });
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

// Cache-aside lazy fill (ADR-0016 § "Per-request cache miss"). Called by the
// SPA when the Convex mirror search returns 0 hits — falls through to the
// LIVE Feishu /records/search with the same `or` `contains` filter the legacy
// per-keystroke path uses, then INCREMENTALLY upserts any new rows into the
// mirror so the next search hits the fast path. Slower than the mirror query
// (200-500 ms cross-border), but the latency hit is exactly when the user
// asked for it (cache miss) and it self-heals for next time.
export const searchAndCacheMiss = action({
  args: { q: v.string(), mineFor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ records: CustomerRecord[]; backfilled: number }> => {
    const q = args.q.trim();
    if (q.length < MIN_CUSTOMER_SEARCH_LENGTH) return { records: [], backfilled: 0 };
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
      searchDevCustomerFixtures(q, args.mineFor),
      args.mineFor === undefined
        ? backfilledRecords
        : backfilledRecords.filter((record) => record.owner?.openId === args.mineFor),
    );
    console.log(
      `[customers-mirror] searchAndCacheMiss q="${q.slice(0, 40)}" -> ${records.length}/${backfilledRecords.length} backfilled (${Date.now() - started}ms)`,
    );
    return { records, backfilled: backfilledRecords.length };
  },
});

export const matchByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, args): Promise<{ customer: CustomerRecord | null }> => {
    const domain = canonicalCustomerDomain(emailDomain(args.email));
    if (!domain) return { customer: null };
    const hit = await ctx.db
      .query("customers")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .first();
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

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

// Public ranked search query. Uses Convex's `withSearchIndex` for prefix +
// score ranking on the `searchBlob` column. Optional `mineFor` filters to
// customers whose Owner == that open_id (the "Show mine" toggle from
// CustomerPicker, ADR-0013).
export const search = query({
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
