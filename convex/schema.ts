import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { emailRecordFields } from "./emailRecord";

export default defineSchema({
  feishuTokens: defineTable({
    tokenType: v.literal("tenant_access_token"),
    token: v.string(),
    expiresAt: v.number(),
  }),

  feishuUserTokens: defineTable({
    sessionId: v.string(),
    accessToken: v.string(),
    refreshToken: v.string(),
    expiresAt: v.number(),
    tokenType: v.string(),
    openId: v.string(),
    userName: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
  })
    .index("by_sessionId", ["sessionId"])
    .index("by_openId", ["openId"]),

  emailRecords: defineTable({
    ...emailRecordFields,
    createdAt: v.number(),
  })
    .index("by_internetMessageId", ["internetMessageId"])
    .index("by_conversationId", ["conversationId"])
    .index("by_userEmail", ["userEmail"]),

  // Short-lived, per-session Feishu Search Users results. This keeps repeated
  // Coworker Picker query bursts on Convex instead of paying a Feishu
  // cross-region round-trip on every reopen or duplicate keystroke while still
  // treating Feishu as source of truth after TTL expiry.
  coworkerSearchCache: defineTable({
    sessionId: v.string(),
    query: v.string(),
    results: v.array(
      v.object({
        openId: v.string(),
        name: v.string(),
        avatarUrl: v.optional(v.string()),
      }),
    ),
    cachedAt: v.number(),
    ttlMs: v.number(),
  })
    .index("by_session_query", ["sessionId", "query"])
    .index("by_session_cachedAt", ["sessionId", "cachedAt"])
    .index("by_cachedAt", ["cachedAt"]),

  // ADR-0016: server-indexed Customer search mode. The Customer Table from
  // Feishu Bitable (tbl4TE2GV472sKzp) is mirrored here on a weekly cron
  // (crons.ts: 168 h) plus on-demand `kick` / cache-miss backfill; the
  // search index `by_text` runs prefix + ranked queries over a single
  // `searchBlob` text column (concatenation of name/fullName/accountNo/domain
  // /owner.name/countryRegion). The Bitable record_id is the natural key —
  // the mirror upserts on it, so a Customer's local Convex _id is stable.
  // Optional `ownerOpenId` mirrors `owner.openId` so the "Show mine" filter
  // can run as a `.eq` on the search index.
  customers: defineTable({
    recordId: v.string(),
    name: v.string(),
    domain: v.optional(v.string()),
    fullName: v.optional(v.string()),
    accountNo: v.optional(v.string()),
    countryRegion: v.optional(v.string()),
    ownerOpenId: v.optional(v.string()),
    ownerName: v.optional(v.string()),
    searchBlob: v.string(),
    mirroredAt: v.number(),
  })
    .index("by_recordId", ["recordId"])
    .index("by_domain", ["domain"])
    .searchIndex("by_text", { searchField: "searchBlob", filterFields: ["ownerOpenId"] }),

  // Watermark row for the customer-mirror cron — one row per deployment,
  // updated at the end of each successful fullSync run. Lets the dashboard
  // (and the SPA, if we expose it) show "last refreshed N min ago". Optional
  // audit fields are widened in place so existing deployments keep validating.
  customersMirrorState: defineTable({
    lastFullSyncAt: v.number(),
    lastRowCount: v.number(),
    lastPageCount: v.optional(v.number()),
    lastPageSize: v.optional(v.number()),
    lastInsertedCount: v.optional(v.number()),
    lastUpdatedCount: v.optional(v.number()),
    lastUnchangedCount: v.optional(v.number()),
    lastDuplicateCount: v.optional(v.number()),
    lastReportedTotal: v.optional(v.number()),
    lastSourceRowCount: v.optional(v.number()),
    lastHadMore: v.optional(v.boolean()),
    lastStopReason: v.optional(
      v.union(
        v.literal("complete"),
        v.literal("missingPageToken"),
        v.literal("duplicatePageToken"),
        v.literal("incompleteTotal"),
      ),
    ),
    lastDurationMs: v.optional(v.number()),
    lastFinishedAt: v.optional(v.number()),
    lastSourceTableId: v.optional(v.string()),
  }),

  returnRequests: defineTable({
    internetMessageId: v.string(),
    subject: v.string(),
    from: v.string(),
    orderNumber: v.optional(v.string()),
    returnReason: v.string(),
    returnItems: v.array(
      v.object({
        itemName: v.string(),
        quantity: v.number(),
        amount: v.optional(v.number()),
      }),
    ),
    status: v.union(
      v.literal("draft"),
      v.literal("submitted"),
      v.literal("processing"),
      v.literal("completed"),
    ),
    pdfFileKey: v.optional(v.string()),
    bitableRecordId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_internetMessageId", ["internetMessageId"])
    .index("by_status", ["status"]),
});
