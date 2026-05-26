import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const returnItemValidator = v.object({
  itemName: v.string(),
  quantity: v.number(),
  amount: v.optional(v.number()),
});

export const createReturnRequest = mutation({
  args: {
    internetMessageId: v.string(),
    subject: v.string(),
    from: v.string(),
    orderNumber: v.optional(v.string()),
    returnReason: v.string(),
    returnItems: v.array(returnItemValidator),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("returnRequests", {
      ...args,
      status: "draft" as const,
      createdAt: Date.now(),
    });
  },
});

export const submitReturnRequest = mutation({
  args: {
    id: v.id("returnRequests"),
    pdfFileKey: v.optional(v.string()),
    bitableRecordId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      status: "submitted" as const,
      pdfFileKey: args.pdfFileKey,
      bitableRecordId: args.bitableRecordId,
    });
  },
});

export const listReturnRequests = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("returnRequests").order("desc").take(20);
  },
});
