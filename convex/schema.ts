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
