import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { emailRecordFields } from "./emailRecord";

export default defineSchema({
  // Singleton tenant-token cache. The `by_tokenType` index lets storeToken read
  // the row by a narrow index range instead of a full-table scan, and underpins
  // the herd-collapse skip in feishu/auth.ts that ends the OCC write-conflict
  // storm when many actions refresh an expired token at once.
  feishuTokens: defineTable({
    tokenType: v.literal("tenant_access_token"),
    token: v.string(),
    expiresAt: v.number(),
  }).index("by_tokenType", ["tokenType"]),

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
    .index("by_userEmail", ["userEmail"])
    .index("by_requestSyncKey", ["requestSyncKey"])
    .index("by_bitableSyncStatus_and_bitableNextRetryAt", [
      "bitableSyncStatus",
      "bitableNextRetryAt",
    ])
    // Deferred attachment fill sweep (ADR-0022). Separate from the create-sync
    // index because an attachment-stuck row is bitableSyncStatus='synced' (the
    // row exists) — only its attachment lifecycle is unfinished.
    .index("by_attachmentStatus_and_attachmentNextRetryAt", [
      "bitableAttachmentStatus",
      "attachmentNextRetryAt",
    ]),

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
    // When the last full refresh STARTED (Mirror Kick rate-limit, ADR-0016
    // amendment). Stamped by any refresh; only the on-demand kick gates on it.
    lastRefreshStartedAt: v.optional(v.number()),
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
    // Mirror Prune (ADR-0021): rows scanned + orphans tombstoned on the last
    // complete sync. Optional so existing deployment rows keep validating.
    lastPruneScannedCount: v.optional(v.number()),
    lastDeletedStaleCount: v.optional(v.number()),
  }),

  // ADR-0023: server-indexed Feishu Contacts (org directory) mirror. The Feishu
  // Contact v3 directory is crawled biweekly (crons.ts: 336 h) into this table;
  // the `by_text` search index runs prefix + ranked queries over a single
  // `searchBlob` (name / enterprise_email / department, with CJK bigrams). The
  // immutable Feishu `open_id` is the natural key the mirror upserts on. We store
  // ONLY the enterprise (@fenchem.com) email — never the personal `email` — and
  // NEVER phone numbers; resigned/exited users are skipped and pruned.
  feishuContacts: defineTable({
    openId: v.string(),
    name: v.string(),
    // enterprise_email only; omitted when absent
    email: v.optional(v.string()),
    // joined department name(s)
    department: v.optional(v.string()),
    // open_department_ids
    departmentIds: v.optional(v.array(v.string())),
    // volatile (ADR-0003); re-stamped each run
    avatarUrl: v.optional(v.string()),
    searchBlob: v.string(),
    // ADR-0024: Pinyin match keys precomputed at sync time for the colleague
    // picker's client-side matcher (preload mode). Optional so pre-backfill rows
    // degrade to name/email matching; the pinyin-pro dictionary never ships to
    // the SPA. nameFold is the NFKC-folded lowercased name for cheap substring
    // matching. See convex/feishu/pinyinTokens.ts + src/.../colleagueRank.ts.
    pinyinFull: v.optional(v.string()),
    pinyinInitials: v.optional(v.string()),
    pinyinAlts: v.optional(v.string()),
    nameFold: v.optional(v.string()),
    mirroredAt: v.number(),
  })
    .index("by_openId", ["openId"])
    .index("by_email", ["email"])
    .searchIndex("by_text", { searchField: "searchBlob" }),

  // Watermark row for the contacts-mirror cron — one row per deployment, updated
  // at the end of each successful crawl. Mirrors customersMirrorState (ADR-0023).
  feishuContactsMirrorState: defineTable({
    lastFullSyncAt: v.number(),
    lastUserCount: v.number(),
    // When the last refresh STARTED (single-flight lease). Stamped by any run.
    lastRefreshStartedAt: v.optional(v.number()),
    lastDepartmentCount: v.optional(v.number()),
    lastInsertedCount: v.optional(v.number()),
    lastUpdatedCount: v.optional(v.number()),
    lastUnchangedCount: v.optional(v.number()),
    lastSkippedResignedCount: v.optional(v.number()),
    lastStopReason: v.optional(
      v.union(
        v.literal("complete"),
        v.literal("missingPageToken"),
        v.literal("duplicatePageToken"),
        v.literal("incomplete"),
      ),
    ),
    lastDurationMs: v.optional(v.number()),
    lastFinishedAt: v.optional(v.number()),
    lastPruneScannedCount: v.optional(v.number()),
    lastDeletedStaleCount: v.optional(v.number()),
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
