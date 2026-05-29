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
  canonicalCustomerDomain,
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
// Hard cap of 20 × 500 = 10000 rows per fullSync. Bounds the per-run cost.
const MAX_PAGES = 20;

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
    return { inserted, updated };
  },
});

// Stamp the watermark row once per successful fullSync run.
export const recordSyncCompletion = internalMutation({
  args: { lastFullSyncAt: v.number(), lastRowCount: v.number() },
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
}

// Page through the live Customer Table → upsert into the Convex mirror.
// Tenant-token; runs on the Convex action runtime; called from the cron and
// (optionally) from `kick` for an on-demand refresh.
async function runFullSync(ctx: ActionCtx): Promise<{ pages: number; rows: number }> {
  const appToken = requireAppToken();
  let pageToken: string | undefined;
  const mirroredAt = Date.now();
  let pages = 0;
  let rows = 0;

  while (pages < MAX_PAGES) {
    const queryParams: Record<string, string> = { page_size: String(PAGE_SIZE) };
    if (pageToken) queryParams.page_token = pageToken;
    const data: SearchResponse = await callFeishu<SearchResponse>(ctx, {
      path: `/bitable/v1/apps/${appToken}/tables/${CUSTOMER_TABLE_ID}/records/search`,
      method: "POST",
      auth: "tenant",
      json: {},
      query: queryParams,
      label: "Customers mirror — Bitable page",
    });
    const items = data.items ?? [];
    if (items.length > 0) {
      const projected = items.map((it) => projectionToRow(mapFeishuItemToCustomer(it)));
      await ctx.runMutation(internal.feishu.customersMirror.applyPage, {
        rows: projected,
        mirroredAt,
      });
      rows += projected.length;
    }
    pages += 1;
    if (!data.has_more || !data.page_token) break;
    pageToken = data.page_token;
  }

  if (isDevCustomerFixturesEnabled()) {
    await ctx.runMutation(internal.feishu.customersMirror.applyPage, {
      rows: DEV_CUSTOMER_FIXTURES.map((customer) => projectionToRow(customer)),
      mirroredAt,
    });
    rows += DEV_CUSTOMER_FIXTURES.length;
  }

  await ctx.runMutation(internal.feishu.customersMirror.recordSyncCompletion, {
    lastFullSyncAt: mirroredAt,
    lastRowCount: rows,
  });
  return { pages, rows };
}

export const fullSync = internalAction({
  args: {},
  handler: async (ctx): Promise<{ pages: number; rows: number }> => {
    const started = Date.now();
    const out = await runFullSync(ctx);
    console.log(
      `[customers-mirror] fullSync ok pages=${out.pages} rows=${out.rows} duration=${Date.now() - started}ms`,
    );
    return out;
  },
});

// Public on-demand kick — lets the SPA force a refresh from the picker
// (deferred UI affordance per ADR-0016, but the action is exported so it can
// be exercised from the Convex dashboard / scripts before the UI lands).
export const kick = action({
  args: {},
  handler: async (ctx): Promise<{ pages: number; rows: number }> => {
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
    const q = args.q.trim();
    if (!q) return { records: [], backfilled: 0 };
    const appToken = requireAppToken();
    const started = Date.now();
    const data: SearchResponse = await callFeishu<SearchResponse>(ctx, {
      path: `/bitable/v1/apps/${appToken}/tables/${CUSTOMER_TABLE_ID}/records/search`,
      method: "POST",
      auth: "tenant",
      json: {
        filter: {
          conjunction: "or",
          conditions: [
            { field_name: "Account Name", operator: "contains", value: [q] },
            { field_name: "域名", operator: "contains", value: [q] },
          ],
        },
      },
      query: { page_size: String(PAGE_SIZE) },
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
