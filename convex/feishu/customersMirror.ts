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

import {
  action,
  internalAction,
  internalMutation,
  query,
  type ActionCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { callFeishu } from "./call";
import {
  SEARCH_FALLBACK_PAGE_SIZE,
  canonicalCustomerDomain,
  buildCustomerSearchFilter,
  normalizeCustomerQuery,
  mapFeishuItemToCustomer,
  type CustomerRecord,
} from "./customers";
import {
  dedupeRowsByRecordId,
  mirrorDocToCustomer,
  projectionToRow,
} from "./customerMirrorRows";
import {
  DEV_CUSTOMER_FIXTURES,
  isDevCustomerFixturesEnabled,
  mergePreferredCustomers,
  searchDevCustomerFixtures,
} from "./devCustomerFixtures";

export { buildSearchBlob } from "./customerMirrorRows";

const CUSTOMER_TABLE_ID = "tbl4TE2GV472sKzp";
const PAGE_SIZE = 500;
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
        domainCanonical: v.optional(v.string()),
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
          await ctx.db.patch(existing._id, fields);
          return "updated" as const;
        }
        await ctx.db.insert("customers", fields);
        return "inserted" as const;
      }),
    );
    const inserted = writes.filter((result) => result === "inserted").length;
    const updated = writes.length - inserted;
    return { inserted, updated, duplicateRows };
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
  duplicateRows: number;
}

interface FullSyncResult {
  pages: number;
  rows: number;
  inserted: number;
  updated: number;
  duplicateRows: number;
  sourceRows: number;
  reportedTotal: number;
  hadMore: boolean;
  stopReason: MirrorStopReason;
  durationMs: number;
  pageSize: number;
  sourceTableId: string;
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

async function applyMirrorItems(
  ctx: ActionCtx,
  items: readonly FeishuRecord[],
  mirroredAt: number,
): Promise<AppliedPage> {
  const firstRecordId = items[0]?.record_id ?? "(none)";
  const lastRecordId = items.at(-1)?.record_id ?? "(none)";
  if (items.length === 0) {
    return { inserted: 0, updated: 0, duplicateRows: 0, rowCount: 0, firstRecordId, lastRecordId };
  }
  const projected = items.map((it) => projectionToRow(mapFeishuItemToCustomer(it)));
  const writeStats: PageWriteStats = await ctx.runMutation(
    internal.feishu.customersMirror.applyPage,
    { rows: projected, mirroredAt },
  );
  return { ...writeStats, rowCount: projected.length, firstRecordId, lastRecordId };
}

function addPageTotals(totals: SyncTotals, page: AppliedPage): void {
  totals.pages += 1;
  totals.rows += page.rowCount;
  totals.sourceRows += page.rowCount;
  totals.inserted += page.inserted;
  totals.updated += page.updated;
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
      `updated=${page.updated} duplicateRows=${page.duplicateRows} ` +
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

async function applyDevFixtures(ctx: ActionCtx, totals: SyncTotals, mirroredAt: number) {
  if (!isDevCustomerFixturesEnabled()) return;
  const fixtureStats: PageWriteStats = await ctx.runMutation(
    internal.feishu.customersMirror.applyPage,
    {
      rows: DEV_CUSTOMER_FIXTURES.map((customer) => projectionToRow(customer)),
      mirroredAt,
    },
  );
  totals.rows += DEV_CUSTOMER_FIXTURES.length;
  totals.inserted += fixtureStats.inserted;
  totals.updated += fixtureStats.updated;
  totals.duplicateRows += fixtureStats.duplicateRows;
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
    lastDuplicateCount: result.duplicateRows,
    lastReportedTotal: result.reportedTotal,
    lastSourceRowCount: result.sourceRows,
    lastHadMore: result.hadMore,
    lastStopReason: result.stopReason,
    lastDurationMs: result.durationMs,
    lastFinishedAt: finishedAt,
    lastSourceTableId: CUSTOMER_TABLE_ID,
  });
}

