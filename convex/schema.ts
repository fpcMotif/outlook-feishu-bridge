import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
    subject: v.string(),
    from: v.string(),
    to: v.array(v.string()),
    cc: v.array(v.string()),
    bodyPreview: v.string(),
    internetMessageId: v.string(),
    itemId: v.optional(v.string()),
    conversationId: v.optional(v.string()),
    userEmail: v.optional(v.string()),
    dateTimeCreated: v.optional(v.number()),
    sentToBot: v.boolean(),
    sentToChat: v.boolean(),
    sentToBitable: v.boolean(),
    sentToContacts: v.optional(v.array(v.string())),
    sentToGroups: v.optional(v.array(v.string())),
    requestSelections: v.optional(
      v.array(
        v.object({
          requestType: v.string(),
          note: v.string(),
        }),
      ),
    ),
    selectedCoworkers: v.optional(
      v.array(
        v.object({
          openId: v.string(),
          name: v.string(),
          avatarUrl: v.optional(v.string()),
        }),
      ),
    ),
    feishuMessageId: v.optional(v.string()),
    bitableRecordId: v.optional(v.string()),
    pdfFileKey: v.optional(v.string()),
    attachmentFileKeys: v.optional(
      v.array(
        v.object({
          fileKey: v.string(),
          fileName: v.string(),
          type: v.union(v.literal("file"), v.literal("image")),
        }),
      ),
    ),
    feishuDocUrl: v.optional(v.string()),
    feishuDocToken: v.optional(v.string()),
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
