import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

export const storeEmailRecord = internalMutation({
  args: {
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
      v.array(v.object({ requestType: v.string(), note: v.string() })),
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
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("emailRecords", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const getByInternetMessageId = query({
  args: { internetMessageId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("emailRecords")
      .withIndex("by_internetMessageId", (q) =>
        q.eq("internetMessageId", args.internetMessageId),
      )
      .first();
  },
});

export const listRecent = query({
  handler: async (ctx) => {
    return await ctx.db.query("emailRecords").order("desc").take(20);
  },
});