async function finishFullSync(
  ctx: ActionCtx,
  totals: SyncTotals,
  mirroredAt: number,
  hadMore: boolean,
  stopReason: MirrorStopReason,
): Promise<FullSyncResult> {
  const finishedAt = Date.now();
  const result = {
    ...totals,
    hadMore,
    stopReason,
    durationMs: finishedAt - mirroredAt,
    pageSize: PAGE_SIZE,
    sourceTableId: CUSTOMER_TABLE_ID,
  };
  await recordMirrorCompletion(ctx, result, mirroredAt, finishedAt);
  if (stopReason !== "complete") {
    throw new Error(
      `Customers mirror stopped before completion: reason=${stopReason} pages=${totals.pages} ` +
        `rows=${totals.rows} sourceRows=${totals.sourceRows} reportedTotal=${totals.reportedTotal}`,
    );
  }
  return result;
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
async function runFullSync(ctx: ActionCtx): Promise<FullSyncResult> {
  const appToken = requireAppToken();
  let pageToken: string | undefined;
  const mirroredAt = Date.now();
  const seenPageTokens = new Set<string>();
  const totals: SyncTotals = {
    pages: 0,
    rows: 0,
    inserted: 0,
    updated: 0,
    duplicateRows: 0,
    sourceRows: 0,
    reportedTotal: 0,
  };
  let hadMore = false;
  let stopReason: MirrorStopReason = "complete";
  let previousRequestStartedAt = 0;

  for (;;) {
    previousRequestStartedAt = await waitForPageSlot(previousRequestStartedAt);
    const data = await fetchMirrorPage(ctx, appToken, pageToken);
    totals.reportedTotal = Math.max(totals.reportedTotal, data.total ?? 0);
    const page = await applyMirrorItems(ctx, data.items ?? [], mirroredAt);
    addPageTotals(totals, page);
    hadMore = data.has_more === true;
    logMirrorPage(totals.pages, page, data);
    const next = nextPageTokenOrStop(data, seenPageTokens, totals.pages);
    if (next.stopReason) {
      stopReason = next.stopReason;
      break;
    }
    pageToken = next.pageToken;
  }

  await applyDevFixtures(ctx, totals, mirroredAt);
  const finalStopReason = completenessStopReason(stopReason, totals);
  return await finishFullSync(ctx, totals, mirroredAt, hadMore, finalStopReason);
}

export const fullSync = internalAction({
  args: {},
  handler: async (ctx): Promise<FullSyncResult> => {
    const started = Date.now();
    const out = await runFullSync(ctx);
    console.log(
      `[customers-mirror] fullSync ok pages=${out.pages} rows=${out.rows} ` +
        `inserted=${out.inserted} updated=${out.updated} duplicateRows=${out.duplicateRows} ` +
        `sourceRows=${out.sourceRows} reportedTotal=${out.reportedTotal} ` +
        `stopReason=${out.stopReason} duration=${Date.now() - started}ms`,
    );
    return out;
  },
});

// Public on-demand kick — lets the SPA force a refresh from the picker
// (deferred UI affordance per ADR-0016, but the action is exported so it can
// be exercised from the Convex dashboard / scripts before the UI lands).
export const kick = action({
  args: {},
  handler: async (ctx): Promise<FullSyncResult> => {
    return await runFullSync(ctx);
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
    const q = normalizeCustomerQuery(args.q);
    if (!q) return { records: [], backfilled: 0 };
    const appToken = requireAppToken();
    const started = Date.now();
    const data: SearchResponse = await callFeishu<SearchResponse>(ctx, {
      path: `/bitable/v1/apps/${appToken}/tables/${CUSTOMER_TABLE_ID}/records/search`,
      method: "POST",
      auth: "tenant",
      json: {
        filter: buildCustomerSearchFilter(q),
      },
      query: { page_size: String(SEARCH_FALLBACK_PAGE_SIZE) },
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
    const hitByCanonical = await ctx.db
      .query("customers")
      .withIndex("by_domainCanonical", (q) => q.eq("domainCanonical", domain))
      .first();
    if (hitByCanonical) {
      if (hitByCanonical.recordId === "dev_fixture_fanpc_customer") {
        console.log(
          `[dev-customer-fixture] TEST ONLY matched fanpc customer for ${domain}`,
        );
      }
      return { customer: mirrorDocToCustomer(hitByCanonical) };
    }
    const hitByRaw = await ctx.db
      .query("customers")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .first();
    if (hitByRaw) {
      return { customer: mirrorDocToCustomer(hitByRaw) };
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
    const q = normalizeCustomerQuery(args.q);
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
    const state = await ctx.db.query("customersMirrorState").first();
    if (!q) {
      return { records: [], mirroredAt: state?.lastFullSyncAt ?? null };
    }
    const hits = await ctx.db
      .query("customers")
      .withSearchIndex("by_text", (b) => {
        let s = b.search("searchBlob", q);
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
